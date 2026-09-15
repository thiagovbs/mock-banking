import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'
import { signToken } from '../helpers/token.js'

const CONSENT_ID = '11111111-1111-4111-8111-111111111111'
const CONSENT_URN = `urn:banking:${CONSENT_ID}`
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const SECOND_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444'
const FOREIGN_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'

const GRANTER = { sub: 'user-granter', customerId: 'cust-granter', username: 'joao.silva' }
const GRANTEE = { sub: 'user-grantee', customerId: 'cust-grantee', username: 'fintech.maria' }

const CUSTOMERS: Record<string, unknown> = {
  'cust-granter': { id: 'cust-granter', userId: 'user-granter', name: 'Joao da Silva', document: '12345678901' },
  'cust-grantee': { id: 'cust-grantee', userId: 'user-grantee', name: 'Maria Fintech', document: '98765432100' },
}

function consentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONSENT_ID,
    granteeUserId: GRANTEE.sub,
    granteeCustomerId: GRANTEE.customerId,
    granterDocument: '12345678901',
    granterUserId: GRANTER.sub,
    granterCustomerId: GRANTER.customerId,
    permissions: ['ACCOUNTS_READ', 'ACCOUNTS_BALANCES_READ', 'ACCOUNTS_TRANSACTIONS_READ'],
    status: 'AUTHORISED',
    expiresAt: null as Date | null,
    rejectedBy: null,
    rejectReason: null,
    createdAt: new Date(),
    statusUpdatedAt: new Date(),
    accounts: [{ accountId: ACCOUNT_ID }],
    ...overrides,
  }
}

function accountRow(id = ACCOUNT_ID, accountNumber = '654321') {
  return {
    id,
    customerId: GRANTER.customerId,
    branch: '0001',
    accountNumber,
    balance: new Prisma.Decimal('1500.00'),
    status: 'ACTIVE',
    createdAt: new Date(),
  }
}

describe('Compartilhamento de dados', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient
  let granterToken: string
  let granteeToken: string

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
    granterToken = signToken(app, GRANTER)
    granteeToken = signToken(app, GRANTEE)

    mock.customer.findUnique.mockImplementation(async ({ where }: any) => CUSTOMERS[where.id] ?? null)
  })

  describe('POST /open-banking/consents/v3/consents', () => {
    function createConsent(body: unknown) {
      return app.inject({
        method: 'POST',
        url: '/open-banking/consents/v3/consents',
        headers: { authorization: `Bearer ${granteeToken}` },
        payload: body,
      })
    }

    const validBody = {
      data: {
        loggedUser: { document: { identification: '123.456.789-01', rel: 'CPF' } },
        permissions: ['ACCOUNTS_READ', 'ACCOUNTS_BALANCES_READ'],
      },
    }

    it('nasce aguardando autorizacao e devolve a url da tela de consentimento', async () => {
      mock.dataSharingConsent.create.mockResolvedValue(
        consentRow({ status: 'AWAITING_AUTHORISATION', granterUserId: null, accounts: [] }),
      )

      const response = await createConsent(validBody)

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.data.status).toBe('AWAITING_AUTHORISATION')
      expect(body.data.consentId).toBe(CONSENT_URN)
      expect(body.links.redirect).toContain(`/v1/data-sharing/consents/${CONSENT_ID}/authorise`)
      // Sem expirationDateTime o consentimento e por prazo indeterminado.
      expect(mock.dataSharingConsent.create.mock.calls[0][0].data.expiresAt).toBeNull()
      expect(mock.dataSharingConsent.create.mock.calls[0][0].data.granterDocument).toBe('12345678901')
    })

    it('grava a validade quando o pedido traz expirationDateTime', async () => {
      const expiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      mock.dataSharingConsent.create.mockResolvedValue(
        consentRow({ status: 'AWAITING_AUTHORISATION', expiresAt: new Date(expiration) }),
      )

      const response = await createConsent({
        data: { ...validBody.data, expirationDateTime: expiration },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().data.expirationDateTime).toBe(expiration)
    })

    it('recusa pedido em que receptora e titular sao a mesma pessoa', async () => {
      const response = await createConsent({
        data: {
          loggedUser: { document: { identification: '98765432100' } },
          permissions: ['ACCOUNTS_READ'],
        },
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().error).toBe('SELF_SHARING_NOT_ALLOWED')
    })

    it('recusa permissao fora do catalogo', async () => {
      const response = await createConsent({
        data: {
          loggedUser: { document: { identification: '12345678901' } },
          permissions: ['ACCOUNTS_READ', 'CREDIT_CARDS_ACCOUNTS_READ'],
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('INVALID_PERMISSIONS')
    })

    it('exige autenticacao da receptora', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/open-banking/consents/v3/consents',
        payload: validBody,
      })
      expect(response.statusCode).toBe(401)
    })
  })

  describe('Autorizacao pelo titular — modo texto', () => {
    function authorise(accountIds: string[], token = granterToken) {
      return app.inject({
        method: 'POST',
        url: `/v1/data-sharing/consents/${CONSENT_ID}/authorise`,
        headers: { authorization: `Bearer ${token}` },
        payload: { accountIds },
      })
    }

    beforeEach(() => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(
        consentRow({ status: 'AWAITING_AUTHORISATION', granterUserId: null, accounts: [] }),
      )
      mock.dataSharingConsent.update.mockResolvedValue(consentRow())
    })

    it('autoriza com as contas escolhidas pelo titular', async () => {
      mock.account.findMany.mockResolvedValue([accountRow()])

      const response = await authorise([ACCOUNT_ID])

      expect(response.statusCode).toBe(200)
      expect(response.json().status).toBe('AUTHORISED')
      expect(mock.dataSharingConsentAccount.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [{ consentId: CONSENT_ID, accountId: ACCOUNT_ID }] }),
      )
    })

    it('aceita o consentId no formato urn', async () => {
      mock.account.findMany.mockResolvedValue([accountRow()])

      const response = await app.inject({
        method: 'POST',
        url: `/v1/data-sharing/consents/${encodeURIComponent(CONSENT_URN)}/authorise`,
        headers: { authorization: `Bearer ${granterToken}` },
        payload: { accountIds: [ACCOUNT_ID] },
      })

      expect(response.statusCode).toBe(200)
    })

    it('impede que a receptora autorize o proprio pedido', async () => {
      const response = await authorise([ACCOUNT_ID], granteeToken)

      expect(response.statusCode).toBe(403)
      expect(response.json().error).toBe('CONSENT_HOLDER_MISMATCH')
      expect(mock.dataSharingConsent.update).not.toHaveBeenCalled()
    })

    it('nao aceita conta de terceiro no escopo', async () => {
      mock.account.findMany.mockResolvedValue([])

      const response = await authorise([FOREIGN_ACCOUNT_ID])

      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('ACCOUNT_NOT_FOUND')
    })
  })

  describe('Autorizacao pelo titular — modo tela', () => {
    beforeEach(() => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(
        consentRow({ status: 'AWAITING_AUTHORISATION', granterUserId: null, accounts: [] }),
      )
      mock.dataSharingConsent.update.mockResolvedValue(consentRow())
    })

    it('mostra a tela com permissoes e validade indeterminada', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/data-sharing/consents/${CONSENT_ID}/authorise`,
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).toContain('Maria Fintech')
      expect(response.body).toContain('prazo indeterminado')
    })

    it('compartilha todas as contas marcadas no formulario', async () => {
      mock.account.findMany.mockResolvedValue([accountRow(), accountRow(SECOND_ACCOUNT_ID, '111222')])

      const response = await app.inject({
        method: 'POST',
        url: `/v1/data-sharing/consents/${CONSENT_ID}/authorise/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `token=${granterToken}&accountIds=${ACCOUNT_ID}&accountIds=${SECOND_ACCOUNT_ID}`,
      })

      expect(response.statusCode).toBe(200)
      // Duas checkboxes marcadas nao podem virar uma so conta compartilhada.
      expect(mock.dataSharingConsentAccount.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            { consentId: CONSENT_ID, accountId: ACCOUNT_ID },
            { consentId: CONSENT_ID, accountId: SECOND_ACCOUNT_ID },
          ],
        }),
      )
    })

    it('volta para a tela quando nenhuma conta foi marcada', async () => {
      mock.account.findMany.mockResolvedValue([accountRow()])

      const response = await app.inject({
        method: 'POST',
        url: `/v1/data-sharing/consents/${CONSENT_ID}/authorise/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `token=${granterToken}`,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Selecione ao menos uma conta')
      expect(mock.dataSharingConsent.update).not.toHaveBeenCalled()
    })
  })

  describe('Leitura pela receptora (Accounts v2)', () => {
    function read(url: string, headers: Record<string, string> = {}) {
      return app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${granteeToken}`, 'x-consent-id': CONSENT_ID, ...headers },
      })
    }

    it('devolve o saldo da conta compartilhada', async () => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())
      mock.account.findUnique.mockResolvedValue(accountRow())

      const response = await read(`/open-banking/accounts/v2/accounts/${ACCOUNT_ID}/balances`)

      expect(response.statusCode).toBe(200)
      expect(response.json().data.availableAmount).toEqual({ amount: '1500.00', currency: 'BRL' })
      expect(mock.dataSharingAccess.create).toHaveBeenCalled()
    })

    it('devolve o extrato no formato OFB', async () => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())
      mock.transaction.findMany.mockResolvedValue([
        {
          id: 'tx-1',
          type: 'CREDIT',
          amount: new Prisma.Decimal('100.00'),
          description: 'PIX recebido',
          createdAt: new Date(),
        },
      ])

      const response = await read(`/open-banking/accounts/v2/accounts/${ACCOUNT_ID}/transactions`)

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.data[0].creditDebitType).toBe('CREDITO')
      expect(body.meta.totalRecords).toBe(1)
    })

    it('exige o header x-consent-id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/open-banking/accounts/v2/accounts/${ACCOUNT_ID}/balances`,
        headers: { authorization: `Bearer ${granteeToken}` },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('CONSENT_ID_REQUIRED')
    })

    it('bloqueia leitura de conta fora do consentimento', async () => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())

      const response = await read(`/open-banking/accounts/v2/accounts/${FOREIGN_ACCOUNT_ID}/balances`)

      expect(response.statusCode).toBe(404)
      expect(mock.account.findUnique).not.toHaveBeenCalled()
    })

    it('bloqueia extrato quando o titular so concedeu saldo', async () => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(
        consentRow({ permissions: ['ACCOUNTS_READ', 'ACCOUNTS_BALANCES_READ'] }),
      )

      const response = await read(`/open-banking/accounts/v2/accounts/${ACCOUNT_ID}/transactions`)

      expect(response.statusCode).toBe(403)
      expect(response.json().error).toBe('CONSENT_PERMISSION_MISSING')
    })

    it('para de responder depois da revogacao', async () => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(
        consentRow({
          status: 'REJECTED',
          rejectedBy: 'USER',
          rejectReason: 'CUSTOMER_MANUALLY_REVOKED',
        }),
      )

      const response = await read(`/open-banking/accounts/v2/accounts/${ACCOUNT_ID}/balances`)

      expect(response.statusCode).toBe(403)
      expect(response.json().error).toBe('CONSENT_NOT_AUTHORISED')
    })

    it('para de responder depois do vencimento', async () => {
      const expired = new Date(Date.now() - 60_000)
      mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow({ expiresAt: expired }))
      mock.dataSharingConsent.update.mockResolvedValue(
        consentRow({ status: 'REJECTED', rejectReason: 'CONSENT_EXPIRED', expiresAt: expired }),
      )

      const response = await read(`/open-banking/accounts/v2/accounts/${ACCOUNT_ID}/balances`)

      expect(response.statusCode).toBe(403)
      expect(response.json().error).toBe('CONSENT_EXPIRED')
    })
  })

  describe('Gestao pelo titular', () => {
    it('revoga o consentimento e responde 204', async () => {
      mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())
      mock.dataSharingConsent.update.mockResolvedValue(
        consentRow({ status: 'REJECTED', rejectedBy: 'USER', rejectReason: 'CUSTOMER_MANUALLY_REVOKED' }),
      )

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/me/data-sharing/consents/${CONSENT_ID}`,
        headers: { authorization: `Bearer ${granterToken}` },
      })

      expect(response.statusCode).toBe(204)
      expect(mock.dataSharingConsent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rejectReason: 'CUSTOMER_MANUALLY_REVOKED' }),
        }),
      )
    })

    it('lista o que foi concedido e o que foi recebido', async () => {
      mock.dataSharingConsent.findMany
        .mockResolvedValueOnce([consentRow()])
        .mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/v1/me/data-sharing/consents',
        headers: { authorization: `Bearer ${granterToken}` },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.granted).toHaveLength(1)
      expect(body.granted[0].consentId).toBe(CONSENT_URN)
      expect(body.received).toHaveLength(0)
    })
  })
})
