import { FastifyInstance } from 'fastify'

export type TokenPayload = {
  sub: string
  customerId: string
  username: string
}

export function signToken(app: FastifyInstance, payload: TokenPayload): string {
  return app.jwt.sign(payload, { expiresIn: '1h' })
}
