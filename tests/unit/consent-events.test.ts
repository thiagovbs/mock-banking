import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockPrisma, MockPrismaClient } from '../helpers/mock-prisma.js'
import {
  isWebhookUriAllowed,
  recordConsentEvent,
  signWebhookPayload,
} from '../../src/modules/payments/events.js'

const CONSENT_ID = 'consent-1'
const WEBHOOK = 'http://initiator.local/webhooks/consents'

describe('trilha e aviso do consentimento', () => {
  let mock: MockPrismaClient
  let fetchMock: ReturnType<typeof vi.fn>
  const originalAllowList = process.env.WEBHOOK_ALLOWED_ORIGINS

  beforeEach(() => {
    mock = createMockPrisma()
    mock.paymentConsentEvent.create.mockResolvedValue({})
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    process.env.WEBHOOK_ALLOWED_ORIGINS = 'http://initiator.local'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.WEBHOOK_ALLOWED_ORIGINS = originalAllowList
  })

  describe('allow-list do webhook', () => {
    it('aceita apenas a origem listada', () => {
      expect(isWebhookUriAllowed('http://initiator.local/webhooks/consents')).toBe(true)
      expect(isWebhookUriAllowed('http://initiator.local/outro/caminho')).toBe(true)
      expect(isWebhookUriAllowed('http://evil.local/webhooks')).toBe(false)
    })

    it('nao se engana com prefixo', () => {
      // Compara origem, nao string: o host real aqui e evil.local.
      expect(isWebhookUriAllowed('http://evil.local/http://initiator.local')).toBe(false)
    })

    it('recusa esquema que nao seja http(s)', () => {
      process.env.WEBHOOK_ALLOWED_ORIGINS = 'file://initiator.local'
      expect(isWebhookUriAllowed('file:///etc/passwd')).toBe(false)
    })

    it('allow-list vazia nao deixa sair webhook nenhum', () => {
      process.env.WEBHOOK_ALLOWED_ORIGINS = ''
      expect(isWebhookUriAllowed(WEBHOOK)).toBe(false)
    })
  })

  describe('assinatura', () => {
    it('muda quando o corpo muda', () => {
      const a = signWebhookPayload('segredo', '{"status":"AUTHORISED"}')
      const b = signWebhookPayload('segredo', '{"status":"REJECTED"}')
      expect(a).not.toBe(b)
      expect(a).toBe(signWebhookPayload('segredo', '{"status":"AUTHORISED"}'))
    })

    it('muda quando o segredo muda', () => {
      const body = '{"status":"AUTHORISED"}'
      expect(signWebhookPayload('a', body)).not.toBe(signWebhookPayload('b', body))
    })
  })

  describe('recordConsentEvent', () => {
    it('grava o evento e avisa quando o status mudou', async () => {
      await recordConsentEvent(mock as any, {
        consentId: CONSENT_ID,
        event: 'CONSENT_AUTHORISED',
        actor: 'HOLDER',
        actorUserId: 'user-1',
        statusBefore: 'AWAITING_AUTHORISATION',
        statusAfter: 'AUTHORISED',
        webhookUri: WEBHOOK,
      })

      expect(mock.paymentConsentEvent.create).toHaveBeenCalledOnce()
      expect(mock.paymentConsentEvent.create.mock.calls[0][0].data).toMatchObject({
        consentId: CONSENT_ID,
        event: 'CONSENT_AUTHORISED',
        actor: 'HOLDER',
        outcome: 'ACCEPTED',
        statusAfter: 'AUTHORISED',
      })

      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(WEBHOOK)
      expect(JSON.parse(init.body)).toMatchObject({
        consentId: CONSENT_ID,
        status: 'AUTHORISED',
        previousStatus: 'AWAITING_AUTHORISATION',
      })
      // Assinado com o segredo compartilhado, para a Iniciadora poder confiar.
      expect(init.headers['x-webhook-signature']).toBe(
        signWebhookPayload(process.env.INITIATOR_SERVICE_SECRET ?? '', init.body),
      )
    })

    it('grava a recusa mas nao avisa', async () => {
      await recordConsentEvent(mock as any, {
        consentId: CONSENT_ID,
        event: 'PAYMENT_SUBMISSION',
        actor: 'INITIATOR',
        outcome: 'REFUSED',
        reason: 'CONSENT_NOT_AUTHORISED',
        statusBefore: 'AWAITING_AUTHORISATION',
        webhookUri: WEBHOOK,
      })

      expect(mock.paymentConsentEvent.create.mock.calls[0][0].data).toMatchObject({
        outcome: 'REFUSED',
        reason: 'CONSENT_NOT_AUTHORISED',
      })
      // Tentativa barrada e assunto de auditoria, nao noticia de mudanca.
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('nao avisa quando o status nao mudou', async () => {
      await recordConsentEvent(mock as any, {
        consentId: CONSENT_ID,
        event: 'CONSENT_CREATED',
        actor: 'INITIATOR',
        statusBefore: 'AWAITING_AUTHORISATION',
        statusAfter: 'AWAITING_AUTHORISATION',
        webhookUri: WEBHOOK,
      })

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('nao avisa destino fora da allow-list', async () => {
      await recordConsentEvent(mock as any, {
        consentId: CONSENT_ID,
        event: 'CONSENT_AUTHORISED',
        actor: 'HOLDER',
        statusBefore: 'AWAITING_AUTHORISATION',
        statusAfter: 'AUTHORISED',
        webhookUri: 'http://evil.local/webhooks',
      })

      expect(mock.paymentConsentEvent.create).toHaveBeenCalledOnce()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('webhook que falha nao derruba a operacao', async () => {
      fetchMock.mockRejectedValue(new Error('connection refused'))

      await expect(
        recordConsentEvent(mock as any, {
          consentId: CONSENT_ID,
          event: 'CONSENT_AUTHORISED',
          actor: 'HOLDER',
          statusBefore: 'AWAITING_AUTHORISATION',
          statusAfter: 'AUTHORISED',
          webhookUri: WEBHOOK,
        }),
      ).resolves.toBeUndefined()
    })

    it('falha ao gravar o evento nao derruba a operacao', async () => {
      mock.paymentConsentEvent.create.mockRejectedValue(new Error('db down'))

      await expect(
        recordConsentEvent(mock as any, {
          consentId: CONSENT_ID,
          event: 'CONSENT_CREATED',
          actor: 'INITIATOR',
          statusAfter: 'AWAITING_AUTHORISATION',
        }),
      ).resolves.toBeUndefined()
    })
  })
})
