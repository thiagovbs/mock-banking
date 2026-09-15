-- CreateTable
CREATE TABLE `DataSharingConsent` (
    `id` VARCHAR(191) NOT NULL,
    `granteeUserId` VARCHAR(191) NOT NULL,
    `granteeCustomerId` VARCHAR(191) NOT NULL,
    `granterDocument` VARCHAR(191) NOT NULL,
    `granterUserId` VARCHAR(191) NULL,
    `granterCustomerId` VARCHAR(191) NULL,
    `permissions` JSON NOT NULL,
    `status` ENUM('AWAITING_AUTHORISATION', 'AUTHORISED', 'REJECTED') NOT NULL DEFAULT 'AWAITING_AUTHORISATION',
    `expiresAt` DATETIME(3) NULL,
    `rejectedBy` ENUM('USER', 'ASPSP', 'TPP') NULL,
    `rejectReason` ENUM('CUSTOMER_MANUALLY_REJECTED', 'CUSTOMER_MANUALLY_REVOKED', 'CONSENT_EXPIRED') NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `statusUpdatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `authorisedAt` DATETIME(3) NULL,
    `rejectedAt` DATETIME(3) NULL,

    INDEX `DataSharingConsent_granteeCustomerId_createdAt_idx`(`granteeCustomerId`, `createdAt`),
    INDEX `DataSharingConsent_granterUserId_createdAt_idx`(`granterUserId`, `createdAt`),
    INDEX `DataSharingConsent_granterDocument_createdAt_idx`(`granterDocument`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DataSharingConsentAccount` (
    `id` VARCHAR(191) NOT NULL,
    `consentId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DataSharingConsentAccount_accountId_idx`(`accountId`),
    UNIQUE INDEX `DataSharingConsentAccount_consentId_accountId_key`(`consentId`, `accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DataSharingAccess` (
    `id` VARCHAR(191) NOT NULL,
    `consentId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NULL,
    `resource` VARCHAR(60) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DataSharingAccess_consentId_createdAt_idx`(`consentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DataSharingConsentAccount` ADD CONSTRAINT `DataSharingConsentAccount_consentId_fkey` FOREIGN KEY (`consentId`) REFERENCES `DataSharingConsent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DataSharingConsentAccount` ADD CONSTRAINT `DataSharingConsentAccount_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DataSharingAccess` ADD CONSTRAINT `DataSharingAccess_consentId_fkey` FOREIGN KEY (`consentId`) REFERENCES `DataSharingConsent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
