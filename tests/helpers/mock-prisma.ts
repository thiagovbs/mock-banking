import { vi } from 'vitest'

type MockFn = ReturnType<typeof vi.fn>

type ModelDelegate = {
  findUnique: MockFn
  findFirst: MockFn
  findMany: MockFn
  create: MockFn
  createMany: MockFn
  update: MockFn
  updateMany: MockFn
  delete: MockFn
  deleteMany: MockFn
  count: MockFn
}

function createModelDelegate(): ModelDelegate {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  }
}

export type MockPrismaClient = {
  user: ModelDelegate
  customer: ModelDelegate
  account: ModelDelegate
  transaction: ModelDelegate
  payment: ModelDelegate
  pixKey: ModelDelegate
  pixReceipt: ModelDelegate
  pixTransfer: ModelDelegate
  $transaction: MockFn
  $queryRaw: MockFn
  $connect: MockFn
  $disconnect: MockFn
}

/**
 * Creates a fresh mocked PrismaClient. Every delegate method is a vi.fn() that
 * the test controls. `$transaction` invokes the callback passing the same mock
 * as the transactional client (`tx`), mirroring how the app uses it.
 */
export function createMockPrisma(): MockPrismaClient {
  const prisma: MockPrismaClient = {
    user: createModelDelegate(),
    customer: createModelDelegate(),
    account: createModelDelegate(),
    transaction: createModelDelegate(),
    payment: createModelDelegate(),
    pixKey: createModelDelegate(),
    pixReceipt: createModelDelegate(),
    pixTransfer: createModelDelegate(),
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  }

  prisma.$transaction.mockImplementation(async (callback: (tx: MockPrismaClient) => unknown) => {
    return callback(prisma)
  })

  return prisma
}
