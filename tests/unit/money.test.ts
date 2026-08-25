import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { parseMoney, moneyToString } from '../../src/shared/money.js'
import { AppError } from '../../src/shared/errors.js'

describe('parseMoney', () => {
  it('accepts a positive string amount', () => {
    const result = parseMoney('100.50')
    expect(result.toString()).toBe('100.5')
  })

  it('accepts a positive number amount', () => {
    const result = parseMoney(250)
    expect(result.toString()).toBe('250')
  })

  it('returns a Prisma.Decimal instance', () => {
    expect(parseMoney('10')).toBeInstanceOf(Prisma.Decimal)
  })

  it('accepts zero (current behavior: isPositive allows 0)', () => {
    expect(() => parseMoney('0')).not.toThrow()
  })

  it('rejects negative amounts', () => {
    expect(() => parseMoney('-5')).toThrow(AppError)
  })

  it('rejects amounts with more than 2 decimal places', () => {
    expect(() => parseMoney('10.999')).toThrow(AppError)
  })

  it('throws INVALID_AMOUNT code for negative amounts', () => {
    try {
      parseMoney('-5')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('INVALID_AMOUNT')
      expect((error as AppError).statusCode).toBe(400)
    }
  })
})

describe('moneyToString', () => {
  it('formats a decimal with 2 fixed places', () => {
    expect(moneyToString(new Prisma.Decimal('100.5'))).toBe('100.50')
  })

  it('formats whole numbers with trailing zeros', () => {
    expect(moneyToString(new Prisma.Decimal('250'))).toBe('250.00')
  })
})
