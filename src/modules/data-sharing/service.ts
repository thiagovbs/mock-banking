import { PrismaClient } from '@prisma/client'
import { AppError } from '../../shared/errors.js'

/**
 * Jornada de compartilhamento de dados (AISP).
 *
 * Uma conta receptora pede ao titular de outra conta permissao para ler saldo e
 * extrato. O titular autoriza escolhendo quais das suas contas entram no
 * consentimento e por quanto tempo -- com data de expiracao ou por prazo
 * indeterminado (expirationDateTime nulo).
 *
 * Os status seguem o padrao OFB: AWAITING_AUTHORISATION -> AUTHORISED ->
 * REJECTED. Revogacao e expiracao nao sao status proprios; ambas levam a
 * REJECTED com um `rejectReason` distinto, de modo que exista uma unica
 * maquina de estados para auditar.
 */

export const DATA_SHARING_PERMISSIONS = [
  'ACCOUNTS_READ',
  'ACCOUNTS_BALANCES_READ',
  'ACCOUNTS_TRANSACTIONS_READ',
  'RESOURCES_READ',
] as const

export type DataSharingPermission = (typeof DATA_SHARING_PERMISSIONS)[number]

/** Teto regulatorio do OFB para consentimentos com prazo. */
const MAX_EXPIRATION_MONTHS = 12

const CONSENT_URN_PREFIX = 'urn:banking:'

export function toConsentUrn(consentId: string): string {
  return `${CONSENT_URN_PREFIX}${consentId}`
}

/**
 * Aceita tanto o URN (`urn:banking:<uuid>`) quanto o uuid cru. A receptora
 * recebe o URN nas respostas, mas clientes de demo costumam colar o uuid.
 */
export function parseConsentId(value: string): string {
  const raw = value.startsWith(CONSENT_URN_PREFIX)
    ? value.slice(CONSENT_URN_PREFIX.length)
    : value
  const uuid = raw.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new AppError(400, 'Invalid consent id', 'INVALID_CONSENT_ID')
  }
  return uuid
}

export function normalizeDocument(document: string): string {
  return document.replace(/\D/g, '')
}

export function parsePermissions(input: string[]): DataSharingPermission[] {
  const unique = Array.from(new Set(input))
  const invalid = unique.filter(
    (permission) => !DATA_SHARING_PERMISSIONS.includes(permission as DataSharingPermission),
  )
  if (invalid.length > 0) {
    throw new AppError(400, `Unsupported permissions: ${invalid.join(', ')}`, 'INVALID_PERMISSIONS')
  }
  if (unique.length === 0) {
    throw new AppError(400, 'At least one permission is required', 'INVALID_PERMISSIONS')
  }
  return unique as DataSharingPermission[]
}

/**
 * `undefined`/`null` significa prazo indeterminado: o consentimento vale ate o
 * titular revogar.
 */
export function parseExpiration(input?: string | null): Date | null {
  if (input === undefined || input === null || input === '') return null

  const expiresAt = new Date(input)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new AppError(400, 'expirationDateTime is not a valid date', 'INVALID_EXPIRATION')
  }

  const now = new Date()
  if (expiresAt <= now) {
    throw new AppError(400, 'expirationDateTime must be in the future', 'INVALID_EXPIRATION')
  }

  const limit = new Date(now)
  limit.setMonth(limit.getMonth() + MAX_EXPIRATION_MONTHS)
  if (expiresAt > limit) {
    throw new AppError(
      400,
      `expirationDateTime cannot be more than ${MAX_EXPIRATION_MONTHS} months ahead`,
      'INVALID_EXPIRATION',
    )
  }

  return expiresAt
}

function permissionsOf(consent: { permissions: unknown }): DataSharingPermission[] {
  const raw = consent.permissions
  if (Array.isArray(raw)) return raw as DataSharingPermission[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as DataSharingPermission[]) : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * Expiracao e aplicada na leitura: um consentimento AUTHORISED cuja data ja
 * passou vira REJECTED/CONSENT_EXPIRED antes de qualquer resposta. Evita
 * depender de job agendado para que o dado pare de fluir na hora certa.
 */
async function applyExpiry(prisma: PrismaClient, consent: any): Promise<any> {
  if (consent.status !== 'AUTHORISED') return consent
  if (!consent.expiresAt) return consent
  if (new Date(consent.expiresAt) > new Date()) return consent

  const now = new Date()
  return prisma.dataSharingConsent.update({
    where: { id: consent.id },
    data: {
      status: 'REJECTED',
      rejectedBy: 'ASPSP',
      rejectReason: 'CONSENT_EXPIRED',
      rejectedAt: now,
      statusUpdatedAt: now,
    },
    include: { accounts: true },
  })
}

async function findConsent(prisma: PrismaClient, consentId: string): Promise<any> {
  const consent = await prisma.dataSharingConsent.findUnique({
    where: { id: consentId },
    include: { accounts: true },
  })
  if (!consent) {
    throw new AppError(404, 'Data sharing consent not found', 'CONSENT_NOT_FOUND')
  }
  return applyExpiry(prisma, consent)
}

export type ConsentView = {
  consentId: string
  status: string
  permissions: DataSharingPermission[]
  expirationDateTime: string | null
  creationDateTime: Date
  statusUpdateDateTime: Date
  loggedUserDocument: string
  accountIds: string[]
  rejectedBy: string | null
  rejectReason: string | null
}

export function toConsentView(consent: any): ConsentView {
  return {
    consentId: toConsentUrn(consent.id),
    status: consent.status,
    permissions: permissionsOf(consent),
    expirationDateTime: consent.expiresAt ? new Date(consent.expiresAt).toISOString() : null,
    creationDateTime: consent.createdAt,
    statusUpdateDateTime: consent.statusUpdatedAt ?? consent.createdAt,
    loggedUserDocument: consent.granterDocument,
    accountIds: (consent.accounts ?? []).map((link: any) => link.accountId),
    rejectedBy: consent.rejectedBy ?? null,
    rejectReason: consent.rejectReason ?? null,
  }
}

export type CreateConsentParams = {
  prisma: PrismaClient
  grantee: { userId: string; customerId: string }
  input: {
    loggedUserDocument: string
    permissions: string[]
    expirationDateTime?: string | null
    redirectUri?: string
  }
}

export async function createDataSharingConsent(params: CreateConsentParams): Promise<ConsentView> {
  const { prisma, grantee, input } = params

  const permissions = parsePermissions(input.permissions)
  const expiresAt = parseExpiration(input.expirationDateTime)
  const granterDocument = normalizeDocument(input.loggedUserDocument)
  if (!granterDocument) {
    throw new AppError(400, 'loggedUser document is required', 'INVALID_DOCUMENT')
  }

  const granteeCustomer = await prisma.customer.findUnique({ where: { id: grantee.customerId } })
  if (!granteeCustomer) {
    throw new AppError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND')
  }

  // Um titular compartilhando consigo mesmo nao e uma jornada de
  // compartilhamento; seria apenas ler a propria conta pela porta errada.
  if (normalizeDocument(granteeCustomer.document) === granterDocument) {
    throw new AppError(
      422,
      'Data owner and data recipient must be different customers',
      'SELF_SHARING_NOT_ALLOWED',
    )
  }

  const consent = await prisma.dataSharingConsent.create({
    data: {
      granteeUserId: grantee.userId,
      granteeCustomerId: grantee.customerId,
      granterDocument,
      permissions,
      expiresAt,
      redirectUri: input.redirectUri,
      status: 'AWAITING_AUTHORISATION',
      statusUpdatedAt: new Date(),
    },
    include: { accounts: true },
  })

  return toConsentView(consent)
}

export type GetConsentParams = {
  prisma: PrismaClient
  consentId: string
  /** Quem esta lendo: a receptora (granteeCustomerId) ou o titular (userId). */
  requester: { userId: string; customerId: string }
}

export async function getDataSharingConsent(params: GetConsentParams): Promise<ConsentView> {
  const { prisma, consentId, requester } = params
  const consent = await findConsent(prisma, consentId)
  assertParticipant(consent, requester)
  return toConsentView(consent)
}

function assertParticipant(consent: any, requester: { userId: string; customerId: string }): void {
  const isGrantee = consent.granteeCustomerId === requester.customerId
  const isGranter = consent.granterUserId === requester.userId
  if (!isGrantee && !isGranter) {
    throw new AppError(403, 'Consent does not belong to this user', 'CONSENT_FORBIDDEN')
  }
}

export type AuthoriseConsentParams = {
  prisma: PrismaClient
  consentId: string
  granter: { userId: string; customerId: string; document: string }
  accountIds: string[]
}

/**
 * Autoriza o consentimento. Mesmo caminho para os dois modos da jornada: a tela
 * de redirect (o chatbot abre o navegador) e a autorizacao em texto (o chatbot
 * ja tem o token do titular).
 */
export async function authoriseDataSharingConsent(
  params: AuthoriseConsentParams,
): Promise<ConsentView> {
  const { prisma, consentId, granter, accountIds } = params

  const consent = await findConsent(prisma, consentId)

  if (consent.status !== 'AWAITING_AUTHORISATION') {
    throw new AppError(
      409,
      `Consent is not awaiting authorisation (status: ${consent.status})`,
      'CONSENT_NOT_AWAITING_AUTHORISATION',
    )
  }

  // O consentimento nasce enderecado a um documento. Quem autoriza tem que ser
  // o dono daquele documento, senao qualquer usuario logado poderia assumir um
  // pedido feito para outra pessoa.
  if (normalizeDocument(granter.document) !== normalizeDocument(consent.granterDocument)) {
    throw new AppError(
      403,
      'Consent was requested for a different account holder',
      'CONSENT_HOLDER_MISMATCH',
    )
  }

  if (consent.granteeCustomerId === granter.customerId) {
    throw new AppError(
      422,
      'Data owner and data recipient must be different customers',
      'SELF_SHARING_NOT_ALLOWED',
    )
  }

  const uniqueAccountIds = Array.from(new Set(accountIds))
  if (uniqueAccountIds.length === 0) {
    throw new AppError(400, 'At least one account must be shared', 'NO_ACCOUNTS_SELECTED')
  }

  // As contas sao conferidas contra o titular dentro da propria query: uma
  // conta de terceiro simplesmente nao aparece no resultado.
  const accounts = await prisma.account.findMany({
    where: {
      id: { in: uniqueAccountIds },
      customer: { is: { userId: granter.userId } },
    },
  })
  if (accounts.length !== uniqueAccountIds.length) {
    throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')
  }

  const now = new Date()
  const updated = await prisma.$transaction(async (tx: any) => {
    await tx.dataSharingConsentAccount.createMany({
      data: uniqueAccountIds.map((accountId) => ({ consentId: consent.id, accountId })),
      skipDuplicates: true,
    })

    return tx.dataSharingConsent.update({
      where: { id: consent.id },
      data: {
        status: 'AUTHORISED',
        granterUserId: granter.userId,
        granterCustomerId: granter.customerId,
        authorisedAt: now,
        statusUpdatedAt: now,
      },
      include: { accounts: true },
    })
  })

  return toConsentView(updated)
}

export type RejectConsentParams = {
  prisma: PrismaClient
  consentId: string
  requester: { userId: string; customerId: string }
}

/**
 * Serve para recusar (ainda nao autorizado) e para revogar (ja autorizado). O
 * titular pode sempre; a receptora pode desistir do proprio pedido.
 */
export async function rejectDataSharingConsent(params: RejectConsentParams): Promise<ConsentView> {
  const { prisma, consentId, requester } = params
  const consent = await findConsent(prisma, consentId)
  assertParticipant(consent, requester)

  if (consent.status === 'REJECTED') {
    return toConsentView(consent)
  }

  const isGranter = consent.granterUserId === requester.userId
  const wasAuthorised = consent.status === 'AUTHORISED'
  const now = new Date()

  const updated = await prisma.dataSharingConsent.update({
    where: { id: consent.id },
    data: {
      status: 'REJECTED',
      rejectedBy: isGranter ? 'USER' : 'TPP',
      rejectReason: wasAuthorised ? 'CUSTOMER_MANUALLY_REVOKED' : 'CUSTOMER_MANUALLY_REJECTED',
      rejectedAt: now,
      statusUpdatedAt: now,
    },
    include: { accounts: true },
  })

  return toConsentView(updated)
}

export type ListConsentsParams = {
  prisma: PrismaClient
  user: { userId: string; customerId: string; document: string }
}

/**
 * Painel do usuario: o que ele concedeu (como titular) e o que recebeu (como
 * receptora). Pedidos ainda pendentes aparecem pelo documento, porque
 * granterUserId so e preenchido na autorizacao.
 */
export async function listDataSharingConsents(params: ListConsentsParams): Promise<{
  granted: ConsentView[]
  received: ConsentView[]
}> {
  const { prisma, user } = params
  const document = normalizeDocument(user.document)

  const [grantedRaw, receivedRaw] = await Promise.all([
    prisma.dataSharingConsent.findMany({
      where: {
        OR: [{ granterUserId: user.userId }, { granterDocument: document }],
      },
      include: { accounts: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.dataSharingConsent.findMany({
      where: { granteeCustomerId: user.customerId },
      include: { accounts: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ])

  const granted = await Promise.all(grantedRaw.map((consent: any) => applyExpiry(prisma, consent)))
  const received = await Promise.all(receivedRaw.map((consent: any) => applyExpiry(prisma, consent)))

  return {
    granted: granted.map(toConsentView),
    received: received.map(toConsentView),
  }
}

export type ActiveConsentParams = {
  prisma: PrismaClient
  consentId: string
  grantee: { customerId: string }
  permission: DataSharingPermission
  accountId?: string
}

export type ActiveConsent = {
  id: string
  accountIds: string[]
  permissions: DataSharingPermission[]
  expiresAt: Date | null
}

/**
 * Porteiro de toda leitura feita pela receptora. Um consentimento so libera
 * dado se estiver AUTHORISED, dentro da validade, com a permissao pedida e com
 * a conta dentro do escopo que o titular marcou.
 */
export async function requireActiveConsent(params: ActiveConsentParams): Promise<ActiveConsent> {
  const { prisma, consentId, grantee, permission, accountId } = params

  const consent = await findConsent(prisma, consentId)

  if (consent.granteeCustomerId !== grantee.customerId) {
    throw new AppError(403, 'Consent does not belong to this user', 'CONSENT_FORBIDDEN')
  }

  if (consent.status !== 'AUTHORISED') {
    const expired = consent.rejectReason === 'CONSENT_EXPIRED'
    throw new AppError(
      403,
      expired ? 'Consent has expired' : `Consent is not authorised (status: ${consent.status})`,
      expired ? 'CONSENT_EXPIRED' : 'CONSENT_NOT_AUTHORISED',
    )
  }

  const permissions = permissionsOf(consent)
  if (!permissions.includes(permission)) {
    throw new AppError(403, `Consent does not grant ${permission}`, 'CONSENT_PERMISSION_MISSING')
  }

  const accountIds = (consent.accounts ?? []).map((link: any) => link.accountId)
  if (accountId && !accountIds.includes(accountId)) {
    // 404 em vez de 403: uma conta fora do consentimento nao deve nem existir
    // aos olhos da receptora.
    throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')
  }

  return {
    id: consent.id,
    accountIds,
    permissions,
    expiresAt: consent.expiresAt ? new Date(consent.expiresAt) : null,
  }
}

/** Trilha de auditoria. Nunca deve derrubar a leitura que ela registra. */
export async function logConsentAccess(
  prisma: PrismaClient,
  consentId: string,
  resource: string,
  accountId?: string,
): Promise<void> {
  try {
    await prisma.dataSharingAccess.create({
      data: { consentId, accountId: accountId ?? null, resource },
    })
  } catch {
    // auditoria e best-effort
  }
}
