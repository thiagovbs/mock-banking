import { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JwtUser } from '../../plugins/auth.js'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'
import { executePixTransfer, normalizePixKey, validatePixKey } from './service.js'

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

    const result = await executePixTransfer({
      prisma: app.prisma,
      sourceAccountId,
      userId: user.sub,
      amount,
      input: {
        pixKey: input.pixKey,
        consentId: input.consentId,
        enrollmentId: input.enrollmentId,
        description: input.description,
      },
    })

    return reply.code(result.idempotentReplay ? 200 : 201).send({
      pixTransferId: result.transfer.id,
      endToEndId: result.transfer.endToEndId,
      consentId: result.transfer.consentId,
      enrollmentId: result.transfer.enrollmentId,
      pixKey: result.normalizedKey,
      status: result.transfer.status,
      amount: moneyToString(result.transfer.amount),
      balance: moneyToString(result.sourceBalanceAfter),
      idempotentReplay: result.idempotentReplay,
      createdAt: result.transfer.createdAt,
    })
  })
}

export default pixRoutes
