import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import { executePixTransfer } from '../pix/service.js'

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

  if (options.requireUserId && consent.userId !== options.requireUserId) {
    throw new AppError(403, 'Consent does not belong to this user', 'CONSENT_FORBIDDEN')
  }

  if (consent.status !== 'AUTHORISED' && consent.status !== 'PAYMENT_SUBMITTED') {
    throw new AppError(409, 'Consent is not authorized', 'CONSENT_NOT_AUTHORISED')
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
    },
  })

  await prisma.paymentConsent.update({
    where: { id: consent.id },
    data: { status: 'COMPLETED' },
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
