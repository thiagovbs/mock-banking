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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLES = `
  :root {
    --bg:#FBFAFC; --surface:#FFFFFF; --surface-2:#F4F2F8; --ink:#1A1526;
    --muted:#6B6280; --faint:#8E85A3; --line:#E7E2F0;
    --purple:#8241B0; --purple-soft:#F0E7F8; --orange:#EA5B0C; --orange-soft:#FCEBDF;
    --green:#1F7A54; --green-soft:#E4F4EC;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 10px 30px rgba(26,21,38,0.08);
    width: 100%;
    max-width: 440px;
    padding: 36px 32px;
  }
  .eyebrow {
    font-family: ui-monospace, "SF Mono", "Menlo", "Courier New", monospace;
    text-transform: uppercase;
    letter-spacing: .12em;
    font-size: 11px;
    color: var(--orange);
    text-align: center;
    margin-bottom: 8px;
  }
  h1 { font-size: 21px; font-weight: 600; text-align: center; margin-bottom: 8px; }
  .subtitle { color: var(--muted); font-size: 14px; text-align: center; margin-bottom: 26px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type=text], input[type=password] {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    font-size: 15px;
    color: var(--ink);
    background: var(--surface);
    margin-bottom: 18px;
  }
  input[type=text]:focus, input[type=password]:focus {
    outline: none; border-color: var(--purple); box-shadow: 0 0 0 3px var(--purple-soft);
  }
  button {
    width: 100%;
    padding: 13px;
    background: var(--orange);
    color: #fff;
    border: none;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #C2480A; }
  button.secondary { background: transparent; color: var(--muted); border: 1px solid var(--line); margin-top: 10px; }
  button.secondary:hover { background: var(--surface-2); color: var(--ink); }
  .error { background: var(--orange-soft); color: #C2480A; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 18px; }
  .section-title {
    font-family: ui-monospace, "SF Mono", "Menlo", "Courier New", monospace;
    text-transform: uppercase; letter-spacing: .1em; font-size: 10px;
    color: var(--faint); margin: 22px 0 10px;
  }
  .amount {
    background: var(--purple-soft); border-radius: 12px; padding: 18px;
    text-align: center; margin-bottom: 14px;
  }
  .amount .value { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
  .amount .caption {
    font-family: ui-monospace, "SF Mono", "Menlo", "Courier New", monospace;
    text-transform: uppercase; letter-spacing: .1em; font-size: 10px;
    color: var(--purple); margin-top: 4px;
  }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .row:last-child { border-bottom: none; }
  .row .k { color: var(--muted); flex: none; }
  .row .v { text-align: right; word-break: break-word; font-weight: 500; }
  .account {
    display: flex; align-items: center; gap: 12px;
    padding: 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; cursor: pointer;
  }
  .account:hover { border-color: var(--purple); }
  .account input { width: 18px; height: 18px; accent-color: var(--purple); flex: none; }
  .account .info strong { display: block; font-size: 14px; }
  .account .info span { font-size: 12.5px; color: var(--muted); }
  .success { background: var(--green-soft); color: var(--green); border-radius: 10px; padding: 14px; font-size: 14px; text-align: center; margin-bottom: 18px; }
  .footer {
    margin-top: 24px; text-align: center;
    font-family: ui-monospace, "SF Mono", "Menlo", "Courier New", monospace;
    font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint);
  }
`

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
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
    `    <div class="eyebrow">Autorização de pagamento</div>
    <h1>Confirme este pagamento</h1>
    <p class="subtitle">Entre na sua conta para revisar e autorizar</p>
${errorBlock}
    <div class="section-title">O que está sendo pedido</div>
${paymentBlock(consent)}
    <div class="section-title">Identifique-se</div>
    <form method="POST" action="/v1/aspsp/payments/consents/${escapeHtml(
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
    `    <div class="eyebrow">Autorização de pagamento</div>
    <h1>De qual conta vai sair?</h1>
    <p class="subtitle">O valor só sai depois que você autorizar</p>
${errorBlock}
    <div class="section-title">O que está sendo pedido</div>
${paymentBlock(consent)}
    <div class="section-title">Suas contas</div>
    <form method="POST" action="/v1/aspsp/payments/consents/${escapeHtml(
      consent.id,
    )}/authorise/confirm">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
${accountsBlock}
      <button type="submit">Autorizar pagamento</button>
    </form>
    <form method="POST" action="/v1/aspsp/payments/consents/${escapeHtml(
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
