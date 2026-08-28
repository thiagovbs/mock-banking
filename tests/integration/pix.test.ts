import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'
import { signToken } from '../helpers/token.js'

const USER = { sub: 'user-1', customerId: 'cust-1', username: 'joao.silva' }

const SOURCE_ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEST_ACC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function decimal(value: string) {
  return new Prisma.Decimal(value)
}

describe('PIX endpoints', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient
  let token: string

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
    token = signToken(app, USER)
  })

  describe('POST /v1/accounts/:accountId/pix/keys', () => {
    it('creates an EVP key when no value is provided', async () => {
      mock.account.findFirst.mockResolvedValue({ id: SOURCE_ACC })
      mock.pixKey.findUnique.mockResolvedValue(null)
      mock.pixKey.create.mockResolvedValue({
        id: 'key-1',
        accountId: SOURCE_ACC,
        type: 'EVP',
        value: 'some-uuid',
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })

      const response = await app.inject({
        method: 'POST',
        url: `/v1/accounts/${SOURCE_ACC}/pix/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.type).toBe('EVP')
      expect(body.generated).toBe(true)
    })

    it('creates a typed key with a value', async () => {
      mock.account.findFirst.mockResolvedValue({ id: SOURCE_ACC })
      mock.pixKey.findUnique.mockResolvedValue(null)
      mock.pixKey.create.mockResolvedValue({
        id: 'key-1',
        accountId: SOURCE_ACC,
        type: 'EMAIL',
        value: 'joao@example.com',
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })

      const response = await app.inject({
        method: 'POST',
        url: `/v1/accounts/${SOURCE_ACC}/pix/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: 'EMAIL', value: 'Joao@Example.com' },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().value).toBe('joao@example.com')
    })
  })

  describe('POST /v1/accounts/:accountId/pix/transfers', () => {
    const transferPayload = {
      amount: '100.00',
      pixKey: { type: 'EMAIL', value: 'destino@example.com' },
      consentId: 'consent-1',
    }

    it('executes a successful transfer', async () => {
      mock.account.findFirst.mockResolvedValue({
        id: SOURCE_ACC,
        customerId: 'cust-1',
        status: 'ACTIVE',
        balance: decimal('500.00'),
      })
      mock.pixKey.findFirst.mockResolvedValue({
        id: 'key-dest',
        accountId: DEST_ACC,
        type: 'EMAIL',
        value: 'destino@example.com',
        status: 'ACTIVE',
      })
      mock.pixTransfer.findUnique.mockResolvedValue(null)

      mock.$queryRaw.mockResolvedValue([
        { id: SOURCE_ACC, customerId: 'cust-1', status: 'ACTIVE', balance: decimal('500.00') },
        { id: DEST_ACC, customerId: 'cust-2', status: 'ACTIVE', balance: decimal('200.00') },
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
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })
      mock.account.update.mockResolvedValue({})

      const response = await app.inject({
        method: 'POST',
        url: `/v1/accounts/${SOURCE_ACC}/pix/transfers`,
        headers: { authorization: `Bearer ${token}` },
        payload: transferPayload,
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.pixTransferId).toBe('transfer-1')
      expect(body.status).toBe('COMPLETED')
      expect(body.balance).toBe('400.00')
      expect(body.idempotentReplay).toBe(false)
      expect(mock.transaction.create).toHaveBeenCalledTimes(2)
      expect(mock.pixTransfer.create).toHaveBeenCalledTimes(1)
    })

    it('returns an idempotent replay when consentId was already used', async () => {
      mock.account.findFirst.mockResolvedValue({
        id: SOURCE_ACC,
        status: 'ACTIVE',
        balance: decimal('500.00'),
      })
      mock.pixKey.findFirst.mockResolvedValue({
        id: 'key-dest',
        accountId: DEST_ACC,
        type: 'EMAIL',
        value: 'destino@example.com',
        status: 'ACTIVE',
      })
      mock.pixTransfer.findUnique.mockResolvedValue({
        id: 'transfer-1',
        sourceAccountId: SOURCE_ACC,
        endToEndId: 'E000000002026010100000000000000000000000',
        consentId: 'consent-1',
        enrollmentId: null,
        status: 'COMPLETED',
        amount: decimal('100.00'),
        debitTransactionId: 'tx-debit',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })
      mock.transaction.findUnique.mockResolvedValue({
        id: 'tx-debit',
        balanceAfter: decimal('400.00'),
      })

      const response = await app.inject({
        method: 'POST',
        url: `/v1/accounts/${SOURCE_ACC}/pix/transfers`,
        headers: { authorization: `Bearer ${token}` },
        payload: transferPayload,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.idempotentReplay).toBe(true)
      expect(body.pixTransferId).toBe('transfer-1')
      expect(mock.pixTransfer.create).not.toHaveBeenCalled()
    })
  })
})
