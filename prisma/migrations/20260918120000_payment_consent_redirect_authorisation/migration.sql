-- Jornada de pagamento com redirecionamento: o consentimento passa a nascer
-- pendente e so vira AUTHORISED depois que o titular confirma na tela da
-- Detentora. Titular, cliente e conta ficam nulos ate esse momento, porque a
-- Iniciadora nao sabe quem vai autorizar quando cria o consentimento.

-- AlterTable
ALTER TABLE `PaymentConsent`
  MODIFY `status` ENUM('CREATED', 'AWAITING_AUTHORISATION', 'AUTHORISED', 'REJECTED', 'PAYMENT_SUBMITTED', 'COMPLETED', 'EXPIRED') NOT NULL DEFAULT 'CREATED',
  MODIFY `userId` VARCHAR(191) NULL,
  MODIFY `customerId` VARCHAR(191) NULL,
  MODIFY `accountId` VARCHAR(191) NULL,
  ADD COLUMN `debtorDocument` VARCHAR(191) NULL,
  ADD COLUMN `redirectUri` VARCHAR(500) NULL,
  ADD COLUMN `statusUpdatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `rejectedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `PaymentConsent_debtorDocument_createdAt_idx` ON `PaymentConsent`(`debtorDocument`, `createdAt`);
