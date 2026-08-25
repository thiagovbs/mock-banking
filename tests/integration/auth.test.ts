import { describe, it, expect, beforeEach } from 'vitest'
import bcrypt from 'bcrypt'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'

describe('POST /v1/auth/login', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
  })

  it('returns an access token for valid credentials', async () => {
    const passwordHash = await bcrypt.hash('senhaSegura123', 4)
    mock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'joao.silva',
      passwordHash,
      customer: { id: 'cust-1' },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'joao.silva', password: 'senhaSegura123' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.accessToken).toBeTruthy()
    expect(body.tokenType).toBe('Bearer')
    expect(body.expiresIn).toBe(3600)
  })

  it('returns 401 when user has no customer', async () => {
    const passwordHash = await bcrypt.hash('senhaSegura123', 4)
    mock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'joao.silva',
      passwordHash,
      customer: null,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'joao.silva', password: 'senhaSegura123' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 401 for unknown user', async () => {
    mock.user.findUnique.mockResolvedValue(null)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'nao.existe', password: 'senhaSegura123' },
    })

    expect(response.statusCode).toBe(401)
  })
})
