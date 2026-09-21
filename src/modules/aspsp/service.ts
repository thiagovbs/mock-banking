import { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import { type PixKeyType } from '../pix/service.js'
import { createPaymentConsentRecord, normalizeDocument } from './../payments/create-consent.js'
import { settlePaymentConsent, type SettleConsentResult } from '../payments/consent.js'
import { recordConsentEvent } from '../payments/events.js'

/**
 * Jornada de pagamento iniciada por terceiro, com redirecionamento (PISP).
 *
 * A Iniciadora cria o consentimento *antes* de saber quem vai pagar: ele nasce
 * AWAITING_AUTHORISATION, sem titular e sem conta. O navegador do titular e
 * entao levado a tela da Detentora, onde ele se identifica, ve valor e credor e
 * escolhe a conta de debito. So essa confirmacao move o consentimento para
 * AUTHORISED -- e `settlePaymentConsent` recusa qualquer outro estado, entao
 * nao ha caminho que pague sem aprovacao.
 *
 * A jornada JSR (sem redirecionamento) vive em `modules/jsr`: la o
 * consentimento nasce CREATED, preso a um dispositivo ja aprovado, e a
 * aprovacao e a assertion FIDO. As duas terminam no mesmo
 * `settlePaymentConsent`.
 */

export type PaymentConsentView = {
  consentId: string
  status: string
  amount: string
  description: string | null
  creditorName: string
  creditorDocument: string | null
  creditorKey: { type: string; value: string }
  debtorDocument: string | null
  accountId: string | null
  paymentId: string | null
  createdAt: Date
  statusUpdatedAt: Date
  authorisedAt: Date | null
  rejectedAt: Date | null
}

export { normalizeDocument }

export type Granter = {
  userId: string
  customerId: string
  document: string
}

export function toConsentView(consent: any): PaymentConsentView {
  return {
    consentId: consent.id,
    status: consent.status,
    amount: moneyToString(consent.amount),
    description: consent.description ?? null,
    creditorName: consent.creditorName,
    creditorDocument: consent.creditorDocument ?? null,
    creditorKey: { type: consent.creditorKeyType, value: consent.creditorKeyValue },
    debtorDocument: consent.debtorDocument ?? null,
    accountId: consent.accountId ?? null,
    paymentId: consent.paymentId ?? null,
    createdAt: consent.createdAt,
    statusUpdatedAt: consent.statusUpdatedAt ?? consent.createdAt,
    authorisedAt: consent.authorisedAt ?? null,
    rejectedAt: consent.rejectedAt ?? null,
  }
}

async function findConsent(prisma: PrismaClient, consentId: string) {
  const consent = await prisma.paymentConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Payment consent not found', 'CONSENT_NOT_FOUND')
  return consent
}

export type CreatePaymentConsentParams = {
  prisma: PrismaClient
  input: {
    amount: Prisma.Decimal
    description?: string
    creditorName: string
    creditorDocument?: string
    creditorKey: { type: PixKeyType; value: string }
    /** CPF do pagador, quando a Iniciadora ja o conhece. */
    debtorDocument?: string
    /** Para onde devolver o navegador ao fim da tela. */
    redirectUri?: string
    /** Para onde avisar a Iniciadora a cada mudanca de status. */
    webhookUri?: string
    externalConsentId?: string
  }
}

/**
 * Cria o consentimento pendente de aprovacao.
 *
 * Nao recebe titular nem conta: na jornada com redirecionamento a Iniciadora
 * ainda nao sabe quem vai autorizar. Os dois sao fixados em
 * `authorisePaymentConsent`, quando a pessoa confirma na tela.
 */
export async function createPaymentConsent(
  params: CreatePaymentConsentParams,
): Promise<PaymentConsentView> {
  const { prisma, input } = params

  const consent = await createPaymentConsentRecord(prisma, {
    flow: 'REDIRECT_FLOW',
    amount: input.amount,
    description: input.description,
    creditorName: input.creditorName,
    creditorDocument: input.creditorDocument,
    creditorKey: input.creditorKey,
    debtorDocument: input.debtorDocument,
    redirectUri: input.redirectUri,
    webhookUri: input.webhookUri,
    externalConsentId: input.externalConsentId,
  })

  return toConsentView(consent)
}

export type AuthorisePaymentConsentParams = {
  prisma: PrismaClient
  consentId: string
  granter: Granter
  accountId: string
}

/**
 * Aprovacao pelo titular: fixa quem paga e de qual conta, e libera a
 * liquidacao.
 */
export async function authorisePaymentConsent(
  params: AuthorisePaymentConsentParams,
): Promise<PaymentConsentView> {
  const { prisma, consentId, granter } = params

  const consent = await findConsent(prisma, consentId)

  // Uma aprovacao recusada nao muda nada no consentimento; sem o evento, a
  // tentativa de aprovar com o CPF errado nao deixaria rastro.
  try {
    return await authorise(params, consent)
  } catch (error) {
    if (error instanceof AppError) {
      await recordConsentEvent(prisma, {
        consentId: consent.id,
        event: 'CONSENT_AUTHORISATION',
        actor: 'HOLDER',
        actorUserId: granter.userId,
        outcome: 'REFUSED',
        reason: error.code,
        statusBefore: consent.status,
      })
    }
    throw error
  }
}

async function authorise(
  params: AuthorisePaymentConsentParams,
  consent: any,
): Promise<PaymentConsentView> {
  const { prisma, consentId, granter, accountId } = params

  if (consent.status !== 'AWAITING_AUTHORISATION') {
    throw new AppError(
      409,
      `Consent is not awaiting authorisation (status: ${consent.status})`,
      'CONSENT_NOT_AWAITING_AUTHORISATION',
    )
  }

  // Quando a Iniciadora enderecou o consentimento a um CPF, so aquele titular
  // pode aprova-lo -- senao qualquer usuario logado assumiria um pedido feito
  // para outra pessoa. Mesma checagem do compartilhamento de dados.
  if (
    consent.debtorDocument &&
    normalizeDocument(granter.document) !== normalizeDocument(consent.debtorDocument)
  ) {
    throw new AppError(
      403,
      'Consent was requested for a different account holder',
      'CONSENT_HOLDER_MISMATCH',
    )
  }

  // A titularidade da conta entra na propria query: conta de terceiro nao
  // aparece no resultado.
  const account = await prisma.account.findFirst({
    where: { id: accountId, status: 'ACTIVE', customer: { is: { userId: granter.userId } } },
  })
  if (!account) throw new AppError(404, 'Active account not found', 'ACCOUNT_NOT_FOUND')

  const now = new Date()
  // O status na clausula where faz a reserva: duas confirmacoes concorrentes
  // disputam a mesma linha e apenas uma sai com count 1.
  const claimed = await prisma.paymentConsent.updateMany({
    where: { id: consent.id, status: 'AWAITING_AUTHORISATION' },
    data: {
      status: 'AUTHORISED',
      userId: granter.userId,
      customerId: granter.customerId,
      accountId: account.id,
      authorisedAt: now,
      statusUpdatedAt: now,
    },
  })
  if (claimed.count === 0) {
    throw new AppError(
      409,
      'Consent is no longer awaiting authorisation',
      'CONSENT_NOT_AWAITING_AUTHORISATION',
    )
  }

  await recordConsentEvent(prisma, {
    consentId: consent.id,
    event: 'CONSENT_AUTHORISED',
    actor: 'HOLDER',
    actorUserId: granter.userId,
    statusBefore: 'AWAITING_AUTHORISATION',
    statusAfter: 'AUTHORISED',
    detail: { accountId: account.id },
    webhookUri: consent.webhookUri,
  })

  return toConsentView(await findConsent(prisma, consentId))
}

export type RejectPaymentConsentParams = {
  prisma: PrismaClient
  consentId: string
  granter?: Granter
}

/**
 * Recusa pelo titular (ou desistencia da Iniciadora, que chama sem granter).
 *
 * Consentimento ja liquidado nao volta atras: o dinheiro saiu, e apagar o
 * registro esconderia a operacao da auditoria.
 */
export async function rejectPaymentConsent(
  params: RejectPaymentConsentParams,
): Promise<PaymentConsentView> {
  const { prisma, consentId, granter } = params

  const consent = await findConsent(prisma, consentId)

  if (consent.status === 'REJECTED') {
    // Recusar duas vezes nao e erro: o estado final e o mesmo.
    return toConsentView(consent)
  }

  if (consent.status !== 'AWAITING_AUTHORISATION' && consent.status !== 'CREATED') {
    throw new AppError(
      409,
      `Consent can no longer be rejected (status: ${consent.status})`,
      'CONSENT_NOT_REJECTABLE',
    )
  }

  if (
    granter &&
    consent.debtorDocument &&
    normalizeDocument(granter.document) !== normalizeDocument(consent.debtorDocument)
  ) {
    throw new AppError(
      403,
      'Consent was requested for a different account holder',
      'CONSENT_HOLDER_MISMATCH',
    )
  }

  const now = new Date()
  await prisma.paymentConsent.updateMany({
    where: { id: consent.id, status: consent.status },
    data: { status: 'REJECTED', rejectedAt: now, statusUpdatedAt: now },
  })

  await recordConsentEvent(prisma, {
    consentId: consent.id,
    event: 'CONSENT_REJECTED',
    actor: granter ? 'HOLDER' : 'INITIATOR',
    actorUserId: granter?.userId,
    statusBefore: consent.status,
    statusAfter: 'REJECTED',
    webhookUri: consent.webhookUri,
  })

  return toConsentView(await findConsent(prisma, consent.id))
}

export type SubmitPaymentParams = {
  prisma: PrismaClient
  consentId: string
  /** Presente no modo texto, em que quem submete e o proprio titular logado. */
  requireUserId?: string
}

export async function submitPayment(params: SubmitPaymentParams): Promise<SettleConsentResult> {
  const { prisma, consentId, requireUserId } = params
  return settlePaymentConsent(prisma, consentId, { requireUserId })
}

export async function getPaymentConsent(
  prisma: PrismaClient,
  consentId: string,
  options: { requireUserId?: string } = {},
): Promise<PaymentConsentView> {
  const consent = await findConsent(prisma, consentId)
  if (options.requireUserId && consent.userId && consent.userId !== options.requireUserId) {
    throw new AppError(403, 'Consent does not belong to this user', 'CONSENT_FORBIDDEN')
  }
  return toConsentView(consent)
}
