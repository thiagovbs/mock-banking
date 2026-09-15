import { describe, it, expect } from 'vitest'
import { signFidoAssertion, verifyFidoAssertion } from '../../src/modules/jsr/assertion.js'

/**
 * Vetor fixo compartilhado com a Iniciadora (app/assertion.py do repo
 * Payments-Initiator). As duas pontas precisam produzir exatamente este valor:
 * se alguem mudar o dominio, a ordem dos campos ou o separador de um lado so,
 * a jornada JSR quebra em runtime. Este teste faz a divergencia aparecer aqui.
 */
const SECRET = 'initiator-test-secret'
const INPUT = {
  consentId: 'consent-1',
  credentialId: 'credential-xpto',
  challenge: 'challenge-abc',
}
const EXPECTED = '5f202708746b6cb9d29cabb819d6ee01088595296b55ed179d80c3802e4b4484'

describe('FIDO assertion cross-language vector', () => {
  it('matches the signature produced by the Python side', () => {
    expect(signFidoAssertion(SECRET, INPUT)).toBe(EXPECTED)
  })

  it('verifies its own signature', () => {
    expect(verifyFidoAssertion(SECRET, INPUT, EXPECTED)).toBe(true)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyFidoAssertion(SECRET, INPUT, 'short')).toBe(false)
  })

  it.each([
    ['consentId', { ...INPUT, consentId: 'consent-2' }],
    ['credentialId', { ...INPUT, credentialId: 'other-credential' }],
    ['challenge', { ...INPUT, challenge: 'other-challenge' }],
  ])('changes when %s changes', (_field, changed) => {
    expect(signFidoAssertion(SECRET, changed)).not.toBe(EXPECTED)
  })
})
