import { describe, it, expect } from 'vitest'
import { normalizePixKey, validatePixKey } from '../../src/modules/pix/service.js'
import { AppError } from '../../src/shared/errors.js'

describe('normalizePixKey', () => {
  it('strips non-digits from CPF', () => {
    expect(normalizePixKey('CPF', '123.456.789-01')).toBe('12345678901')
  })

  it('strips non-digits from CNPJ', () => {
    expect(normalizePixKey('CNPJ', '12.345.678/0001-90')).toBe('12345678000190')
  })

  it('lowercases and trims EMAIL', () => {
    expect(normalizePixKey('EMAIL', '  Joao@Example.COM ')).toBe('joao@example.com')
  })

  it('removes spaces, parens and dashes from PHONE', () => {
    expect(normalizePixKey('PHONE', '+55 (11) 98765-4321')).toBe('+5511987654321')
  })

  it('lowercases and trims EVP', () => {
    expect(normalizePixKey('EVP', '  ABCDEF00-1234-5678-9ABC-DEF012345678 ')).toBe('abcdef00-1234-5678-9abc-def012345678')
  })
})

describe('validatePixKey', () => {
  it('accepts a valid CPF', () => {
    expect(() => validatePixKey('CPF', '12345678901')).not.toThrow()
  })

  it('rejects an invalid CPF length', () => {
    expect(() => validatePixKey('CPF', '123')).toThrow(AppError)
  })

  it('accepts a valid CNPJ', () => {
    expect(() => validatePixKey('CNPJ', '12345678000190')).not.toThrow()
  })

  it('rejects an invalid CNPJ', () => {
    expect(() => validatePixKey('CNPJ', '123')).toThrow(AppError)
  })

  it('accepts a valid EMAIL', () => {
    expect(() => validatePixKey('EMAIL', 'joao@example.com')).not.toThrow()
  })

  it('rejects an invalid EMAIL', () => {
    expect(() => validatePixKey('EMAIL', 'not-an-email')).toThrow(AppError)
  })

  it('accepts a valid PHONE', () => {
    expect(() => validatePixKey('PHONE', '+5511987654321')).not.toThrow()
  })

  it('rejects an invalid PHONE', () => {
    expect(() => validatePixKey('PHONE', '123')).toThrow(AppError)
  })

  it('accepts a valid EVP UUID', () => {
    expect(() => validatePixKey('EVP', 'abcdef00-1234-5678-9abc-def012345678')).not.toThrow()
  })

  it('rejects an invalid EVP', () => {
    expect(() => validatePixKey('EVP', 'not-a-uuid')).toThrow(AppError)
  })

  it('throws INVALID_PIX_KEY code', () => {
    try {
      validatePixKey('CPF', '123')
      expect.unreachable()
    } catch (error) {
      expect((error as AppError).code).toBe('INVALID_PIX_KEY')
      expect((error as AppError).statusCode).toBe(400)
    }
  })
})
