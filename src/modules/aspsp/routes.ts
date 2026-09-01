import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { parseMoney } from '../../shared/money.js'
import {
  createPaymentConsent,
  getPaymentConsent,
  submitPayment,
} from './service.js'

const createConsentSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(200).optional(),
  creditorName: z.string().trim().min(1).max(191),
  creditorDocument: z.string().trim().min(1).max(191).optional(),
  creditorKey: z.object({
    type: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']),
    value: z.string().trim().min(1).max(255),
  }),
  externalConsentId: z.string().trim().min(1).max(255).optional(),
})

const submitPaymentSchema = z.object({
  consentId: z.string().uuid(),
})

const consentParamsSchema = z.object({ consentId: z.string().uuid() })

const aspspRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/aspsp/payments/consents', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const input = createConsentSchema.parse(request.body)
    const amount = parseMoney(input.amount)

    const result = await createPaymentConsent({
      prisma: app.prisma,
      userId: user.sub,
      input: {
        accountId: input.accountId,
        amount,
        description: input.description,
        creditorName: input.creditorName,
        creditorDocument: input.creditorDocument,
        creditorKey: input.creditorKey,
        externalConsentId: input.externalConsentId,
      },
    })

    return reply.code(201).send(result)
  })

  app.post('/v1/aspsp/payments', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const input = submitPaymentSchema.parse(request.body)

    const result = await submitPayment({
      prisma: app.prisma,
      userId: user.sub,
      consentId: input.consentId,
    })

    return reply.code(result.idempotentReplay ? 200 : 201).send(result)
  })

  app.get('/v1/aspsp/payments/:consentId', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { consentId } = consentParamsSchema.parse(request.params)
    return getPaymentConsent(app.prisma, user.sub, consentId)
  })
}

export default aspspRoutes
