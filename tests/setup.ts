import { vi } from 'vitest'
import { createMockPrisma, MockPrismaClient } from './helpers/mock-prisma.js'

// Shared mutable reference so tests can swap the mock instance per test.
let currentMock: MockPrismaClient = createMockPrisma()

export function setMockPrisma(mock: MockPrismaClient) {
  currentMock = mock
}

export function getMockPrisma(): MockPrismaClient {
  return currentMock
}

// Mock the PrismaClient class so the database plugin never opens a real
// connection. `Prisma` (used for Decimal) is preserved from the real module.
vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>()
  return {
    ...actual,
    PrismaClient: class {
      constructor() {
        return currentMock
      }
    },
  }
})
