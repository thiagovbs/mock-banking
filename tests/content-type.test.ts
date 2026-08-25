import { describe, it, expect } from 'vitest'
import { buildTestApp } from './helpers/build-app.js'

describe('content-type tolerance', () => {
  it('accepts a JSON body without Content-Type header (no 415)', async () => {
    const { app } = await buildTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/me/payments',
      payload: { paymentMethod: 'PIX', amount: 500 },
      // no content-type header
    })
    // Should NOT be 415. Without a token it will be 401 (auth runs first).
    expect(response.statusCode).not.toBe(415)
  })

  it('accepts a JSON body with text/plain content type', async () => {
    const { app } = await buildTestApp()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/me/payments',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ paymentMethod: 'PIX', amount: 500 }),
    })
    expect(response.statusCode).not.toBe(415)
  })
})
