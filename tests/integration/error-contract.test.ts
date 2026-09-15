import { describe, it, expect, beforeEach } from 'vitest'
import bcrypt from 'bcrypt'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'

/**
 * The published contract (components/schemas/Error of the gateway spec) is
 * { error: <machine readable code>, message }. That only holds while the
 * custom error handler is installed before the route plugins are registered:
 * each register() creates an encapsulated context that captures the handler in
 * force at that moment, so setting it afterwards silently leaves every route
 * on Fastify's default serializer, which puts the HTTP status text in `error`.
 */
describe('AppError response contract', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
  })

  it('puts the application code in `error`, not the HTTP status text', async () => {
    mock.user.findUnique.mockResolvedValue(null)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'someone', password: 'whatever' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password',
    })
  })

  it('reports validation failures as VALIDATION_ERROR', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'someone' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('VALIDATION_ERROR')
  })

  it('keeps unexpected failures as INTERNAL_SERVER_ERROR', async () => {
    mock.user.findUnique.mockRejectedValue(new Error('connection lost'))

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'someone', password: await bcrypt.hash('x', 4) },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().error).toBe('INTERNAL_SERVER_ERROR')
  })
})
