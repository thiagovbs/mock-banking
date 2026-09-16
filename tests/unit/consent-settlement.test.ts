import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { createMockPrisma, MockPrismaClient } from '../helpers/mock-prisma.js'
import { settlePaymentConsent } from '../../src/modules/payments/consent.js'
import { AppError } from '../../src/shared/errors.js'

const CONSENT_ID = 'consent-1'

function consentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONSENT_ID,
    userId: 'user-1',
    customerId: 'cust-1',
    accountId: 'acc-source',
    amount: new Prisma.Decimal('25.00'),
    description: null,
    creditorName: 'Beneficiario',
    creditorKeyType: 'EMAIL',
    creditorKeyValue: 'destino@example.com',
    status: 'AUTHORISED',
    paymentId: null,
    ...overrides,
  }
}

describe('settlePaymentConsent', () => {
  let mock: MockPrismaClient

  /** Arranges a successful PIX transfer for the consent. */
  function arrangeTransfer() {
    mock.account.findFirst.mockResolvedValue({
      id: 'acc-source',
      customerId: 'cust-1',
      status: 'ACTIVE',
      balance: new Prisma.Decimal('500.00'),
    })
    mock.pixKey.findFirst.mockResolvedValue({
      id: 'key-dest',
      accountId: 'acc-dest',
      type: 'EMAIL',
      value: 'destino@example.com',
      status: 'ACTIVE',
    })
    mock.pixTransfer.findUnique.mockResolvedValue(null)
    mock.$queryRaw.mockResolvedValue([
      { id: 'acc-source', customerId: 'cust-1', status: 'ACTIVE', balance: new Prisma.Decimal('500.00') },
      { id: 'acc-dest', customerId: 'cust-2', status: 'ACTIVE', balance: new Prisma.Decimal('100.00') },
    ])
    mock.transaction.create
      .mockResolvedValueOnce({ id: 'tx-debit', balanceAfter: new Prisma.Decimal('475.00') })
      .mockResolvedValueOnce({ id: 'tx-credit', balanceAfter: new Prisma.Decimal('125.00') })
    mock.pixTransfer.create.mockResolvedValue({
      id: 'transfer-1',
      endToEndId: 'E000000002026010100000000000000000000000',
      consentId: CONSENT_ID,
      enrollmentId: null,
      status: 'COMPLETED',
      amount: new Prisma.Decimal('25.00'),
      debitTransactionId: 'tx-debit',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    mock.account.update.mockResolvedValue({})
    mock.paymentConsent.updateMany.mockResolvedValue({ count: 1 })
    mock.paymentConsent.update.mockResolvedValue({})
  }

  beforeEach(() => {
    mock = createMockPrisma()
  })

  describe('documento declarado do recebedor', () => {
    /** Titular real da chave de destino. */
    function arrangeDestinationHolder(document: string) {
      mock.account.findUnique.mockResolvedValue({
        id: 'acc-dest',
        customer: { id: 'cust-2', document },
      })
    }

    it('liquida quando o documento declarado e o do dono da chave', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ creditorDocument: '987.654.321-00' }),
      )
      arrangeTransfer()
      // Mascara no consentimento, digitos no cadastro: a comparacao normaliza.
      arrangeDestinationHolder('98765432100')

      const result = await settlePaymentConsent(mock as never, CONSENT_ID)

      expect(result.endToEndId).toBeTruthy()
    })

    it('recusa quando a chave e de outro titular', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ creditorDocument: '11111111111' }),
      )
      arrangeTransfer()
      arrangeDestinationHolder('98765432100')

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toMatchObject({
        statusCode: 422,
        code: 'CREDITOR_MISMATCH',
      })
      // Nada de dinheiro se move quando o recebedor nao confere.
      expect(mock.pixTransfer.create).not.toHaveBeenCalled()
      expect(mock.transaction.create).not.toHaveBeenCalled()
    })

    it('recusa quando a conta de destino nao tem titular identificavel', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ creditorDocument: '98765432100' }),
      )
      arrangeTransfer()
      mock.account.findUnique.mockResolvedValue(null)

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toMatchObject({
        code: 'CREDITOR_MISMATCH',
      })
    })

    it('segue sem conferencia quando nenhum documento foi declarado', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow({ creditorDocument: null }))
      arrangeTransfer()

      const result = await settlePaymentConsent(mock as never, CONSENT_ID)

      expect(result.endToEndId).toBeTruthy()
      expect(mock.account.findUnique).not.toHaveBeenCalled()
    })
  })

  it('settles an authorised consent', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
    arrangeTransfer()

    const result = await settlePaymentConsent(mock as never, CONSENT_ID)

    expect(result.endToEndId).toBe('E000000002026010100000000000000000000000')
    expect(result.amount).toBe('25.00')
    expect(result.idempotentReplay).toBe(false)
  })

  // The paymentId is the lookup key for the payment. Persisting it only after
  // the transfer meant a failure in between handed the caller an identifier
  // that never reached the database.
  it('persists the paymentId before moving any money', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
    arrangeTransfer()

    const result = await settlePaymentConsent(mock as never, CONSENT_ID)

    const claim = mock.paymentConsent.updateMany.mock.calls[0][0]
    expect(claim.data.paymentId).toBe(result.paymentId)
    expect(claim.data.status).toBe('PAYMENT_SUBMITTED')
    // The reservation happened before the transfer wrote anything.
    expect(mock.paymentConsent.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(mock.pixTransfer.create.mock.invocationCallOrder[0])
  })

  it('reserves the consent by status, so a concurrent call loses the race', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
    arrangeTransfer()

    await settlePaymentConsent(mock as never, CONSENT_ID)

    expect(mock.paymentConsent.updateMany.mock.calls[0][0].where).toEqual({
      id: CONSENT_ID,
      status: 'AUTHORISED',
    })
  })

  it('rejects when another call already reserved the consent', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
    arrangeTransfer()
    mock.paymentConsent.updateMany.mockResolvedValue({ count: 0 })

    await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)
    expect(mock.pixTransfer.create).not.toHaveBeenCalled()
  })

  // An attempt interrupted after the reservation must be completable, keeping
  // the paymentId the caller already received.
  it('resumes a PAYMENT_SUBMITTED consent without a new reservation', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(
      consentRow({ status: 'PAYMENT_SUBMITTED', paymentId: 'pay-existing' }),
    )
    arrangeTransfer()

    const result = await settlePaymentConsent(mock as never, CONSENT_ID)

    expect(result.paymentId).toBe('pay-existing')
    expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
  })

  it('marks the consent COMPLETED once the transfer lands', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
    arrangeTransfer()

    await settlePaymentConsent(mock as never, CONSENT_ID)

    expect(mock.paymentConsent.update).toHaveBeenCalledWith({
      where: { id: CONSENT_ID },
      data: { status: 'COMPLETED' },
    })
  })

  it.each([['CREATED'], ['COMPLETED'], ['EXPIRED']])(
    'refuses a consent in status %s',
    async (status) => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow({ status }))

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)
      expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
    },
  )

  it('refuses a consent owned by another user when an owner is required', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())

    await expect(
      settlePaymentConsent(mock as never, CONSENT_ID, { requireUserId: 'someone-else' }),
    ).rejects.toThrow(AppError)
  })

  it('does not check ownership when no owner is required (JSR path)', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
    arrangeTransfer()

    await expect(settlePaymentConsent(mock as never, CONSENT_ID)).resolves.toBeDefined()
  })

  it('reports 404 for an unknown consent', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(null)

    await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)
  })
})
