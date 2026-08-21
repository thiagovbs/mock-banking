import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'

const paramsSchema = z.object({ accountId: z.uuid() })

const pixReceiptSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  endToEndId: z.string().min(8).max(64),
  payer: z.object({
    name: z.string().min(2).max(120),
    document: z.string().min(11).max(14).regex(/^\d+$/),
  }),
  description: z.string().max(200).optional(),
})

const pixRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/accounts/:accountId/pix/receipts', { preHandler: app.authenticate }, async (request, reply) => {
    const { accountId } = paramsSchema.parse(request.params)
    const user = request.user as JwtUser
    const input = pixReceiptSchema.parse(request.body)
    const amount = parseMoney(input.amount)

    // Ownership is part of the lookup so another customer's account is indistinguishable from an unknown account.
    const account = await app.prisma.account.findFirst({
      where: { id: accountId, customer: { is: { userId: user.sub } } },
    })
    if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    const existing = await app.prisma.pixReceipt.findUnique({
      where: { endToEndId: input.endToEndId },
    })

    if (existing) {
      if (existing.accountId !== accountId) {
        throw new AppError(409, 'EndToEndId is already associated with another account', 'PIX_END_TO_END_ID_CONFLICT')
      }

      const currentAccount = await app.prisma.account.findFirst({
        where: { id: accountId, customer: { is: { userId: user.sub } } },
      })
      if (!currentAccount) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

      return reply.code(200).send({
        pixReceiptId: existing.id,
        endToEndId: existing.endToEndId,
        status: existing.status,
        amount: moneyToString(existing.amount),
        balance: moneyToString(currentAccount.balance),
        idempotentReplay: true,
        createdAt: existing.createdAt,
      })
    }

    const result = await app.prisma.$transaction(async (tx) => {
      // Ownership is revalidated while acquiring the MySQL/InnoDB row lock.
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

      // Re-check after acquiring the account lock to handle concurrent PIX retries.
      const replay = await tx.pixReceipt.findUnique({ where: { endToEndId: input.endToEndId } })
      if (replay) {
        if (replay.accountId !== accountId) {
          throw new AppError(409, 'EndToEndId is already associated with another account', 'PIX_END_TO_END_ID_CONFLICT')
        }

        const lockedAccount = await tx.account.findFirst({
          where: { id: accountId, customer: { is: { userId: user.sub } } },
        })
        if (!lockedAccount) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

        return { pixReceipt: replay, balanceAfter: lockedAccount.balance, idempotentReplay: true }
      }

      const lockedAccount = await tx.account.findFirst({
        where: { id: accountId, customer: { is: { userId: user.sub } } },
      })
      if (!lockedAccount) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

      if (lockedAccount.status !== 'ACTIVE') {
        throw new AppError(409, 'Account is not active', 'ACCOUNT_NOT_ACTIVE')
      }

      const balanceAfter = lockedAccount.balance.add(amount)

      const transaction = await tx.transaction.create({
        data: {
          accountId,
          type: 'CREDIT',
          amount,
          balanceBefore: lockedAccount.balance,
          balanceAfter,
          description: input.description ?? `PIX received from ${input.payer.name}`,
        },
      })

      const pixReceipt = await tx.pixReceipt.create({
        data: {
          accountId,
          endToEndId: input.endToEndId,
          amount,
          payerName: input.payer.name,
          payerDocument: input.payer.document,
          description: input.description,
          status: 'COMPLETED',
          transactionId: transaction.id,
        },
      })

      await tx.transaction.update({
        where: { id: transaction.id },
        data: { referenceId: pixReceipt.id },
      })

      await tx.account.update({
        where: { id: accountId },
        data: { balance: balanceAfter },
      })

      return { pixReceipt, balanceAfter, idempotentReplay: false }
    })

    return reply.code(result.idempotentReplay ? 200 : 201).send({
      pixReceiptId: result.pixReceipt.id,
      endToEndId: result.pixReceipt.endToEndId,
      status: result.pixReceipt.status,
      amount: moneyToString(result.pixReceipt.amount),
      balance: moneyToString(result.balanceAfter),
      idempotentReplay: result.idempotentReplay,
      createdAt: result.pixReceipt.createdAt,
    })
  })
}

export default pixRoutes
