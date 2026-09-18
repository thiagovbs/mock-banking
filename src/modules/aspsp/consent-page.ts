/**
 * Telas da autorizacao de um pagamento iniciado por terceiro.
 *
 * Sao o passo que faltava na jornada com redirecionamento: a Iniciadora abre a
 * authorisationUrl no navegador do titular, ele se autentica, ve **o que vai
 * pagar** (valor, credor, chave) e escolhe de qual conta sai o dinheiro antes
 * de confirmar. Sem passar por aqui o consentimento nao sai de
 * AWAITING_AUTHORISATION, e sem consentimento autorizado o pagamento nao
 * liquida.
 *
 * Espelha `data-sharing/consent-page.ts`: mesmos estilos e mesma divisao em
 * tres passos (identificacao, revisao, desfecho). A diferenca de fundo e que
 * aqui a escolha de conta e unica -- um pagamento debita uma conta so --,
 * entao o seletor e radio, e nao checkbox.
 */

import { ASSET_PATHS } from '../assets/routes.js'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}


/**
 * O CSS vem de arquivo, e nao de <style> inline: atras do gateway a CSP traz
 * `style-src 'self'`, que recusa estilo inline e deixava a tela crua.
 */
function page(title: string, baseUrl: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${escapeHtml(baseUrl)}${ASSET_PATHS.css}" />
</head>
<body>
  <div class="card">
${body}
    <div class="footer">Sensedia · Open Finance</div>
  </div>
</body>
</html>`
}

export type PaymentConsentPageView = {
  id: string
  /**
   * Endereco publico desta API, com o basePath do gateway. Prefixa as `action`
   * dos formularios: sem ele, a tela servida atras de um gateway posta num
   * caminho que perde o basePath e responde 404.
   */
  baseUrl: string
  amount: string
  creditorName: string
  creditorDocument: string | null
  creditorKey: string
  description: string | null
  redirectUri: string | null
}

/** O que esta sendo pago, repetido nos dois passos para nao exigir memoria. */
function paymentBlock(consent: PaymentConsentPageView): string {
  const rows = [
    ['Para', consent.creditorName],
    ...(consent.creditorDocument ? [['CPF/CNPJ', consent.creditorDocument]] : []),
    ['Chave PIX', consent.creditorKey],
    ...(consent.description ? [['Descrição', consent.description]] : []),
  ]
    .map(
      ([key, value]) =>
        `      <div class="row"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(
          value,
        )}</span></div>`,
    )
    .join('\n')

  return `    <div class="amount">
      <div class="value">R$ ${escapeHtml(consent.amount)}</div>
      <div class="caption">Pagamento PIX</div>
    </div>
${rows}`
}

/** Passo 1: o titular se identifica, ja vendo o que foi pedido. */
export function paymentLoginStepHtml(
  consent: PaymentConsentPageView,
  error?: string,
): string {
  const errorBlock = error ? `    <div class="error">${escapeHtml(error)}</div>` : ''

  return page(
    'Autorização de pagamento',
    consent.baseUrl,
    `    <div class="eyebrow">Autorização de pagamento</div>
    <h1>Confirme este pagamento</h1>
    <p class="subtitle">Entre na sua conta para revisar e autorizar</p>
${errorBlock}
    <div class="section-title">O que está sendo pedido</div>
${paymentBlock(consent)}
    <div class="section-title">Identifique-se</div>
    <form method="POST" action="${escapeHtml(consent.baseUrl)}/v1/aspsp/payments/consents/${escapeHtml(
      consent.id,
    )}/authorise/login">
      <label for="username">Usuário</label>
      <input type="text" id="username" name="username" autocomplete="username" required />
      <label for="password">Senha</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required />
      <button type="submit">Continuar</button>
    </form>`,
  )
}

export type PaymentConsentPageAccount = {
  id: string
  branch: string
  accountNumber: string
  balance: string
}

/** Passo 2: o titular escolhe a conta de debito e confirma -- ou recusa. */
export function paymentReviewStepHtml(
  consent: PaymentConsentPageView,
  accounts: PaymentConsentPageAccount[],
  token: string,
  error?: string,
): string {
  const errorBlock = error ? `    <div class="error">${escapeHtml(error)}</div>` : ''

  const accountsBlock = accounts.length
    ? accounts
        .map(
          (account, index) => `      <label class="account">
        <input type="radio" name="accountId" value="${escapeHtml(account.id)}"${
            index === 0 ? ' checked' : ''
          } required />
        <div class="info"><strong>Agência ${escapeHtml(account.branch)} · Conta ${escapeHtml(
            account.accountNumber,
          )}</strong><span>Saldo R$ ${escapeHtml(account.balance)}</span></div>
      </label>`,
        )
        .join('\n')
    : '      <div class="error">Você não possui contas ativas para pagar.</div>'

  return page(
    'Autorização de pagamento',
    consent.baseUrl,
    `    <div class="eyebrow">Autorização de pagamento</div>
    <h1>De qual conta vai sair?</h1>
    <p class="subtitle">O valor só sai depois que você autorizar</p>
${errorBlock}
    <div class="section-title">O que está sendo pedido</div>
${paymentBlock(consent)}
    <div class="section-title">Suas contas</div>
    <form method="POST" action="${escapeHtml(consent.baseUrl)}/v1/aspsp/payments/consents/${escapeHtml(
      consent.id,
    )}/authorise/confirm">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
${accountsBlock}
      <button type="submit">Autorizar pagamento</button>
    </form>
    <form method="POST" action="${escapeHtml(consent.baseUrl)}/v1/aspsp/payments/consents/${escapeHtml(
      consent.id,
    )}/authorise/reject">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <button class="secondary" type="submit">Recusar</button>
    </form>`,
  )
}

/** Passo 3: desfecho, autorizado ou recusado. */
export function paymentResultStepHtml(
  consent: PaymentConsentPageView,
  authorised: boolean,
): string {
  return page(
    'Autorização de pagamento',
    consent.baseUrl,
    `    <div class="eyebrow">Autorização de pagamento</div>
    <h1>${authorised ? 'Pagamento autorizado' : 'Pagamento recusado'}</h1>
    <div class="success">${
      authorised
        ? `R$ ${escapeHtml(consent.amount)} para ${escapeHtml(consent.creditorName)}.`
        : 'Nenhum valor saiu da sua conta.'
    }</div>
    <p class="subtitle">${
      authorised
        ? 'Você pode voltar para a loja: ela vai concluir o pagamento.'
        : 'A loja foi avisada de que você recusou.'
    }</p>`,
  )
}
