-- Ancora a jornada JSR no enrollment: a conta passa a ser fixada na
-- confirmacao do titular e o consentimento nasce preso ao enrollment e a
-- credencial que o autorizou. Todas as colunas sao nullable para nao
-- invalidar linhas existentes.
-- AlterTable
ALTER TABLE `PaymentConsent` ADD COLUMN `enrollmentId` VARCHAR(191) NULL,
    ADD COLUMN `fidoCredentialId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Enrollment` ADD COLUMN `accountId` VARCHAR(191) NULL,
    ADD COLUMN `revokedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Enrollment_accountId_createdAt_idx` ON `Enrollment`(`accountId`, `createdAt`);

-- AddForeignKey
ALTER TABLE `Enrollment` ADD CONSTRAINT `Enrollment_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

