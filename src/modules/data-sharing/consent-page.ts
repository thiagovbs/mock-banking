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

import { ASSET_PATHS, metaRefreshTag, returnLinkHtml } from '../assets/routes.js'

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
function page(title: string, baseUrl: string, body: string, returnUrl?: string | null): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${escapeHtml(baseUrl)}${ASSET_PATHS.css}" />${metaRefreshTag(returnUrl)}
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
    consent.baseUrl,
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
    consent.baseUrl,
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
export function resultStepHtml(
  granteeName: string,
  authorised: boolean,
  baseUrl: string,
  returnUrl?: string | null,
): string {
  return page(
    'Compartilhamento de dados',
    baseUrl,
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
    }</p>
${returnLinkHtml(returnUrl, 'Voltar agora')}`,
    returnUrl,
  )
}
