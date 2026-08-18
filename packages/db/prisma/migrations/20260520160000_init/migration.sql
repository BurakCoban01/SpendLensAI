-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('RECEIPT', 'INVOICE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PREPROCESSING', 'OCR_RUNNING', 'EXTRACTED', 'NEEDS_REVIEW', 'APPROVED', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'EXTRACTED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'REIMBURSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "OCREngineCode" AS ENUM ('TESSERACT', 'CUSTOM_CRNN', 'ENSEMBLE', 'CATEGORY_ML');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('CANDIDATE', 'ACTIVE', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "DatasetSplit" AS ENUM ('TRAIN', 'VALIDATION', 'TEST');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "rotatedFromId" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "taxIdentifier" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'TRY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "taxIdentifier" TEXT,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "maskedLast4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "merchantId" TEXT,
    "categoryId" TEXT,
    "paymentMethodId" TEXT,
    "documentId" TEXT,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "amountMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "reimbursable" BOOLEAN NOT NULL DEFAULT false,
    "businessExpense" BOOLEAN NOT NULL DEFAULT false,
    "projectCode" TEXT,
    "costCenter" TEXT,
    "duplicateGroup" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseAttachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "label" TEXT,
    "note" TEXT,
    "attachedById" TEXT NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detachedAt" TIMESTAMP(3),

    CONSTRAINT "ExpenseAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseLineItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "taxRateBps" INTEGER,
    "totalMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseComment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxBreakdown" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "taxableMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxBreakdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "amountMinor" BIGINT NOT NULL,
    "alertPercent" INTEGER NOT NULL DEFAULT 80,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetPeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "spentMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "merchantId" TEXT,
    "capturedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "supplierName" TEXT,
    "invoiceNumber" TEXT,
    "issueDate" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "receiptId" TEXT,
    "invoiceId" TEXT,
    "originalName" TEXT NOT NULL,
    "safeName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "processedBucket" TEXT,
    "processedKey" TEXT,
    "preprocessingProfile" TEXT,
    "qualityScore" DECIMAL(5,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCRJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedEngines" TEXT[],
    "progress" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OCRJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCREngineRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ocrJobId" TEXT NOT NULL,
    "engine" "OCREngineCode" NOT NULL,
    "modelVersionId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "language" TEXT,
    "psm" INTEGER,
    "oem" INTEGER,
    "rawTextKey" TEXT,
    "normalizedJson" JSONB,
    "confidence" DECIMAL(5,4),
    "latencyMs" INTEGER,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OCREngineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCRTextBlock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "engineRunId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "bbox" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OCRTextBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCRLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "engineRunId" TEXT NOT NULL,
    "blockId" TEXT,
    "lineNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "bbox" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OCRLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCRToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "engineRunId" TEXT NOT NULL,
    "lineId" TEXT,
    "text" TEXT NOT NULL,
    "normalizedText" TEXT,
    "confidence" DECIMAL(5,4),
    "bbox" JSONB NOT NULL,
    "tokenIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OCRToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCRConfidenceScore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "engineRunId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OCRConfidenceScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCRCorrection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "fieldName" TEXT,
    "beforeValue" TEXT,
    "afterValue" TEXT NOT NULL,
    "correctedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OCRCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OCRReviewTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "assignedToId" TEXT,
    "reasonCodes" TEXT[],
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OCRReviewTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "ocrJobId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "confidence" DECIMAL(5,4),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedField" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extractionJobId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "sourceEngine" "OCREngineCode",
    "validationStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extractionJobId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "candidateValue" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationIssue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extractionJobId" TEXT,
    "expenseId" TEXT,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ValidationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "engine" "OCREngineCode" NOT NULL,
    "status" "ModelStatus" NOT NULL DEFAULT 'CANDIDATE',
    "artifactBucket" TEXT,
    "artifactKey" TEXT,
    "metrics" JSONB,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelTrainingRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "modelVersionId" TEXT,
    "datasetId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "profile" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "metrics" JSONB,
    "logsKey" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ModelTrainingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelEvaluationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "modelVersionId" TEXT,
    "datasetId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "metrics" JSONB,
    "reportKey" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ModelEvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "documentFileId" TEXT,
    "split" "DatasetSplit" NOT NULL,
    "imageBucket" TEXT,
    "imageKey" TEXT,
    "groundTruth" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "datasetItemId" TEXT,
    "documentFileId" TEXT,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Annotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelingTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "datasetItemId" TEXT,
    "documentFileId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "LabelingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveLearningSuggestion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentFileId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "score" DECIMAL(8,6) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "ActiveLearningSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MLCategoryPrediction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "expenseId" TEXT,
    "documentFileId" TEXT,
    "modelVersionId" TEXT,
    "categoryId" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "explanation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MLCategoryPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "merchantId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "cadence" TEXT NOT NULL,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "merchantId" TEXT,
    "name" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "cadence" TEXT NOT NULL,
    "detectedFromExpenseId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementClaim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "claimantId" TEXT NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "ReimbursementClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementClaimExpense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReimbursementClaimExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpensePolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpensePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalWorkflow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "approverId" TEXT,
    "policySnapshot" JSONB,
    "slaDueAt" TIMESTAMP(3),
    "slaBreachedAt" TIMESTAMP(3),
    "slaStatus" TEXT NOT NULL DEFAULT 'ON_TRACK',
    "slaHours" INTEGER NOT NULL DEFAULT 48,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "secretHash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APIKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "APIKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "stats" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "bucket" TEXT,
    "objectKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemHealthSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "component" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "details" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "failureReason" TEXT,
    "lockedBy" TEXT,
    "createdById" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkerJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consumerName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "correlationId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Tenant_slug_idx" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Role_tenantId_idx" ON "Role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_code_key" ON "Role"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_key" ON "Permission"("code");

-- CreateIndex
CREATE INDEX "UserRole_tenantId_userId_idx" ON "UserRole"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_tenantId_userId_roleId_key" ON "UserRole"("tenantId", "userId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_tenantId_roleId_permissionId_key" ON "RolePermission"("tenantId", "roleId", "permissionId");

-- CreateIndex
CREATE INDEX "Session_tenantId_userId_idx" ON "Session"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Workspace_tenantId_idx" ON "Workspace"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_tenantId_name_key" ON "Workspace"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Household_tenantId_workspaceId_idx" ON "Household"("tenantId", "workspaceId");

-- CreateIndex
CREATE INDEX "BusinessProfile_tenantId_workspaceId_idx" ON "BusinessProfile"("tenantId", "workspaceId");

-- CreateIndex
CREATE INDEX "Merchant_tenantId_idx" ON "Merchant"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_tenantId_normalizedName_key" ON "Merchant"("tenantId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_tenantId_slug_key" ON "ExpenseCategory"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "PaymentMethod_tenantId_idx" ON "PaymentMethod"("tenantId");

-- CreateIndex
CREATE INDEX "Expense_tenantId_workspaceId_occurredAt_idx" ON "Expense"("tenantId", "workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "Expense_tenantId_status_idx" ON "Expense"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ExpenseAttachment_tenantId_expenseId_detachedAt_idx" ON "ExpenseAttachment"("tenantId", "expenseId", "detachedAt");

-- CreateIndex
CREATE INDEX "ExpenseAttachment_tenantId_documentFileId_idx" ON "ExpenseAttachment"("tenantId", "documentFileId");

-- CreateIndex
CREATE INDEX "ExpenseLineItem_tenantId_expenseId_idx" ON "ExpenseLineItem"("tenantId", "expenseId");

-- CreateIndex
CREATE INDEX "ExpenseComment_tenantId_expenseId_createdAt_idx" ON "ExpenseComment"("tenantId", "expenseId", "createdAt");

-- CreateIndex
CREATE INDEX "TaxBreakdown_tenantId_expenseId_idx" ON "TaxBreakdown"("tenantId", "expenseId");

-- CreateIndex
CREATE INDEX "Budget_tenantId_workspaceId_idx" ON "Budget"("tenantId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPeriod_tenantId_budgetId_startsAt_endsAt_key" ON "BudgetPeriod"("tenantId", "budgetId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "ReceiptDocument_tenantId_workspaceId_status_idx" ON "ReceiptDocument"("tenantId", "workspaceId", "status");

-- CreateIndex
CREATE INDEX "InvoiceDocument_tenantId_workspaceId_status_idx" ON "InvoiceDocument"("tenantId", "workspaceId", "status");

-- CreateIndex
CREATE INDEX "DocumentFile_tenantId_workspaceId_kind_idx" ON "DocumentFile"("tenantId", "workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFile_tenantId_sha256_key" ON "DocumentFile"("tenantId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPage_tenantId_documentFileId_pageNumber_key" ON "DocumentPage"("tenantId", "documentFileId", "pageNumber");

-- CreateIndex
CREATE INDEX "OCRJob_tenantId_status_idx" ON "OCRJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "OCREngineRun_tenantId_ocrJobId_engine_idx" ON "OCREngineRun"("tenantId", "ocrJobId", "engine");

-- CreateIndex
CREATE INDEX "OCRTextBlock_tenantId_engineRunId_idx" ON "OCRTextBlock"("tenantId", "engineRunId");

-- CreateIndex
CREATE INDEX "OCRLine_tenantId_engineRunId_idx" ON "OCRLine"("tenantId", "engineRunId");

-- CreateIndex
CREATE INDEX "OCRToken_tenantId_engineRunId_idx" ON "OCRToken"("tenantId", "engineRunId");

-- CreateIndex
CREATE INDEX "OCRConfidenceScore_tenantId_engineRunId_idx" ON "OCRConfidenceScore"("tenantId", "engineRunId");

-- CreateIndex
CREATE INDEX "OCRCorrection_tenantId_documentFileId_idx" ON "OCRCorrection"("tenantId", "documentFileId");

-- CreateIndex
CREATE INDEX "OCRReviewTask_tenantId_status_assignedToId_idx" ON "OCRReviewTask"("tenantId", "status", "assignedToId");

-- CreateIndex
CREATE INDEX "ExtractionJob_tenantId_status_idx" ON "ExtractionJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ExtractedField_tenantId_extractionJobId_fieldName_idx" ON "ExtractedField"("tenantId", "extractionJobId", "fieldName");

-- CreateIndex
CREATE INDEX "ExtractionCandidate_tenantId_extractionJobId_idx" ON "ExtractionCandidate"("tenantId", "extractionJobId");

-- CreateIndex
CREATE INDEX "ValidationIssue_tenantId_code_severity_idx" ON "ValidationIssue"("tenantId", "code", "severity");

-- CreateIndex
CREATE INDEX "ModelVersion_tenantId_engine_status_idx" ON "ModelVersion"("tenantId", "engine", "status");

-- CreateIndex
CREATE INDEX "ModelTrainingRun_tenantId_status_idx" ON "ModelTrainingRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ModelEvaluationRun_tenantId_status_idx" ON "ModelEvaluationRun"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_tenantId_name_key" ON "Dataset"("tenantId", "name");

-- CreateIndex
CREATE INDEX "DatasetItem_tenantId_datasetId_split_idx" ON "DatasetItem"("tenantId", "datasetId", "split");

-- CreateIndex
CREATE INDEX "Annotation_tenantId_label_idx" ON "Annotation"("tenantId", "label");

-- CreateIndex
CREATE INDEX "LabelingTask_tenantId_status_idx" ON "LabelingTask"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ActiveLearningSuggestion_tenantId_reasonCode_score_idx" ON "ActiveLearningSuggestion"("tenantId", "reasonCode", "score");

-- CreateIndex
CREATE INDEX "CategoryRule_tenantId_enabled_priority_idx" ON "CategoryRule"("tenantId", "enabled", "priority");

-- CreateIndex
CREATE INDEX "MLCategoryPrediction_tenantId_categoryId_idx" ON "MLCategoryPrediction"("tenantId", "categoryId");

-- CreateIndex
CREATE INDEX "RecurringExpense_tenantId_workspaceId_active_idx" ON "RecurringExpense"("tenantId", "workspaceId", "active");

-- CreateIndex
CREATE INDEX "Subscription_tenantId_workspaceId_active_idx" ON "Subscription"("tenantId", "workspaceId", "active");

-- CreateIndex
CREATE INDEX "ReimbursementClaim_tenantId_workspaceId_status_idx" ON "ReimbursementClaim"("tenantId", "workspaceId", "status");

-- CreateIndex
CREATE INDEX "ReimbursementClaimExpense_tenantId_expenseId_idx" ON "ReimbursementClaimExpense"("tenantId", "expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementClaimExpense_tenantId_claimId_expenseId_key" ON "ReimbursementClaimExpense"("tenantId", "claimId", "expenseId");

-- CreateIndex
CREATE INDEX "ExpensePolicy_tenantId_workspaceId_active_idx" ON "ExpensePolicy"("tenantId", "workspaceId", "active");

-- CreateIndex
CREATE INDEX "ExpensePolicy_tenantId_ruleType_idx" ON "ExpensePolicy"("tenantId", "ruleType");

-- CreateIndex
CREATE INDEX "ApprovalWorkflow_tenantId_targetType_targetId_idx" ON "ApprovalWorkflow"("tenantId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "ApprovalWorkflow_tenantId_workspaceId_slaStatus_idx" ON "ApprovalWorkflow"("tenantId", "workspaceId", "slaStatus");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_resourceType_resourceId_idx" ON "AuditLog"("tenantId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_action_createdAt_idx" ON "AuditLog"("tenantId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_userId_readAt_idx" ON "Notification"("tenantId", "userId", "readAt");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_tenantId_enabled_idx" ON "WebhookEndpoint"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "APIKey_tenantId_revokedAt_idx" ON "APIKey"("tenantId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "APIKey_tenantId_keyPrefix_key" ON "APIKey"("tenantId", "keyPrefix");

-- CreateIndex
CREATE INDEX "ImportBatch_tenantId_workspaceId_status_idx" ON "ImportBatch"("tenantId", "workspaceId", "status");

-- CreateIndex
CREATE INDEX "ExportJob_tenantId_workspaceId_status_idx" ON "ExportJob"("tenantId", "workspaceId", "status");

-- CreateIndex
CREATE INDEX "SystemHealthSnapshot_component_capturedAt_idx" ON "SystemHealthSnapshot"("component", "capturedAt");

-- CreateIndex
CREATE INDEX "WorkerJob_tenantId_queue_status_idx" ON "WorkerJob"("tenantId", "queue", "status");

-- CreateIndex
CREATE INDEX "WorkerJob_tenantId_jobType_createdAt_idx" ON "WorkerJob"("tenantId", "jobType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerJob_tenantId_dedupeKey_key" ON "WorkerJob"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_tenantId_topic_idx" ON "OutboxEvent"("tenantId", "topic");

-- CreateIndex
CREATE INDEX "InboxEvent_tenantId_consumerName_receivedAt_idx" ON "InboxEvent"("tenantId", "consumerName", "receivedAt");

-- CreateIndex
CREATE INDEX "InboxEvent_tenantId_topic_idx" ON "InboxEvent"("tenantId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "InboxEvent_consumerName_eventId_key" ON "InboxEvent"("consumerName", "eventId");

