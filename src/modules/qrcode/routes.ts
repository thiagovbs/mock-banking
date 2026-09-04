import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import {
  cancelPaymentRequest,
  createPaymentRequest,
  getPaymentRequest,
  parsePaymentRequestAmount,
  settlePaymentRequest,
} from './service.js'

const idParamSchema = z.object({ id: z.string().uuid() })

const createQrCodeSchema = z.object({
  pixKey: z.object({
    type: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']),
    value: z.string().trim().min(1).max(255),
  }),
  amount: z.union([z.string(), z.number()]),
  description: z.string().trim().max(200).optional(),
  expiresMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
})

const qrCodeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/me/qrcodes', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const input = createQrCodeSchema.parse(request.body)
    const amount = parsePaymentRequestAmount(input.amount)

    const result = await createPaymentRequest({
      prisma: app.prisma,
      userId: user.sub,
      pixKey: input.pixKey,
      amount,
      description: input.description,
      expiresMinutes: input.expiresMinutes,
    })

    return reply.code(201).send(result)
  })

  app.get('/v1/me/qrcodes/:id', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { id } = idParamSchema.parse(request.params)
    return getPaymentRequest(app.prisma, user.sub, id)
  })

  app.delete('/v1/me/qrcodes/:id', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { id } = idParamSchema.parse(request.params)
    return cancelPaymentRequest(app.prisma, user.sub, id)
  })

  app.post('/v1/qrcodes/:id/pay', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const { id } = idParamSchema.parse(request.params)

    const result = await settlePaymentRequest({
      prisma: app.prisma,
      payerUserId: user.sub,
      paymentRequestId: id,
    })

    return reply.code(200).send(result)
  })
}

export default qrCodeRoutes
