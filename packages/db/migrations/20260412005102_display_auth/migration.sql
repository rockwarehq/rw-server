-- AlterTable
ALTER TABLE "Display" ADD COLUMN     "bootstrapSecretCreatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "bootstrapSecretHash" TEXT,
ADD COLUMN     "bootstrapSecretLastUsedAt" TIMESTAMPTZ(3),
ALTER COLUMN "claimCode" DROP NOT NULL;

-- AlterTable
ALTER TABLE "EmployeeRole" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "DisplayRefreshToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "displayId" UUID NOT NULL,

    CONSTRAINT "DisplayRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisplayRefreshToken_tokenHash_key" ON "DisplayRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DisplayRefreshToken_displayId_idx" ON "DisplayRefreshToken"("displayId");

-- AddForeignKey
ALTER TABLE "DisplayRefreshToken" ADD CONSTRAINT "DisplayRefreshToken_displayId_fkey" FOREIGN KEY ("displayId") REFERENCES "Display"("id") ON DELETE CASCADE ON UPDATE CASCADE;
