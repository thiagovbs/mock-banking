import { Prisma, PrismaClient } from '@prisma/client'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import { executePixTransfer } from '../pix/service.js'

/**
 * FIDO simplificado (Opção B): geramos challenges e derivamos uma "publicKey"
 * via HMAC. Não há validação criptográfica WebAuthn real — suficiente para a
 * demo ponta a ponta entre Iniciadora e Detentora (ambas backend).
 */

const FIDO_RP_ID = 'sensedia.com'
const FIDO_RP_NAME = 'ITP Open Finance'

function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function derivePublicKey(secret: string, userId: string, credentialId: string): string {
  return hmac(secret, `${userId}:${credentialId}`)
}

// ---------------------------------------------------------------------------
// Enrollment de dispositivo (ITP)
// ---------------------------------------------------------------------------

export async function createEnrollment(prisma: PrismaClient, redirectUri: string) {
  const challenge = base64url(randomBytes(32))
  const requestId = randomUUID()

  const enrollment = await prisma.enrollment.create({
    data: { redirectUri, challenge, requestId },
  })

  return {
    enrollmentId: enrollment.id,
    redirectUri: enrollment.redirectUri,
    requestId: enrollment.requestId,
    fidoRegistrationOptions: {
      challenge: enrollment.challenge,
      user: { id: base64url(Buffer.from(enrollment.id)), name: 'Cooperado', displayName: 'Cooperado' },
      rp: { id: FIDO_RP_ID, name: FIDO_RP_NAME },
    },
  }
}

export async function getEnrollment(prisma: PrismaClient, enrollmentId: string) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment) throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')
  return { status: enrollment.status, enrollmentId: enrollment.id }
}

export async function accountHolderConfirmed(
  prisma: PrismaClient,
  enrollmentId: string,
  input: { userId: string; debtorAccountNumber: string },
) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment) throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')

  // Vincula o usuário titular ao enrollment e gera o code (como no fluxo OAuth).
  const code = randomUUID()
  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: {
      userId: input.userId,
      code,
      status: 'ACCOUNT_HOLDER_CONFIRMED',
    },
  })

  // A iniciadora segue o Location para obter o code+state (redirect simulado).
  const location =
    `${enrollment.redirectUri}?code=${code}&state=${enrollment.requestId ?? enrollment.id}`
  return { location }
}

export async function confirmEnrollment(
  prisma: PrismaClient,
  authorizationCode: string,
  requestId: string,
) {
  const enrollment = await prisma.enrollment.findFirst({
    where: { code: authorizationCode },
  })
  if (!enrollment) throw new AppError(400, 'Invalid authorization code', 'INVALID_AUTH_CODE')

  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: { used: true },
  })

  return {
    fidoRegistrationOptions: {
      challenge: enrollment.challenge,
      user: { id: base64url(Buffer.from(enrollment.id)), name: 'Cooperado', displayName: 'Cooperado' },
      rp: { id: FIDO_RP_ID, name: FIDO_RP_NAME },
    },
  }
}

export async function registerFidoCredential(
  prisma: PrismaClient,
  secret: string,
  enrollmentId: string,
  fidoResponse: { id: string; rawId?: string },
) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment) throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')
  if (!enrollment.userId) throw new AppError(400, 'Enrollment has no user', 'ENROLLMENT_NO_USER')

  const credentialId = fidoResponse.rawId || fidoResponse.id
  const publicKey = derivePublicKey(secret, enrollment.userId, credentialId)

  await prisma.fidoCredential.create({
    data: {
      userId: enrollment.userId,
      enrollmentId,
      credentialId,
      publicKey,
    },
  })

  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: { status: 'FIDO_REGISTERED' },
  })
}

// ---------------------------------------------------------------------------
// Pagamento JSR (PISP v5)
// ---------------------------------------------------------------------------

export async function createJsConsent(
  prisma: PrismaClient,
  input: {
    accountId: string
    userId: string
    customerId: string
    amount: Prisma.Decimal
    creditorName: string
    creditorDocument?: string
    creditorKey: { type: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP'; value: string }
    description?: string
  },
) {
  const fidoChallenge = base64url(randomBytes(32))

  const consent = await prisma.paymentConsent.create({
    data: {
      userId: input.userId,
      customerId: input.customerId,
      accountId: input.accountId,
      amount: input.amount,
      description: input.description,
      creditorName: input.creditorName,
      creditorDocument: input.creditorDocument,
      creditorKeyType: input.creditorKey.type,
      creditorKeyValue: input.creditorKey.value,
      status: 'CREATED',
      authorisationFlow: 'FIDO_FLOW',
      fidoChallenge,
    },
  })

  return { consentId: consent.id, fidoChallenge }
}

export async function authoriseJsConsent(
  prisma: PrismaClient,
  consentId: string,
  body: { credentialId?: string; challenge?: string },
) {
  const consent = await prisma.paymentConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Consent not found', 'CONSENT_NOT_FOUND')
  if (consent.status !== 'CREATED') {
    throw new AppError(409, 'Consent is not awaiting authorisation', 'CONSENT_NOT_PENDING')
  }

  // Validação FIDO simplificada: a credencial deve existir para o usuário e o
  // challenge deve bater com o do consentimento.
  if (!body.credentialId) {
    throw new AppError(400, 'Missing credentialId', 'FIDO_ASSERTION_INVALID')
  }
  const credential = await prisma.fidoCredential.findFirst({
    where: { userId: consent.userId, credentialId: body.credentialId },
  })
  if (!credential) {
    throw new AppError(400, 'Unknown credential', 'FIDO_ASSERTION_INVALID')
  }
  if (body.challenge && body.challenge !== consent.fidoChallenge) {
    throw new AppError(400, 'Challenge mismatch', 'FIDO_CHALLENGE_MISMATCH')
  }

  await prisma.paymentConsent.update({
    where: { id: consentId },
    data: { status: 'AUTHORISED', authorisedAt: new Date() },
  })
}

export async function initiateJsPayment(
  prisma: PrismaClient,
  userId: string,
  consentId: string,
) {
  const consent = await prisma.paymentConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Consent not found', 'CONSENT_NOT_FOUND')
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
    data: { status: 'COMPLETED', paymentId, submittedAt: new Date() },
  })

  return {
    paymentId,
    consentId: consent.id,
    endToEndId: result.transfer.endToEndId,
    status: result.transfer.status,
    amount: moneyToString(result.transfer.amount),
    balance: moneyToString(result.sourceBalanceAfter),
  }
}

export async function getJsPaymentStatus(prisma: PrismaClient, paymentId: string) {
  const consent = await prisma.paymentConsent.findFirst({ where: { paymentId } })
  if (!consent) throw new AppError(404, 'Payment not found', 'PAYMENT_NOT_FOUND')
  return {
    consentId: consent.id,
    status: consent.status,
    paymentId: consent.paymentId,
    amount: moneyToString(consent.amount),
    createdAt: consent.createdAt,
  }
}
