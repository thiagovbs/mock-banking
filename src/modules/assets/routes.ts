import { FastifyPluginAsync } from 'fastify'

/**
 * Estilo e imagem das telas HTML, servidos como arquivos.
 *
 * Nao e preciosismo de organizacao: atras do gateway da Sensedia a resposta
 * carrega uma Content-Security-Policy com `style-src 'self'` e `img-src 'self'`,
 * sem `'unsafe-inline'` nem `data:`. Com o CSS dentro de <style> e o logo em
 * data: URI, o navegador recebia tudo e recusava a aplicar -- a tela aparecia
 * crua, com a estrutura certa e nenhum estilo.
 *
 * Servidos daqui, sao recursos da mesma origem da pagina, que e o que `'self'`
 * permite. Em acesso direto, sem CSP nenhuma, o resultado e o mesmo.
 *
 * Uma folha so para as tres telas (login OAuth, consentimento de pagamento e
 * compartilhamento de dados): elas ja compartilhavam quase todo o CSS, e manter
 * copias divergindo era o caminho mais curto para uma delas envelhecer.
 */

const ONE_HOUR = 3600

export const CONSENT_CSS = `:root {
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
/* A tela de login e mais estreita: so um formulario, sem blocos de revisao. */
.card.login { max-width: 400px; padding: 40px 32px; }
.logo { display: block; margin: 0 auto 28px; height: 40px; width: auto; }
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
  transition: background .15s;
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
/* Consentimento de pagamento: quanto e para quem. */
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
/* Compartilhamento de dados: permissoes pedidas e validade. */
.perm { display: flex; gap: 10px; padding: 10px 12px; background: var(--surface-2); border-radius: 10px; margin-bottom: 8px; }
.perm .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--purple); margin-top: 7px; flex: none; }
.perm strong { display: block; font-size: 14px; font-weight: 600; }
.perm span { font-size: 12.5px; color: var(--muted); }
.validity { background: var(--purple-soft); border-radius: 10px; padding: 12px 14px; font-size: 13px; color: var(--ink); margin-bottom: 4px; }
.validity strong { font-weight: 600; }
/* Selecao de contas, nas duas jornadas. */
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

export const SENSEDIA_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="812" height="226" viewBox="0 0 812 226">' +
  '<rect width="812" height="226" fill="#ffffff"/>' +
  '<text x="406" y="130" font-family="Arial, sans-serif" font-size="60" font-weight="700" ' +
  'fill="#8241B0" text-anchor="middle">Sensedia</text></svg>'

/** Segundos de leitura antes de devolver o navegador a quem iniciou a jornada. */
const RETURN_DELAY_SECONDS = 2

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Redirecionamento que sobrevive a CSP do gateway.
 *
 * Responder 302 depois de um POST de formulario nao funciona atras de
 * `form-action 'self'`: o navegador aplica a diretiva tambem ao redirect que
 * segue a submissao, e como o destino e a Iniciadora -- outra origem -- ele e
 * bloqueado. A tela fica parada, e a pessoa clica de novo achando que nao
 * enviou. Meta refresh e navegacao comum, fora do alcance de form-action.
 *
 * O link visivel acompanha de proposito: se o refresh nao rodar, a jornada
 * continua sendo concluivel com um clique, em vez de terminar numa tela morta.
 */
export function metaRefreshTag(url: string | null | undefined): string {
  if (!url) return ''
  return `
  <meta http-equiv="refresh" content="${RETURN_DELAY_SECONDS};url=${escapeAttr(url)}" />`
}

export function returnLinkHtml(url: string | null | undefined, label: string): string {
  if (!url) return ''
  return `    <p class="subtitle"><a href="${escapeAttr(url)}">${label}</a></p>`
}

/** Caminhos usados pelas telas para montar `<link>` e `<img>`. */
export const ASSET_PATHS = {
  css: '/v1/assets/consent.css',
  logo: '/v1/assets/sensedia-logo.svg',
} as const

const assetRoutes: FastifyPluginAsync = async (app) => {
  app.get(ASSET_PATHS.css, async (_request, reply) => {
    return reply
      .type('text/css; charset=utf-8')
      .header('cache-control', `public, max-age=${ONE_HOUR}`)
      .send(CONSENT_CSS)
  })

  app.get(ASSET_PATHS.logo, async (_request, reply) => {
    return reply
      .type('image/svg+xml; charset=utf-8')
      .header('cache-control', `public, max-age=${ONE_HOUR}`)
      .send(SENSEDIA_LOGO_SVG)
  })
}

export default assetRoutes
