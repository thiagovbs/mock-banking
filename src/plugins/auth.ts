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
