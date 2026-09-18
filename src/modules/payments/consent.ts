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

  // Consentimento ja liquidado: devolve o pagamento que existe, em vez de
  // recusar. Uma Iniciadora que reenvia apos timeout precisa saber que deu
  // certo; recusar com "Consent is not authorized" a faria procurar um problema
  // de autorizacao num pagamento que ja foi pago.
  if (consent.status === 'COMPLETED') {
    return replayCompletedPayment(prisma, consent)
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
  // Só esta chamada pode desfazer a própria reserva: se o consentimento ja
  // entrou aqui em PAYMENT_SUBMITTED, quem reservou foi outra tentativa.
  let reserved = false

  if (consent.status === 'AUTHORISED') {
    paymentId = randomUUID()
    // O status na cláusula where faz a reserva: duas chamadas concorrentes
    // disputam a mesma linha e apenas uma sai com count 1.
    const claimed = await prisma.paymentConsent.updateMany({
      where: { id: consent.id, status: 'AUTHORISED' },
      data: {
        status: 'PAYMENT_SUBMITTED',
        paymentId,
        submittedAt: new Date(),
        statusUpdatedAt: new Date(),
      },
    })
    if (claimed.count === 0) {
      throw new AppError(409, 'Consent is already being submitted', 'CONSENT_NOT_AUTHORISED')
    }
    reserved = true

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

  let result
  try {
    result = await executePixTransfer({
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
  } catch (error) {
    await releaseReservation(prisma, consent, paymentId, reserved)
    throw error
  }

  await prisma.paymentConsent.update({
    where: { id: consent.id },
    data: { status: 'COMPLETED', statusUpdatedAt: new Date() },
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

/**
 * Desfaz a reserva AUTHORISED -> PAYMENT_SUBMITTED quando a transferencia falha
 * sem mover dinheiro.
 *
 * Sem isto, um consentimento cuja liquidacao falha por motivo permanente
 * (chave do proprio pagador, chave inexistente, recebedor divergente) fica preso
 * em PAYMENT_SUBMITTED para sempre: nao liquida, porque o motivo nao muda, e nao
 * pode ser recusado, porque a recusa so aceita consentimento pendente. A conta
 * do titular ficava presa a uma operacao que nunca aconteceu.
 *
 * Duas condicoes para desfazer, e as duas importam:
 *
 *  - `reserved`: so a chamada que fez a reserva a desfaz. Um consentimento que
 *    ja entrou em PAYMENT_SUBMITTED e tentativa de outra chamada, possivelmente
 *    ainda em curso.
 *  - Nao existir PixTransfer para este consentimento: e o que prova que nada foi
 *    debitado. Se a transferencia commitou e a falha veio depois, manter
 *    PAYMENT_SUBMITTED e o certo -- `executePixTransfer` e idempotente por
 *    consentId, entao uma retentativa conclui em vez de debitar de novo.
 *
 * O evento e gravado sem `webhookUri` de proposito: avisar a Iniciadora de que
 * o consentimento voltou a AUTHORISED faria o webhook dela submeter de novo, e
 * cada nova falha geraria outro aviso -- um laco. Ela ja fica sabendo pelo erro
 * da propria chamada.
 */
async function releaseReservation(
  prisma: PrismaClient,
  consent: any,
  paymentId: string,
  reserved: boolean,
): Promise<void> {
  if (!reserved) return

  try {
    const transfer = await prisma.pixTransfer.findUnique({ where: { consentId: consent.id } })
    if (transfer) return

    const released = await prisma.paymentConsent.updateMany({
      // O paymentId no where amarra a reserva a esta chamada.
      where: { id: consent.id, status: 'PAYMENT_SUBMITTED', paymentId },
      data: {
        status: 'AUTHORISED',
        paymentId: null,
        submittedAt: null,
        statusUpdatedAt: new Date(),
      },
    })
    if (released.count === 0) return

    await recordConsentEvent(prisma, {
      consentId: consent.id,
      event: 'PAYMENT_SUBMISSION_RELEASED',
      actor: 'SYSTEM',
      statusBefore: 'PAYMENT_SUBMITTED',
      statusAfter: 'AUTHORISED',
      detail: { paymentId },
    })
  } catch {
    // Desfazer e best-effort: falhar aqui nao pode esconder o erro original da
    // transferencia, que e o que o chamador precisa ver.
  }
}

/**
 * Resposta de um consentimento que ja liquidou.
 *
 * Nada e reexecutado: os dados saem do PixTransfer gravado na liquidacao
 * original, e o `paymentId` e o mesmo que o chamador recebeu da primeira vez.
 * `balance` e o saldo **atual** da conta pagadora, nao o do momento do debito --
 * outras operacoes podem ter acontecido desde entao.
 */
async function replayCompletedPayment(
  prisma: PrismaClient,
  consent: any,
): Promise<SettleConsentResult> {
  const transfer = await prisma.pixTransfer.findUnique({ where: { consentId: consent.id } })

  const account = consent.accountId
    ? await prisma.account.findUnique({ where: { id: consent.accountId } })
    : null

  // COMPLETED sem transferencia, sem paymentId ou sem conta e estado
  // inconsistente, e nao ha o que devolver: recusar e melhor que inventar um
  // recibo.
  if (!transfer || !consent.paymentId || !account) {
    throw new AppError(409, 'Consent is not authorized', 'CONSENT_NOT_AUTHORISED')
  }

  await recordConsentEvent(prisma, {
    consentId: consent.id,
    event: 'PAYMENT_SUBMISSION_REPLAYED',
    actor: 'INITIATOR',
    statusBefore: 'COMPLETED',
    statusAfter: 'COMPLETED',
    detail: { paymentId: consent.paymentId },
    paymentId: consent.paymentId,
  })

  return {
    paymentId: consent.paymentId,
    consentId: consent.id,
    endToEndId: transfer.endToEndId,
    status: transfer.status,
    amount: moneyToString(transfer.amount),
    balance: moneyToString(account.balance),
    idempotentReplay: true,
  }
}
