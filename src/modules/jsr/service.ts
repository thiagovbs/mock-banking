import { Prisma, PrismaClient } from '@prisma/client'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'
import { settlePaymentConsent } from '../payments/consent.js'
import { recordConsentEvent } from '../payments/events.js'
import { verifyFidoAssertion } from './assertion.js'

/**
 * FIDO simplificado (Opção B): geramos challenges e derivamos uma "publicKey"
 * via HMAC. Não há validação criptográfica WebAuthn real — suficiente para a
 * demo ponta a ponta entre Iniciadora e Detentora (ambas backend).
 *
 * A autorização de um consentimento exige, além disso, uma assinatura HMAC
 * sobre (consentimento, credencial, challenge). Ver assertion.ts para o que
 * essa assinatura prova e o que ela não prova.
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

export async function listAccountDevices(prisma: PrismaClient, accountNumber: string) {
  const account = await prisma.account.findFirst({
    where: { accountNumber },
    include: { customer: true },
  })
  if (!account?.customer) {
    throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')
  }

  const [enrollments, credentials] = await Promise.all([
    prisma.enrollment.findMany({
      where: { userId: account.customer.userId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.fidoCredential.findMany({
      where: { userId: account.customer.userId },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return {
    accountNumber: account.accountNumber,
    branch: account.branch,
    devices: enrollments.map((enrollment) => ({
      enrollmentId: enrollment.id,
      status: enrollment.status,
      used: enrollment.used,
      revokedAt: enrollment.revokedAt,
      active: enrollment.status === 'FIDO_REGISTERED' && enrollment.revokedAt === null,
      createdAt: enrollment.createdAt,
      credentialId:
        credentials.find((credential) => credential.enrollmentId === enrollment.id)
          ?.credentialId ?? null,
    })),
  }
}

export async function getEnrollment(prisma: PrismaClient, enrollmentId: string) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment) throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')
  return {
    status: enrollment.status,
    enrollmentId: enrollment.id,
    revokedAt: enrollment.revokedAt,
    active: enrollment.status === 'FIDO_REGISTERED' && enrollment.revokedAt === null,
  }
}

export async function accountHolderConfirmed(
  prisma: PrismaClient,
  enrollmentId: string,
  input: { userId: string; accountId: string },
) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment) throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')
  if (enrollment.revokedAt) {
    throw new AppError(409, 'Enrollment is revoked', 'ENROLLMENT_REVOKED')
  }

  // Titular e conta ficam fixados aqui. Daqui em diante a jornada inteira
  // deriva do enrollment, em vez de reaceitar esses dados pelo corpo.
  const code = randomUUID()
  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: {
      userId: input.userId,
      accountId: input.accountId,
      code,
      status: 'ACCOUNT_HOLDER_CONFIRMED',
    },
  })

  // A iniciadora segue o Location para obter o code+state (redirect simulado).
  const location =
    `${enrollment.redirectUri}?code=${code}&state=${enrollment.requestId ?? enrollment.id}`
  return { location }
}

/**
 * Carrega um enrollment apto a autorizar pagamento: dispositivo registrado,
 * não revogado, com titular e conta fixados.
 */
export async function requireActiveEnrollment(prisma: PrismaClient, enrollmentId: string) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment) throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')
  if (enrollment.revokedAt) {
    throw new AppError(409, 'Enrollment is revoked', 'ENROLLMENT_REVOKED')
  }
  if (enrollment.status !== 'FIDO_REGISTERED') {
    throw new AppError(409, 'Enrollment has no registered device', 'ENROLLMENT_NOT_REGISTERED')
  }
  if (!enrollment.userId || !enrollment.accountId) {
    throw new AppError(409, 'Enrollment has no account holder bound', 'ENROLLMENT_NOT_BOUND')
  }
  return enrollment
}

export async function revokeEnrollment(prisma: PrismaClient, enrollmentId: string) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment) throw new AppError(404, 'Enrollment not found', 'ENROLLMENT_NOT_FOUND')

  // Revogar duas vezes nao e erro: o estado final e o mesmo.
  if (enrollment.revokedAt) {
    return { enrollmentId, revokedAt: enrollment.revokedAt, alreadyRevoked: true }
  }

  const revokedAt = new Date()
  await prisma.enrollment.update({ where: { id: enrollmentId }, data: { revokedAt } })
  return { enrollmentId, revokedAt, alreadyRevoked: false }
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

  // O requestId acompanha o code desde a criacao do enrollment (e volta a
  // Iniciadora como `state`). Sem conferi-lo, um code valido era aceito em
  // qualquer contexto.
  if (enrollment.requestId !== requestId) {
    throw new AppError(400, 'Authorization code does not match the request', 'INVALID_AUTH_CODE')
  }

  // A troca e de uso unico. O `used: false` no where faz a reserva atomica,
  // entao duas trocas concorrentes com o mesmo code nao passam as duas.
  const claimed = await prisma.enrollment.updateMany({
    where: { id: enrollment.id, used: false },
    data: { used: true },
  })
  if (claimed.count === 0) {
    throw new AppError(400, 'Authorization code already used', 'AUTH_CODE_USED')
  }

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
  if (enrollment.revokedAt) {
    throw new AppError(409, 'Enrollment is revoked', 'ENROLLMENT_REVOKED')
  }
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
    enrollmentId: string
    amount: Prisma.Decimal
    creditorName: string
    creditorDocument?: string
    creditorKey: { type: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP'; value: string }
    description?: string
    /** Se a Iniciadora informar, precisa coincidir com a conta do enrollment. */
    expectedAccountId?: string
  },
) {
  const enrollment = await requireActiveEnrollment(prisma, input.enrollmentId)

  // A conta vem do enrollment. Um accountId divergente no corpo e recusado, em
  // vez de ignorado: falhar alto evita que a Iniciadora acredite ter debitado
  // uma conta diferente da que foi de fato debitada.
  if (input.expectedAccountId && input.expectedAccountId !== enrollment.accountId) {
    throw new AppError(
      400,
      'accountId does not match the account bound to this enrollment',
      'ENROLLMENT_ACCOUNT_MISMATCH',
    )
  }

  const account = await prisma.account.findFirst({
    where: { id: enrollment.accountId as string },
    include: { customer: true },
  })
  if (!account?.customer) throw new AppError(404, 'Account not found', 'ACCOUNT_NOT_FOUND')

  const fidoChallenge = base64url(randomBytes(32))

  const consent = await prisma.paymentConsent.create({
    data: {
      userId: account.customer.userId,
      customerId: account.customer.id,
      accountId: account.id,
      enrollmentId: enrollment.id,
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

  await recordConsentEvent(prisma, {
    consentId: consent.id,
    event: 'CONSENT_CREATED',
    actor: 'INITIATOR',
    statusAfter: 'CREATED',
    detail: {
      amount: moneyToString(consent.amount),
      creditorName: consent.creditorName,
      enrollmentId: enrollment.id,
      flow: 'FIDO_FLOW',
    },
  })

  return { consentId: consent.id, fidoChallenge, accountId: account.id }
}

export async function authoriseJsConsent(
  prisma: PrismaClient,
  secret: string,
  consentId: string,
  body: { credentialId?: string; challenge?: string; signature?: string },
) {
  const consent = await prisma.paymentConsent.findUnique({ where: { id: consentId } })
  if (!consent) throw new AppError(404, 'Consent not found', 'CONSENT_NOT_FOUND')

  // Mesma trilha da jornada com redirecionamento: assertion invalida, challenge
  // trocado ou dispositivo revogado viram evento REFUSED, em vez de sumirem.
  try {
    await authoriseJs(prisma, secret, consent, body)
  } catch (error) {
    if (error instanceof AppError) {
      await recordConsentEvent(prisma, {
        consentId: consent.id,
        event: 'CONSENT_AUTHORISATION',
        actor: 'HOLDER',
        actorUserId: consent.userId,
        outcome: 'REFUSED',
        reason: error.code,
        statusBefore: consent.status,
        detail: { flow: 'FIDO_FLOW', credentialId: body.credentialId ?? null },
      })
    }
    throw error
  }
}

async function authoriseJs(
  prisma: PrismaClient,
  secret: string,
  consent: any,
  body: { credentialId?: string; challenge?: string; signature?: string },
) {
  const consentId = consent.id
  if (consent.status !== 'CREATED') {
    throw new AppError(409, 'Consent is not awaiting authorisation', 'CONSENT_NOT_PENDING')
  }
  if (!consent.enrollmentId || !consent.userId) {
    throw new AppError(409, 'Consent is not bound to an enrollment', 'CONSENT_NOT_BOUND')
  }

  if (!body.credentialId) {
    throw new AppError(400, 'Missing credentialId', 'FIDO_ASSERTION_INVALID')
  }
  // O challenge deixa de ser opcional: antes, omiti-lo pulava a verificacao.
  if (!body.challenge) {
    throw new AppError(400, 'Missing challenge', 'FIDO_ASSERTION_INVALID')
  }
  if (!body.signature) {
    throw new AppError(400, 'Missing signature', 'FIDO_ASSERTION_INVALID')
  }

  // O challenge e limpo ao autorizar, entao nao serve para uma segunda
  // autorizacao.
  if (!consent.fidoChallenge || body.challenge !== consent.fidoChallenge) {
    throw new AppError(400, 'Challenge mismatch', 'FIDO_CHALLENGE_MISMATCH')
  }

  // A credencial precisa ser a do enrollment deste consentimento, e nao
  // qualquer credencial do titular.
  const credential = await prisma.fidoCredential.findFirst({
    where: {
      credentialId: body.credentialId,
      userId: consent.userId,
      enrollmentId: consent.enrollmentId,
    },
  })
  if (!credential) {
    throw new AppError(
      400,
      'Credential does not belong to this enrollment',
      'FIDO_ASSERTION_INVALID',
    )
  }

  // O dispositivo precisa continuar ativo no momento da autorizacao.
  await requireActiveEnrollment(prisma, consent.enrollmentId)

  const valid = verifyFidoAssertion(
    secret,
    { consentId: consent.id, credentialId: body.credentialId, challenge: body.challenge },
    body.signature,
  )
  if (!valid) {
    throw new AppError(400, 'Invalid assertion signature', 'FIDO_ASSERTION_INVALID')
  }

  const claimed = await prisma.paymentConsent.updateMany({
    where: { id: consentId, status: 'CREATED' },
    data: {
      status: 'AUTHORISED',
      authorisedAt: new Date(),
      fidoCredentialId: credential.id,
      fidoChallenge: null,
    },
  })
  if (claimed.count === 0) {
    throw new AppError(409, 'Consent is not awaiting authorisation', 'CONSENT_NOT_PENDING')
  }

  await recordConsentEvent(prisma, {
    consentId: consent.id,
    event: 'CONSENT_AUTHORISED',
    actor: 'HOLDER',
    actorUserId: consent.userId,
    statusBefore: 'CREATED',
    statusAfter: 'AUTHORISED',
    detail: {
      flow: 'FIDO_FLOW',
      enrollmentId: consent.enrollmentId,
      credentialId: body.credentialId,
    },
  })
}

export async function initiateJsPayment(prisma: PrismaClient, consentId: string) {
  // O titular vem do proprio consentimento; a rota JSR e autenticada pela
  // Iniciadora, nao por um usuario logado.
  return settlePaymentConsent(prisma, consentId)
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
