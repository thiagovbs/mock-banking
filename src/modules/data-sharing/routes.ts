import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import {
  authoriseDataSharingConsent,
  createDataSharingConsent,
  getDataSharingConsent,
  listDataSharingConsents,
  logConsentAccess,
  parseConsentId,
  rejectDataSharingConsent,
  requireActiveConsent,
  toConsentUrn,
  type ConsentView,
} from './service.js'
import { accountsStepHtml, loginStepHtml, resultStepHtml } from './consent-page.js'

/** Identificacao da "instituicao" nesta demo, usada nos payloads OFB. */
const BRAND_NAME = 'Sensedia Bank'
const COMPANY_CNPJ = '00000000000191'
const COMPE_CODE = '001'

/** Token curto emitido para a tela de consentimento, entre login e confirmacao. */
const CONSENT_SESSION_TTL = '10m'

const consentParams = z.object({ consentId: z.string().min(1) })
const accountParams = z.object({ consentId: z.string().min(1).optional(), accountId: z.uuid() })

const createConsentSchema = z.object({
  data: z.object({
    loggedUser: z.object({
      document: z.object({
        identification: z.string().trim().min(1).max(191),
        rel: z.string().optional(),
      }),
    }),
    permissions: z.array(z.string().trim().min(1)).min(1),
    // Ausente ou null = prazo indeterminado.
    expirationDateTime: z.string().trim().min(1).nullish(),
  }),
})

const authoriseSchema = z.object({
  accountIds: z.array(z.uuid()).min(1),
})

const loginFormSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const confirmFormSchema = z.object({
  token: z.string().min(1),
  // Um unico checkbox marcado chega como string; varios, como array.
  accountIds: z.union([z.string(), z.array(z.string())]).optional(),
})

function selfLink(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}${request.url}`
}

function requestMeta(totalRecords?: number) {
  const meta: Record<string, unknown> = { requestDateTime: new Date().toISOString() }
  if (totalRecords !== undefined) {
    meta.totalRecords = totalRecords
    meta.totalPages = totalRecords === 0 ? 0 : 1
  }
  return meta
}

/** Envelope padrao OFB: data + links + meta. */
function envelope(request: FastifyRequest, data: unknown, totalRecords?: number) {
  return { data, links: { self: selfLink(request) }, meta: requestMeta(totalRecords) }
}

function consentPayload(consent: ConsentView) {
  return {
    consentId: consent.consentId,
    creationDateTime: consent.creationDateTime,
    status: consent.status,
    statusUpdateDateTime: consent.statusUpdateDateTime,
    permissions: consent.permissions,
    expirationDateTime: consent.expirationDateTime,
    loggedUser: { document: { identification: consent.loggedUserDocument, rel: 'CPF' } },
    ...(consent.rejectedBy
      ? { rejection: { rejectedBy: consent.rejectedBy, reason: { code: consent.rejectReason } } }
      : {}),
  }
}

/**
 * O JWT carrega apenas sub/customerId/username, mas a jornada precisa do
 * documento do titular (o consentimento nasce enderecado a um CPF) e do nome da
 * receptora (exibido na tela). Ambos vem do Customer.
 */
async function loadActor(app: any, user: JwtUser) {
  const customer = await app.prisma.customer.findUnique({ where: { id: user.customerId } })
  if (!customer) throw new AppError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND')
  return {
    userId: user.sub,
    customerId: customer.id,
    document: customer.document,
    name: customer.name,
  }
}

async function loadConsentForPage(app: any, consentId: string) {
  const consent = await app.prisma.dataSharingConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Data sharing consent not found', 'CONSENT_NOT_FOUND')

  const grantee = await app.prisma.customer.findUnique({
    where: { id: consent.granteeCustomerId },
  })

  const permissions = Array.isArray(consent.permissions)
    ? (consent.permissions as string[])
    : JSON.parse(String(consent.permissions ?? '[]'))

  return {
    raw: consent,
    page: {
      id: consent.id,
      granteeName: grantee?.name ?? 'Instituição receptora',
      permissions,
      expiresAt: consent.expiresAt ? new Date(consent.expiresAt) : null,
    },
  }
}

const dataSharingRoutes: FastifyPluginAsync = async (app) => {
  // ---------------------------------------------------------------------
  // Consents v3 — chamado pela receptora (a conta que quer ver os dados).
  // ---------------------------------------------------------------------

  app.post('/open-banking/consents/v3/consents', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const input = createConsentSchema.parse(request.body)

    const consent = await createDataSharingConsent({
      prisma: app.prisma,
      grantee: { userId: user.sub, customerId: user.customerId },
      input: {
        loggedUserDocument: input.data.loggedUser.document.identification,
        permissions: input.data.permissions,
        expirationDateTime: input.data.expirationDateTime,
      },
    })

    // `links.redirect` nao faz parte do OFB (la o redirect vem do fluxo OIDC);
    // e a extensao que permite ao chatbot abrir a tela de autorizacao.
    const consentUuid = parseConsentId(consent.consentId)
    const authorisationUrl = `${request.protocol}://${request.host}/v1/data-sharing/consents/${consentUuid}/authorise`

    return reply.code(201).send({
      data: consentPayload(consent),
      links: { self: selfLink(request), redirect: authorisationUrl },
      meta: requestMeta(),
    })
  })

  app.get('/open-banking/consents/v3/consents/:consentId', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { consentId } = consentParams.parse(request.params)

    const consent = await getDataSharingConsent({
      prisma: app.prisma,
      consentId: parseConsentId(consentId),
      requester: { userId: user.sub, customerId: user.customerId },
    })

    return envelope(request, consentPayload(consent))
  })

  // No OFB a revogacao e um DELETE que responde 204.
  app.delete('/open-banking/consents/v3/consents/:consentId', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const { consentId } = consentParams.parse(request.params)

    await rejectDataSharingConsent({
      prisma: app.prisma,
      consentId: parseConsentId(consentId),
      requester: { userId: user.sub, customerId: user.customerId },
    })

    return reply.code(204).send()
  })

  // ---------------------------------------------------------------------
  // Autorizacao pelo titular — modo texto (chatbot ja logado).
  // ---------------------------------------------------------------------

  app.post('/v1/data-sharing/consents/:consentId/authorise', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { consentId } = consentParams.parse(request.params)
    const input = authoriseSchema.parse(request.body)
    const granter = await loadActor(app, user)

    const consent = await authoriseDataSharingConsent({
      prisma: app.prisma,
      consentId: parseConsentId(consentId),
      granter,
      accountIds: input.accountIds,
    })

    return consentPayload(consent)
  })

  /**
   * Contas que o titular pode oferecer neste consentimento. Serve ao chatbot
   * para perguntar "quais dessas voce quer compartilhar?" antes de autorizar.
   */
  app.get('/v1/data-sharing/consents/:consentId/accounts', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { consentId } = consentParams.parse(request.params)
    const granter = await loadActor(app, user)
    const { page } = await loadConsentForPage(app, parseConsentId(consentId))

    const accounts = await app.prisma.account.findMany({
      where: { customer: { is: { userId: granter.userId } } },
      orderBy: { createdAt: 'desc' },
    })

    return {
      consentId: toConsentUrn(page.id),
      granteeName: page.granteeName,
      permissions: page.permissions,
      expirationDateTime: page.expiresAt ? page.expiresAt.toISOString() : null,
      accounts: accounts.map((account: any) => ({
        id: account.id,
        branch: account.branch,
        accountNumber: account.accountNumber,
        balance: moneyToString(account.balance),
        status: account.status,
      })),
    }
  })

  // ---------------------------------------------------------------------
  // Autorizacao pelo titular — modo tela (chatbot abre o navegador).
  // ---------------------------------------------------------------------

  app.get('/v1/data-sharing/consents/:consentId/authorise', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const { page } = await loadConsentForPage(app, parseConsentId(consentId))
    return reply.type('text/html').send(loginStepHtml(page))
  })

  app.post('/v1/data-sharing/consents/:consentId/authorise/login', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const input = loginFormSchema.parse(request.body)
    const { page } = await loadConsentForPage(app, parseConsentId(consentId))

    const user = await app.prisma.user.findUnique({
      where: { username: input.username },
      include: { customer: true },
    })

    if (!user?.customer || !(await bcrypt.compare(input.password, user.passwordHash))) {
      return reply.type('text/html').send(loginStepHtml(page, 'Usuário ou senha inválidos.'))
    }

    const token = app.jwt.sign(
      { sub: user.id, customerId: user.customer.id, username: user.username },
      { expiresIn: CONSENT_SESSION_TTL },
    )

    const accounts = await app.prisma.account.findMany({
      where: { customerId: user.customer.id },
      orderBy: { createdAt: 'desc' },
    })

    return reply.type('text/html').send(
      accountsStepHtml(
        page,
        accounts.map((account: any) => ({
          id: account.id,
          branch: account.branch,
          accountNumber: account.accountNumber,
          balance: moneyToString(account.balance),
        })),
        token,
      ),
    )
  })

  app.post('/v1/data-sharing/consents/:consentId/authorise/confirm', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const input = confirmFormSchema.parse(request.body)
    const { page } = await loadConsentForPage(app, parseConsentId(consentId))

    const session = verifyConsentSession(app, input.token)
    const granter = await loadActor(app, session)

    const accountIds = normalizeAccountIds(input.accountIds)
    if (accountIds.length === 0) {
      const accounts = await app.prisma.account.findMany({
        where: { customerId: granter.customerId },
        orderBy: { createdAt: 'desc' },
      })
      return reply.type('text/html').send(
        accountsStepHtml(
          page,
          accounts.map((account: any) => ({
            id: account.id,
            branch: account.branch,
            accountNumber: account.accountNumber,
            balance: moneyToString(account.balance),
          })),
          input.token,
          'Selecione ao menos uma conta para compartilhar.',
        ),
      )
    }

    await authoriseDataSharingConsent({
      prisma: app.prisma,
      consentId: page.id,
      granter,
      accountIds,
    })

    return reply.type('text/html').send(resultStepHtml(page.granteeName, true))
  })

  app.post('/v1/data-sharing/consents/:consentId/authorise/reject', async (request, reply) => {
    const { consentId } = consentParams.parse(request.params)
    const input = confirmFormSchema.parse(request.body)
    const { page } = await loadConsentForPage(app, parseConsentId(consentId))

    const session = verifyConsentSession(app, input.token)
    const granter = await loadActor(app, session)

    // Recusa antes de autorizar: o consentimento ainda nao tem granterUserId,
    // entao o vinculo e feito aqui para que a recusa fique atribuida a ele.
    await app.prisma.dataSharingConsent.updateMany({
      where: { id: page.id, granterUserId: null, granterDocument: granter.document.replace(/\D/g, '') },
      data: { granterUserId: granter.userId, granterCustomerId: granter.customerId },
    })

    await rejectDataSharingConsent({
      prisma: app.prisma,
      consentId: page.id,
      requester: { userId: granter.userId, customerId: granter.customerId },
    })

    return reply.type('text/html').send(resultStepHtml(page.granteeName, false))
  })

  // ---------------------------------------------------------------------
  // Gestao pelo usuario: o que concedi e o que recebi.
  // ---------------------------------------------------------------------

  app.get('/v1/me/data-sharing/consents', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const actor = await loadActor(app, user)
    const consents = await listDataSharingConsents({ prisma: app.prisma, user: actor })

    return {
      granted: consents.granted.map(consentPayload),
      received: consents.received.map(consentPayload),
    }
  })

  app.delete('/v1/me/data-sharing/consents/:consentId', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const { consentId } = consentParams.parse(request.params)

    await rejectDataSharingConsent({
      prisma: app.prisma,
      consentId: parseConsentId(consentId),
      requester: { userId: user.sub, customerId: user.customerId },
    })

    return reply.code(204).send()
  })

  // ---------------------------------------------------------------------
  // Accounts v2 — leitura feita pela receptora sob um consentimento.
  // O consentId vai no header x-consent-id (no OFB ele viaja no escopo do
  // token); o JWT continua identificando a receptora.
  // ---------------------------------------------------------------------

  function consentIdFromHeader(request: FastifyRequest): string {
    const header = request.headers['x-consent-id']
    if (typeof header !== 'string' || !header.trim()) {
      throw new AppError(400, 'Missing x-consent-id header', 'CONSENT_ID_REQUIRED')
    }
    return parseConsentId(header)
  }

  app.get('/open-banking/accounts/v2/accounts', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const consent = await requireActiveConsent({
      prisma: app.prisma,
      consentId: consentIdFromHeader(request),
      grantee: { customerId: user.customerId },
      permission: 'ACCOUNTS_READ',
    })

    const accounts = await app.prisma.account.findMany({
      where: { id: { in: consent.accountIds } },
      orderBy: { createdAt: 'desc' },
    })

    await logConsentAccess(app.prisma, consent.id, 'ACCOUNTS')

    const data = accounts.map((account: any) => ({
      accountId: account.id,
      brandName: BRAND_NAME,
      companyCnpj: COMPANY_CNPJ,
      type: 'CONTA_DEPOSITO_A_VISTA',
      compeCode: COMPE_CODE,
      branchCode: account.branch,
      number: account.accountNumber,
      checkDigit: '0',
    }))

    return envelope(request, data, data.length)
  })

  app.get('/open-banking/accounts/v2/accounts/:accountId', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { accountId } = accountParams.parse(request.params)

    const consent = await requireActiveConsent({
      prisma: app.prisma,
      consentId: consentIdFromHeader(request),
      grantee: { customerId: user.customerId },
      permission: 'ACCOUNTS_READ',
      accountId,
    })

    const account = await app.prisma.account.findUnique({ where: { id: accountId } })
    if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    await logConsentAccess(app.prisma, consent.id, 'ACCOUNT', accountId)

    return envelope(request, {
      compeCode: COMPE_CODE,
      branchCode: account.branch,
      number: account.accountNumber,
      checkDigit: '0',
      type: 'CONTA_DEPOSITO_A_VISTA',
      subtype: 'INDIVIDUAL',
      currency: 'BRL',
    })
  })

  app.get('/open-banking/accounts/v2/accounts/:accountId/balances', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { accountId } = accountParams.parse(request.params)

    const consent = await requireActiveConsent({
      prisma: app.prisma,
      consentId: consentIdFromHeader(request),
      grantee: { customerId: user.customerId },
      permission: 'ACCOUNTS_BALANCES_READ',
      accountId,
    })

    const account = await app.prisma.account.findUnique({ where: { id: accountId } })
    if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    await logConsentAccess(app.prisma, consent.id, 'BALANCES', accountId)

    return envelope(request, {
      availableAmount: { amount: moneyToString(account.balance), currency: 'BRL' },
      blockedAmount: { amount: '0.00', currency: 'BRL' },
      automaticallyInvestedAmount: { amount: '0.00', currency: 'BRL' },
      updateDateTime: new Date().toISOString(),
    })
  })

  app.get('/open-banking/accounts/v2/accounts/:accountId/transactions', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { accountId } = accountParams.parse(request.params)

    const consent = await requireActiveConsent({
      prisma: app.prisma,
      consentId: consentIdFromHeader(request),
      grantee: { customerId: user.customerId },
      permission: 'ACCOUNTS_TRANSACTIONS_READ',
      accountId,
    })

    const transactions = await app.prisma.transaction.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    await logConsentAccess(app.prisma, consent.id, 'TRANSACTIONS', accountId)

    const data = transactions.map((tx: any) => ({
      transactionId: tx.id,
      completedAuthorisedPaymentType: 'TRANSACAO_EFETIVADA',
      creditDebitType: tx.type === 'CREDIT' ? 'CREDITO' : 'DEBITO',
      transactionName: tx.description ?? 'Movimentação',
      type: 'OUTROS',
      transactionAmount: { amount: moneyToString(tx.amount), currency: 'BRL' },
      transactionDateTime: tx.createdAt,
    }))

    return envelope(request, data, data.length)
  })
}

/** Valida o token curto emitido na tela de login do consentimento. */
function verifyConsentSession(app: any, token: string): JwtUser {
  try {
    return app.jwt.verify(token) as JwtUser
  } catch {
    throw new AppError(401, 'Consent session expired, start again', 'CONSENT_SESSION_EXPIRED')
  }
}

/**
 * Um checkbox marcado chega como string, varios como array (ver o parser de
 * form-urlencoded em app.ts).
 */
function normalizeAccountIds(value: string | string[] | undefined): string[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((item) => item.trim()).filter(Boolean)
}

export default dataSharingRoutes
