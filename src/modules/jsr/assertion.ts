import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Prova de posse da credencial na jornada JSR.
 *
 * Isto NAO e WebAuthn. Nao ha chave privada no dispositivo nem verificacao de
 * assinatura assimetrica: Iniciadora e Detentora sao dois backends e compartilham
 * um segredo. O que a assinatura prova e que quem autoriza conhece o challenge
 * daquele consentimento especifico e a credencial certa -- nao que o dispositivo
 * do titular participou.
 *
 * Como o segredo e o mesmo que autentica a Iniciadora, a assinatura nao
 * acrescenta um ator novo: quem tem o x-initiator-key consegue produzi-la. O
 * ganho e amarrar a autorizacao a um par (consentimento, credencial) e a um
 * challenge de uso unico, fechando a reutilizacao.
 */
const DOMAIN = 'jsr-fido-assertion'

export type AssertionInput = {
  consentId: string
  credentialId: string
  challenge: string
}

export function signFidoAssertion(secret: string, input: AssertionInput): string {
  return createHmac('sha256', secret)
    .update(`${DOMAIN}|${input.consentId}|${input.credentialId}|${input.challenge}`)
    .digest('hex')
}

export function verifyFidoAssertion(
  secret: string,
  input: AssertionInput,
  presented: string,
): boolean {
  const expected = signFidoAssertion(secret, input)
  // O hash previo iguala o comprimento exigido por timingSafeEqual e evita que
  // uma assinatura de tamanho errado seja distinguivel pelo tempo de resposta.
  const a = createHmac('sha256', secret).update(expected).digest()
  const b = createHmac('sha256', secret).update(presented).digest()
  return timingSafeEqual(a, b)
}
