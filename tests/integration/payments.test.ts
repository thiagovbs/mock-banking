import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'
import { signToken } from '../helpers/token.js'

const USER = { sub: 'user-1', customerId: 'cust-1', username: 'joao.silva' }

function decimal(value: string) {
  return new Prisma.Decimal(value)
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
  })

  describe('PIX payment method', () => {
    it('executes a PIX payment via the shared service', async () => {
      // Facade looks up the first active account, then the service re-validates
      // ownership of that same account. Both return the source account.
      mock.account.findFirst.mockResolvedValue({
        id: 'acc-source',
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

      mock.$queryRaw.mockResolvedValue([])
      mock.account.findUnique.mockResolvedValue({
        id: 'acc-dest',
        status: 'ACTIVE',
        balance: decimal('200.00'),
      })
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
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })
      mock.account.update.mockResolvedValue({})

      const response = await app.inject({
        method: 'POST',
        url: '/v1/me/payments',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          paymentMethod: 'PIX',
          amount: '100.00',
          pix: { key: 'destino@example.com' },
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.paymentId).toBe('transfer-1')
      expect(body.paymentMethod).toBe('PIX')
      expect(body.status).toBe('COMPLETED')
      expect(body.balance).toBe('400.00')
      expect(body.idempotentReplay).toBe(false)
      expect(mock.pixTransfer.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('BOLETO payment method', () => {
    it('executes a boleto payment', async () => {
      mock.account.findFirst.mockResolvedValue({
        id: 'acc-source',
        status: 'ACTIVE',
        balance: decimal('500.00'),
      })
      mock.$queryRaw.mockResolvedValue([])
      mock.transaction.create.mockResolvedValue({ id: 'tx-1' })
      mock.account.update.mockResolvedValue({})

      const response = await app.inject({
        method: 'POST',
        url: '/v1/me/payments',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          paymentMethod: 'BOLETO',
          amount: '100.00',
          boleto: { digitableLine: '12345678901234567890123456789012345678901234' },
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.paymentMethod).toBe('BOLETO')
      expect(body.status).toBe('COMPLETED')
      expect(body.balance).toBe('400.00')
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

      const response = await app.inject({
        method: 'POST',
        url: '/v1/me/payments',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          paymentMethod: 'BILL',
          amount: '100.00',
          bill: { provider: 'Energia', reference: '2026-01' },
        },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().paymentMethod).toBe('BILL')
    })
  })
})
