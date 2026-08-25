import { buildApp } from '../../src/app.js'
import { getMockPrisma, setMockPrisma } from '../setup.js'
import { createMockPrisma, MockPrismaClient } from './mock-prisma.js'

/**
 * Builds the Fastify app backed by a mocked PrismaClient (no real DB).
 *
 * The `@prisma/client` module is mocked globally in tests/setup.ts, so the
 * database plugin decorates `app.prisma` with the current mock instance.
 * Each call to buildTestApp installs a fresh mock to isolate tests.
 */
export async function buildTestApp() {
  const mock = createMockPrisma()
  setMockPrisma(mock)
  const app = await buildApp()
  return { app, mock }
}

export { MockPrismaClient }
export { getMockPrisma }
