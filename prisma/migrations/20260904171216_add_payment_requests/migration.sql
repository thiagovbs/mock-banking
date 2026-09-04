-- CreateTable
CREATE TABLE `PaymentRequest` (
    `id` VARCHAR(191) NOT NULL,
    `txid` VARCHAR(255) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pixKeyId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `description` VARCHAR(255) NULL,
    `payload` TEXT NOT NULL,
    `status` ENUM('ACTIVE', 'PAID', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
    `expiresAt` DATETIME(3) NOT NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PaymentRequest_txid_key`(`txid`),
    INDEX `PaymentRequest_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaymentRequest` ADD CONSTRAINT `PaymentRequest_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentRequest` ADD CONSTRAINT `PaymentRequest_pixKeyId_fkey` FOREIGN KEY (`pixKeyId`) REFERENCES `PixKey`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
