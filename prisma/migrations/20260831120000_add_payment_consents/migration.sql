-- CreateTable
CREATE TABLE `PaymentConsent` (
    `id` VARCHAR(191) NOT NULL,
    `externalConsentId` VARCHAR(255) NULL,
    `userId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `description` VARCHAR(191) NULL,
    `creditorName` VARCHAR(191) NOT NULL,
    `creditorDocument` VARCHAR(191) NULL,
    `creditorKeyType` ENUM('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP') NOT NULL,
    `creditorKeyValue` VARCHAR(255) NOT NULL,
    `status` ENUM('CREATED', 'AUTHORISED', 'PAYMENT_SUBMITTED', 'COMPLETED', 'EXPIRED') NOT NULL DEFAULT 'CREATED',
    `paymentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `authorisedAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `expiredAt` DATETIME(3) NULL,

    UNIQUE INDEX `PaymentConsent_externalConsentId_key`(`externalConsentId`),
    UNIQUE INDEX `PaymentConsent_paymentId_key`(`paymentId`),
    INDEX `PaymentConsent_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `PaymentConsent_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaymentConsent` ADD CONSTRAINT `PaymentConsent_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
