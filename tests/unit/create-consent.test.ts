import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { createMockPrisma, MockPrismaClient } from '../helpers/mock-prisma.js'
import { createPaymentConsentRecord } from '../../src/modules/payments/create-consent.js'
import { AppError } from '../../src/shared/errors.js'

/**
 * Antes cada jornada tinha o seu `paymentConsent.create`, e as regras de entrada
 * divergiram: a do redirecionamento normalizava e validava a chave PIX e recusava
 * valor nao positivo; a JSR gravava a chave como veio e so descobria o problema
 * na liquidacao, com o consentimento ja criado e autorizado.
 */

const HOLDER = { userId: 'user-1', customerId: 'cust-1', accountId: 'acc-1' }

describe('createPaymentConsentRecord', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
    mock.paymentConsent.create.mockImplementation(async ({ data }: any) => ({
      id: 'consent-1',
      ...data,
    }))
    mock.paymentConsentEvent.create.mockResolvedValue({})
  })

  function input(overrides: Record<string, unknown> = {}) {
    return {
      flow: 'REDIRECT_FLOW' as const,
      amount: new Prisma.Decimal('25.00'),
      creditorName: 'Beneficiario',
      creditorKey: { type: 'CPF' as const, value: '016.881.663-60' },
      ...overrides,
    }
  }

  describe('estado inicial deriva da jornada', () => {
    it('com redirecionamento nasce esperando uma pessoa', async () => {
      await createPaymentConsentRecord(mock as never, input())

      const data = mock.paymentConsent.create.mock.calls[0][0].data
      expect(data.status).toBe('AWAITING_AUTHORISATION')
      expect(data.authorisationFlow).toBe('REDIRECT_FLOW')
      // Titular e conta so se sabem na aprovacao.
      expect(data.userId).toBeUndefined()
      expect(data.accountId).toBeUndefined()
    })

    it('na JSR nasce esperando a assertion do dispositivo', async () => {
      await createPaymentConsentRecord(
        mock as never,
        input({ flow: 'FIDO_FLOW', holder: HOLDER, enrollmentId: 'enr-1', fidoChallenge: 'ch' }),
      )

      const data = mock.paymentConsent.create.mock.calls[0][0].data
      expect(data.status).toBe('CREATED')
      expect(data.authorisationFlow).toBe('FIDO_FLOW')
      // O enrollment ja entregou titular e conta.
      expect(data.userId).toBe(HOLDER.userId)
      expect(data.accountId).toBe(HOLDER.accountId)
      expect(data.enrollmentId).toBe('enr-1')
    })

    it('nenhuma jornada nasce autorizada', async () => {
      for (const flow of ['REDIRECT_FLOW', 'FIDO_FLOW'] as const) {
        mock.paymentConsent.create.mockClear()
        await createPaymentConsentRecord(
          mock as never,
          input({ flow, ...(flow === 'FIDO_FLOW' ? { holder: HOLDER } : {}) }),
        )
        expect(mock.paymentConsent.create.mock.calls[0][0].data.status).not.toBe('AUTHORISED')
      }
    })
  })

  describe('a chave do credor passa pelo mesmo crivo nas duas', () => {
    it.each([['REDIRECT_FLOW'], ['FIDO_FLOW']] as const)(
      'normaliza a chave em %s',
      async (flow) => {
        await createPaymentConsentRecord(
          mock as never,
          input({ flow, ...(flow === 'FIDO_FLOW' ? { holder: HOLDER } : {}) }),
        )

        // Mascara na entrada, digitos na base -- e assim que a liquidacao procura.
        expect(mock.paymentConsent.create.mock.calls[0][0].data.creditorKeyValue).toBe(
          '01688166360',
        )
      },
    )

    it.each([['REDIRECT_FLOW'], ['FIDO_FLOW']] as const)(
      'recusa chave invalida em %s, antes de criar',
      async (flow) => {
        await expect(
          createPaymentConsentRecord(
            mock as never,
            input({
              flow,
              creditorKey: { type: 'CPF', value: '123' },
              ...(flow === 'FIDO_FLOW' ? { holder: HOLDER } : {}),
            }),
          ),
        ).rejects.toMatchObject({ code: 'INVALID_PIX_KEY' })

        // A JSR so descobria isso na liquidacao, com o consentimento ja criado.
        expect(mock.paymentConsent.create).not.toHaveBeenCalled()
      },
    )

    it.each([['REDIRECT_FLOW'], ['FIDO_FLOW']] as const)(
      'recusa valor nao positivo em %s',
      async (flow) => {
        await expect(
          createPaymentConsentRecord(
            mock as never,
            input({
              flow,
              amount: new Prisma.Decimal('0'),
              ...(flow === 'FIDO_FLOW' ? { holder: HOLDER } : {}),
            }),
          ),
        ).rejects.toThrow(AppError)

        expect(mock.paymentConsent.create).not.toHaveBeenCalled()
      },
    )
  })

  describe('trilha', () => {
    it('registra a criacao com a jornada de origem', async () => {
      await createPaymentConsentRecord(
        mock as never,
        input({ flow: 'FIDO_FLOW', holder: HOLDER, enrollmentId: 'enr-1' }),
      )

      expect(mock.paymentConsentEvent.create.mock.calls[0][0].data).toMatchObject({
        event: 'CONSENT_CREATED',
        actor: 'INITIATOR',
        statusAfter: 'CREATED',
      })
      const detail = mock.paymentConsentEvent.create.mock.calls[0][0].data.detail
      expect(detail).toMatchObject({ flow: 'FIDO_FLOW', enrollmentId: 'enr-1' })
    })
  })

  it('normaliza o CPF do pagador quando enderecado', async () => {
    await createPaymentConsentRecord(mock as never, input({ debtorDocument: '123.456.789-01' }))

    expect(mock.paymentConsent.create.mock.calls[0][0].data.debtorDocument).toBe('12345678901')
  })
})
