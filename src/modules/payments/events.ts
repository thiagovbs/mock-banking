import { PrismaClient } from '@prisma/client'
import { createHmac } from 'node:crypto'

/**
 * Trilha de auditoria do consentimento de pagamento, e o aviso a Iniciadora.
 *
 * As duas coisas ficam na mesma funcao de proposito: o webhook conta o que o
 * evento gravou, entao nao ha como um existir sem o outro e as duas visoes
 * divergirem.
 *
 * Nada aqui pode derrubar a operacao que esta sendo registrada -- registrar e
 * avisar sao consequencias, nao pre-requisitos. Por isso tudo e best-effort,
 * como a trilha do compartilhamento de dados.
 */

export type ConsentEventActor = 'INITIATOR' | 'HOLDER' | 'SYSTEM'
export type ConsentEventOutcome = 'ACCEPTED' | 'REFUSED'

export type RecordConsentEventInput = {
  consentId: string
  event: string
  actor: ConsentEventActor
  actorUserId?: string | null
  outcome?: ConsentEventOutcome
  /** Codigo do AppError, quando recusado. */
  reason?: string | null
  statusBefore?: string | null
  statusAfter?: string | null
  detail?: Record<string, unknown>
  /** Destino do aviso. Ausente (ou recusa) nao dispara webhook. */
  webhookUri?: string | null
  paymentId?: string | null
}

const WEBHOOK_TIMEOUT_MS = 5000

/**
 * Origens para as quais o core aceita disparar webhook, separadas por virgula.
 * Vazia = nenhum webhook sai. A Iniciadora se autentica para criar o
 * consentimento, mas a URL de aviso ainda vem do corpo de uma requisicao:
 * sem allow-list, ela apontaria o core para qualquer endereco interno.
 */
function allowedWebhookOrigins(): Set<string> {
  const raw = process.env.WEBHOOK_ALLOWED_ORIGINS ?? ''
  const origins = new Set<string>()
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    try {
      origins.add(new URL(trimmed).origin)
    } catch {
      // Entrada malformada e ignorada em vez de derrubar o processo: uma
      // variavel de ambiente errada nao deve impedir pagamentos.
    }
  }
  return origins
}

export function isWebhookUriAllowed(uri: string): boolean {
  const allowed = allowedWebhookOrigins()
  if (allowed.size === 0) return false
  try {
    const url = new URL(uri)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return allowed.has(url.origin)
  } catch {
    return false
  }
}

/**
 * Assina o corpo do webhook com o segredo compartilhado com a Iniciadora.
 *
 * Sem isso, qualquer um que descubra a URL de webhook postaria "status:
 * AUTHORISED" e a Iniciadora submeteria um pagamento que o titular nunca
 * aprovou -- ela age em cima do aviso.
 */
export function signWebhookPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

async function dispatchWebhook(uri: string, payload: Record<string, unknown>): Promise<void> {
  if (!isWebhookUriAllowed(uri)) return

  const body = JSON.stringify(payload)
  const secret = process.env.INITIATOR_SERVICE_SECRET ?? ''

  try {
    await fetch(uri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': signWebhookPayload(secret, body),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
  } catch {
    // A Iniciadora tem o GET do consentimento para se reconciliar: perder um
    // aviso atrasa a noticia, nao a perde.
  }
}

/**
 * Grava o evento e, quando o status mudou de fato, avisa a Iniciadora.
 *
 * O webhook so sai em eventos aceitos: uma tentativa recusada e assunto de
 * auditoria, nao noticia de mudanca de estado.
 */
export async function recordConsentEvent(
  prisma: PrismaClient,
  input: RecordConsentEventInput,
): Promise<void> {
  const outcome = input.outcome ?? 'ACCEPTED'

  try {
    await prisma.paymentConsentEvent.create({
      data: {
        consentId: input.consentId,
        event: input.event,
        actor: input.actor,
        actorUserId: input.actorUserId ?? null,
        outcome,
        reason: input.reason ?? null,
        statusBefore: (input.statusBefore ?? null) as any,
        statusAfter: (input.statusAfter ?? null) as any,
        detail: (input.detail ?? undefined) as any,
      },
    })
  } catch {
    // auditoria e best-effort
  }

  const changedStatus = Boolean(input.statusAfter) && input.statusAfter !== input.statusBefore
  if (outcome !== 'ACCEPTED' || !changedStatus || !input.webhookUri) return

  await dispatchWebhook(input.webhookUri, {
    consentId: input.consentId,
    event: input.event,
    status: input.statusAfter,
    previousStatus: input.statusBefore ?? null,
    paymentId: input.paymentId ?? null,
    timestamp: new Date().toISOString(),
  })
}

export type ConsentEventView = {
  event: string
  actor: string
  actorUserId: string | null
  outcome: string
  reason: string | null
  statusBefore: string | null
  statusAfter: string | null
  detail: unknown
  createdAt: Date
}

export async function listConsentEvents(
  prisma: PrismaClient,
  consentId: string,
): Promise<ConsentEventView[]> {
  const events = await prisma.paymentConsentEvent.findMany({
    where: { consentId },
    orderBy: { createdAt: 'asc' },
  })

  return events.map((event: any) => ({
    event: event.event,
    actor: event.actor,
    actorUserId: event.actorUserId ?? null,
    outcome: event.outcome,
    reason: event.reason ?? null,
    statusBefore: event.statusBefore ?? null,
    statusAfter: event.statusAfter ?? null,
    detail: event.detail ?? null,
    createdAt: event.createdAt,
  }))
}
