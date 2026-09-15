import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'
import { signToken } from '../helpers/token.js'

const USER = { sub: 'user-1', customerId: 'cust-1', username: 'joao.silva' }

function decimal(value: string) {
  return new Prisma.Decimal(value)
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    accountId: 'acc-source',
    method: 'BILL',
    amount: decimal('100.00'),
    description: null,
    status: 'COMPLETED',
    idempotencyKey: 'idem-1',
    transactionId: 'tx-1',
    beneficiaryName: null,
    beneficiaryDoc: null,
    pixKey: null,
    endToEndId: null,
    pixTransferId: null,
    digitableLine: null,
    billProvider: null,
    billReference: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('POST /v1/me/payments (facade)', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient
  let token: string

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
    token = signToken(app, USER)
    // No previous payment under the same idempotency key unless a test says so.
    mock.payment.findUnique.mockResolvedValue(null)
  })

  function pay(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/me/payments',
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload,
    })
  }

  describe('PIX payment method', () => {
    function arrangePixTransfer() {
      // Facade looks up the first active account, then the service re-validates
      // ownership of that same account. Both return the source account.
      mock.account.findFirst.mockResolvedValue({
        id: 'acc-source',
        customerId: 'cust-1',
        status: 'ACTIVE',
        balance: decimal('500.00'),
      })
      mock.pixKey.findFirst.mockResolvedValue({
        id: 'key-dest',
        accountId: 'acc-dest',
        type: 'EMAIL',
        value: 'destino@example.com',
        status: 'ACTIVE',
      })
      mock.pixTransfer.findUnique.mockResolvedValue(null)

      mock.$queryRaw.mockResolvedValue([
        { id: 'acc-source', customerId: 'cust-1', status: 'ACTIVE', balance: decimal('500.00') },
        { id: 'acc-dest', customerId: 'cust-2', status: 'ACTIVE', balance: decimal('200.00') },
      ])
      mock.transaction.create
        .mockResolvedValueOnce({ id: 'tx-debit', balanceAfter: decimal('400.00') })
        .mockResolvedValueOnce({ id: 'tx-credit', balanceAfter: decimal('300.00') })
      mock.pixTransfer.create.mockResolvedValue({
        id: 'transfer-1',
        endToEndId: 'E000000002026010100000000000000000000000',
        consentId: 'consent-1',
        enrollmentId: null,
        status: 'COMPLETED',
        amount: decimal('100.00'),
        debitTransactionId: 'tx-debit',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })
      mock.account.update.mockResolvedValue({})
    }

    it('executes a PIX payment via the shared service', async () => {
      arrangePixTransfer()
      mock.payment.create.mockResolvedValue(
        paymentRow({
          id: 'pay-pix',
          method: 'PIX',
          pixKey: 'destino@example.com',
          endToEndId: 'E000000002026010100000000000000000000000',
          pixTransferId: 'transfer-1',
          transactionId: 'tx-debit',
        }),
      )

      const response = await pay({
        paymentMethod: 'PIX',
        amount: '100.00',
        pix: { key: 'destino@example.com' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.paymentMethod).toBe('PIX')
      expect(body.status).toBe('COMPLETED')
      expect(body.balance).toBe('400.00')
      expect(body.idempotentReplay).toBe(false)
      expect(mock.pixTransfer.create).toHaveBeenCalledTimes(1)
    })

    it('records the payment linked to the transfer it settled', async () => {
      arrangePixTransfer()
      mock.payment.create.mockResolvedValue(paymentRow({ method: 'PIX' }))

      await pay({
        paymentMethod: 'PIX',
        amount: '100.00',
        pix: { key: 'destino@example.com' },
      })

      expect(mock.payment.create).toHaveBeenCalledTimes(1)
      const { data } = mock.payment.create.mock.calls[0][0]
      expect(data).toMatchObject({
        method: 'PIX',
        pixTransferId: 'transfer-1',
        endToEndId: 'E000000002026010100000000000000000000000',
        transactionId: 'tx-debit',
        pixKey: 'destino@example.com',
      })
    })

    it('exposes the transfer identifiers under pix', async () => {
      arrangePixTransfer()
      mock.payment.create.mockResolvedValue(
        paymentRow({
          method: 'PIX',
          pixTransferId: 'transfer-1',
          endToEndId: 'E000000002026010100000000000000000000000',
          pixKey: 'destino@example.com',
        }),
      )

      const body = (await pay({
        paymentMethod: 'PIX',
        amount: '100.00',
        pix: { key: 'destino@example.com' },
      })).json()

      expect(body.pix).toEqual({
        key: 'destino@example.com',
        endToEndId: 'E000000002026010100000000000000000000000',
        pixTransferId: 'transfer-1',
      })
      expect(body.boleto).toBeNull()
      expect(body.bill).toBeNull()
    })
  })

  describe('BOLETO payment method', () => {
    beforeEach(() => {
      mock.account.findFirst.mockResolvedValue({
        id: 'acc-source',
        status: 'ACTIVE',
        balance: decimal('500.00'),
      })
      mock.$queryRaw.mockResolvedValue([])
      mock.transaction.create.mockResolvedValue({ id: 'tx-1' })
      mock.account.update.mockResolvedValue({})
    })

    it('executes a boleto payment', async () => {
      const row = paymentRow({ method: 'BOLETO', digitableLine: '1'.repeat(44) })
      mock.payment.create.mockResolvedValue(row)
      mock.payment.update.mockResolvedValue(row)

      const response = await pay({
        paymentMethod: 'BOLETO',
        amount: '100.00',
        boleto: { digitableLine: '12345678901234567890123456789012345678901234' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.paymentMethod).toBe('BOLETO')
      expect(body.status).toBe('COMPLETED')
      expect(body.balance).toBe('400.00')
      expect(body.boleto).toEqual({ digitableLine: '1'.repeat(44) })
      expect(body.pix).toBeNull()
    })

    it('writes the payment inside the same transaction as the debit', async () => {
      const row = paymentRow({ method: 'BOLETO' })
      mock.payment.create.mockResolvedValue(row)
      mock.payment.update.mockResolvedValue(row)

      await pay({
        paymentMethod: 'BOLETO',
        amount: '100.00',
        boleto: { digitableLine: '12345678901234567890123456789012345678901234' },
      })

      expect(mock.$transaction).toHaveBeenCalledTimes(1)
      expect(mock.payment.create).toHaveBeenCalledTimes(1)
      // The ledger entry points back at the payment it settled.
      const txData = mock.transaction.create.mock.calls[0][0].data
      expect(txData.referenceId).toBe('pay-1')
    })
  })

  describe('BILL payment method', () => {
    it('executes a bill payment', async () => {
      mock.account.findFirst.mockResolvedValue({
        id: 'acc-source',
        status: 'ACTIVE',
        balance: decimal('500.00'),
      })
      mock.$queryRaw.mockResolvedValue([])
      mock.transaction.create.mockResolvedValue({ id: 'tx-1' })
      mock.account.update.mockResolvedValue({})
      const row = paymentRow({ method: 'BILL', billProvider: 'Energia', billReference: '2026-01' })
      mock.payment.create.mockResolvedValue(row)
      mock.payment.update.mockResolvedValue(row)

      const response = await pay({
        paymentMethod: 'BILL',
        amount: '100.00',
        bill: { provider: 'Energia', reference: '2026-01' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.paymentMethod).toBe('BILL')
      expect(body.bill).toEqual({ provider: 'Energia', reference: '2026-01' })
    })
  })

  describe('Idempotency-Key', () => {
    beforeEach(() => {
      mock.account.findFirst.mockResolvedValue({
        id: 'acc-source',
        status: 'ACTIVE',
        balance: decimal('500.00'),
      })
    })

    it('replays the stored payment without moving money again', async () => {
      mock.payment.findUnique.mockResolvedValue(
        paymentRow({ id: 'pay-existing', method: 'BILL', idempotencyKey: 'abc-123' }),
      )

      const response = await pay(
        {
          paymentMethod: 'BILL',
          amount: '100.00',
          bill: { provider: 'Energia', reference: '2026-01' },
        },
        { 'idempotency-key': 'abc-123' },
      )

      expect(response.statusCode).toBe(200)
      expect(response.json().paymentId).toBe('pay-existing')
      expect(response.json().idempotentReplay).toBe(true)
      expect(mock.payment.create).not.toHaveBeenCalled()
      expect(mock.transaction.create).not.toHaveBeenCalled()
    })

    it('looks the key up scoped to the source account', async () => {
      mock.payment.findUnique.mockResolvedValue(paymentRow())

      await pay(
        {
          paymentMethod: 'BILL',
          amount: '100.00',
          bill: { provider: 'Energia', reference: '2026-01' },
        },
        { 'idempotency-key': 'abc-123' },
      )

      expect(mock.payment.findUnique).toHaveBeenCalledWith({
        where: { accountId_idempotencyKey: { accountId: 'acc-source', idempotencyKey: 'abc-123' } },
      })
    })

    it('generates a key when the header is absent, so calls stay independent', async () => {
      mock.$queryRaw.mockResolvedValue([])
      mock.transaction.create.mockResolvedValue({ id: 'tx-1' })
      mock.account.update.mockResolvedValue({})
      const row = paymentRow()
      mock.payment.create.mockResolvedValue(row)
      mock.payment.update.mockResolvedValue(row)

      await pay({
        paymentMethod: 'BILL',
        amount: '100.00',
        bill: { provider: 'Energia', reference: '2026-01' },
      })

      const key = mock.payment.create.mock.calls[0][0].data.idempotencyKey
      expect(key).toMatch(/^[0-9a-f-]{36}$/)
    })
  })
})

describe('GET /v1/payments/:paymentId', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient
  let token: string

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
    token = signToken(app, USER)
  })

  function get(id: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/payments/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  it('returns 401 without a token', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/payments/${ID}` })
    expect(response.statusCode).toBe(401)
  })

  it('returns the stored payment', async () => {
    mock.payment.findFirst.mockResolvedValue(
      paymentRow({ id: ID, method: 'BOLETO', digitableLine: '1'.repeat(44) }),
    )

    const response = await get(ID)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      paymentId: ID,
      paymentMethod: 'BOLETO',
      amount: '100.00',
      boleto: { digitableLine: '1'.repeat(44) },
    })
  })

  it('scopes the lookup to the authenticated owner', async () => {
    mock.payment.findFirst.mockResolvedValue(paymentRow({ id: ID }))

    await get(ID)

    expect(mock.payment.findFirst).toHaveBeenCalledWith({
      where: { id: ID, account: { customer: { is: { userId: USER.sub } } } },
    })
  })

  // A payment belonging to someone else must be indistinguishable from one that
  // does not exist, otherwise the endpoint allows enumeration.
  it('returns 404 when the payment is not the caller\'s', async () => {
    mock.payment.findFirst.mockResolvedValue(null)

    const response = await get(ID)

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('PAYMENT_NOT_FOUND')
  })
})
