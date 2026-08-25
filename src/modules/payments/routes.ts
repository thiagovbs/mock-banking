import { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'

const paymentSchema = z.object({
  paymentMethod: z.enum(['PIX', 'QR_CODE', 'BOLETO', 'BILL']),
  amount: z.union([z.string(), z.number()]),
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

function inferPixKeyType(value: string): 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP' {
  const trimmed = value.trim()

  if (trimmed.includes('@')) return 'EMAIL'
  if (/^\d{11}$/.test(trimmed)) return 'CPF'
  if (/^\d{14}$/.test(trimmed)) return 'CNPJ'
  if (/^\+?\d{10,15}$/.test(trimmed)) return 'PHONE'
  if (z.string().uuid().safeParse(trimmed).success) return 'EVP'

  throw new AppError(400, 'Could not infer PIX key type', 'INVALID_PIX_KEY')
}

const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/me/payments', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const input = paymentSchema.parse(request.body)
    const amount = parseMoney(input.amount)
    const consentId = randomUUID()

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

      const keyType = inferPixKeyType(pixKey)
      const authorization = request.headers.authorization

      if (!authorization) {
        throw new AppError(401, 'Authorization header is required', 'UNAUTHORIZED')
      }

      // Reuse the existing PIX endpoint instead of duplicating its financial logic.
      const pixResponse = await app.inject({
        method: 'POST',
        url: `/v1/accounts/${sourceAccount.id}/pix/transfers`,
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        payload: {
          amount: moneyToString(amount),
          pixKey: {
            type: keyType,
            value: pixKey,
          },
          consentId,
          enrollmentId: input.enrollmentId,
          description: input.description,
        },
      })

      const body = pixResponse.json()

      if (pixResponse.statusCode >= 400) {
        return reply.code(pixResponse.statusCode).send(body)
      }

      return reply.code(pixResponse.statusCode).send({
        paymentId: body.pixTransferId,
        paymentMethod: input.paymentMethod,
        status: body.status,
        amount: body.amount,
        balance: body.balance,
        endToEndId: body.endToEndId,
        consentId: body.consentId ?? consentId,
        idempotentReplay: body.idempotentReplay,
        createdAt: body.createdAt,
      })
    }

    if (input.paymentMethod === 'BOLETO' && !input.boleto?.digitableLine) {
      throw new AppError(400, 'boleto.digitableLine is required', 'PAYMENT_DATA_REQUIRED')
    }

    if (input.paymentMethod === 'BILL' && (!input.bill?.provider || !input.bill?.reference)) {
      throw new AppError(400, 'bill.provider and bill.reference are required', 'PAYMENT_DATA_REQUIRED')
    }

    const paymentId = randomUUID()

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

      await tx.transaction.create({
        data: {
          accountId: lockedAccount.id,
          type: 'DEBIT',
          amount,
          balanceBefore: lockedAccount.balance,
          balanceAfter,
          referenceId: paymentId,
          description,
        },
      })

      await tx.account.update({
        where: { id: lockedAccount.id },
        data: { balance: balanceAfter },
      })

      return {
        balanceAfter,
      }
    })

    return reply.code(201).send({
      paymentId,
      paymentMethod: input.paymentMethod,
      consentId,
      status: 'COMPLETED',
      amount: moneyToString(amount),
      balance: moneyToString(result.balanceAfter),
      createdAt: new Date().toISOString(),
    })
  })
}

export default paymentRoutes
