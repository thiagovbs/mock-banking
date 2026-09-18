import { describe, it, expect, afterEach } from 'vitest'
import { publicBaseUrl } from '../../src/shared/public-url.js'

/**
 * Atras de um gateway, `request.host` e o endereco do backend. Usa-lo para
 * montar URL devolve ao cliente um endereco interno, e deixa as telas HTML com
 * `action` sem o basePath do gateway -- o titular preenche a senha e recebe 404.
 */
function fakeRequest(protocol = 'http', host = '10.0.0.5:3000') {
  return { protocol, host } as never
}

describe('publicBaseUrl', () => {
  const original = process.env.PUBLIC_BASE_URL

  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_BASE_URL
    else process.env.PUBLIC_BASE_URL = original
  })

  it('usa o host da requisicao quando a variavel nao esta setada', () => {
    delete process.env.PUBLIC_BASE_URL

    // Acesso direto e desenvolvimento continuam funcionando sem configurar nada.
    expect(publicBaseUrl(fakeRequest('http', 'localhost:3000'))).toBe('http://localhost:3000')
  })

  it('usa a variavel quando setada, ignorando o host interno', () => {
    process.env.PUBLIC_BASE_URL = 'https://api-assets.sensedia.com/v1'

    expect(publicBaseUrl(fakeRequest())).toBe('https://api-assets.sensedia.com/v1')
  })

  it('descarta barra final, para nao dobrar na concatenacao', () => {
    process.env.PUBLIC_BASE_URL = 'https://api-assets.sensedia.com/v1///'

    expect(publicBaseUrl(fakeRequest())).toBe('https://api-assets.sensedia.com/v1')
  })

  it('variavel vazia ou so espacos equivale a nao setada', () => {
    process.env.PUBLIC_BASE_URL = '   '

    expect(publicBaseUrl(fakeRequest('https', 'core.local'))).toBe('https://core.local')
  })
})
