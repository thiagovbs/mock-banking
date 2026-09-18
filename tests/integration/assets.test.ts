import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildTestApp } from '../helpers/build-app.js'
import { MockPrismaClient } from '../helpers/mock-prisma.js'

/**
 * Atras do gateway da Sensedia a resposta carrega uma CSP com
 * `style-src 'self'` e `img-src 'self'`, sem `'unsafe-inline'` nem `data:`.
 * Com o CSS em <style> e o logo em data: URI, o navegador recebia tudo e
 * recusava a aplicar -- a tela aparecia crua. Servidos como arquivo da mesma
 * origem, passam.
 */

const CONSENT_ID = '55555555-5555-4555-8555-555555555555'

describe('estilo e imagem das telas', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app']
  let mock: MockPrismaClient
  const original = process.env.PUBLIC_BASE_URL

  beforeEach(async () => {
    const built = await buildTestApp()
    app = built.app
    mock = built.mock
  })

  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_BASE_URL
    else process.env.PUBLIC_BASE_URL = original
  })

  describe('arquivos servidos', () => {
    it('serve a folha de estilo como text/css', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/assets/consent.css' })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/css')
      expect(response.headers['cache-control']).toContain('max-age')
      // Regras das tres telas convivem na mesma folha.
      expect(response.body).toContain('.card')
      expect(response.body).toContain('.amount')
      expect(response.body).toContain('.perm')
      expect(response.body).toContain('.logo')
    })

    it('serve o logo como svg', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/assets/sensedia-logo.svg' })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('image/svg+xml')
      expect(response.body).toContain('<svg')
    })
  })

  describe('telas nao usam mais estilo inline', () => {
    function consentRow() {
      return {
        id: CONSENT_ID,
        userId: null,
        customerId: null,
        accountId: null,
        debtorDocument: null,
        amount: new Prisma.Decimal('25.00'),
        description: null,
        creditorName: 'Loja Exemplo',
        creditorDocument: null,
        creditorKeyType: 'EMAIL',
        creditorKeyValue: 'loja@example.com',
        status: 'AWAITING_AUTHORISATION',
        paymentId: null,
        redirectUri: null,
        createdAt: new Date(),
        statusUpdatedAt: new Date(),
        authorisedAt: null,
        rejectedAt: null,
      }
    }

    it('a tela de pagamento referencia a folha, sem <style>', async () => {
      process.env.PUBLIC_BASE_URL = 'https://api-assets.sensedia.com/v1'
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())

      const response = await app.inject({
        method: 'GET',
        url: `/v1/aspsp/payments/consents/${CONSENT_ID}/authorise`,
      })

      expect(response.body).not.toContain('<style>')
      expect(response.body).toContain(
        'href="https://api-assets.sensedia.com/v1/v1/assets/consent.css"',
      )
    })

    it('a tela de login referencia folha e logo, sem inline nem data:', async () => {
      process.env.PUBLIC_BASE_URL = 'https://api-assets.sensedia.com/v1'
      mock.authRequest.findUnique.mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        redirectUri: 'http://initiator.local/callback',
      })

      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/login?request_id=11111111-1111-4111-8111-111111111111',
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain('<style>')
      // data: URI e recusada por img-src 'self'.
      expect(response.body).not.toContain('data:image')
      expect(response.body).toContain(
        'href="https://api-assets.sensedia.com/v1/v1/assets/consent.css"',
      )
      expect(response.body).toContain(
        'src="https://api-assets.sensedia.com/v1/v1/assets/sensedia-logo.svg"',
      )
    })

    it('sem PUBLIC_BASE_URL, referencia a folha no proprio host', async () => {
      delete process.env.PUBLIC_BASE_URL
      mock.paymentConsent.findUnique.mockResolvedValue(consentRow())

      const response = await app.inject({
        method: 'GET',
        url: `/v1/aspsp/payments/consents/${CONSENT_ID}/authorise`,
      })

      expect(response.body).toContain('href="http://localhost:80/v1/assets/consent.css"')
    })
  })
})
