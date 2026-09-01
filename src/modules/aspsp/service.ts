import { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import {
  executePixTransfer,
  normalizePixKey,
  validatePixKey,
  type PixKeyType,
} from '../pix/service.js'

export type CreatePaymentConsentParams = {
  prisma: PrismaClient
  userId: string
  input: {
    accountId: string
    amount: Prisma.Decimal
    description?: string
    creditorName: string
    creditorDocument?: string
    creditorKey: { type: PixKeyType; value: string }
    externalConsentId?: string
  }
}

export type SubmitPaymentParams = {
  prisma: PrismaClient
  userId: string
  consentId: string
}

export async function createPaymentConsent(params: CreatePaymentConsentParams): Promise<{
  consentId: string
  status: string
}> {
  const { prisma, userId, input } = params

  const account = await prisma.account.findFirst({
    where: { id: input.accountId, customer: { is: { userId } } },
  })
  if (!account) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

  const creditorKeyValue = normalizePixKey(input.creditorKey.type, input.creditorKey.value)
  validatePixKey(input.creditorKey.type, creditorKeyValue)

  const customer = await prisma.customer.findUnique({ where: { userId } })
  if (!customer) throw new AppError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND')

  const consent = await prisma.paymentConsent.create({
    data: {
      userId,
      customerId: customer.id,
      accountId: input.accountId,
      amount: input.amount,
      description: input.description,
      creditorName: input.creditorName,
      creditorDocument: input.creditorDocument,
      creditorKeyType: input.creditorKey.type,
      creditorKeyValue,
      externalConsentId: input.externalConsentId,
      status: 'AUTHORISED',
      authorisedAt: new Date(),
    },
  })

  return { consentId: consent.id, status: consent.status }
}

export async function submitPayment(params: SubmitPaymentParams): Promise<{
  paymentId: string
  consentId: string
  endToEndId: string
  status: string
  amount: string
  balance: string
  idempotentReplay: boolean
}> {
  const { prisma, userId, consentId } = params

  const consent = await prisma.paymentConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Payment consent not found', 'CONSENT_NOT_FOUND')
  if (consent.userId !== userId) {
    throw new AppError(403, 'Consent does not belong to this user', 'CONSENT_FORBIDDEN')
  }
  if (consent.status !== 'AUTHORISED') {
    throw new AppError(409, 'Consent is not authorized', 'CONSENT_NOT_AUTHORISED')
  }

  const paymentId = randomUUID()

  const result = await executePixTransfer({
    prisma,
    sourceAccountId: consent.accountId,
    userId,
    amount: consent.amount,
    input: {
      pixKey: { type: consent.creditorKeyType, value: consent.creditorKeyValue },
      consentId: consent.id,
      description: consent.description ?? `PIX to ${consent.creditorName}`,
    },
  })

  await prisma.paymentConsent.update({
    where: { id: consent.id },
    data: {
      status: 'COMPLETED',
      paymentId,
      submittedAt: new Date(),
    },
  })

  return {
    paymentId,
    consentId: consent.id,
    endToEndId: result.transfer.endToEndId,
    status: result.transfer.status,
    amount: moneyToString(result.transfer.amount),
    balance: moneyToString(result.sourceBalanceAfter),
    idempotentReplay: result.idempotentReplay,
  }
}

export async function getPaymentConsent(
  prisma: PrismaClient,
  userId: string,
  consentId: string,
): Promise<unknown> {
  const consent = await prisma.paymentConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Payment consent not found', 'CONSENT_NOT_FOUND')
  if (consent.userId !== userId) {
    throw new AppError(403, 'Consent does not belong to this user', 'CONSENT_FORBIDDEN')
  }
  return {
    consentId: consent.id,
    status: consent.status,
    amount: moneyToString(consent.amount),
    accountId: consent.accountId,
    creditorName: consent.creditorName,
    creditorKey: { type: consent.creditorKeyType, value: consent.creditorKeyValue },
    paymentId: consent.paymentId,
    createdAt: consent.createdAt,
  }
}
