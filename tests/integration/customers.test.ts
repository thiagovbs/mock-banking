import { describe, it, expect, beforeEach } from 'vitest'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'

describe('POST /v1/customers', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
  })

  it('creates a customer and user, returning 201', async () => {
    mock.user.create.mockResolvedValue({ id: 'user-1', username: 'joao.silva' })
    mock.customer.create.mockResolvedValue({
      id: 'cust-1',
      name: 'Joao da Silva',
      document: '12345678901',
      email: 'joao@example.com',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      payload: {
        name: 'Joao da Silva',
        document: '12345678901',
        email: 'joao@example.com',
        username: 'joao.silva',
        password: 'MinhaSenha123',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.id).toBe('cust-1')
    expect(body.name).toBe('Joao da Silva')
    expect(body.document).toBe('12345678901')
    expect(body.email).toBe('joao@example.com')
    expect(body).not.toHaveProperty('password')
    expect(body).not.toHaveProperty('passwordHash')
  })
})
