import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'
import { signToken } from '../helpers/token.js'

/**
 * Jornada de pagamento iniciada por terceiro, com redirecionamento.
 *
 * O que estes testes prendem: **nenhum caminho paga sem aprovacao do titular**.
 * O consentimento nasce pendente, a submissao so passa depois do AUTHORISED, e
 * quem aprova tem que ser o titular a quem o consentimento foi enderecado.
 */

const INITIATOR_KEY = 'test-only-initiator-secret'
const CONSENT_ID = '55555555-5555-4555-8555-555555555555'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const FOREIGN_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'

const HOLDER = { sub: 'user-holder', customerId: 'cust-holder', username: 'joao.silva' }
const OTHER = { sub: 'user-other', customerId: 'cust-other', username: 'maria.souza' }

const CUSTOMERS: Record<string, unknown> = {
  'cust-holder': { id: 'cust-holder', userId: 'user-holder', name: 'Joao', document: '12345678901' },
  'cust-other': { id: 'cust-other', userId: 'user-other', name: 'Maria', document: '98765432100' },
}

function consentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONSENT_ID,
    userId: null as string | null,
    customerId: null as string | null,
    accountId: null as string | null,
    debtorDocument: null as string | null,
    amount: new Prisma.Decimal('25.00'),
    description: 'Pagamento via Open Finance',
    creditorName: 'Loja Exemplo',
    creditorDocument: '11222333000181',
    creditorKeyType: 'EMAIL',
    creditorKeyValue: 'loja@example.com',
    status: 'AWAITING_AUTHORISATION',
    paymentId: null,
    authorisationFlow: 'REDIRECT_FLOW',
    fidoChallenge: null,
    enrollmentId: null,
    redirectUri: 'http://initiator.local/callback',
    createdAt: new Date('2026-09-18T12:00:00Z'),
    statusUpdatedAt: new Date('2026-09-18T12:00:00Z'),
    authorisedAt: null,
    rejectedAt: null,
    ...overrides,
  }
}

function accountRow(id = ACCOUNT_ID) {
  return {
    id,
    customerId: HOLDER.customerId,
    branch: '0001',
    accountNumber: '654321',
    balance: new Prisma.Decimal('500.00'),
    status: 'ACTIVE',
    createdAt: new Date(),
  }
}

describe('Pagamento com redirecionamento (ASPSP)', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient
  let holderToken: string
  let otherToken: string

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
    holderToken = signToken(app, HOLDER)
    otherToken = signToken(app, OTHER)

    mock.customer.findUnique.mockImplementation(async ({ where }: any) =>
      CUSTOMERS[where.id] ?? null,
    )
  })

  describe('criacao pela Iniciadora', () => {
    it('nasce pendente de aprovacao e devolve a URL onde o titular aprova', async () => {
      mock.paymentConsent.create.mockResolvedValue(consentRow())

      const response = await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments/consents',
        headers: { 'x-initiator-key': INITIATOR_KEY },
        payload: {
          amount: '25.00',
          creditorName: 'Loja Exemplo',
          creditorKey: { type: 'EMAIL', value: 'loja@example.com' },
          redirect_uri: 'http://initiator.local/callback',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.status).toBe('AWAITING_AUTHORISATION')
      expect(body.authorisationUrl).toContain(`/v1/aspsp/payments/consents/${CONSENT_ID}/authorise`)

      // Sem titular nem conta: quem paga so se sabe na aprovacao.
      const created = mock.paymentConsent.create.mock.calls[0][0].data
      expect(created.status).toBe('AWAITING_AUTHORISATION')
      expect(created.userId).toBeUndefined()
      expect(created.accountId).toBeUndefined()
    })

    it('recusa quem nao apresenta a chave da Iniciadora', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments/consents',
        payload: {
          amount: '25.00',
          creditorName: 'Loja Exemplo',
          creditorKey: { type: 'EMAIL', value: 'loja@example.com' },
        },
      })

      expect(response.statusCode).toBe(401)
      expect(mock.paymentConsent.create).not.toHaveBeenCalled()
    })
  })

  describe('submissao do pagamento', () => {
    it('recusa enquanto o titular nao aprovou', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())

      const response = await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments',
        headers: { 'x-initiator-key': INITIATOR_KEY },
        payload: { consentId: CONSENT_ID },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toBe('CONSENT_NOT_AUTHORISED')
      // Nada foi debitado.
      expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
    })

    it('recusa um consentimento recusado pelo titular', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow({ status: 'REJECTED' }))

      const response = await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments',
        headers: { 'x-initiator-key': INITIATOR_KEY },
        payload: { consentId: CONSENT_ID },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toBe('CONSENT_NOT_AUTHORISED')
    })

    it('recusa um AUTHORISED sem conta vinculada', async () => {
      // Estado impossivel pela API, mas que antes debitaria: sem accountId nao
      // ha de onde tirar o dinheiro.
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ status: 'AUTHORISED', accountId: null, userId: null }),
      )

      const response = await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments',
        headers: { 'x-initiator-key': INITIATOR_KEY },
        payload: { consentId: CONSENT_ID },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toBe('CONSENT_NOT_BOUND')
    })
  })

  describe('aprovacao pelo titular', () => {
    it('fixa titular e conta, e move para AUTHORISED', async () => {
      mock.paymentConsent.findUnique
        .mockResolvedValueOnce(consentRow())
        .mockResolvedValueOnce(
          consentRow({
            status: 'AUTHORISED',
            userId: HOLDER.sub,
            customerId: HOLDER.customerId,
            accountId: ACCOUNT_ID,
            authorisedAt: new Date(),
          }),
        )
      mock.account.findFirst.mockResolvedValue(accountRow())
      mock.paymentConsent.updateMany.mockResolvedValue({ count: 1 })

      const response = await app.inject({
        method: 'POST',
        url: `/v1/me/payment-consents/${CONSENT_ID}/authorise`,
        headers: { authorization: `Bearer ${holderToken}` },
        payload: { accountId: ACCOUNT_ID },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().status).toBe('AUTHORISED')
      expect(response.json().accountId).toBe(ACCOUNT_ID)

      const update = mock.paymentConsent.updateMany.mock.calls[0][0]
      // A reserva atomica: duas confirmacoes concorrentes, so uma passa.
      expect(update.where).toMatchObject({ status: 'AWAITING_AUTHORISATION' })
      expect(update.data).toMatchObject({
        status: 'AUTHORISED',
        userId: HOLDER.sub,
        accountId: ACCOUNT_ID,
      })
    })

    it('recusa quem nao e o titular a quem o consentimento foi enderecado', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ debtorDocument: '12345678901' }),
      )

      const response = await app.inject({
        method: 'POST',
        url: `/v1/me/payment-consents/${CONSENT_ID}/authorise`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { accountId: ACCOUNT_ID },
      })

      expect(response.statusCode).toBe(403)
      expect(response.json().error).toBe('CONSENT_HOLDER_MISMATCH')
      expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
    })

    it('recusa conta que nao e do titular', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
      // A titularidade entra na query: conta de terceiro nao aparece.
      mock.account.findFirst.mockResolvedValue(null)

      const response = await app.inject({
        method: 'POST',
        url: `/v1/me/payment-consents/${CONSENT_ID}/authorise`,
        headers: { authorization: `Bearer ${holderToken}` },
        payload: { accountId: FOREIGN_ACCOUNT_ID },
      })

      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('ACCOUNT_NOT_FOUND')
      expect(mock.paymentConsent.updateMany).not.toHaveBeenCalled()
    })

    it('nao aprova duas vezes', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ status: 'AUTHORISED', accountId: ACCOUNT_ID, userId: HOLDER.sub }),
      )

      const response = await app.inject({
        method: 'POST',
        url: `/v1/me/payment-consents/${CONSENT_ID}/authorise`,
        headers: { authorization: `Bearer ${holderToken}` },
        payload: { accountId: ACCOUNT_ID },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toBe('CONSENT_NOT_AWAITING_AUTHORISATION')
    })
  })

  describe('recusa pelo titular', () => {
    it('move para REJECTED', async () => {
      mock.paymentConsent.findUnique
        .mockResolvedValueOnce(consentRow())
        .mockResolvedValueOnce(consentRow({ status: 'REJECTED', rejectedAt: new Date() }))
      mock.paymentConsent.updateMany.mockResolvedValue({ count: 1 })

      const response = await app.inject({
        method: 'POST',
        url: `/v1/me/payment-consents/${CONSENT_ID}/reject`,
        headers: { authorization: `Bearer ${holderToken}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().status).toBe('REJECTED')
    })

    it('nao desfaz um pagamento ja liquidado', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ status: 'COMPLETED', accountId: ACCOUNT_ID, userId: HOLDER.sub }),
      )

      const response = await app.inject({
        method: 'POST',
        url: `/v1/me/payment-consents/${CONSENT_ID}/reject`,
        headers: { authorization: `Bearer ${holderToken}` },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toBe('CONSENT_NOT_REJECTABLE')
    })
  })

  describe('trilha de eventos', () => {
    it('registra a criacao do consentimento', async () => {
      mock.paymentConsent.create.mockResolvedValue(consentRow())
      mock.paymentConsentEvent.create.mockResolvedValue({})

      await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments/consents',
        headers: { 'x-initiator-key': INITIATOR_KEY },
        payload: {
          amount: '25.00',
          creditorName: 'Loja Exemplo',
          creditorKey: { type: 'EMAIL', value: 'loja@example.com' },
        },
      })

      expect(mock.paymentConsentEvent.create.mock.calls[0][0].data).toMatchObject({
        consentId: CONSENT_ID,
        event: 'CONSENT_CREATED',
        actor: 'INITIATOR',
        statusAfter: 'AWAITING_AUTHORISATION',
      })
    })

    it('registra a submissao recusada, que nao muda nada no consentimento', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
      mock.paymentConsentEvent.create.mockResolvedValue({})

      const response = await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments',
        headers: { 'x-initiator-key': INITIATOR_KEY },
        payload: { consentId: CONSENT_ID },
      })

      expect(response.statusCode).toBe(409)
      expect(mock.paymentConsentEvent.create.mock.calls[0][0].data).toMatchObject({
        event: 'PAYMENT_SUBMISSION',
        outcome: 'REFUSED',
        reason: 'CONSENT_NOT_AUTHORISED',
        statusBefore: 'AWAITING_AUTHORISATION',
      })
    })

    it('registra a aprovacao recusada por CPF divergente', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(
        consentRow({ debtorDocument: '12345678901' }),
      )
      mock.paymentConsentEvent.create.mockResolvedValue({})

      await app.inject({
        method: 'POST',
        url: `/v1/me/payment-consents/${CONSENT_ID}/authorise`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { accountId: ACCOUNT_ID },
      })

      expect(mock.paymentConsentEvent.create.mock.calls[0][0].data).toMatchObject({
        event: 'CONSENT_AUTHORISATION',
        actor: 'HOLDER',
        actorUserId: OTHER.sub,
        outcome: 'REFUSED',
        reason: 'CONSENT_HOLDER_MISMATCH',
      })
    })

    it('devolve a trilha para a Iniciadora', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())
      mock.paymentConsentEvent.findMany.mockResolvedValue([
        {
          event: 'CONSENT_CREATED',
          actor: 'INITIATOR',
          actorUserId: null,
          outcome: 'ACCEPTED',
          reason: null,
          statusBefore: null,
          statusAfter: 'AWAITING_AUTHORISATION',
          detail: null,
          createdAt: new Date('2026-09-18T12:00:00Z'),
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: `/v1/aspsp/payments/consents/${CONSENT_ID}/events`,
        headers: { 'x-initiator-key': INITIATOR_KEY },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().events).toHaveLength(1)
      expect(response.json().events[0].event).toBe('CONSENT_CREATED')
    })

    it('consentimento desconhecido responde 404, nao lista vazia', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(null)

      const response = await app.inject({
        method: 'GET',
        url: `/v1/aspsp/payments/consents/${CONSENT_ID}/events`,
        headers: { 'x-initiator-key': INITIATOR_KEY },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('webhook', () => {
    it('recusa um webhook_uri fora da allow-list', async () => {
      // WEBHOOK_ALLOWED_ORIGINS nao esta configurada nos testes: nada e aceito.
      const response = await app.inject({
        method: 'POST',
        url: '/v1/aspsp/payments/consents',
        headers: { 'x-initiator-key': INITIATOR_KEY },
        payload: {
          amount: '25.00',
          creditorName: 'Loja Exemplo',
          creditorKey: { type: 'EMAIL', value: 'loja@example.com' },
          webhook_uri: 'http://evil.local/webhooks',
        },
      })

      // Falha alto em vez de aceitar em silencio: a Iniciadora nao deve
      // acreditar que sera avisada.
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('WEBHOOK_URI_NOT_ALLOWED')
      expect(mock.paymentConsent.create).not.toHaveBeenCalled()
    })
  })

  describe('tela de aprovacao', () => {
    it('mostra valor e credor antes de pedir a senha', async () => {
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())

      const response = await app.inject({
        method: 'GET',
        url: `/v1/aspsp/payments/consents/${CONSENT_ID}/authorise`,
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).toContain('25.00')
      expect(response.body).toContain('Loja Exemplo')
      expect(response.body).toContain('loja@example.com')
    })
  })
})
