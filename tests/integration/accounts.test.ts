import { describe, it, expect, beforeEach } from 'vitest'
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
})
