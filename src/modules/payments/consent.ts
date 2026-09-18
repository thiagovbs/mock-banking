import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import { executePixTransfer } from '../pix/service.js'
import { recordConsentEvent } from './events.js'

export type SettleConsentResult = {
  paymentId: string
  consentId: string
  endToEndId: string
  status: string
  amount: string
  balance: string
  idempotentReplay: boolean
}

/**
 * Liquida um consentimento de pagamento, movendo o dinheiro via PIX.
 *
 * Compartilhado pelo fluxo ASPSP (`/v1/aspsp/payments`) e pela jornada JSR
 * (`/open-banking/pisp/.../jsr/pix/payments`), que faziam a mesma coisa em
 * duplicidade.
 *
 * O consentimento e reservado ANTES da transferencia: a transicao
 * AUTHORISED -> PAYMENT_SUBMITTED e atomica e ja grava o `paymentId`. Isso
 * importa porque `paymentId` e a chave de consulta do pagamento: gerando-o
 * depois, uma falha entre a transferencia e a gravacao devolvia ao cliente um
 * identificador que nunca chegou ao banco, e a consulta ficava em 404 para
 * sempre.
 *
 * PAYMENT_SUBMITTED tambem e aceito na entrada, para que uma tentativa
 * interrompida no meio possa ser concluida: `executePixTransfer` e idempotente
 * por `consentId` (unique em PixTransfer), entao repetir nao debita de novo.
 */
export async function settlePaymentConsent(
  prisma: PrismaClient,
  consentId: string,
  options: { requireUserId?: string } = {},
): Promise<SettleConsentResult> {
  const consent = await prisma.paymentConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Payment consent not found', 'CONSENT_NOT_FOUND')

  // Toda saida deste ponto em diante vira evento: as recusas nao mudam nada no
  // consentimento, entao sem isto uma submissao barrada nao deixaria rastro
  // nenhum -- que e justamente o que se quer auditar.
  try {
    return await settle(prisma, consent, options)
  } catch (error) {
    if (error instanceof AppError) {
      await recordConsentEvent(prisma, {
        consentId: consent.id,
        event: 'PAYMENT_SUBMISSION',
        actor: 'INITIATOR',
        outcome: 'REFUSED',
        reason: error.code,
        statusBefore: consent.status,
      })
    }
    throw error
  }
}

async function settle(
  prisma: PrismaClient,
  consent: any,
  options: { requireUserId?: string },
): Promise<SettleConsentResult> {
  if (options.requireUserId && consent.userId !== options.requireUserId) {
    throw new AppError(403, 'Consent does not belong to this user', 'CONSENT_FORBIDDEN')
  }

  if (consent.status !== 'AUTHORISED' && consent.status !== 'PAYMENT_SUBMITTED') {
    throw new AppError(409, 'Consent is not authorized', 'CONSENT_NOT_AUTHORISED')
  }

  // Na jornada com redirecionamento o consentimento nasce sem titular e sem
  // conta -- ambos sao fixados na aprovacao. Um AUTHORISED sem eles seria um
  // consentimento inconsistente, e nao ha conta de onde debitar.
  if (!consent.accountId || !consent.userId) {
    throw new AppError(
      409,
      'Consent has no account holder bound',
      'CONSENT_NOT_BOUND',
    )
  }

  // Consentimento JSR: o dispositivo precisa continuar ativo agora, e nao
  // apenas quando o consentimento foi criado. A checagem e feita aqui, e nao
  // importada de jsr/service, para nao criar ciclo entre os dois modulos.
  if (consent.enrollmentId) {
    const enrollment = await prisma.enrollment.findUnique({
      where: { id: consent.enrollmentId },
    })
    if (!enrollment || enrollment.revokedAt || enrollment.status !== 'FIDO_REGISTERED') {
      throw new AppError(409, 'Enrollment is no longer active', 'ENROLLMENT_REVOKED')
    }
  }

  let paymentId = consent.paymentId

  if (consent.status === 'AUTHORISED') {
    paymentId = randomUUID()
    // O status na cláusula where faz a reserva: duas chamadas concorrentes
    // disputam a mesma linha e apenas uma sai com count 1.
    const claimed = await prisma.paymentConsent.updateMany({
      where: { id: consent.id, status: 'AUTHORISED' },
      data: { status: 'PAYMENT_SUBMITTED', paymentId, submittedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new AppError(409, 'Consent is already being submitted', 'CONSENT_NOT_AUTHORISED')
    }

    await recordConsentEvent(prisma, {
      consentId: consent.id,
      event: 'PAYMENT_SUBMITTED',
      actor: 'INITIATOR',
      statusBefore: 'AUTHORISED',
      statusAfter: 'PAYMENT_SUBMITTED',
      webhookUri: consent.webhookUri,
      paymentId,
    })
  }

  if (!paymentId) {
    throw new AppError(500, 'Consent has no payment identifier', 'CONSENT_INCONSISTENT')
  }

  const result = await executePixTransfer({
    prisma,
    sourceAccountId: consent.accountId,
    userId: consent.userId,
    amount: consent.amount,
    input: {
      pixKey: { type: consent.creditorKeyType, value: consent.creditorKeyValue },
      consentId: consent.id,
      description: consent.description ?? `PIX to ${consent.creditorName}`,
      expectedCreditorDocument: consent.creditorDocument ?? undefined,
    },
  })

  await prisma.paymentConsent.update({
    where: { id: consent.id },
    data: { status: 'COMPLETED' },
  })

  await recordConsentEvent(prisma, {
    consentId: consent.id,
    event: 'PAYMENT_COMPLETED',
    actor: 'SYSTEM',
    statusBefore: 'PAYMENT_SUBMITTED',
    statusAfter: 'COMPLETED',
    detail: {
      endToEndId: result.transfer.endToEndId,
      amount: moneyToString(result.transfer.amount),
      idempotentReplay: result.idempotentReplay,
    },
    webhookUri: consent.webhookUri,
    paymentId,
  })

  return {
    paymentId,
    consentId: consent.id,
    endToEndId: result.transfer.endToEndId,
    status: result.transfer.status,
    amount: moneyToString(result.transfer.amount),
    balance: moneyToString(result.sourceBalanceAfter),
    idempotentReplay: result.idempotentReplay,
  }
}
