import { randomUUID } from "node:crypto";
import type {
  CreateDocumentInput,
  CreateUploadSessionInput,
  DocumentListPageInput,
  DocumentRepository,
  StoredDocumentFile,
  StoredDocumentPage,
  StoredUploadChunk,
  StoredUploadSession,
  UpsertUploadChunkInput,
  UpsertDocumentPageInput
} from "./types";

export class InMemoryDocumentRepository implements DocumentRepository {
  private files = new Map<string, StoredDocumentFile>();
  private pages = new Map<string, StoredDocumentPage>();
  private uploadSessions = new Map<string, StoredUploadSession>();
  private uploadChunks = new Map<string, StoredUploadChunk>();
  private workspaces = new Set<string>();

  constructor(private readonly allowUnknownWorkspaces = false) {}

  addWorkspace(tenantId: string, workspaceId: string): void {
    this.workspaces.add(workspaceKey(tenantId, workspaceId));
  }

  async workspaceExists(tenantId: string, workspaceId: string): Promise<boolean> {
    return this.workspaces.has(workspaceKey(tenantId, workspaceId)) || this.allowUnknownWorkspaces;
  }

  async findBySha256(tenantId: string, sha256: string): Promise<StoredDocumentFile | null> {
    return [...this.files.values()].find((file) => file.tenantId === tenantId && file.sha256 === sha256) ?? null;
  }

  async findById(tenantId: string, documentFileId: string): Promise<StoredDocumentFile | null> {
    const file = this.files.get(documentFileId);
    return file?.tenantId === tenantId ? file : null;
  }

  async list(input: { tenantId: string; workspaceId?: string }): Promise<StoredDocumentFile[]> {
    return [...this.files.values()]
      .filter(
        (file) =>
          file.tenantId === input.tenantId &&
          !file.deletedAt &&
          (!input.workspaceId || file.workspaceId === input.workspaceId)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listPage(input: DocumentListPageInput): Promise<StoredDocumentFile[]> {
    const normalizedSearch = input.search?.trim().toLocaleLowerCase("tr-TR");
    return [...this.files.values()]
      .filter((file) => {
        if (file.tenantId !== input.tenantId || file.deletedAt) return false;
        if (input.workspaceId && file.workspaceId !== input.workspaceId) return false;
        if (input.kind && file.kind !== input.kind) return false;
        if (input.createdFrom && file.createdAt < input.createdFrom) return false;
        if (input.createdTo && file.createdAt > input.createdTo) return false;
        if (
          normalizedSearch &&
          !file.originalName.toLocaleLowerCase("tr-TR").includes(normalizedSearch) &&
          !file.safeName.toLocaleLowerCase("tr-TR").includes(normalizedSearch)
        ) {
          return false;
        }
        if (!input.cursor) return true;
        const timeDifference = file.createdAt.getTime() - input.cursor.createdAt.getTime();
        return timeDifference < 0 || (timeDifference === 0 && file.id.localeCompare(input.cursor.id) < 0);
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, input.limit);
  }

  async listPages(input: { tenantId: string; documentFileId: string }): Promise<StoredDocumentPage[]> {
    return [...this.pages.values()]
      .filter((page) => page.tenantId === input.tenantId && page.documentFileId === input.documentFileId)
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }

  async upsertDocumentPage(input: UpsertDocumentPageInput): Promise<StoredDocumentPage> {
    const key = pageKey(input.tenantId, input.documentFileId, input.pageNumber);
    const existing = this.pages.get(key);
    const page: StoredDocumentPage = {
      id: existing?.id ?? randomUUID(),
      tenantId: input.tenantId,
      documentFileId: input.documentFileId,
      pageNumber: input.pageNumber,
      width: input.width ?? null,
      height: input.height ?? null,
      processedBucket: input.processedBucket ?? null,
      processedKey: input.processedKey ?? null,
      preprocessingProfile: input.preprocessingProfile ?? null,
      qualityScore: input.qualityScore ?? null,
      createdAt: existing?.createdAt ?? new Date()
    };
    this.pages.set(key, page);
    return page;
  }

  async createUploadedDocument(input: CreateDocumentInput): Promise<StoredDocumentFile> {
    const now = new Date();
    const file: StoredDocumentFile = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      receiptId: input.kind === "RECEIPT" ? randomUUID() : null,
      invoiceId: input.kind === "INVOICE" ? randomUUID() : null,
      originalName: input.originalName,
      safeName: input.safeName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      bucket: input.bucket,
      objectKey: input.objectKey,
      createdById: input.createdById,
      createdAt: now,
      deletedAt: null
    };
    this.files.set(file.id, file);
    return file;
  }

  async createUploadSession(input: CreateUploadSessionInput): Promise<StoredUploadSession> {
    const now = new Date();
    const session: StoredUploadSession = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      originalName: input.originalName,
      safeName: input.safeName,
      clientMimeType: input.clientMimeType,
      totalSizeBytes: input.totalSizeBytes,
      chunkSizeBytes: input.chunkSizeBytes,
      totalChunks: input.totalChunks,
      status: "INITIATED",
      finalSha256: null,
      documentFileId: null,
      failureReason: null,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      completedAt: null
    };
    this.uploadSessions.set(session.id, session);
    return session;
  }

  async findUploadSession(input: { tenantId: string; uploadSessionId: string }): Promise<StoredUploadSession | null> {
    const session = this.uploadSessions.get(input.uploadSessionId);
    return session?.tenantId === input.tenantId ? session : null;
  }

  async listUploadChunks(input: { tenantId: string; uploadSessionId: string }): Promise<StoredUploadChunk[]> {
    return [...this.uploadChunks.values()]
      .filter((chunk) => chunk.tenantId === input.tenantId && chunk.uploadSessionId === input.uploadSessionId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async findUploadChunk(input: {
    tenantId: string;
    uploadSessionId: string;
    chunkIndex: number;
  }): Promise<StoredUploadChunk | null> {
    const chunk = this.uploadChunks.get(uploadChunkKey(input.tenantId, input.uploadSessionId, input.chunkIndex));
    return chunk ?? null;
  }

  async upsertUploadChunk(input: UpsertUploadChunkInput): Promise<StoredUploadChunk> {
    const key = uploadChunkKey(input.tenantId, input.uploadSessionId, input.chunkIndex);
    const existing = this.uploadChunks.get(key);
    const now = new Date();
    const chunk: StoredUploadChunk = {
      id: existing?.id ?? randomUUID(),
      tenantId: input.tenantId,
      uploadSessionId: input.uploadSessionId,
      chunkIndex: input.chunkIndex,
      sizeBytes: input.sizeBytes,
      clientCrc32: input.clientCrc32,
      serverCrc32: input.serverCrc32,
      bucket: input.bucket,
      objectKey: input.objectKey,
      status: input.status,
      retryCount: (existing?.retryCount ?? 0) + (input.incrementRetryCount ? 1 : 0),
      uploadedAt: input.status === "UPLOADED" ? now : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.uploadChunks.set(key, chunk);
    return chunk;
  }

  async updateUploadSession(input: {
    tenantId: string;
    uploadSessionId: string;
    status?: StoredUploadSession["status"];
    finalSha256?: string | null;
    documentFileId?: string | null;
    failureReason?: string | null;
    completedAt?: Date | null;
  }): Promise<StoredUploadSession | null> {
    const existing = await this.findUploadSession(input);
    if (!existing) return null;
    const updated: StoredUploadSession = {
      ...existing,
      ...(input.status ? { status: input.status } : {}),
      ...(input.finalSha256 !== undefined ? { finalSha256: input.finalSha256 } : {}),
      ...(input.documentFileId !== undefined ? { documentFileId: input.documentFileId } : {}),
      ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      updatedAt: new Date()
    };
    this.uploadSessions.set(updated.id, updated);
    return updated;
  }

  async markDeleted(input: {
    tenantId: string;
    documentFileId: string;
    actorUserId: string;
  }): Promise<StoredDocumentFile | null> {
    const file = await this.findById(input.tenantId, input.documentFileId);
    if (!file || file.deletedAt) return null;
    const deleted = { ...file, deletedAt: new Date() };
    this.files.set(file.id, deleted);
    return deleted;
  }
}

function workspaceKey(tenantId: string, workspaceId: string): string {
  return `${tenantId}:${workspaceId}`;
}

function pageKey(tenantId: string, documentFileId: string, pageNumber: number): string {
  return `${tenantId}:${documentFileId}:${pageNumber}`;
}

function uploadChunkKey(tenantId: string, uploadSessionId: string, chunkIndex: number): string {
  return `${tenantId}:${uploadSessionId}:${chunkIndex}`;
}
