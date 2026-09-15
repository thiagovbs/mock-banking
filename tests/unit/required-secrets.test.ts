import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import authPlugin from '../../src/plugins/auth.js'

const VALID = 'a-valid-secret'

describe('auth plugin required secrets', () => {
  const original = {
    JWT_SECRET: process.env.JWT_SECRET,
    INITIATOR_SERVICE_SECRET: process.env.INITIATOR_SERVICE_SECRET,
  }

  afterEach(() => {
    process.env.JWT_SECRET = original.JWT_SECRET
    process.env.INITIATOR_SERVICE_SECRET = original.INITIATOR_SERVICE_SECRET
  })

  describe.each(['JWT_SECRET', 'INITIATOR_SERVICE_SECRET'] as const)('%s', (name) => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['only whitespace', '   '],
    ])(`refuses to boot when ${name} is %s`, async (_label, value) => {
      // The other secret stays valid, so the rejection can only come from this one.
      process.env.JWT_SECRET = VALID
      process.env.INITIATOR_SERVICE_SECRET = VALID
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }

      const app = Fastify()
      app.register(authPlugin)

      await expect(app.ready()).rejects.toThrow(new RegExp(name))
      await app.close()
    })
  })

  it('boots when both secrets are set', async () => {
    process.env.JWT_SECRET = VALID
    process.env.INITIATOR_SERVICE_SECRET = VALID

    const app = Fastify()
    app.register(authPlugin)

    await expect(app.ready()).resolves.toBeTruthy()
    await app.close()
  })
})

describe('requireInitiator', () => {
  async function buildGuardedApp() {
    const app = Fastify()
    app.register(authPlugin)
    // Nested plugin so the route is declared before ready() but still after
    // authPlugin has decorated the instance with requireInitiator.
    app.register(async (instance) => {
      instance.get('/guarded', { preHandler: instance.requireInitiator }, async () => ({ ok: true }))
    })
    await app.ready()
    return app
  }

  it.each([
    ['no x-initiator-key header', {}],
    ['a wrong x-initiator-key', { 'x-initiator-key': 'wrong-secret' }],
  ])('answers 401 with %s', async (_label, headers) => {
    const app = await buildGuardedApp()
    const response = await app.inject({ method: 'GET', url: '/guarded', headers })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('UNAUTHORIZED')
    await app.close()
  })

  it('lets the request through with the configured key', async () => {
    const app = await buildGuardedApp()
    const response = await app.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-initiator-key': process.env.INITIATOR_SERVICE_SECRET as string },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    await app.close()
  })
})
