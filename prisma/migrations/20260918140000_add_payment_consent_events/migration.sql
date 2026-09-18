-- Trilha de auditoria do consentimento de pagamento: o consentimento guarda o
-- estado atual, esta tabela guarda o caminho ate ele -- inclusive tentativas
-- recusadas, que nao deixam marca no consentimento.

-- AlterTable
ALTER TABLE `PaymentConsent` ADD COLUMN `webhookUri` VARCHAR(500) NULL;

-- CreateTable
CREATE TABLE `PaymentConsentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `consentId` VARCHAR(191) NOT NULL,
    `event` VARCHAR(60) NOT NULL,
    `actor` ENUM('INITIATOR', 'HOLDER', 'SYSTEM') NOT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `outcome` ENUM('ACCEPTED', 'REFUSED') NOT NULL DEFAULT 'ACCEPTED',
    `reason` VARCHAR(60) NULL,
    `statusBefore` ENUM('CREATED', 'AWAITING_AUTHORISATION', 'AUTHORISED', 'REJECTED', 'PAYMENT_SUBMITTED', 'COMPLETED', 'EXPIRED') NULL,
    `statusAfter` ENUM('CREATED', 'AWAITING_AUTHORISATION', 'AUTHORISED', 'REJECTED', 'PAYMENT_SUBMITTED', 'COMPLETED', 'EXPIRED') NULL,
    `detail` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaymentConsentEvent_consentId_createdAt_idx`(`consentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaymentConsentEvent` ADD CONSTRAINT `PaymentConsentEvent_consentId_fkey` FOREIGN KEY (`consentId`) REFERENCES `PaymentConsent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
