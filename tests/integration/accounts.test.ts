import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'
import { signToken } from '../helpers/token.js'

const USER = { sub: 'user-1', customerId: 'cust-1', username: 'joao.silva' }

describe('Accounts endpoints', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient
  let token: string

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
    token = signToken(app, USER)
  })

  describe('GET /v1/me/accounts', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/me/accounts' })
      expect(response.statusCode).toBe(401)
    })
  })

  describe('POST /v1/accounts', () => {
    const takenNumber = () =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['accountNumber'] },
      })

    const created = {
      id: 'acc-1',
      branch: '0001',
      accountNumber: '654321',
      balance: new Prisma.Decimal('0.00'),
      status: 'ACTIVE',
      createdAt: new Date(),
    }

    function createAccount() {
      return app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { authorization: `Bearer ${token}` },
      })
    }

    it('retries with a new number when the drawn one is taken', async () => {
      mock.account.create
        .mockRejectedValueOnce(takenNumber())
        .mockResolvedValueOnce(created)

      const response = await createAccount()

      expect(response.statusCode).toBe(201)
      expect(mock.account.create).toHaveBeenCalledTimes(2)
      // Each attempt must draw a fresh number, otherwise the retry is pointless.
      const [first, second] = mock.account.create.mock.calls
      expect(first[0].data.accountNumber).not.toBe(second[0].data.accountNumber)
    })

    it('gives up with 503 after exhausting the attempts', async () => {
      mock.account.create.mockRejectedValue(takenNumber())

      const response = await createAccount()

      expect(response.statusCode).toBe(503)
      expect(response.json().error).toBe('ACCOUNT_NUMBER_UNAVAILABLE')
      expect(mock.account.create).toHaveBeenCalledTimes(5)
    })

    it('does not retry on an unrelated failure', async () => {
      mock.account.create.mockRejectedValue(new Error('connection lost'))

      const response = await createAccount()

      expect(response.statusCode).toBe(500)
      expect(mock.account.create).toHaveBeenCalledTimes(1)
    })
  })
})
