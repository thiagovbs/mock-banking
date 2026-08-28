import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import { FastifyReply, FastifyRequest } from 'fastify'

export type JwtUser = {
  sub: string
  customerId: string
  username: string
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export default fp(async (app) => {
  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'dev-only-secret',
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
})
