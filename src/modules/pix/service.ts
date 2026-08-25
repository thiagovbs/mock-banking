import { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'

export type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP'

export type ExecutePixTransferParams = {
  prisma: PrismaClient
  sourceAccountId: string
  userId: string
  amount: Prisma.Decimal
  input: {
    pixKey: { type: PixKeyType; value: string }
    consentId: string
    enrollmentId?: string
    description?: string
  }
}

export type PixTransferResult = {
  transfer: {
    id: string
    endToEndId: string
    consentId: string
    enrollmentId: string | null
    status: string
    amount: Prisma.Decimal
    createdAt: Date
  }
  sourceBalanceAfter: Prisma.Decimal
  idempotentReplay: boolean
  normalizedKey: string
}

export function normalizePixKey(type: PixKeyType, value: string): string {
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

export function validatePixKey(type: PixKeyType, value: string): void {
  if (type === 'CPF' && !/^\d{11}$/.test(value)) {
    throw new AppError(400, 'CPF PIX key must contain 11 digits', 'INVALID_PIX_KEY')
  }
  if (type === 'CNPJ' && !/^\d{14}$/.test(value)) {
    throw new AppError(400, 'CNPJ PIX key must contain 14 digits', 'INVALID_PIX_KEY')
  }
  if (type === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AppError(400, 'Invalid email PIX key', 'INVALID_PIX_KEY')
  }
  if (type === 'PHONE' && !/^\+?\d{10,15}$/.test(value)) {
    throw new AppError(400, 'Invalid phone PIX key', 'INVALID_PIX_KEY')
  }
  if (type === 'EVP' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, 'EVP PIX key must be a valid UUID', 'INVALID_PIX_KEY')
  }
}

function generateEndToEndId(): string {
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

export async function executePixTransfer(params: ExecutePixTransferParams): Promise<PixTransferResult> {
  const { prisma, sourceAccountId, userId, amount, input } = params

  const sourceAccount = await prisma.account.findFirst({
    where: { id: sourceAccountId, customer: { is: { userId } } },
  })
  if (!sourceAccount) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

  const normalizedKey = normalizePixKey(input.pixKey.type, input.pixKey.value)
  validatePixKey(input.pixKey.type, normalizedKey)

  const destinationKey = await prisma.pixKey.findFirst({
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

  const existing = await prisma.pixTransfer.findUnique({ where: { consentId: input.consentId } })
  if (existing) {
    if (existing.sourceAccountId !== sourceAccountId) {
      throw new AppError(409, 'Consent is already associated with another PIX transfer', 'CONSENT_ALREADY_USED')
    }
    const debit = await prisma.transaction.findUnique({ where: { id: existing.debitTransactionId } })
    if (!debit) throw new AppError(500, 'PIX transfer ledger is inconsistent', 'PIX_LEDGER_INCONSISTENT')

    return {
      transfer: {
        id: existing.id,
        endToEndId: existing.endToEndId,
        consentId: existing.consentId,
        enrollmentId: existing.enrollmentId,
        status: existing.status,
        amount: existing.amount,
        createdAt: existing.createdAt,
      },
      sourceBalanceAfter: debit.balanceAfter,
      idempotentReplay: true,
      normalizedKey,
    }
  }

  const transferId = randomUUID()

  const result = await prisma.$transaction(async (tx) => {
    const idsToLock = [sourceAccountId, destinationKey.accountId].sort()
    for (const id of idsToLock) {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM Account WHERE id = ${id} FOR UPDATE
      `
    }

    const lockedSource = await tx.account.findFirst({
      where: { id: sourceAccountId, customer: { is: { userId } } },
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
        referenceId: transferId,
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
        referenceId: transferId,
        description: input.description ?? `PIX received via key ${normalizedKey}`,
      },
    })

    const transfer = await tx.pixTransfer.create({
      data: {
        id: transferId,
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

    await tx.account.update({ where: { id: sourceAccountId }, data: { balance: sourceBalanceAfter } })
    await tx.account.update({ where: { id: lockedDestination.id }, data: { balance: destinationBalanceAfter } })

    return { transfer, sourceBalanceAfter, idempotentReplay: false }
  })

  return {
    transfer: {
      id: result.transfer.id,
      endToEndId: result.transfer.endToEndId,
      consentId: result.transfer.consentId,
      enrollmentId: result.transfer.enrollmentId,
      status: result.transfer.status,
      amount: result.transfer.amount,
      createdAt: result.transfer.createdAt,
    },
    sourceBalanceAfter: result.sourceBalanceAfter,
    idempotentReplay: result.idempotentReplay,
    normalizedKey,
  }
}
