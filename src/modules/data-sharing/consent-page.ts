/**
 * Telas da autorizacao de compartilhamento de dados.
 *
 * Sao o modo "redirect" da jornada: o chatbot abre a authorisationUrl no
 * navegador, o titular se autentica, ve exatamente o que esta sendo pedido,
 * marca as contas e confirma. O modo texto usa o mesmo servico sem passar por
 * aqui.
 */

const PERMISSION_LABELS: Record<string, { title: string; detail: string }> = {
  ACCOUNTS_READ: {
    title: 'Dados da conta',
    detail: 'Agencia, numero e situacao das contas selecionadas',
  },
  ACCOUNTS_BALANCES_READ: {
    title: 'Saldo',
    detail: 'Saldo disponivel das contas selecionadas',
  },
  ACCOUNTS_TRANSACTIONS_READ: {
    title: 'Extrato',
    detail: 'Lancamentos de entrada e saida das contas selecionadas',
  },
  RESOURCES_READ: {
    title: 'Situacao dos recursos',
    detail: 'Quais contas estao disponiveis para consulta',
  },
}

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
  .perm { display: flex; gap: 10px; padding: 10px 12px; background: var(--surface-2); border-radius: 10px; margin-bottom: 8px; }
  .perm .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--purple); margin-top: 7px; flex: none; }
  .perm strong { display: block; font-size: 14px; font-weight: 600; }
  .perm span { font-size: 12.5px; color: var(--muted); }
  .account {
    display: flex; align-items: center; gap: 12px;
    padding: 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; cursor: pointer;
  }
  .account:hover { border-color: var(--purple); }
  .account input { width: 18px; height: 18px; accent-color: var(--purple); flex: none; }
  .account .info strong { display: block; font-size: 14px; }
  .account .info span { font-size: 12.5px; color: var(--muted); }
  .validity { background: var(--purple-soft); border-radius: 10px; padding: 12px 14px; font-size: 13px; color: var(--ink); margin-bottom: 4px; }
  .validity strong { font-weight: 600; }
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

export type ConsentPageConsent = {
  id: string
  /**
   * Endereco publico desta API, com o basePath do gateway. Prefixa as `action`
   * dos formularios: sem ele, a tela servida atras de um gateway posta num
   * caminho que perde o basePath e responde 404.
   */
  baseUrl: string
  granteeName: string
  permissions: string[]
  expiresAt: Date | null
}

function permissionsBlock(permissions: string[]): string {
  return permissions
    .map((permission) => {
      const label = PERMISSION_LABELS[permission] ?? {
        title: permission,
        detail: 'Permissao solicitada',
      }
      return `      <div class="perm"><div class="dot"></div><div><strong>${escapeHtml(
        label.title,
      )}</strong><span>${escapeHtml(label.detail)}</span></div></div>`
    })
    .join('\n')
}

function validityBlock(expiresAt: Date | null): string {
  if (!expiresAt) {
    return `      <div class="validity">Validade: <strong>prazo indeterminado</strong> — vale ate voce revogar em Compartilhamento de dados.</div>`
  }
  const formatted = expiresAt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  return `      <div class="validity">Validade: ate <strong>${escapeHtml(
    formatted,
  )}</strong> — depois disso o acesso para sozinho.</div>`
}

/** Passo 1: o titular se identifica. */
export function loginStepHtml(consent: ConsentPageConsent, error?: string): string {
  const errorBlock = error ? `    <div class="error">${escapeHtml(error)}</div>` : ''

  return page(
    'Compartilhamento de dados',
    `    <div class="eyebrow">Compartilhamento de dados</div>
    <h1>${escapeHtml(consent.granteeName)} quer acessar seus dados</h1>
    <p class="subtitle">Entre na sua conta para revisar o pedido</p>
${errorBlock}
    <div class="section-title">O que esta sendo pedido</div>
${permissionsBlock(consent.permissions)}
${validityBlock(consent.expiresAt)}
    <div class="section-title">Identifique-se</div>
    <form method="POST" action="${escapeHtml(consent.baseUrl)}/v1/data-sharing/consents/${escapeHtml(consent.id)}/authorise/login">
      <label for="username">Usuário</label>
      <input type="text" id="username" name="username" autocomplete="username" required />
      <label for="password">Senha</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required />
      <button type="submit">Continuar</button>
    </form>`,
  )
}

export type ConsentPageAccount = {
  id: string
  branch: string
  accountNumber: string
  balance: string
}

/** Passo 2: o titular escolhe quais contas entram no consentimento. */
export function accountsStepHtml(
  consent: ConsentPageConsent,
  accounts: ConsentPageAccount[],
  token: string,
  error?: string,
): string {
  const errorBlock = error ? `    <div class="error">${escapeHtml(error)}</div>` : ''

  const accountsBlock = accounts.length
    ? accounts
        .map(
          (account) => `      <label class="account">
        <input type="checkbox" name="accountIds" value="${escapeHtml(account.id)}" checked />
        <div class="info"><strong>Agência ${escapeHtml(account.branch)} · Conta ${escapeHtml(
          account.accountNumber,
        )}</strong><span>Saldo R$ ${escapeHtml(account.balance)}</span></div>
      </label>`,
        )
        .join('\n')
    : '      <div class="error">Você não possui contas para compartilhar.</div>'

  return page(
    'Compartilhamento de dados',
    `    <div class="eyebrow">Compartilhamento de dados</div>
    <h1>Quais contas você quer compartilhar?</h1>
    <p class="subtitle">${escapeHtml(consent.granteeName)} verá apenas o que você marcar</p>
${errorBlock}
    <div class="section-title">O que esta sendo pedido</div>
${permissionsBlock(consent.permissions)}
${validityBlock(consent.expiresAt)}
    <div class="section-title">Suas contas</div>
    <form method="POST" action="${escapeHtml(consent.baseUrl)}/v1/data-sharing/consents/${escapeHtml(
      consent.id,
    )}/authorise/confirm">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
${accountsBlock}
      <button type="submit">Autorizar compartilhamento</button>
    </form>
    <form method="POST" action="${escapeHtml(consent.baseUrl)}/v1/data-sharing/consents/${escapeHtml(consent.id)}/authorise/reject">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <button class="secondary" type="submit">Recusar</button>
    </form>`,
  )
}

/** Passo 3: desfecho, autorizado ou recusado. */
export function resultStepHtml(granteeName: string, authorised: boolean): string {
  return page(
    'Compartilhamento de dados',
    `    <div class="eyebrow">Compartilhamento de dados</div>
    <h1>${authorised ? 'Compartilhamento autorizado' : 'Pedido recusado'}</h1>
    <div class="success">${
      authorised
        ? `${escapeHtml(granteeName)} já pode consultar os dados que você autorizou.`
        : `${escapeHtml(granteeName)} não terá acesso aos seus dados.`
    }</div>
    <p class="subtitle">${
      authorised
        ? 'Você pode revogar quando quiser, em Compartilhamento de dados.'
        : 'Nenhum dado seu foi compartilhado.'
    }</p>`,
  )
}
