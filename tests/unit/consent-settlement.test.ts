import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
      data: { status: 'COMPLETED', statusUpdatedAt: expect.any(Date) },
    })
  })

  it.each([['CREATED'], ['EXPIRED'], ['AWAITING_AUTHORISATION'], ['REJECTED']])(
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

  /**
   * Uma Iniciadora que reenvia apos timeout precisa saber que deu certo. Antes,
   * repetir um consentimento liquidado respondia "Consent is not authorized" --
   * mandando procurar um problema de autorizacao num pagamento que ja foi pago.
   */
  describe('consentimento ja liquidado', () => {
    function arrangeCompleted(overrides: Record<string, unknown> = {}) {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ status: 'COMPLETED', paymentId: 'pay-original', ...overrides }),
      )
      mock.pixTransfer.findUnique.mockResolvedValue({
        id: 'transfer-1',
        consentId: CONSENT_ID,
        endToEndId: 'E000000002026010100000000000000000000000',
        status: 'COMPLETED',
        amount: new Prisma.Decimal('25.00'),
      })
      mock.account.findUnique.mockResolvedValue({
        id: 'acc-source',
        balance: new Prisma.Decimal('475.00'),
      })
      mock.paymentConsentEvent.create.mockResolvedValue({})
    }

    it('devolve o pagamento existente como replay, sem debitar de novo', async () => {
      arrangeCompleted()

      const result = await settlePaymentConsent(mock as never, CONSENT_ID)

      expect(result.idempotentReplay).toBe(true)
      expect(result.paymentId).toBe('pay-original')
      expect(result.endToEndId).toBe('E000000002026010100000000000000000000000')
      expect(result.amount).toBe('25.00')
      // Nada se move, e o consentimento nao e reescrito.
      expect(mock.pixTransfer.create).not.toHaveBeenCalled()
      expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
      expect(mock.paymentConsent.update).not.toHaveBeenCalled()
    })

    it('registra o replay na trilha', async () => {
      arrangeCompleted()

      await settlePaymentConsent(mock as never, CONSENT_ID)

      expect(mock.paymentConsentEvent.create.mock.calls[0][0].data).toMatchObject({
        event: 'PAYMENT_SUBMISSION_REPLAYED',
        outcome: 'ACCEPTED',
        statusBefore: 'COMPLETED',
        statusAfter: 'COMPLETED',
      })
    })

    it('recusa um COMPLETED sem transferencia registrada', async () => {
      // Estado inconsistente: melhor recusar que inventar um recibo.
      arrangeCompleted()
      mock.pixTransfer.findUnique.mockResolvedValue(null)

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toMatchObject({
        code: 'CONSENT_NOT_AUTHORISED',
      })
    })

    it('recusa um COMPLETED sem paymentId', async () => {
      arrangeCompleted({ paymentId: null })

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toMatchObject({
        code: 'CONSENT_NOT_AUTHORISED',
      })
    })

    it('respeita a titularidade tambem no replay', async () => {
      arrangeCompleted()

      await expect(
        settlePaymentConsent(mock as never, CONSENT_ID, { requireUserId: 'someone-else' }),
      ).rejects.toMatchObject({ code: 'CONSENT_FORBIDDEN' })
    })
  })

  it('reports 404 for an unknown consent', async () => {
    mock.paymentConsent.findUnique.mockResolvedValue(null)

    await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)
  })

  /**
   * A reserva AUTHORISED -> PAYMENT_SUBMITTED acontece antes da transferencia,
   * para o paymentId ser consultavel. Sem desfaze-la, um consentimento cuja
   * liquidacao falha por motivo permanente ficava preso: nao liquidava, porque
   * o motivo nao muda, e nao podia ser recusado, porque a recusa so aceita
   * consentimento pendente.
   */
  describe('reserva desfeita quando a transferencia falha sem debitar', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchMock)
      mock.paymentConsentEvent.create.mockResolvedValue({})
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /** Transferencia que falha antes de escrever qualquer coisa. */
    function arrangeUnresolvableKey() {
      mock.account.findFirst.mockResolvedValue({
        id: 'acc-source',
        customerId: 'cust-1',
        status: 'ACTIVE',
        balance: new Prisma.Decimal('500.00'),
      })
      mock.pixKey.findFirst.mockResolvedValue(null)
      mock.pixTransfer.findUnique.mockResolvedValue(null)
      mock.paymentConsent.updateMany.mockResolvedValue({ count: 1 })
    }

    it('devolve o consentimento para AUTHORISED e limpa o paymentId', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
      arrangeUnresolvableKey()

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)

      const release = mock.paymentConsent.updateMany.mock.calls.at(-1)[0]
      expect(release.data).toMatchObject({
        status: 'AUTHORISED',
        paymentId: null,
        submittedAt: null,
      })
      // O paymentId no where amarra o desfazer a reserva desta chamada.
      expect(release.where).toMatchObject({ id: CONSENT_ID, status: 'PAYMENT_SUBMITTED' })
      expect(release.where.paymentId).toBeTruthy()
    })

    it('registra o desfazer na trilha', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
      arrangeUnresolvableKey()

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)

      const eventos = mock.paymentConsentEvent.create.mock.calls.map((call) => call[0].data)
      expect(eventos).toContainEqual(
        expect.objectContaining({
          event: 'PAYMENT_SUBMISSION_RELEASED',
          statusBefore: 'PAYMENT_SUBMITTED',
          statusAfter: 'AUTHORISED',
        }),
      )
    })

    it('nao avisa a Iniciadora do desfazer, para nao gerar laco de retentativa', async () => {
      // O webhook diria "AUTHORISED", a Iniciadora submeteria de novo, falharia
      // de novo, e o desfazer avisaria de novo.
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ webhookUri: 'http://initiator.local/webhooks/consents' }),
      )
      arrangeUnresolvableKey()

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)

      const avisos = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).status)
      expect(avisos).not.toContain('AUTHORISED')
    })

    it('mantem PAYMENT_SUBMITTED quando a transferencia ja tinha commitado', async () => {
      // Dinheiro que saiu nao volta por desfazer status: manter a reserva deixa
      // a retentativa concluir, porque executePixTransfer e idempotente.
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
      arrangeTransfer()
      let commitou = false
      mock.pixTransfer.findUnique.mockImplementation(async () =>
        commitou ? { id: 'transfer-1', consentId: CONSENT_ID } : null,
      )
      mock.pixTransfer.create.mockImplementation(async () => {
        commitou = true
        return {
          id: 'transfer-1',
          endToEndId: 'E1',
          consentId: CONSENT_ID,
          status: 'COMPLETED',
          amount: new Prisma.Decimal('25.00'),
          debitTransactionId: 'tx-debit',
          createdAt: new Date(),
        }
      })
      mock.account.update.mockRejectedValue(new Error('queda depois do débito'))

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow()

      const reverteu = mock.paymentConsent.updateMany.mock.calls.some(
        (call) => call[0].data?.status === 'AUTHORISED',
      )
      expect(reverteu).toBe(false)
    })

    it('nao desfaz a reserva de outra chamada', async () => {
      // Entrou ja em PAYMENT_SUBMITTED: quem reservou foi outra tentativa,
      // possivelmente ainda em curso.
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ status: 'PAYMENT_SUBMITTED', paymentId: 'pay-de-outra-chamada' }),
      )
      arrangeUnresolvableKey()

      await expect(settlePaymentConsent(mock as never, CONSENT_ID)).rejects.toThrow(AppError)

      expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
    })
  })
})
