import { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../shared/errors.js'
import { parseMoney } from '../../shared/money.js'
import {
  accountHolderConfirmed,
  authoriseJsConsent,
  confirmEnrollment,
  createEnrollment,
  createJsConsent,
  getEnrollment,
  getJsPaymentStatus,
  initiateJsPayment,
  registerFidoCredential,
} from './service.js'

const enrollmentParams = z.object({ enrollmentId: z.string().uuid() })
const consentParams = z.object({ consentId: z.string().uuid() })
const paymentParams = z.object({ paymentId: z.string().min(1) })

const accountHolderSchema = z.object({
  data: z.object({
    debtorAccount: z.object({
      number: z.string().min(1),
      accountType: z.string().optional(),
      ibgeTownCode: z.string().optional(),
    }),
    fidoUser: z.object({ name: z.string().min(1), displayName: z.string().optional() }).optional(),
  }),
})

const confirmEnrollmentSchema = z.object({
  authorizationCode: z.string().min(1),
  requestId: z.string().min(1),
})

const fidoRegistrationSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().optional(),
  response: z.any().optional(),
})

const jsConsentSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(200).optional(),
  creditor: z.object({
    cpfCnpj: z.string().min(1),
    name: z.string().min(1),
  }),
  payment: z.object({
    amount: z.union([z.string(), z.number()]).optional(),
    details: z.object({
      proxy: z.string().min(1),
      localInstrument: z.string().optional(),
      creditorAccount: z.object({
        number: z.string().optional(),
        accountType: z.string().optional(),
      }).optional(),
    }),
  }),
  debtorAccount: z.object({ number: z.string().min(1) }).optional(),
  platform: z.string().optional(),
})

const authoriseSchema = z.object({
  credentialId: z.string().min(1),
  challenge: z.string().optional(),
})

const initiatePaymentSchema = z.object({
  consentId: z.string().uuid(),
  authorisationFlow: z.string().optional(),
  endToEndIds: z.array(z.string()).optional(),
})

const jsrRoutes: FastifyPluginAsync = async (app) => {
  // -------- ITP: Enrollment de dispositivo --------

  app.post('/open-banking/itp/v2/enrollments', { preHandler: app.requireInitiator }, async (request, reply) => {
    const redirectUri =
      (request.body as { redirect_uri?: string } | undefined)?.redirect_uri ||
      `${request.protocol}://${request.hostname}/callback`
    const result = await createEnrollment(app.prisma, redirectUri)
    return reply
      .header('x-itp-enrollment-id', result.enrollmentId)
      .header('location', result.redirectUri)
      .code(201)
      .send({
        enrollmentId: result.enrollmentId,
        redirect_uri: result.redirectUri,
        request_id: result.requestId,
        fidoRegistrationOptions: result.fidoRegistrationOptions,
      })
  })

  app.get('/open-banking/itp/v2/enrollments/:enrollmentId', { preHandler: app.requireInitiator }, async (request) => {
    const { enrollmentId } = enrollmentParams.parse(request.params)
    return getEnrollment(app.prisma, enrollmentId)
  })

  app.patch(
    '/open-banking/enrollment-supports/v2/enrollment-supports/:enrollmentId/account-holder-confirmed',
    { preHandler: app.requireInitiator },
    async (request, reply) => {
      const { enrollmentId } = enrollmentParams.parse(request.params)
      const input = accountHolderSchema.parse(request.body)
      const userName = input.data.fidoUser?.name ?? 'Cooperado'

      // O titular é resolvido pelo username do fidoUser (simplificado). Em uma
      // implementação real, o usuário seria autenticado aqui.
      const user = await app.prisma.user.findFirst({
        where: { username: userName.toLowerCase() },
        include: { customer: true },
      })
      if (!user?.customer) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }

      const { location } = await accountHolderConfirmed(app.prisma, enrollmentId, {
        userId: user.id,
        debtorAccountNumber: input.data.debtorAccount.number,
      })
      return reply.header('location', location).code(200).send({})
    },
  )

  app.post('/open-banking/itp/v2/enrollments/confirmations', { preHandler: app.requireInitiator }, async (request) => {
    const input = confirmEnrollmentSchema.parse(request.body)
    return confirmEnrollment(app.prisma, input.authorizationCode, input.requestId)
  })

  app.post('/open-banking/itp/v2/enrollments/:enrollmentId/fido-registration', { preHandler: app.requireInitiator }, async (request) => {
    const { enrollmentId } = enrollmentParams.parse(request.params)
    const input = fidoRegistrationSchema.parse(request.body)
    const secret = process.env.INITIATOR_SERVICE_SECRET ?? ''
    await registerFidoCredential(app.prisma, secret, enrollmentId, input)
    return { registered: true }
  })

  // -------- PISP: Pagamento JSR --------

  app.post('/open-banking/pisp/payments/v5/jsr/consents', { preHandler: app.requireInitiator }, async (request, reply) => {
    const input = jsConsentSchema.parse(request.body)
    const amount = parseMoney(input.payment.amount ?? input.amount)
    const account = await app.prisma.account.findFirst({
      where: { id: input.accountId },
      include: { customer: true },
    })
    if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    const proxy = input.payment.details.proxy
    const keyType = inferPixKeyType(proxy)

    const { consentId, fidoChallenge } = await createJsConsent(app.prisma, {
      accountId: input.accountId,
      userId: account.customer.userId,
      customerId: account.customer.id,
      amount,
      creditorName: input.creditor.name,
      creditorDocument: input.creditor.cpfCnpj,
      creditorKey: { type: keyType, value: proxy },
      description: input.description,
    })

    return reply
      .header('x-pisp-consent-id', consentId)
      .code(201)
      .send({ consentId, fidoChallenge })
  })

  app.post('/open-banking/itp/v2/consents/:consentId/authorise', { preHandler: app.requireInitiator }, async (request) => {
    const { consentId } = consentParams.parse(request.params)
    const input = authoriseSchema.parse(request.body)
    await authoriseJsConsent(app.prisma, consentId, input)
    return { status: 'AUTHORISED' }
  })

  app.post('/open-banking/pisp/payments/v5/jsr/pix/payments', { preHandler: app.requireInitiator }, async (request, reply) => {
    const input = initiatePaymentSchema.parse(request.body)
    const consent = await app.prisma.paymentConsent.findUnique({ where: { id: input.consentId } })
    if (!consent) throw new AppError(404, 'Consent not found', 'CONSENT_NOT_FOUND')

    const result = await initiateJsPayment(app.prisma, consent.userId, input.consentId)
    return reply.code(201).send({ paymentId: result.paymentId })
  })

  app.get('/open-banking/pisp/payments/v5/jsr/pix/payments/:paymentId', { preHandler: app.requireInitiator }, async (request) => {
    const { paymentId } = paymentParams.parse(request.params)
    return getJsPaymentStatus(app.prisma, paymentId)
  })
}

function inferPixKeyType(value: string): 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP' {
  const cleaned = value.replace(/\D/g, '')
  if (cleaned.length === 11) return 'CPF'
  if (cleaned.length === 14) return 'CNPJ'
  if (value.includes('@')) return 'EMAIL'
  if (/^\+?\d{10,15}$/.test(value)) return 'PHONE'
  return 'EVP'
}

export default jsrRoutes
