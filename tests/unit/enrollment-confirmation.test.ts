import { describe, it, expect, beforeEach } from 'vitest'
import { createMockPrisma, MockPrismaClient } from '../helpers/mock-prisma.js'
import { confirmEnrollment } from '../../src/modules/jsr/service.js'
import { AppError } from '../../src/shared/errors.js'

const CODE = 'auth-code-1'
const REQUEST_ID = 'request-1'

function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enroll-1',
    userId: 'user-1',
    code: CODE,
    requestId: REQUEST_ID,
    challenge: 'challenge-abc',
    used: false,
    status: 'ACCOUNT_HOLDER_CONFIRMED',
    ...overrides,
  }
}

describe('confirmEnrollment', () => {
  let mock: MockPrismaClient

  beforeEach(() => {
    mock = createMockPrisma()
    mock.enrollment.updateMany.mockResolvedValue({ count: 1 })
  })

  it('confirms a valid code and returns the FIDO options', async () => {
    mock.enrollment.findFirst.mockResolvedValue(enrollmentRow())

    const result = await confirmEnrollment(mock as never, CODE, REQUEST_ID)

    expect(result.fidoRegistrationOptions.challenge).toBe('challenge-abc')
  })

  it('rejects an unknown code', async () => {
    mock.enrollment.findFirst.mockResolvedValue(null)

    await expect(confirmEnrollment(mock as never, 'nope', REQUEST_ID)).rejects.toThrow(AppError)
  })

  // The requestId travelled with the code since the enrollment was created and
  // comes back as `state`. It used to be accepted and ignored entirely.
  it('rejects a valid code presented with the wrong requestId', async () => {
    mock.enrollment.findFirst.mockResolvedValue(enrollmentRow())

    await expect(confirmEnrollment(mock as never, CODE, 'other-request')).rejects.toThrow(AppError)
    expect(mock.enrollment.updateMany).not.toHaveBeenCalled()
  })

  // Previously the code could be exchanged an unlimited number of times: `used`
  // was written but never read.
  it('rejects a code that was already exchanged', async () => {
    mock.enrollment.findFirst.mockResolvedValue(enrollmentRow({ used: true }))
    mock.enrollment.updateMany.mockResolvedValue({ count: 0 })

    await expect(confirmEnrollment(mock as never, CODE, REQUEST_ID)).rejects.toThrow(AppError)
  })

  it('claims the code atomically, so concurrent exchanges cannot both win', async () => {
    mock.enrollment.findFirst.mockResolvedValue(enrollmentRow())

    await confirmEnrollment(mock as never, CODE, REQUEST_ID)

    expect(mock.enrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enroll-1', used: false },
      data: { used: true },
    })
  })
})
