import { FastifyPluginAsync } from 'fastify'
import { randomInt } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'

const accountIdParams = z.object({ accountId: z.uuid() })

// accountNumber tem 6 digitos e e @unique, entao sorteios colidem muito antes
// de o espaco se esgotar (aniversario: ~1 em 1000 ja perto de 1.000 contas).
// Sem retry a colisao vaza como P2002 e vira 500.
const ACCOUNT_NUMBER_ATTEMPTS = 5

function generateAccountNumber(): string {
  return String(randomInt(100000, 1000000))
}

function isAccountNumberTaken(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

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
  app.get('/v1/me/accounts', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtUser

    const accounts = await app.prisma.account.findMany({
      where: {
        customer: {
          is: { userId: user.sub },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return accounts.map((account: any) => ({
      id: account.id,
      branch: account.branch,
      accountNumber: account.accountNumber,
      balance: moneyToString(account.balance),
      status: account.status,
      createdAt: account.createdAt,
    }))
  })

  app.post('/v1/accounts', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtUser

    // customerId is always taken from the authenticated token, never from the request body.
    let account
    for (let attempt = 1; ; attempt++) {
      try {
        account = await app.prisma.account.create({
          data: {
            customerId: user.customerId,
            branch: '0001',
            accountNumber: generateAccountNumber(),
          },
        })
        break
      } catch (error) {
        if (!isAccountNumberTaken(error)) throw error
        if (attempt === ACCOUNT_NUMBER_ATTEMPTS) {
          throw new AppError(
            503,
            'Could not allocate a free account number, please retry',
            'ACCOUNT_NUMBER_UNAVAILABLE',
          )
        }
      }
    }

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
