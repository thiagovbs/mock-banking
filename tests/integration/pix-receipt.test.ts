import { describe, it, expect, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'
import { signToken } from '../helpers/token.js'

const PAYER = { sub: 'user-payer', customerId: 'cust-payer', username: 'joao.silva' }
const PAYEE = { sub: 'user-payee', customerId: 'cust-payee', username: 'maria.souza' }
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function transferRow() {
  return {
    id: TRANSFER_ID,
    endToEndId: 'E000000002026010100000000000000000000000',
    consentId: 'consent-1',
    enrollmentId: null,
    amount: new Prisma.Decimal('150.50'),
    status: 'COMPLETED',
    description: 'Pagamento de servico',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    sourceAccount: {
      id: 'acc-payer',
      branch: '0001',
      accountNumber: '111111',
      customer: { userId: PAYER.sub, name: 'Joao da Silva', document: '12345678901' },
    },
    destinationAccount: {
      id: 'acc-payee',
      branch: '0001',
      accountNumber: '222222',
      customer: { userId: PAYEE.sub, name: 'Maria Souza', document: '98765432100' },
    },
    pixKey: { type: 'EMAIL', value: 'maria@example.com' },
  }
}

describe('GET /v1/pix/transfers/:pixTransferId', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
  })

  function get(user: typeof PAYER) {
    return app.inject({
      method: 'GET',
      url: `/v1/pix/transfers/${TRANSFER_ID}`,
      headers: { authorization: `Bearer ${signToken(app, user)}` },
    })
  }

  it('returns 401 without a token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/pix/transfers/${TRANSFER_ID}`,
    })
    expect(response.statusCode).toBe(401)
  })

  it('returns the full receipt with both parties', async () => {
    mock.pixTransfer.findFirst.mockResolvedValue(transferRow())

    const response = await get(PAYER)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      pixTransferId: TRANSFER_ID,
      endToEndId: 'E000000002026010100000000000000000000000',
      amount: '150.50',
      status: 'COMPLETED',
      payer: { accountNumber: '111111', name: 'Joao da Silva' },
      payee: {
        accountNumber: '222222',
        name: 'Maria Souza',
        pixKey: { type: 'EMAIL', value: 'maria@example.com' },
      },
    })
  })

  // The receipt is visible to both sides of the transfer, and `direction` tells
  // each of them which side they are on.
  it('reports SENT for the payer', async () => {
    mock.pixTransfer.findFirst.mockResolvedValue(transferRow())
    expect((await get(PAYER)).json().direction).toBe('SENT')
  })

  it('reports RECEIVED for the payee', async () => {
    mock.pixTransfer.findFirst.mockResolvedValue(transferRow())
    expect((await get(PAYEE)).json().direction).toBe('RECEIVED')
  })

  it('scopes the lookup to either side of the transfer', async () => {
    mock.pixTransfer.findFirst.mockResolvedValue(transferRow())

    await get(PAYER)

    const where = mock.pixTransfer.findFirst.mock.calls[0][0].where
    expect(where.id).toBe(TRANSFER_ID)
    expect(where.OR).toEqual([
      { sourceAccount: { customer: { is: { userId: PAYER.sub } } } },
      { destinationAccount: { customer: { is: { userId: PAYER.sub } } } },
    ])
  })

  it('returns 404 for a transfer the caller is not part of', async () => {
    mock.pixTransfer.findFirst.mockResolvedValue(null)

    const response = await get(PAYER)

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('PIX_TRANSFER_NOT_FOUND')
  })
})
