-- CreateTable
CREATE TABLE `PixTransfer` (
    `id` VARCHAR(191) NOT NULL,
    `sourceAccountId` VARCHAR(191) NOT NULL,
    `destinationAccountId` VARCHAR(191) NOT NULL,
    `pixKeyId` VARCHAR(191) NOT NULL,
    `endToEndId` VARCHAR(191) NOT NULL,
    `consentId` VARCHAR(255) NOT NULL,
    `enrollmentId` VARCHAR(255) NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `description` VARCHAR(191) NULL,
    `status` ENUM('COMPLETED', 'FAILED') NOT NULL DEFAULT 'COMPLETED',
    `debitTransactionId` VARCHAR(191) NOT NULL,
    `creditTransactionId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PixTransfer_endToEndId_key`(`endToEndId`),
    UNIQUE INDEX `PixTransfer_consentId_key`(`consentId`),
    UNIQUE INDEX `PixTransfer_debitTransactionId_key`(`debitTransactionId`),
    UNIQUE INDEX `PixTransfer_creditTransactionId_key`(`creditTransactionId`),
    INDEX `PixTransfer_sourceAccountId_createdAt_idx`(`sourceAccountId`, `createdAt`),
    INDEX `PixTransfer_destinationAccountId_createdAt_idx`(`destinationAccountId`, `createdAt`),
    INDEX `PixTransfer_pixKeyId_createdAt_idx`(`pixKeyId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PixTransfer` ADD CONSTRAINT `PixTransfer_sourceAccountId_fkey` FOREIGN KEY (`sourceAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PixTransfer` ADD CONSTRAINT `PixTransfer_destinationAccountId_fkey` FOREIGN KEY (`destinationAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PixTransfer` ADD CONSTRAINT `PixTransfer_pixKeyId_fkey` FOREIGN KEY (`pixKeyId`) REFERENCES `PixKey`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
