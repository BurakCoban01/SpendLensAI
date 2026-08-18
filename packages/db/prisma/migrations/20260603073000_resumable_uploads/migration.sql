CREATE TYPE "UploadSessionStatus" AS ENUM ('INITIATED', 'UPLOADING', 'PAUSED', 'COMPLETING', 'COMPLETED', 'CANCELED', 'EXPIRED', 'FAILED');

CREATE TYPE "UploadChunkStatus" AS ENUM ('UPLOADED', 'FAILED');

CREATE TABLE "UploadSession" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "kind" "DocumentKind" NOT NULL,
  "originalName" TEXT NOT NULL,
  "safeName" TEXT NOT NULL,
  "clientMimeType" TEXT NOT NULL,
  "totalSizeBytes" BIGINT NOT NULL,
  "chunkSizeBytes" INTEGER NOT NULL,
  "totalChunks" INTEGER NOT NULL,
  "status" "UploadSessionStatus" NOT NULL DEFAULT 'INITIATED',
  "finalSha256" TEXT,
  "documentFileId" TEXT,
  "failureReason" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UploadChunk" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "uploadSessionId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "clientCrc32" TEXT NOT NULL,
  "serverCrc32" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "status" "UploadChunkStatus" NOT NULL DEFAULT 'UPLOADED',
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "uploadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UploadChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UploadSession_tenantId_workspaceId_status_idx" ON "UploadSession"("tenantId", "workspaceId", "status");
CREATE INDEX "UploadSession_tenantId_createdById_status_idx" ON "UploadSession"("tenantId", "createdById", "status");
CREATE UNIQUE INDEX "UploadChunk_tenantId_uploadSessionId_chunkIndex_key" ON "UploadChunk"("tenantId", "uploadSessionId", "chunkIndex");
CREATE INDEX "UploadChunk_tenantId_uploadSessionId_status_idx" ON "UploadChunk"("tenantId", "uploadSessionId", "status");
