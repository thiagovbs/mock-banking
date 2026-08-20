import { Prisma } from '@prisma/client'
import { AppError } from './errors.js'

export function parseMoney(value: string | number): Prisma.Decimal {
  const decimal = new Prisma.Decimal(value)

  if (!decimal.isPositive()) {
    throw new AppError(400, 'Amount must be greater than zero', 'INVALID_AMOUNT')
  }

  if (decimal.decimalPlaces() > 2) {
    throw new AppError(400, 'Amount can have at most 2 decimal places', 'INVALID_AMOUNT')
  }

  return decimal
}

export function moneyToString(value: Prisma.Decimal): string {
  return value.toFixed(2)
}
