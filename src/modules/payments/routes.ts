import { FastifyPluginAsync } from 'fastify'
import { Payment } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'
import { executePixTransfer, inferPixKeyType } from '../pix/service.js'

const paymentSchema = z.object({
  paymentMethod: z.enum(['PIX', 'QR_CODE', 'BOLETO', 'BILL']),
  amount: z.union([z.string(), z.number()]),
  // Obrigatorio em PIX, conforme o contrato publicado. A exigencia fica no
  // handler, e nao aqui, porque depende do paymentMethod: QR_CODE, BOLETO e
  // BILL nao pedem dispositivo.
  enrollmentId: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(200).optional(),

  pix: z.object({
    key: z.string().trim().min(1).max(255),
  }).optional(),

  qrCode: z.object({
    payload: z.string().trim().min(1).max(2048).optional(),
    pixKey: z.string().trim().min(1).max(255),
  }).optional(),

  boleto: z.object({
    digitableLine: z.string().trim().min(20).max(100),
  }).optional(),

  bill: z.object({
    provider: z.string().trim().min(1).max(100),
    reference: z.string().trim().min(1).max(255),
  }).optional(),
})

const paymentIdParams = z.object({ paymentId: z.uuid() })

/**
 * Serializa um Payment. Os campos especificos de cada metodo ficam nulos nos
 * demais, entao a leitura e a mesma para os quatro.
 */
function serializePayment(payment: Payment) {
  return {
    paymentId: payment.id,
    accountId: payment.accountId,
    paymentMethod: payment.method,
    amount: moneyToString(payment.amount),
    status: payment.status,
    description: payment.description,
    idempotencyKey: payment.idempotencyKey,
    transactionId: payment.transactionId,
    pix:
      payment.method === 'PIX' || payment.method === 'QR_CODE'
        ? {
            key: payment.pixKey,
            endToEndId: payment.endToEndId,
            pixTransferId: payment.pixTransferId,
          }
        : null,
    boleto: payment.method === 'BOLETO' ? { digitableLine: payment.digitableLine } : null,
    bill:
      payment.method === 'BILL'
        ? { provider: payment.billProvider, reference: payment.billReference }
        : null,
    createdAt: payment.createdAt,
  }
}

/**
 * Dispositivo apto a pagar pela fachada: existe, e do pagador, esta registrado
 * e nao foi revogado -- a mesma definicao de "active" que a listagem de
 * dispositivos usa.
 *
 * Nao reaproveita requireActiveEnrollment do modulo JSR porque aquela exige
 * tambem conta fixada no enrollment, o que so faz sentido na jornada sem
 * redirect: aqui a conta de origem e resolvida pela propria fachada.
 */
async function requireActiveDevice(
  prisma: any,
  enrollmentId: string,
  userId: string,
): Promise<void> {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })

  // Dispositivo de outro titular responde como inexistente, para nao confirmar
  // a existencia de enrollments alheios.
  if (!enrollment || enrollment.userId !== userId) {
    throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')
  }
  if (enrollment.revokedAt) {
    throw new AppError(409, 'Enrollment is revoked', 'ENROLLMENT_REVOKED')
  }
  if (enrollment.status !== 'FIDO_REGISTERED') {
    throw new AppError(409, 'Enrollment has no registered device', 'ENROLLMENT_NOT_REGISTERED')
  }
}

const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/me/payments', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const input = paymentSchema.parse(request.body)
    const amount = parseMoney(input.amount)

    // Idempotency-Key e opcional: sem ele cada chamada e uma operacao nova.
    // Com ele, repetir a chamada devolve o pagamento ja registrado.
    const headerKey = request.headers['idempotency-key']
    const idempotencyKey =
      (Array.isArray(headerKey) ? headerKey[0] : headerKey)?.trim() || randomUUID()

    const sourceAccount = await app.prisma.account.findFirst({
      where: {
        status: 'ACTIVE',
        customer: {
          is: {
            userId: user.sub,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    if (!sourceAccount) {
      throw new AppError(404, 'Active account not found', 'ACCOUNT_NOT_FOUND')
    }

    const replay = await app.prisma.payment.findUnique({
      where: { accountId_idempotencyKey: { accountId: sourceAccount.id, idempotencyKey } },
    })
    if (replay) {
      return reply.code(200).send({ ...serializePayment(replay), idempotentReplay: true })
    }

    if (input.paymentMethod === 'PIX' || input.paymentMethod === 'QR_CODE') {
      const pixKey =
        input.paymentMethod === 'PIX'
          ? input.pix?.key
          : input.qrCode?.pixKey

      if (!pixKey) {
        throw new AppError(
          400,
          input.paymentMethod === 'PIX'
            ? 'pix.key is required for PIX payments'
            : 'qrCode.pixKey is required for QR_CODE payments',
          'PAYMENT_DATA_REQUIRED'
        )
      }

      if (input.paymentMethod === 'PIX') {
        if (!input.enrollmentId) {
          throw new AppError(
            400,
            'enrollmentId is required for PIX payments',
            'PAYMENT_DATA_REQUIRED',
          )
        }
        await requireActiveDevice(app.prisma, input.enrollmentId, user.sub)
      }

      const keyType = inferPixKeyType(pixKey)

      const result = await executePixTransfer({
        prisma: app.prisma,
        sourceAccountId: sourceAccount.id,
        userId: user.sub,
        amount,
        input: {
          pixKey: { type: keyType, value: pixKey },
          consentId: randomUUID(),
          enrollmentId: input.enrollmentId,
          description: input.description,
        },
      })

      // O Payment e criado depois que a transferencia commita: PixTransfer e a
      // fonte de verdade do dinheiro, Payment e o registro consultavel.
      const payment = await app.prisma.payment.create({
        data: {
          accountId: sourceAccount.id,
          method: input.paymentMethod,
          amount: result.transfer.amount,
          description: input.description,
          status: 'COMPLETED',
          idempotencyKey,
          transactionId: result.transfer.debitTransactionId,
          pixKey: result.normalizedKey,
          endToEndId: result.transfer.endToEndId,
          pixTransferId: result.transfer.id,
        },
      })

      return reply.code(201).send({
        ...serializePayment(payment),
        balance: moneyToString(result.sourceBalanceAfter),
        idempotentReplay: false,
      })
    }

    if (input.paymentMethod === 'BOLETO' && !input.boleto?.digitableLine) {
      throw new AppError(400, 'boleto.digitableLine is required', 'PAYMENT_DATA_REQUIRED')
    }

    if (input.paymentMethod === 'BILL' && (!input.bill?.provider || !input.bill?.reference)) {
      throw new AppError(400, 'bill.provider and bill.reference are required', 'PAYMENT_DATA_REQUIRED')
    }

    const result = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM Account WHERE id = ${sourceAccount.id} FOR UPDATE
      `

      const lockedAccount = await tx.account.findFirst({
        where: {
          id: sourceAccount.id,
          status: 'ACTIVE',
          customer: {
            is: {
              userId: user.sub,
            },
          },
        },
      })

      if (!lockedAccount) {
        throw new AppError(404, 'Active account not found', 'ACCOUNT_NOT_FOUND')
      }

      if (lockedAccount.balance.lessThan(amount)) {
        throw new AppError(422, 'Insufficient balance', 'INSUFFICIENT_BALANCE')
      }

      const balanceAfter = lockedAccount.balance.sub(amount)

      const description =
        input.description ??
        (input.paymentMethod === 'BOLETO'
          ? `Boleto ${input.boleto!.digitableLine}`
          : `Bill ${input.bill!.provider} ${input.bill!.reference}`)

      // Boleto e conta nao geram PixTransfer, entao o Payment e gravado aqui,
      // na mesma transacao do debito.
      const payment = await tx.payment.create({
        data: {
          accountId: lockedAccount.id,
          method: input.paymentMethod,
          amount,
          description: input.description ?? description,
          status: 'COMPLETED',
          idempotencyKey,
          digitableLine: input.paymentMethod === 'BOLETO' ? input.boleto!.digitableLine : null,
          billProvider: input.paymentMethod === 'BILL' ? input.bill!.provider : null,
          billReference: input.paymentMethod === 'BILL' ? input.bill!.reference : null,
        },
      })

      const transaction = await tx.transaction.create({
        data: {
          accountId: lockedAccount.id,
          type: 'DEBIT',
          amount,
          balanceBefore: lockedAccount.balance,
          balanceAfter,
          referenceId: payment.id,
          description,
        },
      })

      const linkedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: { transactionId: transaction.id },
      })

      await tx.account.update({
        where: { id: lockedAccount.id },
        data: { balance: balanceAfter },
      })

      return { payment: linkedPayment, balanceAfter }
    })

    return reply.code(201).send({
      ...serializePayment(result.payment),
      balance: moneyToString(result.balanceAfter),
      idempotentReplay: false,
    })
  })

  app.get('/v1/payments/:paymentId', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser
    const { paymentId } = paymentIdParams.parse(request.params)

    // A titularidade entra na propria consulta. Pagamento de outro titular
    // tambem devolve 404, para nao permitir enumeracao.
    const payment = await app.prisma.payment.findFirst({
      where: {
        id: paymentId,
        account: { customer: { is: { userId: user.sub } } },
      },
    })

    if (!payment) throw new AppError(404, 'Payment not found', 'PAYMENT_NOT_FOUND')
    return serializePayment(payment)
  })
}

export default paymentRoutes
