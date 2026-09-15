import { describe, it, expect, beforeEach } from 'vitest'
import { createMockPrisma, MockPrismaClient } from '../helpers/mock-prisma.js'
import {
  authoriseDataSharingConsent,
  parseExpiration,
  parsePermissions,
  rejectDataSharingConsent,
  requireActiveConsent,
} from '../../src/modules/data-sharing/service.js'
import { AppError } from '../../src/shared/errors.js'

const CONSENT_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'

function consentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONSENT_ID,
    granteeUserId: 'user-grantee',
    granteeCustomerId: 'cust-grantee',
    granterDocument: '12345678901',
    granterUserId: 'user-granter',
    granterCustomerId: 'cust-granter',
    permissions: ['ACCOUNTS_READ', 'ACCOUNTS_BALANCES_READ'],
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

function inDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

describe('parseExpiration', () => {
  it('trata ausencia de data como prazo indeterminado', () => {
    expect(parseExpiration(undefined)).toBeNull()
    expect(parseExpiration(null)).toBeNull()
    expect(parseExpiration('')).toBeNull()
  })

  it('aceita uma data futura dentro do teto de 12 meses', () => {
    const value = inDays(30).toISOString()
    expect(parseExpiration(value)?.toISOString()).toBe(value)
  })

  it('recusa data no passado', () => {
    expect(() => parseExpiration(inDays(-1).toISOString())).toThrow(AppError)
  })

  it('recusa prazo acima de 12 meses', () => {
    expect(() => parseExpiration(inDays(400).toISOString())).toThrow(/12 months/)
  })
})

describe('parsePermissions', () => {
  it('rejeita permissao fora do catalogo', () => {
    expect(() => parsePermissions(['ACCOUNTS_READ', 'PIX_PAYMENTS_WRITE'])).toThrow(
      /PIX_PAYMENTS_WRITE/,
    )
  })

  it('deduplica sem perder as validas', () => {
    expect(parsePermissions(['ACCOUNTS_READ', 'ACCOUNTS_READ'])).toEqual(['ACCOUNTS_READ'])
  })
})

describe('requireActiveConsent', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
  })

  function callGuard(overrides: Record<string, unknown> = {}) {
    return requireActiveConsent({
      prisma: mock as any,
      consentId: CONSENT_ID,
      grantee: { customerId: 'cust-grantee' },
      permission: 'ACCOUNTS_BALANCES_READ',
      accountId: ACCOUNT_ID,
      ...overrides,
    })
  }

  it('libera a leitura quando o consentimento cobre conta e permissao', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())

    const consent = await callGuard()

    expect(consent.accountIds).toEqual([ACCOUNT_ID])
  })

  it('bloqueia outra receptora que tente usar o mesmo consentId', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())

    await expect(callGuard({ grantee: { customerId: 'cust-intruso' } })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONSENT_FORBIDDEN',
    })
  })

  it('bloqueia permissao que o titular nao concedeu', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())

    await expect(callGuard({ permission: 'ACCOUNTS_TRANSACTIONS_READ' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONSENT_PERMISSION_MISSING',
    })
  })

  it('esconde conta fora do escopo como 404', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())

    await expect(callGuard({ accountId: OTHER_ACCOUNT_ID })).rejects.toMatchObject({
      statusCode: 404,
      code: 'ACCOUNT_NOT_FOUND',
    })
  })

  it('expira o consentimento vencido na propria leitura e corta o acesso', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(
      consentRow({ expiresAt: inDays(-1) }),
    )
    mock.dataSharingConsent.update.mockResolvedValue(
      consentRow({ status: 'REJECTED', rejectReason: 'CONSENT_EXPIRED', expiresAt: inDays(-1) }),
    )

    await expect(callGuard()).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONSENT_EXPIRED',
    })

    // O status tem que ficar persistido, nao apenas negado em memoria.
    expect(mock.dataSharingConsent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED', rejectReason: 'CONSENT_EXPIRED' }),
      }),
    )
  })

  it('nao expira consentimento sem data de validade', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow({ expiresAt: null }))

    await expect(callGuard()).resolves.toBeTruthy()
    expect(mock.dataSharingConsent.update).not.toHaveBeenCalled()
  })
})

describe('authoriseDataSharingConsent', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
  })

  const granter = {
    userId: 'user-granter',
    customerId: 'cust-granter',
    document: '123.456.789-01',
  }

  function authorise(accountIds = [ACCOUNT_ID]) {
    return authoriseDataSharingConsent({
      prisma: mock as any,
      consentId: CONSENT_ID,
      granter,
      accountIds,
    })
  }

  it('vincula o titular e as contas escolhidas', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(
      consentRow({ status: 'AWAITING_AUTHORISATION', granterUserId: null, accounts: [] }),
    )
    mock.account.findMany.mockResolvedValue([{ id: ACCOUNT_ID }])
    mock.dataSharingConsent.update.mockResolvedValue(consentRow())

    const result = await authorise()

    expect(result.status).toBe('AUTHORISED')
    expect(mock.dataSharingConsentAccount.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ consentId: CONSENT_ID, accountId: ACCOUNT_ID }] }),
    )
  })

  it('recusa quem nao e o titular enderecado no consentimento', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(
      consentRow({ status: 'AWAITING_AUTHORISATION', granterDocument: '99999999999' }),
    )

    await expect(authorise()).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONSENT_HOLDER_MISMATCH',
    })
    expect(mock.dataSharingConsent.update).not.toHaveBeenCalled()
  })

  it('recusa conta que nao e do titular', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(
      consentRow({ status: 'AWAITING_AUTHORISATION' }),
    )
    // A query ja filtra por dono: a conta de terceiro simplesmente nao volta.
    mock.account.findMany.mockResolvedValue([])

    await expect(authorise([OTHER_ACCOUNT_ID])).rejects.toMatchObject({
      statusCode: 404,
      code: 'ACCOUNT_NOT_FOUND',
    })
  })

  it('nao reautoriza um consentimento ja autorizado', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow({ status: 'AUTHORISED' }))

    await expect(authorise()).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONSENT_NOT_AWAITING_AUTHORISATION',
    })
  })
})

describe('rejectDataSharingConsent', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
  })

  it('marca revogacao pelo titular quando ja estava autorizado', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())
    mock.dataSharingConsent.update.mockResolvedValue(
      consentRow({ status: 'REJECTED', rejectedBy: 'USER', rejectReason: 'CUSTOMER_MANUALLY_REVOKED' }),
    )

    await rejectDataSharingConsent({
      prisma: mock as any,
      consentId: CONSENT_ID,
      requester: { userId: 'user-granter', customerId: 'cust-granter' },
    })

    expect(mock.dataSharingConsent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectedBy: 'USER',
          rejectReason: 'CUSTOMER_MANUALLY_REVOKED',
        }),
      }),
    )
  })

  it('recusa quem nao participa do consentimento', async () => {
    mock.dataSharingConsent.findUnique.mockResolvedValue(consentRow())

    await expect(
      rejectDataSharingConsent({
        prisma: mock as any,
        consentId: CONSENT_ID,
        requester: { userId: 'user-x', customerId: 'cust-x' },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CONSENT_FORBIDDEN' })
  })
})
