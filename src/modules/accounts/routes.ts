import { FastifyPluginAsync } from 'fastify'
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'

const accountIdParams = z.object({ accountId: z.uuid() })
const creditSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(200).optional(),
})

async function requireOwnedAccount(app: any, accountId: string, customerId: string) {
  const account = await app.prisma.account.findUnique({ where: { id: accountId } })
  if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')
  if (account.customerId !== customerId) throw new AppError(403, 'You cannot access this account', 'FORBIDDEN_ACCOUNT')
  return account
}

const accountRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/accounts', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const accountNumber = String(randomInt(100000, 999999))

    const account = await app.prisma.account.create({
      data: {
        customerId: user.customerId,
        branch: '0001',
        accountNumber,
      },
    })

    return reply.code(201).send({
      id: account.id,
      branch: account.branch,
      accountNumber: account.accountNumber,
      balance: moneyToString(account.balance),
      status: account.status,
      createdAt: account.createdAt,
    })
  })

  app.get('/v1/accounts/:accountId', { preHandler: app.authenticate }, async (request) => {
    const { accountId } = accountIdParams.parse(request.params)
    const user = request.user as JwtUser
    const account = await requireOwnedAccount(app, accountId, user.customerId)

    return {
      id: account.id,
      branch: account.branch,
      accountNumber: account.accountNumber,
      balance: moneyToString(account.balance),
      status: account.status,
      createdAt: account.createdAt,
    }
  })

  app.get('/v1/accounts/:accountId/balance', { preHandler: app.authenticate }, async (request) => {
    const { accountId } = accountIdParams.parse(request.params)
    const user = request.user as JwtUser
    const account = await requireOwnedAccount(app, accountId, user.customerId)

    return {
      accountId: account.id,
      balance: moneyToString(account.balance),
      currency: 'BRL',
    }
  })

  app.get('/v1/accounts/:accountId/transactions', { preHandler: app.authenticate }, async (request) => {
    const { accountId } = accountIdParams.parse(request.params)
    const user = request.user as JwtUser
    await requireOwnedAccount(app, accountId, user.customerId)

    const transactions = await app.prisma.transaction.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return transactions.map((tx: any) => ({
      id: tx.id,
      type: tx.type,
      amount: moneyToString(tx.amount),
      balanceBefore: moneyToString(tx.balanceBefore),
      balanceAfter: moneyToString(tx.balanceAfter),
      referenceId: tx.referenceId,
      description: tx.description,
      createdAt: tx.createdAt,
    }))
  })

  // DEMO ONLY: in a real banking system this would be restricted to a trusted/internal channel.
  app.post('/v1/accounts/:accountId/credits', { preHandler: app.authenticate }, async (request, reply) => {
    const { accountId } = accountIdParams.parse(request.params)
    const user = request.user as JwtUser
    const input = creditSchema.parse(request.body)
    const amount = parseMoney(input.amount)

    await requireOwnedAccount(app, accountId, user.customerId)

    const result = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Account WHERE id = ${accountId} FOR UPDATE`
      const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } })
      const balanceAfter = account.balance.add(amount)

      const transaction = await tx.transaction.create({
        data: {
          accountId,
          type: 'CREDIT',
          amount,
          balanceBefore: account.balance,
          balanceAfter,
          description: input.description ?? 'Demo credit',
        },
      })

      await tx.account.update({ where: { id: accountId }, data: { balance: balanceAfter } })
      return { transaction, balanceAfter }
    })

    return reply.code(201).send({
      transactionId: result.transaction.id,
      amount: moneyToString(result.transaction.amount),
      balance: moneyToString(result.balanceAfter),
    })
  })
}

export default accountRoutes
