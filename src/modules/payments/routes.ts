import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'

const paramsSchema = z.object({ accountId: z.uuid() })
const paymentIdSchema = z.object({ paymentId: z.uuid() })
const paymentSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  beneficiary: z.object({
    name: z.string().min(2).max(120),
    document: z.string().min(11).max(14).regex(/^\d+$/),
  }),
  description: z.string().max(200).optional(),
})

const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/accounts/:accountId/payments', { preHandler: app.authenticate }, async (request, reply) => {
    const { accountId } = paramsSchema.parse(request.params)
    const user = request.user as JwtUser
    const input = paymentSchema.parse(request.body)
    const idempotencyKeyHeader = request.headers['idempotency-key']
    const idempotencyKey = Array.isArray(idempotencyKeyHeader) ? idempotencyKeyHeader[0] : idempotencyKeyHeader

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 100) {
      throw new AppError(400, 'A valid Idempotency-Key header is required', 'INVALID_IDEMPOTENCY_KEY')
    }

    // Do not disclose whether another customer's account exists.
    const account = await app.prisma.account.findFirst({
      where: { id: accountId, customer: { is: { userId: user.sub } } },
    })
    if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    const existing = await app.prisma.payment.findUnique({
      where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
    })

    if (existing) {
      return reply.code(200).send({
        paymentId: existing.id,
        status: existing.status,
        amount: moneyToString(existing.amount),
        idempotentReplay: true,
        createdAt: existing.createdAt,
      })
    }

    const amount = parseMoney(input.amount)

    const result = await app.prisma.$transaction(async (tx) => {
      // Ownership is revalidated while acquiring the MySQL/InnoDB row lock.
      // This makes account authorization part of the financial transaction itself.
      const ownedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT a.id
        FROM Account a
        INNER JOIN Customer c ON c.id = a.customerId
        WHERE a.id = ${accountId}
          AND c.userId = ${user.sub}
        FOR UPDATE
      `

      if (ownedRows.length === 0) {
        throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')
      }

      // Re-check after acquiring the account lock to handle concurrent retries safely.
      const replay = await tx.payment.findUnique({
        where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
      })
      if (replay) return { payment: replay, idempotentReplay: true }

      const lockedAccount = await tx.account.findFirst({
        where: { id: accountId, customer: { is: { userId: user.sub } } },
      })
      if (!lockedAccount) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

      if (lockedAccount.status !== 'ACTIVE') {
        throw new AppError(409, 'Account is not active', 'ACCOUNT_NOT_ACTIVE')
      }
      if (lockedAccount.balance.lessThan(amount)) {
        throw new AppError(422, 'Insufficient balance', 'INSUFFICIENT_BALANCE')
      }

      const balanceAfter = lockedAccount.balance.sub(amount)

      const transaction = await tx.transaction.create({
        data: {
          accountId,
          type: 'DEBIT',
          amount,
          balanceBefore: lockedAccount.balance,
          balanceAfter,
          description: input.description ?? `Payment to ${input.beneficiary.name}`,
        },
      })

      const createdPayment = await tx.payment.create({
        data: {
          accountId,
          amount,
          beneficiaryName: input.beneficiary.name,
          beneficiaryDoc: input.beneficiary.document,
          description: input.description,
          status: 'COMPLETED',
          idempotencyKey,
          transactionId: transaction.id,
        },
      })

      await tx.transaction.update({
        where: { id: transaction.id },
        data: { referenceId: createdPayment.id },
      })

      await tx.account.update({ where: { id: accountId }, data: { balance: balanceAfter } })
      return { payment: createdPayment, idempotentReplay: false }
    })

    return reply.code(result.idempotentReplay ? 200 : 201).send({
      paymentId: result.payment.id,
      status: result.payment.status,
      amount: moneyToString(result.payment.amount),
      idempotentReplay: result.idempotentReplay,
      createdAt: result.payment.createdAt,
    })
  })

  app.get('/v1/payments/:paymentId', { preHandler: app.authenticate }, async (request) => {
    const { paymentId } = paymentIdSchema.parse(request.params)
    const user = request.user as JwtUser

    const payment = await app.prisma.payment.findFirst({
      where: {
        id: paymentId,
        account: {
          is: {
            customer: {
              is: { userId: user.sub },
            },
          },
        },
      },
    })

    // Same non-enumeration behavior for payment resources.
    if (!payment) {
      throw new AppError(404, 'Payment not found', 'PAYMENT_NOT_FOUND')
    }

    return {
      paymentId: payment.id,
      accountId: payment.accountId,
      amount: moneyToString(payment.amount),
      beneficiary: {
        name: payment.beneficiaryName,
        document: payment.beneficiaryDoc,
      },
      description: payment.description,
      status: payment.status,
      createdAt: payment.createdAt,
    }
  })
}

export default paymentRoutes
