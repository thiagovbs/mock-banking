import { FastifyRequest } from 'fastify'

/**
 * Endereco publico sob o qual esta API e alcancada de fora.
 *
 * Atras de um gateway, `request.host` e o endereco do *backend*: o gateway
 * reescreve o Host ao repassar. Montar URL com ele tem duas consequencias, e as
 * duas quebram a jornada:
 *
 *  - o `authorisationUrl` devolvido a Iniciadora aponta para o endereco interno,
 *    fazendo o navegador do titular ignorar o gateway;
 *  - as telas HTML ficam com `action` de formulario sem o basePath do gateway,
 *    entao o titular ve a tela, preenche a senha e recebe 404 ao confirmar.
 *
 * PUBLIC_BASE_URL e o endereco publico **com** o basePath, ex.:
 * `https://api-assets.sensedia.com/v1`. Os caminhos proprios da aplicacao sao
 * concatenados a ele, de modo que uma rota `/v1/aspsp/...` publicada sob aquele
 * basePath vira `https://api-assets.sensedia.com/v1/v1/aspsp/...` -- que e como
 * o gateway de fato a expoe.
 *
 * Sem a variavel, cai no host da propria requisicao, que e o correto em acesso
 * direto e em desenvolvimento.
 */
export function publicBaseUrl(request: FastifyRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `${request.protocol}://${request.host}`
}
