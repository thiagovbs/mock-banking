import { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'

const paramsSchema = z.object({ accountId: z.uuid() })

const pixKeyRequestSchema = z.object({
  type: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']).optional(),
  value: z.string().trim().min(1).max(255).optional(),
}).optional()

const pixTransferSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  pixKey: z.object({
    type: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']),
    value: z.string().trim().min(1).max(255),
  }),
  consentId: z.string().trim().min(1).max(255),
  enrollmentId: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(200).optional(),
})

function normalizePixKey(type: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP', value: string) {
  switch (type) {
    case 'CPF':
    case 'CNPJ':
      return value.replace(/\D/g, '')
    case 'EMAIL':
      return value.trim().toLowerCase()
    case 'PHONE':
      return value.replace(/[\s()-]/g, '')
    case 'EVP':
      return value.trim().toLowerCase()
  }
}

function validatePixKey(type: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP', value: string) {
  if (type === 'CPF' && !/^\d{11}$/.test(value)) {
    throw new AppError(400, 'CPF PIX key must contain 11 digits', 'INVALID_PIX_KEY')
  }
  if (type === 'CNPJ' && !/^\d{14}$/.test(value)) {
    throw new AppError(400, 'CNPJ PIX key must contain 14 digits', 'INVALID_PIX_KEY')
  }
  if (type === 'EMAIL' && !z.string().email().safeParse(value).success) {
    throw new AppError(400, 'Invalid email PIX key', 'INVALID_PIX_KEY')
  }
  if (type === 'PHONE' && !/^\+?\d{10,15}$/.test(value)) {
    throw new AppError(400, 'Invalid phone PIX key', 'INVALID_PIX_KEY')
  }
  if (type === 'EVP' && !z.string().uuid().safeParse(value).success) {
    throw new AppError(400, 'EVP PIX key must be a valid UUID', 'INVALID_PIX_KEY')
  }
}

function generateEndToEndId() {
  const now = new Date()
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('')

  return `E00000000${timestamp}${randomUUID().replace(/-/g, '').slice(0, 17)}`
}

const pixRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/accounts/:accountId/pix/keys', { preHandler: app.authenticate }, async (request) => {
    const { accountId } = paramsSchema.parse(request.params)
    const user = request.user as JwtUser

    const account = await app.prisma.account.findFirst({
      where: { id: accountId, customer: { is: { userId: user.sub } } },
      select: { id: true },
    })
    if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    const keys = await app.prisma.pixKey.findMany({
      where: { accountId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    })

    return keys.map((pixKey) => ({
      id: pixKey.id,
      accountId: pixKey.accountId,
      type: pixKey.type,
      value: pixKey.value,
      status: pixKey.status,
      createdAt: pixKey.createdAt,
    }))
  })

  app.post('/v1/accounts/:accountId/pix/keys', { preHandler: app.authenticate }, async (request, reply) => {
    const { accountId } = paramsSchema.parse(request.params)
    const user = request.user as JwtUser
    const input = pixKeyRequestSchema.parse(request.body)

    const account = await app.prisma.account.findFirst({
      where: { id: accountId, customer: { is: { userId: user.sub } } },
      select: { id: true },
    })
    if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    let type: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP'
    let value: string
    let generated = false

    if (!input?.value) {
      if (input?.type && input.type !== 'EVP') {
        throw new AppError(400, 'A value is required for CPF, CNPJ, EMAIL and PHONE PIX keys', 'PIX_KEY_VALUE_REQUIRED')
      }
      type = 'EVP'
      value = randomUUID()
      generated = true
    } else {
      if (!input.type) {
        throw new AppError(400, 'PIX key type is required when a value is informed', 'PIX_KEY_TYPE_REQUIRED')
      }
      type = input.type
      value = normalizePixKey(type, input.value)
      validatePixKey(type, value)
    }

    const existing = await app.prisma.pixKey.findUnique({ where: { value } })
    if (existing) {
      throw new AppError(409, 'PIX key is already associated with an account', 'PIX_KEY_ALREADY_EXISTS')
    }

    const pixKey = await app.prisma.pixKey.create({
      data: { accountId, type, value },
    })

    return reply.code(201).send({
      id: pixKey.id,
      accountId: pixKey.accountId,
      type: pixKey.type,
      value: pixKey.value,
      status: pixKey.status,
      generated,
      createdAt: pixKey.createdAt,
    })
  })

  app.post('/v1/accounts/:accountId/pix/transfers', { preHandler: app.authenticate }, async (request, reply) => {
    const { accountId: sourceAccountId } = paramsSchema.parse(request.params)
    const user = request.user as JwtUser
    const input = pixTransferSchema.parse(request.body)
    const amount = parseMoney(input.amount)

    // The source account is always the account in the path and must belong to the JWT subject.
    const sourceAccount = await app.prisma.account.findFirst({
      where: { id: sourceAccountId, customer: { is: { userId: user.sub } } },
    })
    if (!sourceAccount) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

    const normalizedKey = normalizePixKey(input.pixKey.type, input.pixKey.value)
    validatePixKey(input.pixKey.type, normalizedKey)

    const destinationKey = await app.prisma.pixKey.findFirst({
      where: {
        type: input.pixKey.type,
        value: normalizedKey,
        status: 'ACTIVE',
      },
    })
    if (!destinationKey) throw new AppError(404, 'PIX key not found', 'PIX_KEY_NOT_FOUND')

    if (destinationKey.accountId === sourceAccountId) {
      throw new AppError(409, 'Source and destination accounts must be different', 'SAME_ACCOUNT_PIX_TRANSFER')
    }

    // consentId is generated/validated by another system. Here it is persisted and used
    // as the idempotency reference for the mock PIX transfer.
    const existing = await app.prisma.pixTransfer.findUnique({ where: { consentId: input.consentId } })
    if (existing) {
      if (existing.sourceAccountId !== sourceAccountId) {
        throw new AppError(409, 'Consent is already associated with another PIX transfer', 'CONSENT_ALREADY_USED')
      }
      const debit = await app.prisma.transaction.findUnique({ where: { id: existing.debitTransactionId } })
      if (!debit) throw new AppError(500, 'PIX transfer ledger is inconsistent', 'PIX_LEDGER_INCONSISTENT')

      return reply.code(200).send({
        pixTransferId: existing.id,
        endToEndId: existing.endToEndId,
        consentId: existing.consentId,
        enrollmentId: existing.enrollmentId,
        pixKey: normalizedKey,
        status: existing.status,
        amount: moneyToString(existing.amount),
        balance: moneyToString(debit.balanceAfter),
        idempotentReplay: true,
        createdAt: existing.createdAt,
      })
    }

    const result = await app.prisma.$transaction(async (tx) => {
      // Lock both account rows in deterministic order to reduce deadlock risk.
      const idsToLock = [sourceAccountId, destinationKey.accountId].sort()
      for (const id of idsToLock) {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM Account WHERE id = ${id} FOR UPDATE
        `
      }

      // Revalidate ownership while inside the financial transaction.
      const lockedSource = await tx.account.findFirst({
        where: { id: sourceAccountId, customer: { is: { userId: user.sub } } },
      })
      if (!lockedSource) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

      const lockedDestination = await tx.account.findUnique({ where: { id: destinationKey.accountId } })
      if (!lockedDestination) throw new AppError(404, 'Destination account not found', 'DESTINATION_ACCOUNT_NOT_FOUND')

      const replay = await tx.pixTransfer.findUnique({ where: { consentId: input.consentId } })
      if (replay) {
        const debit = await tx.transaction.findUnique({ where: { id: replay.debitTransactionId } })
        if (!debit) throw new AppError(500, 'PIX transfer ledger is inconsistent', 'PIX_LEDGER_INCONSISTENT')
        return { transfer: replay, sourceBalanceAfter: debit.balanceAfter, idempotentReplay: true }
      }

      if (lockedSource.status !== 'ACTIVE') {
        throw new AppError(409, 'Source account is not active', 'ACCOUNT_NOT_ACTIVE')
      }
      if (lockedDestination.status !== 'ACTIVE') {
        throw new AppError(409, 'Destination account is not active', 'DESTINATION_ACCOUNT_NOT_ACTIVE')
      }
      if (lockedSource.balance.lessThan(amount)) {
        throw new AppError(422, 'Insufficient balance', 'INSUFFICIENT_BALANCE')
      }

      const sourceBalanceAfter = lockedSource.balance.sub(amount)
      const destinationBalanceAfter = lockedDestination.balance.add(amount)
      const endToEndId = generateEndToEndId()

      const debitTransaction = await tx.transaction.create({
        data: {
          accountId: sourceAccountId,
          type: 'DEBIT',
          amount,
          balanceBefore: lockedSource.balance,
          balanceAfter: sourceBalanceAfter,
          description: input.description ?? `PIX sent to ${normalizedKey}`,
        },
      })

      const creditTransaction = await tx.transaction.create({
        data: {
          accountId: lockedDestination.id,
          type: 'CREDIT',
          amount,
          balanceBefore: lockedDestination.balance,
          balanceAfter: destinationBalanceAfter,
          description: input.description ?? `PIX received via key ${normalizedKey}`,
        },
      })

      const transfer = await tx.pixTransfer.create({
        data: {
          sourceAccountId,
          destinationAccountId: lockedDestination.id,
          pixKeyId: destinationKey.id,
          endToEndId,
          consentId: input.consentId,
          enrollmentId: input.enrollmentId,
          amount,
          description: input.description,
          status: 'COMPLETED',
          debitTransactionId: debitTransaction.id,
          creditTransactionId: creditTransaction.id,
        },
      })

      await tx.transaction.update({
        where: { id: debitTransaction.id },
        data: { referenceId: transfer.id },
      })
      await tx.transaction.update({
        where: { id: creditTransaction.id },
        data: { referenceId: transfer.id },
      })

      await tx.account.update({ where: { id: sourceAccountId }, data: { balance: sourceBalanceAfter } })
      await tx.account.update({ where: { id: lockedDestination.id }, data: { balance: destinationBalanceAfter } })

      return { transfer, sourceBalanceAfter, idempotentReplay: false }
    })

    return reply.code(result.idempotentReplay ? 200 : 201).send({
      pixTransferId: result.transfer.id,
      endToEndId: result.transfer.endToEndId,
      consentId: result.transfer.consentId,
      enrollmentId: result.transfer.enrollmentId,
      pixKey: normalizedKey,
      status: result.transfer.status,
      amount: moneyToString(result.transfer.amount),
      balance: moneyToString(result.sourceBalanceAfter),
      idempotentReplay: result.idempotentReplay,
      createdAt: result.transfer.createdAt,
    })
  })
}

export default pixRoutes
