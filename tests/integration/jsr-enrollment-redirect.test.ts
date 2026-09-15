import { describe, it, expect, beforeEach } from 'vitest'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'

const INITIATOR_KEY = process.env.INITIATOR_SERVICE_SECRET as string

/**
 * O redirect_uri de fallback e persistido no enrollment e usado depois para
 * devolver code+state a Iniciadora. Se a porta se perder na montagem da URL, o
 * callback vai para a porta 80 e a jornada quebra fora de producao.
 */
describe('POST /open-banking/itp/v2/enrollments — redirect_uri de fallback', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
    mock.enrollment.create.mockImplementation(async ({ data }: any) => ({
      id: 'enrollment-1',
      requestId: data.requestId,
      challenge: data.challenge,
      redirectUri: data.redirectUri,
    }))
  })

  function createEnrollment(headers: Record<string, string> = {}, payload: unknown = {}) {
    return app.inject({
      method: 'POST',
      url: '/open-banking/itp/v2/enrollments',
      headers: { 'x-initiator-key': INITIATOR_KEY, ...headers },
      payload,
    })
  }

  it('preserva a porta do host quando a Iniciadora nao envia redirect_uri', async () => {
    const response = await createEnrollment({ host: 'banking.example.com:8443' })

    expect(response.statusCode).toBe(201)
    expect(response.json().redirect_uri).toBe('http://banking.example.com:8443/callback')
  })

  it('respeita o redirect_uri enviado pela Iniciadora', async () => {
    const response = await createEnrollment(
      { host: 'banking.example.com:8443' },
      { redirect_uri: 'https://iniciadora.example.com/callback' },
    )

    expect(response.json().redirect_uri).toBe('https://iniciadora.example.com/callback')
  })
})
