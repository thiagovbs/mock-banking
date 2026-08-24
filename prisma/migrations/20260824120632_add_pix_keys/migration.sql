/*
  Warnings:

  - You are about to alter the column `status` on the `PixReceipt` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Enum(EnumId(3))`.
  - A unique constraint covering the columns `[transactionId]` on the table `PixReceipt` will be added. If there are existing duplicate values, this will fail.
  - Made the column `transactionId` on table `PixReceipt` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `PixReceipt` MODIFY `status` ENUM('COMPLETED', 'FAILED') NOT NULL DEFAULT 'COMPLETED',
    MODIFY `transactionId` VARCHAR(191) NOT NULL;

-- CreateTable
CREATE TABLE `PixKey` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `type` ENUM('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP') NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `status` ENUM('ACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PixKey_value_key`(`value`),
    INDEX `PixKey_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `PixReceipt_transactionId_key` ON `PixReceipt`(`transactionId`);

-- CreateIndex
CREATE INDEX `PixReceipt_accountId_createdAt_idx` ON `PixReceipt`(`accountId`, `createdAt`);

-- AddForeignKey
ALTER TABLE `PixKey` ADD CONSTRAINT `PixKey_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
