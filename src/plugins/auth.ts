import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import { createHash, timingSafeEqual } from 'node:crypto'
import { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Compara dois segredos em tempo constante. O hash previo iguala o tamanho dos
 * buffers, tanto porque timingSafeEqual exige comprimentos iguais quanto para
 * nao vazar o tamanho do segredo pela duracao da chamada.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export type JwtUser = {
  sub: string
  customerId: string
  username: string
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireInitiator: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export default fp(async (app) => {
  // Both secrets are validated at boot. A missing JWT_SECRET would otherwise
  // fall back to a default that is public in the source code, letting anyone
  // forge an access token; a missing INITIATOR_SERVICE_SECRET would let the app
  // start and then reject every JSR request, which is harder to diagnose.
  const jwtSecret = process.env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    throw new Error(
      'JWT_SECRET is not set (or is empty). Refusing to start: set it to a long random value.',
    )
  }

  const initiatorSecret = process.env.INITIATOR_SERVICE_SECRET?.trim()
  if (!initiatorSecret) {
    throw new Error(
      'INITIATOR_SERVICE_SECRET is not set (or is empty). Refusing to start: set it to the secret shared with the Iniciadora.',
    )
  }

  await app.register(jwt, {
    secret: jwtSecret,
    verify: {
      extractToken: (request) => {
        // Prefer the x-Authorization header (used by the AI agent), falling
        // back to the standard Authorization: Bearer header.
        const xAuth = request.headers['x-authorization']
        if (typeof xAuth === 'string' && xAuth.trim()) {
          return xAuth.trim()
        }
        const auth = request.headers.authorization
        if (typeof auth === 'string' && /^Bearer\s/i.test(auth)) {
          return auth.split(' ')[1]
        }
        return undefined
      },
    },
  })

  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing access token',
      })
      return
    }
  })

  // Autentica a Iniciadora (aplicação de serviço) via header x-initiator-key.
  // Usado nos endpoints ITP/PISP JSR, que são chamados pela iniciadora (não
  // por um usuário logado), portanto sem JWT de usuário.
  app.decorate('requireInitiator', async (request, reply) => {
    const presented = request.headers['x-initiator-key']
    if (typeof presented !== 'string' || !secretsMatch(presented, initiatorSecret)) {
      reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing initiator key',
      })
      return
    }
  })
})
