-- PixReceipt foi substituida por PixTransfer em "add PIX Transactions" e desde
-- entao nenhum codigo le ou escreve nela. O enum PixReceiptStatus permanece:
-- PixTransfer.status ainda o utiliza.
-- DropForeignKey
ALTER TABLE `PixReceipt` DROP FOREIGN KEY `PixReceipt_accountId_fkey`;

-- DropForeignKey
ALTER TABLE `PixReceipt` DROP FOREIGN KEY `PixReceipt_pixKeyId_fkey`;

-- DropTable
DROP TABLE `PixReceipt`;

-- Payment volta a ser gravada pela fachada, agora para os quatro metodos.
-- `method` entra com default temporario porque a tabela pode conter linhas do
-- fluxo antigo (POST /v1/accounts/:id/payments), que so tinha dados de
-- beneficiario e por isso se aproxima de BILL. O default e removido em seguida
-- para que toda insercao nova declare o metodo explicitamente.
-- AlterTable
ALTER TABLE `Payment` ADD COLUMN `billProvider` VARCHAR(100) NULL,
    ADD COLUMN `billReference` VARCHAR(255) NULL,
    ADD COLUMN `digitableLine` VARCHAR(100) NULL,
    ADD COLUMN `endToEndId` VARCHAR(255) NULL,
    ADD COLUMN `method` ENUM('PIX', 'QR_CODE', 'BOLETO', 'BILL') NOT NULL DEFAULT 'BILL',
    ADD COLUMN `pixKey` VARCHAR(255) NULL,
    ADD COLUMN `pixTransferId` VARCHAR(191) NULL,
    MODIFY `beneficiaryName` VARCHAR(191) NULL,
    MODIFY `beneficiaryDoc` VARCHAR(191) NULL;

ALTER TABLE `Payment` ALTER COLUMN `method` DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX `Payment_pixTransferId_key` ON `Payment`(`pixTransferId`);
