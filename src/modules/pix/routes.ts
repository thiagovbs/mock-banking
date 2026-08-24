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

    return keys.map((pixKey: any) => ({
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
  const pixProcessSchema = z.object({
    amount: z.union([z.string(), z.number()]),
    pixKey: z.object({
      type: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']),
      value: z.string().trim().min(1).max(255),
    }),
    consentId: z.string().trim().min(1).max(255),
    enrollmentId: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(200).optional(),
  })

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

  app.post('/v1/pix/receipts', { preHandler: app.authenticate }, async (request, reply) => {
    const input = pixProcessSchema.parse(request.body)
    const amount = parseMoney(input.amount)

    const normalizedKey = normalizePixKey(input.pixKey.type, input.pixKey.value)
    validatePixKey(input.pixKey.type, normalizedKey)

    // The consent is generated/validated by another system.
    // This backend only persists it and uses it as the idempotency reference for this mock.
    const existingByConsent = await app.prisma.pixReceipt.findUnique({
      where: { consentId: input.consentId },
    })

    if (existingByConsent) {
      const currentAccount = await app.prisma.account.findUnique({
        where: { id: existingByConsent.accountId },
      })

      if (!currentAccount) {
        throw new AppError(404, 'Destination account not found', 'DESTINATION_ACCOUNT_NOT_FOUND')
      }

      return reply.code(200).send({
        pixReceiptId: existingByConsent.id,
        endToEndId: existingByConsent.endToEndId,
        consentId: existingByConsent.consentId,
        enrollmentId: existingByConsent.enrollmentId,
        pixKey: normalizedKey,
        status: existingByConsent.status,
        amount: moneyToString(existingByConsent.amount),
        balance: moneyToString(currentAccount.balance),
        idempotentReplay: true,
        createdAt: existingByConsent.createdAt,
      })
    }

    const destinationKey = await app.prisma.pixKey.findFirst({
      where: {
        type: input.pixKey.type,
        value: normalizedKey,
        status: 'ACTIVE',
      },
      include: {
        account: true,
      },
    })

    if (!destinationKey) {
      throw new AppError(404, 'PIX key not found', 'PIX_KEY_NOT_FOUND')
    }

    const result = await app.prisma.$transaction(async (tx) => {
      // Lock the destination account resolved by the PIX key.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT a.id
        FROM Account a
        INNER JOIN PixKey pk ON pk.accountId = a.id
        WHERE pk.id = ${destinationKey.id}
          AND pk.status = 'ACTIVE'
        FOR UPDATE
      `

      if (rows.length === 0) {
        throw new AppError(404, 'PIX key not found', 'PIX_KEY_NOT_FOUND')
      }

      // Re-check consent after acquiring the lock to make concurrent retries idempotent.
      const replay = await tx.pixReceipt.findUnique({
        where: { consentId: input.consentId },
      })

      if (replay) {
        const replayAccount = await tx.account.findUnique({
          where: { id: replay.accountId },
        })
        if (!replayAccount) {
          throw new AppError(404, 'Destination account not found', 'DESTINATION_ACCOUNT_NOT_FOUND')
        }

        return {
          pixReceipt: replay,
          balanceAfter: replayAccount.balance,
          idempotentReplay: true,
        }
      }

      const lockedAccount = await tx.account.findUnique({
        where: { id: destinationKey.accountId },
      })

      if (!lockedAccount) {
        throw new AppError(404, 'Destination account not found', 'DESTINATION_ACCOUNT_NOT_FOUND')
      }

      if (lockedAccount.status !== 'ACTIVE') {
        throw new AppError(409, 'Destination account is not active', 'ACCOUNT_NOT_ACTIVE')
      }

      const balanceAfter = lockedAccount.balance.add(amount)
      const endToEndId = generateEndToEndId()

      const transaction = await tx.transaction.create({
        data: {
          accountId: lockedAccount.id,
          type: 'CREDIT',
          amount,
          balanceBefore: lockedAccount.balance,
          balanceAfter,
          description: input.description ?? `PIX received via key ${normalizedKey}`,
        },
      })

      const pixReceipt = await tx.pixReceipt.create({
        data: {
          accountId: lockedAccount.id,
          pixKeyId: destinationKey.id,
          endToEndId,
          consentId: input.consentId,
          enrollmentId: input.enrollmentId,
          amount,
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
        where: { id: lockedAccount.id },
        data: { balance: balanceAfter },
      })

      return {
        pixReceipt,
        balanceAfter,
        idempotentReplay: false,
      }
    })

    return reply.code(result.idempotentReplay ? 200 : 201).send({
      pixReceiptId: result.pixReceipt.id,
      endToEndId: result.pixReceipt.endToEndId,
      consentId: result.pixReceipt.consentId,
      enrollmentId: result.pixReceipt.enrollmentId,
      pixKey: normalizedKey,
      status: result.pixReceipt.status,
      amount: moneyToString(result.pixReceipt.amount),
      balance: moneyToString(result.balanceAfter),
      idempotentReplay: result.idempotentReplay,
      createdAt: result.pixReceipt.createdAt,
    })
  })
}

export default pixRoutes
