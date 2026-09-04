import { Prisma, PrismaClient } from '@prisma/client'
import QRCode from 'qrcode'
import { randomBytes } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { moneyToString, parseMoney } from '../../shared/money.js'
import {
  executePixTransfer,
  normalizePixKey,
  validatePixKey,
  type PixKeyType,
} from '../pix/service.js'

/**
 * Constantes do padrão BR Code (ESPECIFICAÇÃO PIX / EMV QRCPS-MPM).
 */
const BR_CODE_GUI = 'br.gov.bcb.pix'
const BR_CODE_MCC = '0000'
const BR_CODE_CURRENCY = '986'
const BR_CODE_COUNTRY = 'BR'
const MAX_TXID_LENGTH = 25
const MAX_MERCHANT_NAME_LENGTH = 25
const MAX_MERCHANT_CITY_LENGTH = 15

export type CreatePaymentRequestParams = {
  prisma: PrismaClient
  userId: string
  pixKey: { type: PixKeyType; value: string }
  amount: Prisma.Decimal
  description?: string
  /** Minutos até a expiração (padrão 24h). */
  expiresMinutes?: number
}

export type SettlePaymentRequestParams = {
  prisma: PrismaClient
  payerUserId: string
  paymentRequestId: string
}

export type BrCodeOptions = {
  amount: Prisma.Decimal
  pixKeyValue: string
  txid: string
  merchantName: string
  merchantCity: string
}

// ---------------------------------------------------------------------------
// Helpers do BR Code
// ---------------------------------------------------------------------------

/** Empacota um campo TLV (ID + length + value). */
function tlv(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`
}

/** Calcula o CRC16-CCITT (polinômio 0x1021, init 0xFFFF) do payload. */
export function computeCrc16(payload: string): string {
  let crc = 0xffff
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * Monta o payload BR Code PIX dinâmico (copiable / EMV QRCPS-MPM).
 */
export function buildBrCode(options: BrCodeOptions): string {
  const merchantAccountInformation = tlv('00', BR_CODE_GUI) + tlv('01', options.pixKeyValue)
  const additionalData = tlv('05', options.txid.slice(0, MAX_TXID_LENGTH))

  const payloadWithoutCrc =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('26', merchantAccountInformation) +
    tlv('52', BR_CODE_MCC) +
    tlv('53', BR_CODE_CURRENCY) +
    tlv('54', moneyToString(options.amount)) +
    tlv('58', BR_CODE_COUNTRY) +
    tlv('59', options.merchantName.slice(0, MAX_MERCHANT_NAME_LENGTH)) +
    tlv('60', options.merchantCity.slice(0, MAX_MERCHANT_CITY_LENGTH)) +
    tlv('62', additionalData)

  const crc = computeCrc16(`${payloadWithoutCrc}6304`)
  return `${payloadWithoutCrc}6304${crc}`
}

/** Gera a imagem PNG do QRCode e devolve em base64 (data URL). */
export async function generateQrImage(payload: string): Promise<string> {
  const buffer = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  })
  return `data:image/png;base64,${buffer.toString('base64')}`
}

function sanitize(value: string, max: number): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, max)
}

async function resolveBeneficiaryAccount(
  prisma: PrismaClient,
  userId: string,
  pixKey: { type: PixKeyType; value: string },
) {
  const normalizedKey = normalizePixKey(pixKey.type, pixKey.value)
  validatePixKey(pixKey.type, normalizedKey)

  const key = await prisma.pixKey.findFirst({
    where: { type: pixKey.type, value: normalizedKey, status: 'ACTIVE' },
    include: {
      account: {
        include: { customer: { include: { user: true } } },
      },
    },
  })

  if (!key) throw new AppError(404, 'PIX key not found', 'PIX_KEY_NOT_FOUND')

  // A chave deve pertencer a uma conta do usuário autenticado (beneficiário).
  if (key.account.customer.userId !== userId) {
    throw new AppError(403, 'PIX key does not belong to the authenticated user', 'PIX_KEY_FORBIDDEN')
  }

  return { key, normalizedKey }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function createPaymentRequest(
  params: CreatePaymentRequestParams,
): Promise<{
  id: string
  txid: string
  payload: string
  base64Image: string
  amount: string
  description: string | null
  status: string
  expiresAt: Date
}> {
  const { prisma, userId, pixKey, amount, description } = params
  const { key, normalizedKey } = await resolveBeneficiaryAccount(prisma, userId, pixKey)

  const txid = randomBytes(10).toString('hex')
  const merchantName = sanitize(key.account.customer.name, MAX_MERCHANT_NAME_LENGTH)
  const merchantCity = sanitize('BRASILIA', MAX_MERCHANT_CITY_LENGTH)

  const payload = buildBrCode({
    amount,
    pixKeyValue: normalizedKey,
    txid,
    merchantName: merchantName || 'BENEFICIARIO',
    merchantCity: merchantCity || 'BRASILIA',
  })
  const base64Image = await generateQrImage(payload)

  const expiresMinutes = params.expiresMinutes ?? 24 * 60
  const expiresAt = new Date(Date.now() + expiresMinutes * 60_000)

  const request = await prisma.paymentRequest.create({
    data: {
      txid,
      accountId: key.accountId,
      pixKeyId: key.id,
      amount,
      description,
      payload,
      status: 'ACTIVE',
      expiresAt,
    },
  })

  return {
    id: request.id,
    txid: request.txid,
    payload: request.payload,
    base64Image,
    amount: moneyToString(request.amount),
    description: request.description,
    status: request.status,
    expiresAt: request.expiresAt,
  }
}

async function findOwnedRequest(prisma: PrismaClient, userId: string, id: string) {
  const request = await prisma.paymentRequest.findFirst({
    where: {
      id,
      account: { customer: { is: { userId } } },
    },
  })
  if (!request) throw new AppError(404, 'Payment request not found', 'PAYMENT_REQUEST_NOT_FOUND')
  return request
}

export async function getPaymentRequest(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<{
  id: string
  txid: string
  amount: string
  description: string | null
  payload: string
  status: string
  expiresAt: Date
  paidAt: Date | null
  createdAt: Date
}> {
  const request = await findOwnedRequest(prisma, userId, id)
  return {
    id: request.id,
    txid: request.txid,
    amount: moneyToString(request.amount),
    description: request.description,
    payload: request.payload,
    status: request.status,
    expiresAt: request.expiresAt,
    paidAt: request.paidAt,
    createdAt: request.createdAt,
  }
}

export async function cancelPaymentRequest(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<{ id: string; status: string }> {
  const request = await findOwnedRequest(prisma, userId, id)
  if (request.status !== 'ACTIVE') {
    throw new AppError(409, `Cannot cancel a ${request.status.toLowerCase()} payment request`, 'INVALID_STATUS')
  }

  const updated = await prisma.paymentRequest.update({
    where: { id: request.id },
    data: { status: 'CANCELLED' },
  })

  return { id: updated.id, status: updated.status }
}

/**
 * Liquida uma solicitação de pagamento internamente: debita da conta do
 * pagador autenticado e credita a conta beneficiária (via transferência PIX).
 */
export async function settlePaymentRequest(
  params: SettlePaymentRequestParams,
): Promise<{
  pixTransferId: string
  endToEndId: string
  amount: string
  balance: string
  status: string
}> {
  const { prisma, payerUserId, paymentRequestId } = params

  const request = await prisma.paymentRequest.findUnique({
    where: { id: paymentRequestId },
    include: { pixKey: true, account: true },
  })
  if (!request) {
    throw new AppError(404, 'Payment request not found', 'PAYMENT_REQUEST_NOT_FOUND')
  }
  if (request.status !== 'ACTIVE') {
    throw new AppError(409, `Payment request is ${request.status.toLowerCase()}`, 'INVALID_STATUS')
  }
  if (Date.now() > request.expiresAt.getTime()) {
    throw new AppError(409, 'Payment request expired', 'PAYMENT_REQUEST_EXPIRED')
  }

  const sourceAccount = await prisma.account.findFirst({
    where: {
      status: 'ACTIVE',
      customer: { is: { userId: payerUserId } },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!sourceAccount) {
    throw new AppError(404, 'Active account not found', 'ACCOUNT_NOT_FOUND')
  }

  const result = await executePixTransfer({
    prisma,
    sourceAccountId: sourceAccount.id,
    userId: payerUserId,
    amount: request.amount,
    input: {
      pixKey: { type: request.pixKey.type, value: request.pixKey.value },
      consentId: `qr:${request.id}`,
      description: request.description ?? `QR Code payment ${request.txid}`,
    },
  })

  // Marca como pago de forma atômica (apenas se ainda estiver ACTIVE).
  const claimed = await prisma.paymentRequest.updateMany({
    where: { id: request.id, status: 'ACTIVE' },
    data: { status: 'PAID', paidAt: new Date() },
  })
  if (claimed.count === 0) {
    throw new AppError(409, 'Payment request was already settled', 'INVALID_STATUS')
  }

  return {
    pixTransferId: result.transfer.id,
    endToEndId: result.transfer.endToEndId,
    amount: moneyToString(request.amount),
    balance: moneyToString(result.sourceBalanceAfter),
    status: 'PAID',
  }
}

export function parsePaymentRequestAmount(value: string | number): Prisma.Decimal {
  return parseMoney(value)
}
