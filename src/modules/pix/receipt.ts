import { PrismaClient } from '@prisma/client'
import { AppError } from '../../shared/errors.js'
import { moneyToString } from '../../shared/money.js'

/**
 * Comprovante de uma transferencia PIX.
 *
 * Diferente das demais consultas, o comprovante e visivel para os dois lados
 * da operacao: quem pagou e quem recebeu. A direcao no retorno e relativa ao
 * usuario autenticado.
 */
export async function getPixReceipt(prisma: PrismaClient, userId: string, pixTransferId: string) {
  const transfer = await prisma.pixTransfer.findFirst({
    where: {
      id: pixTransferId,
      OR: [
        { sourceAccount: { customer: { is: { userId } } } },
        { destinationAccount: { customer: { is: { userId } } } },
      ],
    },
    include: {
      sourceAccount: { include: { customer: true } },
      destinationAccount: { include: { customer: true } },
      pixKey: true,
    },
  })

  // 404 tambem quando a transferencia existe mas nao envolve o usuario, para
  // nao permitir enumeracao.
  if (!transfer) {
    throw new AppError(404, 'PIX transfer not found', 'PIX_TRANSFER_NOT_FOUND')
  }

  const isPayer = transfer.sourceAccount.customer.userId === userId

  return {
    pixTransferId: transfer.id,
    endToEndId: transfer.endToEndId,
    consentId: transfer.consentId,
    enrollmentId: transfer.enrollmentId,
    direction: isPayer ? 'SENT' : 'RECEIVED',
    amount: moneyToString(transfer.amount),
    status: transfer.status,
    description: transfer.description,
    payer: {
      accountId: transfer.sourceAccount.id,
      branch: transfer.sourceAccount.branch,
      accountNumber: transfer.sourceAccount.accountNumber,
      name: transfer.sourceAccount.customer.name,
      document: transfer.sourceAccount.customer.document,
    },
    payee: {
      accountId: transfer.destinationAccount.id,
      branch: transfer.destinationAccount.branch,
      accountNumber: transfer.destinationAccount.accountNumber,
      name: transfer.destinationAccount.customer.name,
      document: transfer.destinationAccount.customer.document,
      pixKey: { type: transfer.pixKey.type, value: transfer.pixKey.value },
    },
    createdAt: transfer.createdAt,
  }
}
