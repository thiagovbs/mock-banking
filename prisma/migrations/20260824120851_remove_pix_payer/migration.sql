/*
  Warnings:

  - You are about to drop the column `payerDocument` on the `PixReceipt` table. All the data in the column will be lost.
  - You are about to drop the column `payerName` on the `PixReceipt` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[consentId]` on the table `PixReceipt` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `PixReceipt` DROP COLUMN `payerDocument`,
    DROP COLUMN `payerName`,
    ADD COLUMN `consentId` VARCHAR(255) NULL,
    ADD COLUMN `enrollmentId` VARCHAR(255) NULL,
    ADD COLUMN `pixKeyId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `PixReceipt_consentId_key` ON `PixReceipt`(`consentId`);

-- CreateIndex
CREATE INDEX `PixReceipt_pixKeyId_createdAt_idx` ON `PixReceipt`(`pixKeyId`, `createdAt`);

-- AddForeignKey
ALTER TABLE `PixReceipt` ADD CONSTRAINT `PixReceipt_pixKeyId_fkey` FOREIGN KEY (`pixKeyId`) REFERENCES `PixKey`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
