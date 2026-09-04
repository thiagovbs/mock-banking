import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildBrCode, computeCrc16 } from '../../src/modules/qrcode/service.js'

describe('buildBrCode', () => {
  const opts = {
    amount: new Prisma.Decimal('25.00'),
    pixKeyValue: '01688166360',
    txid: 'abcdef0123456789abcd',
    merchantName: 'MARIA SILVA',
    merchantCity: 'BRASILIA',
  }

  it('gera payload começando com PFI=01 e POI=12 (dinâmico)', () => {
    const payload = buildBrCode(opts)
    expect(payload.startsWith('000201')).toBe(true)
  })

  it('termina com o campo 63 (CRC16) de 4 dígitos hex', () => {
    const payload = buildBrCode(opts)
    expect(payload.slice(-8, -4)).toBe('6304')
    expect(payload.slice(-4)).toMatch(/^[0-9A-F]{4}$/)
  })

  it('o CRC16 computado bate com o sufixo do payload', () => {
    const payload = buildBrCode(opts)
    const computed = computeCrc16(payload.slice(0, -4))
    expect(computed).toBe(payload.slice(-4))
  })

  it('inclui os campos obrigatórios (26, 52, 53, 54, 58, 59, 60, 62)', () => {
    const payload = buildBrCode(opts)
    ;['26', '52', '53', '54', '58', '59', '60', '62'].forEach((id) => {
      expect(payload).toContain(id)
    })
  })

  it('incorpora a chave PIX no Merchant Account Information', () => {
    const payload = buildBrCode(opts)
    expect(payload).toContain(tlvEncoded('01', opts.pixKeyValue))
  })

  it('incorpora o txid no Additional Data (62.05)', () => {
    const payload = buildBrCode(opts)
    expect(payload).toContain(tlvEncoded('05', opts.txid))
  })

  it('serializa o valor com duas casas decimais', () => {
    const payload = buildBrCode(opts)
    expect(payload).toContain(tlvEncoded('54', '25.00'))
  })
})

function tlvEncoded(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`
}
