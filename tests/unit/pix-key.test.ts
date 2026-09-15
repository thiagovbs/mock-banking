import { describe, it, expect } from 'vitest'
import { inferPixKeyType, normalizePixKey, validatePixKey } from '../../src/modules/pix/service.js'
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

describe('inferPixKeyType', () => {
  it.each([
    ['joao@example.com', 'EMAIL'],
    ['12345678901', 'CPF'],
    ['016.881.663-60', 'CPF'],
    ['12345678000199', 'CNPJ'],
    ['12.345.678/0001-99', 'CNPJ'],
    ['+5511999998888', 'PHONE'],
    ['9f1b7c2e-4a5d-4c8b-9e3f-1a2b3c4d5e6f', 'EVP'],
    ['9F1B7C2E-4A5D-4C8B-9E3F-1A2B3C4D5E6F', 'EVP'],
  ])('infers %s as %s', (value, expected) => {
    expect(inferPixKeyType(value)).toBe(expected)
  })

  it('trims surrounding whitespace before inferring', () => {
    expect(inferPixKeyType('  12345678901  ')).toBe('CPF')
  })

  // An e-mail whose local part has 11 digits used to be read as a CPF by the
  // JSR copy, which stripped non-digits before testing for '@'.
  it('reads a digit-only local part as EMAIL, not CPF', () => {
    expect(inferPixKeyType('12345678901@bank.com')).toBe('EMAIL')
  })

  // A UUID made only of digits and dashes used to survive the document test
  // once the dashes were stripped.
  it('reads an all-digit UUID as EVP, not a document', () => {
    expect(inferPixKeyType('12345678-1234-4123-8123-123456789012')).toBe('EVP')
  })

  it('does not read a document embedded in a larger string as CPF', () => {
    expect(() => inferPixKeyType('foo12345678901')).toThrow(AppError)
  })

  // The JSR copy returned EVP for anything it could not classify, which failed
  // later with a confusing "EVP must be a valid UUID" message.
  it.each([['not-a-key'], [''], ['123']])('throws for unclassifiable %s', (value) => {
    expect(() => inferPixKeyType(value)).toThrow(AppError)
  })

  it('throws INVALID_PIX_KEY with status 400', () => {
    try {
      inferPixKeyType('not-a-key')
      expect.unreachable()
    } catch (error) {
      expect((error as AppError).code).toBe('INVALID_PIX_KEY')
      expect((error as AppError).statusCode).toBe(400)
    }
  })
})
