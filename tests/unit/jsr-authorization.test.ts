import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { createMockPrisma, MockPrismaClient } from '../helpers/mock-prisma.js'
import {
  authoriseJsConsent,
  createJsConsent,
  revokeEnrollment,
} from '../../src/modules/jsr/service.js'
import { signFidoAssertion } from '../../src/modules/jsr/assertion.js'
import { settlePaymentConsent } from '../../src/modules/payments/consent.js'
import { AppError } from '../../src/shared/errors.js'

const SECRET = 'initiator-test-secret'
const ENROLLMENT_ID = 'enroll-1'
const CONSENT_ID = 'consent-1'
const CREDENTIAL_ID = 'credential-xpto'
const CHALLENGE = 'challenge-abc'

function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENROLLMENT_ID,
    userId: 'user-1',
    accountId: 'acc-bound',
    status: 'FIDO_REGISTERED',
    revokedAt: null,
    used: true,
    ...overrides,
  }
}

function consentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONSENT_ID,
    userId: 'user-1',
    customerId: 'cust-1',
    accountId: 'acc-bound',
    enrollmentId: ENROLLMENT_ID,
    amount: new Prisma.Decimal('25.00'),
    description: null,
    creditorName: 'Beneficiario',
    creditorKeyType: 'EMAIL',
    creditorKeyValue: 'destino@example.com',
    status: 'CREATED',
    fidoChallenge: CHALLENGE,
    paymentId: null,
    ...overrides,
  }
}

function validSignature() {
  return signFidoAssertion(SECRET, {
    consentId: CONSENT_ID,
    credentialId: CREDENTIAL_ID,
    challenge: CHALLENGE,
  })
}

describe('createJsConsent', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
    mock.account.findFirst.mockResolvedValue({
      id: 'acc-bound',
      customer: { id: 'cust-1', userId: 'user-1' },
    })
    mock.paymentConsent.create.mockResolvedValue(consentRow())
  })

  const base = {
    enrollmentId: ENROLLMENT_ID,
    amount: new Prisma.Decimal('25.00'),
    creditorName: 'Beneficiario',
    creditorKey: { type: 'EMAIL' as const, value: 'destino@example.com' },
  }

  // The account used to come from the request body, so whoever held the
  // initiator key chose which account to debit.
  it('takes the account from the enrollment, not from the caller', async () => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow())

    const result = await createJsConsent(mock as never, base)

    expect(result.accountId).toBe('acc-bound')
    expect(mock.paymentConsent.create.mock.calls[0][0].data).toMatchObject({
      accountId: 'acc-bound',
      userId: 'user-1',
      enrollmentId: ENROLLMENT_ID,
    })
  })

  it('rejects an accountId that diverges from the enrollment', async () => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow())

    await expect(
      createJsConsent(mock as never, { ...base, expectedAccountId: 'acc-someone-else' }),
    ).rejects.toThrow(AppError)
    expect(mock.paymentConsent.create).not.toHaveBeenCalled()
  })

  it('accepts an accountId that matches the enrollment', async () => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow())

    await expect(
      createJsConsent(mock as never, { ...base, expectedAccountId: 'acc-bound' }),
    ).resolves.toBeDefined()
  })

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['without a registered device', { status: 'ACCOUNT_HOLDER_CONFIRMED' }],
    ['without a bound account', { accountId: null }],
  ])('refuses an enrollment %s', async (_label, overrides) => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow(overrides))

    await expect(createJsConsent(mock as never, base)).rejects.toThrow(AppError)
    expect(mock.paymentConsent.create).not.toHaveBeenCalled()
  })
})

describe('authoriseJsConsent', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow())
    mock.fidoCredential.findFirst.mockResolvedValue({
      id: 'cred-row-1',
      credentialId: CREDENTIAL_ID,
      userId: 'user-1',
      enrollmentId: ENROLLMENT_ID,
    })
    mock.paymentConsent.updateMany.mockResolvedValue({ count: 1 })
  })

  function authorise(body: Record<string, unknown>) {
    return authoriseJsConsent(mock as never, SECRET, CONSENT_ID, body)
  }

  it('authorises with a matching challenge and signature', async () => {
    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: CHALLENGE, signature: validSignature() }),
    ).resolves.toBeUndefined()

    expect(mock.paymentConsent.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'AUTHORISED',
      fidoCredentialId: 'cred-row-1',
      // Single-use: clearing it stops the same challenge authorising again.
      fidoChallenge: null,
    })
  })

  // The challenge check used to be `if (body.challenge && ...)`, so omitting the
  // field skipped verification entirely.
  it('refuses when the challenge is omitted', async () => {
    await expect(
      authorise({ credentialId: CREDENTIAL_ID, signature: validSignature() }),
    ).rejects.toThrow(AppError)
    expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a wrong challenge', async () => {
    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: 'other', signature: validSignature() }),
    ).rejects.toThrow(AppError)
  })

  it('refuses when the signature is missing', async () => {
    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: CHALLENGE }),
    ).rejects.toThrow(AppError)
  })

  it('refuses a signature produced with another secret', async () => {
    const forged = signFidoAssertion('another-secret', {
      consentId: CONSENT_ID,
      credentialId: CREDENTIAL_ID,
      challenge: CHALLENGE,
    })

    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: CHALLENGE, signature: forged }),
    ).rejects.toThrow(AppError)
  })

  // The signature binds the consent, so one valid assertion cannot authorise a
  // different consent.
  it('refuses a signature bound to another consent', async () => {
    const otherConsent = signFidoAssertion(SECRET, {
      consentId: 'consent-other',
      credentialId: CREDENTIAL_ID,
      challenge: CHALLENGE,
    })

    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: CHALLENGE, signature: otherConsent }),
    ).rejects.toThrow(AppError)
  })

  // It used to accept any credential belonging to the user.
  it('refuses a credential from another enrollment', async () => {
    mock.fidoCredential.findFirst.mockResolvedValue(null)

    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: CHALLENGE, signature: validSignature() }),
    ).rejects.toThrow(AppError)

    expect(mock.fidoCredential.findFirst.mock.calls[0][0].where).toEqual({
      credentialId: CREDENTIAL_ID,
      userId: 'user-1',
      enrollmentId: ENROLLMENT_ID,
    })
  })

  it('refuses when the device was revoked meanwhile', async () => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow({ revokedAt: new Date() }))

    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: CHALLENGE, signature: validSignature() }),
    ).rejects.toThrow(AppError)
  })

  it('refuses a consent not bound to any enrollment', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow({ enrollmentId: null }))

    await expect(
      authorise({ credentialId: CREDENTIAL_ID, challenge: CHALLENGE, signature: validSignature() }),
    ).rejects.toThrow(AppError)
  })
})

describe('revokeEnrollment', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
  })

  it('records the revocation timestamp', async () => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow())
    mock.enrollment.update.mockResolvedValue({})

    const result = await revokeEnrollment(mock as never, ENROLLMENT_ID)

    expect(result.alreadyRevoked).toBe(false)
    expect(mock.enrollment.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date)
  })

  it('is idempotent', async () => {
    const revokedAt = new Date('2026-01-01T00:00:00Z')
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow({ revokedAt }))

    const result = await revokeEnrollment(mock as never, ENROLLMENT_ID)

    expect(result).toEqual({ enrollmentId: ENROLLMENT_ID, revokedAt, alreadyRevoked: true })
    expect(mock.enrollment.update).not.toHaveBeenCalled()
  })

  it('reports 404 for an unknown enrollment', async () => {
    mock.enrollment.findUnique.mockResolvedValue(null)

    await expect(revokeEnrollment(mock as never, ENROLLMENT_ID)).rejects.toThrow(AppError)
  })
})

// A device revoked between authorisation and settlement must not be able to
// move money on the strength of the older authorisation.
describe('settlement after revocation', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow({ status: 'AUTHORISED' }))
  })

  it('refuses to settle when the enrollment was revoked', async () => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow({ revokedAt: new Date() }))

    await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)
    expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
  })

  it('refuses to settle when the enrollment lost its device', async () => {
    mock.enrollment.findUnique.mockResolvedValue(enrollmentRow({ status: 'ACCOUNT_HOLDER_CONFIRMED' }))

    await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)
  })
})
