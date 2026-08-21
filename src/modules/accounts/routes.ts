import { FastifyPluginAsync } from 'fastify'
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'

const accountIdParams = z.object({ accountId: z.uuid() })

async function requireOwnedAccount(app: any, accountId: string, userId: string) {
  // Ownership is enforced in the query itself. Returning 404 for both an
  // unknown account and an account owned by another customer avoids resource enumeration.
  const account = await app.prisma.account.findFirst({
    where: {
      id: accountId,
      customer: {
        is: { userId },
      },
    },
  })

  if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')
  return account
}

const accountRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/accounts', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser
    const accountNumber = String(randomInt(100000, 999999))

    // customerId is always taken from the authenticated token, never from the request body.
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
    const account = await requireOwnedAccount(app, accountId, user.sub)

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
    const account = await requireOwnedAccount(app, accountId, user.sub)

    return {
      accountId: account.id,
      balance: moneyToString(account.balance),
      currency: 'BRL',
    }
  })

  app.get('/v1/accounts/:accountId/transactions', { preHandler: app.authenticate }, async (request) => {
    const { accountId } = accountIdParams.parse(request.params)
    const user = request.user as JwtUser
    await requireOwnedAccount(app, accountId, user.sub)

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
}

export default accountRoutes
