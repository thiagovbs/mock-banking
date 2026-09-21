import { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import { normalizePixKey, validatePixKey, type PixKeyType } from '../pix/service.js'
import { recordConsentEvent } from './events.js'

/**
 * Criacao do consentimento de pagamento, para as duas jornadas.
 *
 * Antes cada modulo tinha o seu `paymentConsent.create`, e as regras de
 * entrada foram divergindo: a jornada com redirecionamento normalizava e
 * validava a chave PIX e recusava valor nao positivo; a JSR gravava a chave
 * como veio e so descobria o problema na liquidacao, com o consentimento ja
 * criado e autorizado. Um dono so para o `create` mantem as duas honestas pelo
 * mesmo criterio.
 *
 * Os dois endpoints continuam existindo -- a rota JSR segue o contrato do Open
 * Finance, e a do redirecionamento e a nossa. O que passou a ser unico e o que
 * acontece atras deles.
 */

export type ConsentFlow = 'REDIRECT_FLOW' | 'FIDO_FLOW'

/**
 * O estado inicial e consequencia da jornada, nao escolha de quem chama.
 *
 * Com redirecionamento o consentimento nasce esperando uma pessoa; na JSR
 * nasce esperando a assertion do dispositivo que ja foi aprovado. Deixar isso
 * aqui e o que impede um caminho novo nascer AUTHORISED por engano.
 */
const INITIAL_STATUS = {
  REDIRECT_FLOW: 'AWAITING_AUTHORISATION',
  FIDO_FLOW: 'CREATED',
} as const

export function normalizeDocument(document: string): string {
  return document.replace(/\D/g, '')
}

export type CreateConsentInput = {
  flow: ConsentFlow
  amount: Prisma.Decimal
  creditorName: string
  creditorKey: { type: PixKeyType; value: string }
  creditorDocument?: string | null
  description?: string | null
  /** Titular e conta, quando a jornada ja os conhece -- a JSR, pelo enrollment. */
  holder?: { userId: string; customerId: string; accountId: string }
  enrollmentId?: string | null
  fidoChallenge?: string | null
  /** CPF a quem o consentimento e enderecado, na jornada com redirecionamento. */
  debtorDocument?: string | null
  redirectUri?: string | null
  webhookUri?: string | null
  externalConsentId?: string | null
}

export async function createPaymentConsentRecord(
  prisma: PrismaClient,
  input: CreateConsentInput,
) {
  const creditorKeyValue = normalizePixKey(input.creditorKey.type, input.creditorKey.value)
  validatePixKey(input.creditorKey.type, creditorKeyValue)

  if (input.amount.lessThanOrEqualTo(0)) {
    throw new AppError(400, 'Amount must be greater than zero', 'INVALID_AMOUNT')
  }

  const status = INITIAL_STATUS[input.flow]

  const consent = await prisma.paymentConsent.create({
    data: {
      userId: input.holder?.userId,
      customerId: input.holder?.customerId,
      accountId: input.holder?.accountId,
      amount: input.amount,
      description: input.description ?? undefined,
      creditorName: input.creditorName,
      creditorDocument: input.creditorDocument ?? undefined,
      creditorKeyType: input.creditorKey.type,
      creditorKeyValue,
      debtorDocument: input.debtorDocument
        ? normalizeDocument(input.debtorDocument)
        : undefined,
      enrollmentId: input.enrollmentId ?? undefined,
      fidoChallenge: input.fidoChallenge ?? undefined,
      redirectUri: input.redirectUri ?? undefined,
      webhookUri: input.webhookUri ?? undefined,
      externalConsentId: input.externalConsentId ?? undefined,
      authorisationFlow: input.flow,
      status,
    },
  })

  await recordConsentEvent(prisma, {
    consentId: consent.id,
    event: 'CONSENT_CREATED',
    actor: 'INITIATOR',
    statusAfter: status,
    detail: {
      amount: moneyToString(consent.amount),
      creditorName: consent.creditorName,
      flow: input.flow,
      ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
    },
  })

  return consent
}
