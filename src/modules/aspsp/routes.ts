import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'
import { publicBaseUrl } from '../../shared/public-url.js'
import {
  authorisePaymentConsent,
  createPaymentConsent,
  getPaymentConsent,
  rejectPaymentConsent,
  submitPayment,
  type Granter,
  type PaymentConsentView,
} from './service.js'
import { isWebhookUriAllowed, listConsentEvents } from '../payments/events.js'
import {
  paymentLoginStepHtml,
  paymentResultStepHtml,
  paymentReviewStepHtml,
  type PaymentConsentPageView,
} from './consent-page.js'

/** Token curto emitido na tela de login, entre identificacao e confirmacao. */
const CONSENT_SESSION_TTL = '10m'

const consentParams = z.object({ consentId: z.uuid() })

const createConsentSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(200).optional(),
  creditorName: z.string().trim().min(1).max(191),
  creditorDocument: z.string().trim().min(1).max(191).optional(),
  creditorKey: z.object({
    type: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']),
    value: z.string().trim().min(1).max(255),
  }),
  // CPF do pagador. Informado, so ele consegue autorizar; ausente, quem se
  // autenticar na tela e o pagador (e paga da propria conta).
  debtorDocument: z.string().trim().min(1).max(191).optional(),
  redirect_uri: z.url().max(500).optional(),
  // Para onde avisar a cada mudanca de status. E o que fecha a jornada quando o
  // titular aprova e fecha o navegador antes de voltar.
  webhook_uri: z.url().max(500).optional(),
  externalConsentId: z.string().trim().min(1).max(255).optional(),
})

const submitPaymentSchema = z.object({
  consentId: z.uuid(),
})

const authoriseSchema = z.object({
  accountId: z.uuid(),
})

const loginFormSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const confirmFormSchema = z.object({
  token: z.string().min(1),
  accountId: z.string().trim().min(1).optional(),
})

const rejectFormSchema = z.object({
  token: z.string().min(1),
})

/**
 * O JWT carrega apenas sub/customerId/username, mas a aprovacao precisa do
 * documento do titular (o consentimento pode nascer enderecado a um CPF). Ele
 * vem do Customer.
 */
async function loadGranter(app: any, user: JwtUser): Promise<Granter> {
  const customer = await app.prisma.customer.findUnique({ where: { id: user.customerId } })
  if (!customer) throw new AppError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND')
  return { userId: user.sub, customerId: customer.id, document: customer.document }
}

function toPageView(consent: PaymentConsentView, baseUrl: string): PaymentConsentPageView {
  return {
    id: consent.consentId,
    baseUrl,
    amount: consent.amount,
    creditorName: consent.creditorName,
    creditorDocument: consent.creditorDocument,
    creditorKey: consent.creditorKey.value,
    description: consent.description,
    redirectUri: null,
  }
}

/**
 * Monta a volta para a Iniciadora carregando o desfecho, no mesmo formato do
 * compartilhamento de dados: ela nao precisa adivinhar se o titular aprovou.
 */
function consentCallbackUrl(
  redirectUri: string | null,
  consentId: string,
  status: 'AUTHORISED' | 'REJECTED',
): string | null {
  if (!redirectUri) return null
  const separator = redirectUri.includes('?') ? '&' : '?'
  return `${redirectUri}${separator}${new URLSearchParams({ consentId, status }).toString()}`
}

/** Valida o token curto emitido na tela de login. */
function verifyConsentSession(app: any, token: string): JwtUser {
  try {
    return app.jwt.verify(token) as JwtUser
  } catch {
    throw new AppError(401, 'Consent session expired, start again', 'CONSENT_SESSION_EXPIRED')
  }
}

const aspspRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Carrega o consentimento para a tela, junto do redirectUri cru (que a view
   * nao carrega, para nao vazar em HTML).
   */
  async function loadForPage(consentId: string, request: FastifyRequest) {
    const consent = await getPaymentConsent(app.prisma, consentId)
    const raw = await app.prisma.paymentConsent.findUnique({ where: { id: consentId } })
    return {
      view: toPageView(consent, publicBaseUrl(request)),
      consent,
      redirectUri: (raw?.redirectUri ?? null) as string | null,
    }
  }

  async function activeAccountsOf(userId: string) {
    const accounts = await app.prisma.account.findMany({
      where: { status: 'ACTIVE', customer: { is: { userId } } },
      orderBy: { createdAt: 'asc' },
    })
    return accounts.map((account: any) => ({
      id: account.id,
      branch: account.branch,
      accountNumber: account.accountNumber,
      balance: moneyToString(account.balance),
    }))
  }

  // ---------------------------------------------------------------------
  // Chamadas da Iniciadora (autenticada por x-initiator-key).
  // ---------------------------------------------------------------------

  app.post(
    '/v1/aspsp/payments/consents',
    { preHandler: app.requireInitiator },
    async (request: FastifyRequest, reply) => {
      const input = createConsentSchema.parse(request.body)

      // A Iniciadora esta autenticada, mas a URL de aviso ainda vem do corpo:
      // recusar fora da allow-list evita apontar o core para um endereco
      // interno. Falha alto, para ela nao acreditar que sera avisada.
      if (input.webhook_uri && !isWebhookUriAllowed(input.webhook_uri)) {
        throw new AppError(
          400,
          'webhook_uri is not in the allow-list (WEBHOOK_ALLOWED_ORIGINS)',
          'WEBHOOK_URI_NOT_ALLOWED',
        )
      }

      const consent = await createPaymentConsent({
        prisma: app.prisma,
        input: {
          amount: parseMoney(input.amount),
          description: input.description,
          creditorName: input.creditorName,
          creditorDocument: input.creditorDocument,
          creditorKey: input.creditorKey,
          debtorDocument: input.debtorDocument,
          redirectUri: input.redirect_uri,
          webhookUri: input.webhook_uri,
          externalConsentId: input.externalConsentId,
        },
      })

      // A Iniciadora abre esta URL no navegador do titular. E o unico caminho
      // que tira o consentimento de AWAITING_AUTHORISATION nesta jornada.
      const authorisationUrl = `${publicBaseUrl(request)}/v1/aspsp/payments/consents/${consent.consentId}/authorise`

      return reply
        .header('x-pisp-consent-id', consent.consentId)
        .code(201)
        .send({ ...consent, authorisationUrl, links: { redirect: authorisationUrl } })
    },
  )

  app.get(
    '/v1/aspsp/payments/consents/:consentId',
    { preHandler: app.requireInitiator },
    async (request) => {
      const { consentId } = consentParams.parse(request.params)
      return getPaymentConsent(app.prisma, consentId)
    },
  )

  /**
   * A trilha do consentimento: o que foi tentado, por quem, e o que passou.
   * O consentimento diz onde ele esta; isto diz como chegou la.
   */
  app.get(
    '/v1/aspsp/payments/consents/:consentId/events',
    { preHandler: app.requireInitiator },
    async (request) => {
      const { consentId } = consentParams.parse(request.params)
      // Confere a existencia primeiro, para um id desconhecido responder 404 em
      // vez de uma lista vazia.
      await getPaymentConsent(app.prisma, consentId)
      return { consentId, events: await listConsentEvents(app.prisma, consentId) }
    },
  )

  app.post(
    '/v1/aspsp/payments',
    { preHandler: app.requireInitiator },
    async (request, reply) => {
      const input = submitPaymentSchema.parse(request.body)
      // settlePaymentConsent so aceita AUTHORISED/PAYMENT_SUBMITTED: um
      // consentimento ainda pendente, ou recusado, para aqui com 409.
      const result = await submitPayment({ prisma: app.prisma, consentId: input.consentId })
      return reply.code(result.idempotentReplay ? 200 : 201).send(result)
    },
  )

  // Compatibilidade: a consulta por paymentId/consentId que a Iniciadora ja
  // fazia continua no mesmo endereco.
  app.get(
    '/v1/aspsp/payments/:consentId',
    { preHandler: app.requireInitiator },
    async (request) => {
      const { consentId } = consentParams.parse(request.params)
      return getPaymentConsent(app.prisma, consentId)
    },
  )

  // ---------------------------------------------------------------------
  // Aprovacao pelo titular — modo tela (a Iniciadora abre o navegador).
  // ---------------------------------------------------------------------

  app.get('/v1/aspsp/payments/consents/:consentId/authorise', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const { view } = await loadForPage(consentId, request)
    return reply.type('text/html').send(paymentLoginStepHtml(view))
  })

  app.post('/v1/aspsp/payments/consents/:consentId/authorise/login', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const input = loginFormSchema.parse(request.body)
    const { view } = await loadForPage(consentId, request)

    const user = await app.prisma.user.findUnique({
      where: { username: input.username },
      include: { customer: true },
    })

    if (!user?.customer || !(await bcrypt.compare(input.password, user.passwordHash))) {
      return reply
        .type('text/html')
        .send(paymentLoginStepHtml(view, 'Usuário ou senha inválidos.'))
    }

    const token = app.jwt.sign(
      { sub: user.id, customerId: user.customer.id, username: user.username },
      { expiresIn: CONSENT_SESSION_TTL },
    )

    return reply
      .type('text/html')
      .send(paymentReviewStepHtml(view, await activeAccountsOf(user.id), token))
  })

  app.post('/v1/aspsp/payments/consents/:consentId/authorise/confirm', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const input = confirmFormSchema.parse(request.body)
    const { view, redirectUri } = await loadForPage(consentId, request)

    const session = verifyConsentSession(app, input.token)
    const granter = await loadGranter(app, session)

    if (!input.accountId) {
      return reply
        .type('text/html')
        .send(
          paymentReviewStepHtml(
            view,
            await activeAccountsOf(granter.userId),
            input.token,
            'Escolha a conta de onde o valor vai sair.',
          ),
        )
    }

    await authorisePaymentConsent({
      prisma: app.prisma,
      consentId,
      granter,
      accountId: input.accountId,
    })

    const back = consentCallbackUrl(redirectUri, consentId, 'AUTHORISED')
    if (back) return reply.redirect(back)

    return reply.type('text/html').send(paymentResultStepHtml(view, true))
  })

  app.post('/v1/aspsp/payments/consents/:consentId/authorise/reject', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const input = rejectFormSchema.parse(request.body)
    const { view, redirectUri } = await loadForPage(consentId, request)

    const session = verifyConsentSession(app, input.token)
    const granter = await loadGranter(app, session)

    await rejectPaymentConsent({ prisma: app.prisma, consentId, granter })

    const back = consentCallbackUrl(redirectUri, consentId, 'REJECTED')
    if (back) return reply.redirect(back)

    return reply.type('text/html').send(paymentResultStepHtml(view, false))
  })

  // ---------------------------------------------------------------------
  // Aprovacao pelo titular — modo texto (chatbot ja logado), espelhando o
  // compartilhamento de dados. Mesmo servico, sem passar pelo HTML.
  // ---------------------------------------------------------------------

  app.get(
    '/v1/me/payment-consents/:consentId',
    { preHandler: app.authenticate },
    async (request) => {
      const user = request.user as JwtUser
      const { consentId } = consentParams.parse(request.params)
      const granter = await loadGranter(app, user)
      const consent = await getPaymentConsent(app.prisma, consentId)

      return {
        ...consent,
        accounts: await activeAccountsOf(granter.userId),
        events: await listConsentEvents(app.prisma, consentId),
      }
    },
  )

  app.post(
    '/v1/me/payment-consents/:consentId/authorise',
    { preHandler: app.authenticate },
    async (request) => {
      const user = request.user as JwtUser
      const { consentId } = consentParams.parse(request.params)
      const input = authoriseSchema.parse(request.body)
      const granter = await loadGranter(app, user)

      return authorisePaymentConsent({
        prisma: app.prisma,
        consentId,
        granter,
        accountId: input.accountId,
      })
    },
  )

  app.post(
    '/v1/me/payment-consents/:consentId/reject',
    { preHandler: app.authenticate },
    async (request) => {
      const user = request.user as JwtUser
      const { consentId } = consentParams.parse(request.params)
      const granter = await loadGranter(app, user)

      return rejectPaymentConsent({ prisma: app.prisma, consentId, granter })
    },
  )
}

export default aspspRoutes
