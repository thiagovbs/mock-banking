-- AlterTable
ALTER TABLE `PaymentConsent` ADD COLUMN `authorisationFlow` VARCHAR(191) NULL,
ADD COLUMN `fidoChallenge` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Enrollment` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `status` ENUM('CREATED', 'ACCOUNT_HOLDER_CONFIRMED', 'FIDO_REGISTERED', 'USED') NOT NULL DEFAULT 'CREATED',
    `requestId` VARCHAR(191) NULL,
    `code` VARCHAR(191) NULL,
    `redirectUri` VARCHAR(191) NOT NULL,
    `challenge` VARCHAR(191) NOT NULL,
    `used` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Enrollment_requestId_key`(`requestId`),
    UNIQUE INDEX `Enrollment_code_key`(`code`),
    INDEX `Enrollment_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FidoCredential` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `enrollmentId` VARCHAR(191) NULL,
    `credentialId` VARCHAR(191) NOT NULL,
    `publicKey` VARCHAR(191) NOT NULL,
    `counter` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FidoCredential_enrollmentId_key`(`enrollmentId`),
    UNIQUE INDEX `FidoCredential_credentialId_key`(`credentialId`),
    INDEX `FidoCredential_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
