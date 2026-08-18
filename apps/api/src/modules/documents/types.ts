import type { DocumentKind, UploadChunkStatus, UploadSessionStatus } from "@prisma/client";

export type StoredDocumentFile = {
  id: string;
  tenantId: string;
  workspaceId: string;
  kind: DocumentKind;
  receiptId: string | null;
  invoiceId: string | null;
  originalName: string;
  safeName: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
  bucket: string;
  objectKey: string;
  createdById: string;
  createdAt: Date;
  deletedAt: Date | null;
};

export type StoredDocumentPage = {
  id: string;
  tenantId: string;
  documentFileId: string;
  pageNumber: number;
  width: number | null;
  height: number | null;
  processedBucket: string | null;
  processedKey: string | null;
  preprocessingProfile: string | null;
  qualityScore: { toString(): string } | null;
  createdAt: Date;
};

export type StoredUploadSession = {
  id: string;
  tenantId: string;
  workspaceId: string;
  kind: DocumentKind;
  originalName: string;
  safeName: string;
  clientMimeType: string;
  totalSizeBytes: bigint;
  chunkSizeBytes: number;
  totalChunks: number;
  status: UploadSessionStatus;
  finalSha256: string | null;
  documentFileId: string | null;
  failureReason: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
};

export type StoredUploadChunk = {
  id: string;
  tenantId: string;
  uploadSessionId: string;
  chunkIndex: number;
  sizeBytes: number;
  clientCrc32: string;
  serverCrc32: string;
  bucket: string;
  objectKey: string;
  status: UploadChunkStatus;
  retryCount: number;
  uploadedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateDocumentInput = {
  tenantId: string;
  workspaceId: string;
  kind: DocumentKind;
  originalName: string;
  safeName: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
  bucket: string;
  objectKey: string;
  createdById: string;
  correlationId?: string | null;
};

export type CreateUploadSessionInput = {
  tenantId: string;
  workspaceId: string;
  kind: DocumentKind;
  originalName: string;
  safeName: string;
  clientMimeType: string;
  totalSizeBytes: bigint;
  chunkSizeBytes: number;
  totalChunks: number;
  createdById: string;
  expiresAt: Date;
};

export type UpsertUploadChunkInput = {
  tenantId: string;
  uploadSessionId: string;
  chunkIndex: number;
  sizeBytes: number;
  clientCrc32: string;
  serverCrc32: string;
  bucket: string;
  objectKey: string;
  status: UploadChunkStatus;
  incrementRetryCount?: boolean;
};

export type UpsertDocumentPageInput = {
  tenantId: string;
  documentFileId: string;
  pageNumber: number;
  width?: number | null;
  height?: number | null;
  processedBucket?: string | null;
  processedKey?: string | null;
  preprocessingProfile?: string | null;
  qualityScore?: number | null;
};

export type DocumentListCursor = {
  createdAt: Date;
  id: string;
};

export type DocumentListPageInput = {
  tenantId: string;
  workspaceId?: string;
  kind?: DocumentKind;
  search?: string;
  createdFrom?: Date;
  createdTo?: Date;
  cursor?: DocumentListCursor;
  limit: number;
};

export type DocumentRepository = {
  workspaceExists(tenantId: string, workspaceId: string): Promise<boolean>;
  findBySha256(tenantId: string, sha256: string): Promise<StoredDocumentFile | null>;
  findById(tenantId: string, documentFileId: string): Promise<StoredDocumentFile | null>;
  list(input: { tenantId: string; workspaceId?: string }): Promise<StoredDocumentFile[]>;
  listPage(input: DocumentListPageInput): Promise<StoredDocumentFile[]>;
  listPages(input: { tenantId: string; documentFileId: string }): Promise<StoredDocumentPage[]>;
  upsertDocumentPage(input: UpsertDocumentPageInput): Promise<StoredDocumentPage>;
  createUploadedDocument(input: CreateDocumentInput): Promise<StoredDocumentFile>;
  createUploadSession(input: CreateUploadSessionInput): Promise<StoredUploadSession>;
  findUploadSession(input: { tenantId: string; uploadSessionId: string }): Promise<StoredUploadSession | null>;
  listUploadChunks(input: { tenantId: string; uploadSessionId: string }): Promise<StoredUploadChunk[]>;
  findUploadChunk(input: {
    tenantId: string;
    uploadSessionId: string;
    chunkIndex: number;
  }): Promise<StoredUploadChunk | null>;
  upsertUploadChunk(input: UpsertUploadChunkInput): Promise<StoredUploadChunk>;
  updateUploadSession(input: {
    tenantId: string;
    uploadSessionId: string;
    status?: UploadSessionStatus;
    finalSha256?: string | null;
    documentFileId?: string | null;
    failureReason?: string | null;
    completedAt?: Date | null;
  }): Promise<StoredUploadSession | null>;
  markDeleted(input: {
    tenantId: string;
    documentFileId: string;
    actorUserId: string;
    correlationId?: string | null;
  }): Promise<StoredDocumentFile | null>;
};

export type PutObjectInput = {
  bucket: string;
  objectKey: string;
  body: Buffer;
  mimeType: string;
  metadata: Record<string, string>;
};

export type ComposeObjectInput = {
  bucket: string;
  objectKey: string;
  sources: Array<{ bucket: string; objectKey: string }>;
  mimeType: string;
  metadata: Record<string, string>;
};

export type DocumentStorageBackend = "memory" | "minio";

export type DocumentStorageMetrics = {
  health: {
    backend: DocumentStorageBackend;
    connected: boolean;
    detail?: string;
  };
  storedObjectCount?: number;
  operationErrors: Array<{
    operation: string;
    count: number;
  }>;
};

export type DocumentStorage = {
  putObject(input: PutObjectInput): Promise<void>;
  composeObject(input: ComposeObjectInput): Promise<void>;
  getObject(input: { bucket: string; objectKey: string }): Promise<Buffer>;
  createSignedGetUrl(input: { bucket: string; objectKey: string; expiresInSeconds: number }): Promise<string>;
  removeObject(input: { bucket: string; objectKey: string }): Promise<void>;
  metrics(): Promise<DocumentStorageMetrics>;
};
