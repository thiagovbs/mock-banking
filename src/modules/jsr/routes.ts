import { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../../shared/errors.js'
import { parseMoney } from '../../shared/money.js'
import { inferPixKeyType } from '../pix/service.js'
import {
  accountHolderConfirmed,
  authoriseJsConsent,
  confirmEnrollment,
  createEnrollment,
  createJsConsent,
  getEnrollment,
  getJsPaymentStatus,
  revokeEnrollment,
  initiateJsPayment,
  listAccountDevices,
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
  enrollmentId: z.string().uuid(),
  // Opcional e apenas conferido contra a conta do enrollment; nao e ele que
  // define qual conta sera debitada.
  accountId: z.string().uuid().optional(),
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
  challenge: z.string().min(1),
  signature: z.string().min(1),
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

  app.get(
    '/open-banking/itp/v2/accounts/:accountNumber/enrollments',
    { preHandler: app.requireInitiator },
    async (request) => {
      const { accountNumber } = z
        .object({ accountNumber: z.string().min(1) })
        .parse(request.params)
      return listAccountDevices(app.prisma, accountNumber)
    },
  )

  app.patch(
    '/open-banking/enrollment-supports/v2/enrollment-supports/:enrollmentId/account-holder-confirmed',
    { preHandler: app.requireInitiator },
    async (request, reply) => {
      const { enrollmentId } = enrollmentParams.parse(request.params)
      const input = accountHolderSchema.parse(request.body)

      // O titular é resolvido pelo número da conta informado em debtorAccount.
      // Assim o enrollment fica vinculado ao usuário dono da conta (User - Customer - Account).
      const account = await app.prisma.account.findFirst({
        where: { accountNumber: input.data.debtorAccount.number },
        include: { customer: true },
      })
      if (!account?.customer) {
        throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')
      }
      const user = await app.prisma.user.findUnique({
        where: { id: account.customer.userId },
        include: { customer: true },
      })
      if (!user) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }

      const { location } = await accountHolderConfirmed(app.prisma, enrollmentId, {
        userId: user.id,
        accountId: account.id,
      })
      return reply.header('location', location).code(200).send({})
    },
  )

  app.delete('/open-banking/itp/v2/enrollments/:enrollmentId', { preHandler: app.requireInitiator }, async (request) => {
    const { enrollmentId } = enrollmentParams.parse(request.params)
    return revokeEnrollment(app.prisma, enrollmentId)
  })

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
    const proxy = input.payment.details.proxy

    // Conta e titular derivam do enrollment, dentro de createJsConsent.
    const { consentId, fidoChallenge, accountId } = await createJsConsent(app.prisma, {
      enrollmentId: input.enrollmentId,
      expectedAccountId: input.accountId,
      amount,
      creditorName: input.creditor.name,
      creditorDocument: input.creditor.cpfCnpj,
      creditorKey: { type: inferPixKeyType(proxy), value: proxy },
      description: input.description,
    })

    return reply
      .header('x-pisp-consent-id', consentId)
      .code(201)
      .send({ consentId, fidoChallenge, accountId })
  })

  app.post('/open-banking/itp/v2/consents/:consentId/authorise', { preHandler: app.requireInitiator }, async (request) => {
    const { consentId } = consentParams.parse(request.params)
    const input = authoriseSchema.parse(request.body)
    const secret = process.env.INITIATOR_SERVICE_SECRET ?? ''
    await authoriseJsConsent(app.prisma, secret, consentId, input)
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

export default jsrRoutes
