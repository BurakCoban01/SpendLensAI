import { createHash, randomUUID } from "node:crypto";
import { crc32Hex, isSupportedUploadMimeType, normalizeSafeFilename, preprocessingProfiles } from "@spendlens/shared";
import type { DocumentKind } from "@prisma/client";
import type { AuditRepository, SeedAuditLogInput } from "../audit/types";
import type { AuthPrincipal } from "../auth/types";
import type { CacheService } from "../cache/service";
import type { EventService } from "../events/service";
import type { ExtractionRepository, PersistedExtraction } from "../extraction/types";
import type { JobService } from "../jobs/service";
import type {
  DocumentListCursor,
  DocumentRepository,
  DocumentStorage,
  StoredDocumentFile,
  StoredDocumentPage,
  StoredUploadChunk,
  StoredUploadSession
} from "./types";

export class DocumentError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(code);
  }
}

export type DocumentServiceOptions = {
  repository: DocumentRepository;
  storage: DocumentStorage;
  bucket: string;
  maxBytes?: number;
  events?: EventService;
  jobs?: JobService;
  cache?: CacheService;
  audit?: AuditRepository;
  extractionRepository?: ExtractionRepository;
  enqueueTesseractAfterPreprocessing?: boolean;
  maxResumableBytes?: number;
  tenantStorageSoftLimitBytes?: number;
};

export type DocumentPreprocessingClient = {
  preprocess(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    profile: string;
  }): Promise<{
    pages: Array<{
      pageNumber: number;
      width?: number | null;
      height?: number | null;
      qualityScore?: number | null;
      mimeType: string;
      processedImageBase64: string;
      decisions?: Record<string, unknown>;
    }>;
  }>;
};

export type DocumentTesseractOcrClient = {
  recognize(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    language: string;
  }): Promise<{
    text: string;
    confidence: number;
    tokens?: DocumentOcrToken[];
    latencyMs?: number;
    warnings?: string[];
    pageCount?: number;
    metadata?: Record<string, unknown>;
  }>;
};

export type DocumentCustomOcrClient = {
  recognize(input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
    checkpoint: string;
  }): Promise<{
    text: string;
    confidence: number;
    tokens?: DocumentOcrToken[];
    latencyMs?: number;
    warnings?: string[];
    pageCount?: number;
    metadata?: Record<string, unknown>;
  }>;
};

export type DocumentOcrToken = {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
  pageNumber?: number;
};

export class DocumentService {
  private readonly maxBytes: number;
  private readonly maxResumableBytes: number;
  private readonly tenantStorageSoftLimitBytes: number;

  constructor(private readonly options: DocumentServiceOptions) {
    this.maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    this.maxResumableBytes = options.maxResumableBytes ?? Math.max(this.maxBytes, 512 * 1024 * 1024);
    this.tenantStorageSoftLimitBytes = options.tenantStorageSoftLimitBytes ?? 2 * 1024 * 1024 * 1024;
  }

  async upload(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    kind: DocumentKind;
    originalName: string;
    mimeType: string;
    buffer: Buffer;
    correlationId?: string | null;
  }): Promise<{ document: PublicDocumentFile; duplicate: boolean; warnings: PublicDocumentUploadWarning[] }> {
    const upload = this.assertUpload(input.originalName, input.mimeType, input.buffer);
    if (!(await this.options.repository.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new DocumentError("WORKSPACE_NOT_FOUND", 404);
    }

    const safeName = normalizeSafeFilename(input.originalName);
    const sha256 = createHash("sha256").update(input.buffer).digest("hex");
    const cachedDuplicate = await this.findCachedDuplicate(input.principal.tenantId, sha256);
    if (cachedDuplicate) {
      return { document: toPublicDocument(cachedDuplicate), duplicate: true, warnings: upload.warnings };
    }

    const duplicate = await this.options.repository.findBySha256(input.principal.tenantId, sha256);
    if (duplicate) {
      await this.rememberDuplicate(input.principal.tenantId, sha256, duplicate.id);
      return { document: toPublicDocument(duplicate), duplicate: true, warnings: upload.warnings };
    }

    const documentId = randomUUID();
    const objectKey = [
      "tenants",
      input.principal.tenantId,
      "workspaces",
      input.workspaceId,
      "documents",
      documentId,
      safeName
    ].join("/");

    await this.options.storage.putObject({
      bucket: this.options.bucket,
      objectKey,
      body: input.buffer,
      mimeType: upload.mimeType,
      metadata: {
        "x-amz-meta-tenant-id": input.principal.tenantId,
        "x-amz-meta-workspace-id": input.workspaceId,
        "x-amz-meta-sha256": sha256,
        "x-amz-meta-original-filename": input.originalName,
        "x-amz-meta-client-mime-type": input.mimeType || "missing",
        "x-amz-meta-detected-mime-type": upload.mimeType,
        "x-amz-meta-canonical-mime-type": upload.mimeType,
        "x-amz-meta-extension-mismatch": upload.extensionMismatch ? "true" : "false"
      }
    });

    const created = await this.options.repository.createUploadedDocument({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      originalName: input.originalName,
      safeName,
      mimeType: upload.mimeType,
      sizeBytes: BigInt(input.buffer.byteLength),
      sha256,
      bucket: this.options.bucket,
      objectKey,
      createdById: input.principal.userId
    });

    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.uploaded",
      resourceType: "DocumentFile",
      resourceId: created.id,
      correlationId: input.correlationId ?? null,
      metadata: {
        workspaceId: created.workspaceId,
        kind: created.kind,
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes.toString(),
        sha256: created.sha256,
        safeName: created.safeName,
        clientMimeType: input.mimeType || "missing",
        detectedMimeType: upload.mimeType,
        extensionMismatch: upload.extensionMismatch,
        warnings: upload.warnings
      }
    });

    await this.options.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "document.uploaded",
      aggregateId: created.id,
      correlationId: input.correlationId ?? null,
      payload: {
        documentFileId: created.id,
        workspaceId: created.workspaceId,
        kind: created.kind,
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes.toString(),
        sha256: created.sha256
      }
    });

    await this.options.jobs?.enqueue({
      principal: input.principal,
      queue: "preprocessing",
      jobType: "document.preprocess",
      dedupeKey: `preprocess:${created.id}:TESSERACT_OPTIMIZED`,
      eventTopic: "ocr.job.created",
      aggregateId: created.id,
      correlationId: input.correlationId ?? null,
      payload: {
        documentFileId: created.id,
        profile: "TESSERACT_OPTIMIZED",
        runTesseractAfter: this.options.enqueueTesseractAfterPreprocessing === true
      }
    });

    await this.rememberDuplicate(input.principal.tenantId, sha256, created.id);

    return { document: toPublicDocument(created), duplicate: false, warnings: upload.warnings };
  }

  async search(input: {
    principal: AuthPrincipal;
    query: string;
    workspaceId?: string;
    limit?: number;
    correlationId?: string | null;
  }): Promise<{ results: PublicDocumentSearchResult[]; queryHash: string }> {
    const query = input.query.trim();
    if (query.length < 2) throw new DocumentError("SEARCH_QUERY_TOO_SHORT", 400);
    const normalizedQuery = normalizeSearchText(query);
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const documents = await this.options.repository.listPage({
      tenantId: input.principal.tenantId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      limit: 200
    });
    const extractionPairs = await Promise.all(
      documents.map(async (document) => ({
        document,
        extraction: await this.options.extractionRepository?.findLatestByDocument(input.principal.tenantId, document.id).catch(() => null)
      }))
    );
    const results = extractionPairs
      .map(({ document, extraction }) => scoreDocumentSearchResult(document, extraction ?? null, terms, query))
      .filter((result): result is PublicDocumentSearchResult => result !== null)
      .sort((left, right) => right.score - left.score || right.document.createdAt.localeCompare(left.document.createdAt))
      .slice(0, input.limit ?? 10);
    const queryHash = createHash("sha256").update(normalizedQuery).digest("hex");
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.search.performed",
      resourceType: "DocumentFile",
      resourceId: null,
      correlationId: input.correlationId ?? null,
      metadata: {
        workspaceId: input.workspaceId ?? null,
        queryHash,
        resultCount: results.length,
        limit: input.limit ?? 10,
        mode: "local_lexical"
      }
    });
    return { results, queryHash };
  }

  async initUploadSession(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    kind: DocumentKind;
    originalName: string;
    mimeType: string;
    totalSizeBytes: number;
    chunkSizeBytes: number;
    correlationId?: string | null;
  }): Promise<PublicUploadSessionStatus> {
    if (!input.originalName.trim()) throw new DocumentError("FILENAME_REQUIRED");
    if (!(await this.options.repository.workspaceExists(input.principal.tenantId, input.workspaceId))) {
      throw new DocumentError("WORKSPACE_NOT_FOUND", 404);
    }
    if (!Number.isSafeInteger(input.totalSizeBytes) || input.totalSizeBytes <= 0) throw new DocumentError("INVALID_UPLOAD_SIZE");
    if (input.totalSizeBytes > this.maxResumableBytes) throw new DocumentError("FILE_TOO_LARGE", 413);
    if (!Number.isSafeInteger(input.chunkSizeBytes) || input.chunkSizeBytes < 256 * 1024 || input.chunkSizeBytes > this.maxBytes) {
      throw new DocumentError("INVALID_CHUNK_SIZE");
    }
    const totalChunks = Math.ceil(input.totalSizeBytes / input.chunkSizeBytes);
    if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 10_000) {
      throw new DocumentError("INVALID_CHUNK_COUNT");
    }
    const normalizedClaim = normalizeUploadMimeType(input.mimeType);
    if (normalizedClaim === null) throw new DocumentError("UNSUPPORTED_MEDIA_TYPE", 415);
    if (!mimeTypeFromExtension(input.originalName) && hasFilenameExtension(input.originalName)) {
      throw new DocumentError("UNSUPPORTED_MEDIA_TYPE", 415);
    }
    const existingBytes = (await this.options.repository.list({ tenantId: input.principal.tenantId })).reduce(
      (total, document) => total + (document.deletedAt ? 0n : document.sizeBytes),
      0n
    );
    if (existingBytes + BigInt(input.totalSizeBytes) > BigInt(this.tenantStorageSoftLimitBytes)) {
      throw new DocumentError("TENANT_STORAGE_QUOTA_EXCEEDED", 413);
    }

    const session = await this.options.repository.createUploadSession({
      tenantId: input.principal.tenantId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      originalName: input.originalName,
      safeName: normalizeSafeFilename(input.originalName),
      clientMimeType: input.mimeType || "missing",
      totalSizeBytes: BigInt(input.totalSizeBytes),
      chunkSizeBytes: input.chunkSizeBytes,
      totalChunks,
      createdById: input.principal.userId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.upload_session.created",
      resourceType: "UploadSession",
      resourceId: session.id,
      correlationId: input.correlationId ?? null,
      metadata: {
        workspaceId: session.workspaceId,
        kind: session.kind,
        originalName: session.originalName,
        totalSizeBytes: session.totalSizeBytes.toString(),
        chunkSizeBytes: session.chunkSizeBytes,
        totalChunks: session.totalChunks
      }
    });

    return this.publicUploadStatus(session, []);
  }

  async uploadChunk(input: {
    principal: AuthPrincipal;
    uploadSessionId: string;
    chunkIndex: number;
    clientCrc32: string;
    buffer: Buffer;
    correlationId?: string | null;
  }): Promise<PublicUploadChunkResult> {
    const session = await this.requireUploadSession(input.principal.tenantId, input.uploadSessionId);
    await this.assertUploadSessionOpen(session, { allowPaused: false });
    if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || input.chunkIndex >= session.totalChunks) {
      throw new DocumentError("INVALID_CHUNK_INDEX");
    }
    const expectedSize = expectedChunkSize(session, input.chunkIndex);
    if (input.buffer.byteLength !== expectedSize) throw new DocumentError("INVALID_CHUNK_SIZE");
    const normalizedClientCrc32 = normalizeCrc32(input.clientCrc32);
    if (!normalizedClientCrc32) throw new DocumentError("INVALID_CHUNK_CRC");
    const serverCrc32 = crc32Hex(input.buffer);
    const existing = await this.options.repository.findUploadChunk({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id,
      chunkIndex: input.chunkIndex
    });
    if (
      existing?.status === "UPLOADED" &&
      existing.sizeBytes === input.buffer.byteLength &&
      existing.clientCrc32 === normalizedClientCrc32 &&
      existing.serverCrc32 === serverCrc32
    ) {
      const chunks = await this.options.repository.listUploadChunks({
        tenantId: input.principal.tenantId,
        uploadSessionId: session.id
      });
      return {
        chunk: toPublicUploadChunk(existing),
        uploadedChunks: uploadedChunkIndexes(chunks),
        missingChunks: missingChunkIndexes(session, chunks),
        duplicate: true
      };
    }
    if (existing?.status === "UPLOADED") throw new DocumentError("CHUNK_ALREADY_UPLOADED", 409);
    if (serverCrc32 !== normalizedClientCrc32) {
      await this.options.repository.upsertUploadChunk({
        tenantId: input.principal.tenantId,
        uploadSessionId: session.id,
        chunkIndex: input.chunkIndex,
        sizeBytes: input.buffer.byteLength,
        clientCrc32: normalizedClientCrc32,
        serverCrc32,
        bucket: this.options.bucket,
        objectKey: uploadChunkObjectKey(session, input.chunkIndex),
        status: "FAILED",
        incrementRetryCount: true
      });
      throw new DocumentError("CHUNK_CRC_MISMATCH", 422);
    }

    const objectKey = uploadChunkObjectKey(session, input.chunkIndex);
    await this.options.storage.putObject({
      bucket: this.options.bucket,
      objectKey,
      body: input.buffer,
      mimeType: "application/octet-stream",
      metadata: {
        "x-amz-meta-tenant-id": input.principal.tenantId,
        "x-amz-meta-upload-session-id": session.id,
        "x-amz-meta-chunk-index": String(input.chunkIndex),
        "x-amz-meta-client-crc32": normalizedClientCrc32,
        "x-amz-meta-server-crc32": serverCrc32
      }
    });
    const chunk = await this.options.repository.upsertUploadChunk({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id,
      chunkIndex: input.chunkIndex,
      sizeBytes: input.buffer.byteLength,
      clientCrc32: normalizedClientCrc32,
      serverCrc32,
      bucket: this.options.bucket,
      objectKey,
      status: "UPLOADED"
    });
    if (session.status === "INITIATED") {
      await this.options.repository.updateUploadSession({
        tenantId: input.principal.tenantId,
        uploadSessionId: session.id,
        status: "UPLOADING"
      });
    }
    const chunks = await this.options.repository.listUploadChunks({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id
    });
    return {
      chunk: toPublicUploadChunk(chunk),
      uploadedChunks: uploadedChunkIndexes(chunks),
      missingChunks: missingChunkIndexes(session, chunks),
      duplicate: false
    };
  }

  async uploadStatus(input: { principal: AuthPrincipal; uploadSessionId: string }): Promise<PublicUploadSessionStatus> {
    const session = await this.requireUploadSession(input.principal.tenantId, input.uploadSessionId);
    const checked = await this.expireUploadSessionIfNeeded(session);
    const chunks = await this.options.repository.listUploadChunks({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id
    });
    return this.publicUploadStatus(checked, chunks);
  }

  async pauseUpload(input: { principal: AuthPrincipal; uploadSessionId: string }): Promise<PublicUploadSessionStatus> {
    const session = await this.requireUploadSession(input.principal.tenantId, input.uploadSessionId);
    await this.assertUploadSessionOpen(session, { allowPaused: true });
    const updated = await this.options.repository.updateUploadSession({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id,
      status: "PAUSED"
    });
    return this.publicUploadStatus(updated ?? session, await this.options.repository.listUploadChunks({ tenantId: input.principal.tenantId, uploadSessionId: session.id }));
  }

  async resumeUpload(input: { principal: AuthPrincipal; uploadSessionId: string }): Promise<PublicUploadSessionStatus> {
    const session = await this.requireUploadSession(input.principal.tenantId, input.uploadSessionId);
    await this.expireUploadSessionIfNeeded(session);
    if (session.status !== "PAUSED") throw new DocumentError("UPLOAD_NOT_PAUSED", 409);
    const updated = await this.options.repository.updateUploadSession({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id,
      status: "UPLOADING"
    });
    return this.publicUploadStatus(updated ?? session, await this.options.repository.listUploadChunks({ tenantId: input.principal.tenantId, uploadSessionId: session.id }));
  }

  async cancelUpload(input: { principal: AuthPrincipal; uploadSessionId: string; correlationId?: string | null }): Promise<PublicUploadSessionStatus> {
    const session = await this.requireUploadSession(input.principal.tenantId, input.uploadSessionId);
    const chunks = await this.options.repository.listUploadChunks({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id
    });
    await this.removeChunkObjects(chunks);
    const updated = await this.options.repository.updateUploadSession({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id,
      status: "CANCELED",
      failureReason: null
    });
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.upload_session.canceled",
      resourceType: "UploadSession",
      resourceId: session.id,
      correlationId: input.correlationId ?? null,
      metadata: { removedChunkCount: chunks.length }
    });
    return this.publicUploadStatus(updated ?? session, []);
  }

  async completeUpload(input: {
    principal: AuthPrincipal;
    uploadSessionId: string;
    sha256: string;
    correlationId?: string | null;
  }): Promise<{ document: PublicDocumentFile; duplicate: boolean; warnings: PublicDocumentUploadWarning[]; upload: PublicUploadSessionStatus }> {
    const session = await this.requireUploadSession(input.principal.tenantId, input.uploadSessionId);
    await this.assertUploadSessionOpen(session, { allowPaused: false });
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new DocumentError("INVALID_FINAL_SHA256");
    const chunks = await this.options.repository.listUploadChunks({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id
    });
    const missingChunks = missingChunkIndexes(session, chunks);
    if (missingChunks.length > 0) throw new DocumentError("INCOMPLETE_UPLOAD", 409);
    const uploadedChunks = chunks.filter((chunk) => chunk.status === "UPLOADED").sort((a, b) => a.chunkIndex - b.chunkIndex);
    await this.options.repository.updateUploadSession({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id,
      status: "COMPLETING"
    });

    const finalHash = createHash("sha256");
    let firstChunkBuffer: Buffer | null = null;
    for (const chunk of uploadedChunks) {
      const chunkBuffer = await this.options.storage.getObject({ bucket: chunk.bucket, objectKey: chunk.objectKey });
      if (chunkBuffer.byteLength !== chunk.sizeBytes || crc32Hex(chunkBuffer) !== chunk.serverCrc32) {
        await this.options.repository.updateUploadSession({
          tenantId: input.principal.tenantId,
          uploadSessionId: session.id,
          status: "FAILED",
          failureReason: "CHUNK_STORAGE_MISMATCH"
        });
        throw new DocumentError("CHUNK_STORAGE_MISMATCH", 409);
      }
      firstChunkBuffer ??= chunkBuffer;
      finalHash.update(chunkBuffer);
    }
    const serverSha256 = finalHash.digest("hex");
    if (serverSha256 !== input.sha256.toLowerCase()) {
      await this.options.repository.updateUploadSession({
        tenantId: input.principal.tenantId,
        uploadSessionId: session.id,
        status: "FAILED",
        finalSha256: serverSha256,
        failureReason: "FINAL_SHA256_MISMATCH"
      });
      throw new DocumentError("FINAL_SHA256_MISMATCH", 422);
    }
    if (!firstChunkBuffer) throw new DocumentError("INCOMPLETE_UPLOAD", 409);
    let upload: { mimeType: string; extensionMismatch: boolean; warnings: PublicDocumentUploadWarning[] };
    try {
      upload = this.assertUpload(session.originalName, session.clientMimeType, firstChunkBuffer);
    } catch (error) {
      await this.options.repository.updateUploadSession({
        tenantId: input.principal.tenantId,
        uploadSessionId: session.id,
        status: "FAILED",
        finalSha256: serverSha256,
        failureReason: error instanceof DocumentError ? error.code : "FINAL_MIME_VALIDATION_FAILED"
      });
      throw error;
    }
    const cachedDuplicate = await this.findCachedDuplicate(input.principal.tenantId, serverSha256);
    const durableDuplicate = cachedDuplicate ?? (await this.options.repository.findBySha256(input.principal.tenantId, serverSha256));
    if (durableDuplicate) {
      await this.removeChunkObjects(chunks);
      await this.rememberDuplicate(input.principal.tenantId, serverSha256, durableDuplicate.id);
      const completed = await this.options.repository.updateUploadSession({
        tenantId: input.principal.tenantId,
        uploadSessionId: session.id,
        status: "COMPLETED",
        finalSha256: serverSha256,
        documentFileId: durableDuplicate.id,
        completedAt: new Date()
      });
      return {
        document: toPublicDocument(durableDuplicate),
        duplicate: true,
        warnings: upload.warnings,
        upload: this.publicUploadStatus(completed ?? session, [])
      };
    }

    const documentPathId = randomUUID();
    const objectKey = ["tenants", input.principal.tenantId, "workspaces", session.workspaceId, "documents", documentPathId, session.safeName].join("/");
    await this.options.storage.composeObject({
      bucket: this.options.bucket,
      objectKey,
      sources: uploadedChunks.map((chunk) => ({ bucket: chunk.bucket, objectKey: chunk.objectKey })),
      mimeType: upload.mimeType,
      metadata: {
        "x-amz-meta-tenant-id": input.principal.tenantId,
        "x-amz-meta-workspace-id": session.workspaceId,
        "x-amz-meta-sha256": serverSha256,
        "x-amz-meta-original-filename": session.originalName,
        "x-amz-meta-client-mime-type": session.clientMimeType || "missing",
        "x-amz-meta-detected-mime-type": upload.mimeType,
        "x-amz-meta-canonical-mime-type": upload.mimeType,
        "x-amz-meta-extension-mismatch": upload.extensionMismatch ? "true" : "false",
        "x-amz-meta-upload-session-id": session.id
      }
    });

    const created = await this.options.repository.createUploadedDocument({
      tenantId: input.principal.tenantId,
      workspaceId: session.workspaceId,
      kind: session.kind,
      originalName: session.originalName,
      safeName: session.safeName,
      mimeType: upload.mimeType,
      sizeBytes: session.totalSizeBytes,
      sha256: serverSha256,
      bucket: this.options.bucket,
      objectKey,
      createdById: input.principal.userId
    });
    await this.afterDocumentCreated({
      principal: input.principal,
      created,
      upload,
      clientMimeType: session.clientMimeType,
      correlationId: input.correlationId ?? null,
      source: "resumable"
    });
    await this.removeChunkObjects(chunks);
    await this.rememberDuplicate(input.principal.tenantId, serverSha256, created.id);
    const completed = await this.options.repository.updateUploadSession({
      tenantId: input.principal.tenantId,
      uploadSessionId: session.id,
      status: "COMPLETED",
      finalSha256: serverSha256,
      documentFileId: created.id,
      completedAt: new Date()
    });
    return {
      document: toPublicDocument(created),
      duplicate: false,
      warnings: upload.warnings,
      upload: this.publicUploadStatus(completed ?? session, [])
    };
  }

  async list(principal: AuthPrincipal, workspaceId?: string): Promise<PublicDocumentFile[]> {
    const files = await this.options.repository.list({
      tenantId: principal.tenantId,
      ...(workspaceId ? { workspaceId } : {})
    });
    return files.map(toPublicDocument);
  }

  async listPage(input: {
    principal: AuthPrincipal;
    workspaceId?: string;
    kind?: DocumentKind;
    search?: string;
    createdFrom?: Date;
    createdTo?: Date;
    cursor?: string;
    limit: number;
  }): Promise<{ documents: PublicDocumentFile[]; nextCursor: string | null }> {
    const cursor = input.cursor ? decodeDocumentCursor(input.cursor) : undefined;
    const files = await this.options.repository.listPage({
      tenantId: input.principal.tenantId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.createdFrom ? { createdFrom: input.createdFrom } : {}),
      ...(input.createdTo ? { createdTo: input.createdTo } : {}),
      ...(cursor ? { cursor } : {}),
      limit: input.limit + 1
    });
    const hasMore = files.length > input.limit;
    const page = hasMore ? files.slice(0, input.limit) : files;
    const last = page.at(-1);
    return {
      documents: page.map(toPublicDocument),
      nextCursor: hasMore && last ? encodeDocumentCursor({ createdAt: last.createdAt, id: last.id }) : null
    };
  }

  async get(principal: AuthPrincipal, documentFileId: string): Promise<PublicDocumentFile> {
    const file = await this.options.repository.findById(principal.tenantId, documentFileId);
    if (!file || file.deletedAt) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    return toPublicDocument(file);
  }

  async listPages(input: { principal: AuthPrincipal; documentFileId: string }): Promise<PublicDocumentPage[]> {
    const file = await this.options.repository.findById(input.principal.tenantId, input.documentFileId);
    if (!file || file.deletedAt) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    const pages = await this.options.repository.listPages({
      tenantId: input.principal.tenantId,
      documentFileId: input.documentFileId
    });
    return Promise.all(pages.map((page) => this.toPublicPage(page)));
  }

  async persistPreprocessingArtifacts(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    profile: string;
    pages: Array<{
      pageNumber: number;
      width?: number | null;
      height?: number | null;
      qualityScore?: number | null;
      mimeType: string;
      processedImageBase64: string;
      decisions?: Record<string, unknown>;
    }>;
    correlationId?: string | null;
  }): Promise<{ pages: PublicDocumentPage[]; manifestObjectKey: string }> {
    const file = await this.options.repository.findById(input.principal.tenantId, input.documentFileId);
    if (!file || file.deletedAt) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    if (!isPreprocessingProfile(input.profile)) throw new DocumentError("UNSUPPORTED_PREPROCESSING_PROFILE");
    if (input.pages.length === 0) throw new DocumentError("PREPROCESSING_PAGES_REQUIRED");

    const publicPages: PublicDocumentPage[] = [];
    const manifestPages: Array<Record<string, unknown>> = [];
    for (const page of [...input.pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
      assertPageMetadata(page.pageNumber, page.width, page.height, page.qualityScore);
      const processedImage = decodeProcessedImage(page.processedImageBase64, page.mimeType);
      const extension = imageExtension(page.mimeType);
      const processedKey = [
        "tenants",
        input.principal.tenantId,
        "workspaces",
        file.workspaceId,
        "documents",
        file.id,
        "preprocessing",
        input.profile.toLowerCase().replaceAll("_", "-"),
        `page-${page.pageNumber.toString().padStart(4, "0")}.${extension}`
      ].join("/");

      await this.options.storage.putObject({
        bucket: this.options.bucket,
        objectKey: processedKey,
        body: processedImage,
        mimeType: page.mimeType,
        metadata: {
          "x-amz-meta-tenant-id": input.principal.tenantId,
          "x-amz-meta-workspace-id": file.workspaceId,
          "x-amz-meta-document-file-id": file.id,
          "x-amz-meta-page-number": String(page.pageNumber),
          "x-amz-meta-preprocessing-profile": input.profile
        }
      });

      const storedPage = await this.options.repository.upsertDocumentPage({
        tenantId: input.principal.tenantId,
        documentFileId: file.id,
        pageNumber: page.pageNumber,
        width: page.width ?? null,
        height: page.height ?? null,
        processedBucket: this.options.bucket,
        processedKey,
        preprocessingProfile: input.profile,
        qualityScore: page.qualityScore ?? null
      });
      publicPages.push(await this.toPublicPage(storedPage));
      manifestPages.push({
        pageNumber: page.pageNumber,
        width: page.width ?? null,
        height: page.height ?? null,
        qualityScore: page.qualityScore ?? null,
        processedBucket: this.options.bucket,
        processedKey,
        preprocessingProfile: input.profile,
        decisions: page.decisions ?? {}
      });
    }

    const manifestObjectKey = [
      "tenants",
      input.principal.tenantId,
      "workspaces",
      file.workspaceId,
      "documents",
      file.id,
      "preprocessing",
      input.profile.toLowerCase().replaceAll("_", "-"),
      "preprocessing-manifest.json"
    ].join("/");
    await this.options.storage.putObject({
      bucket: this.options.bucket,
      objectKey: manifestObjectKey,
      body: Buffer.from(
        JSON.stringify(
          {
            documentFileId: file.id,
            workspaceId: file.workspaceId,
            profile: input.profile,
            pageCount: manifestPages.length,
            pages: manifestPages
          },
          null,
          2
        ),
        "utf8"
      ),
      mimeType: "application/json",
      metadata: {
        "x-amz-meta-tenant-id": input.principal.tenantId,
        "x-amz-meta-workspace-id": file.workspaceId,
        "x-amz-meta-document-file-id": file.id,
        "x-amz-meta-preprocessing-profile": input.profile
      }
    });

    await this.options.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "ocr.preprocessing.completed",
      aggregateId: file.id,
      correlationId: input.correlationId ?? null,
      payload: {
        documentFileId: file.id,
        workspaceId: file.workspaceId,
        profile: input.profile,
        pageCount: String(publicPages.length),
        manifestObjectKey
      }
    });

    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.preprocessing_artifacts.persisted",
      resourceType: "DocumentFile",
      resourceId: file.id,
      correlationId: input.correlationId ?? null,
      metadata: {
        workspaceId: file.workspaceId,
        profile: input.profile,
        pageCount: publicPages.length,
        manifestPresent: true
      }
    });

    return { pages: publicPages, manifestObjectKey };
  }

  async runPreprocessing(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    profile: string;
    client: DocumentPreprocessingClient;
    correlationId?: string | null;
  }): Promise<{ pages: PublicDocumentPage[]; manifestObjectKey: string }> {
    const file = await this.options.repository.findById(input.principal.tenantId, input.documentFileId);
    if (!file || file.deletedAt) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    const original = await this.options.storage.getObject({ bucket: file.bucket, objectKey: file.objectKey });
    const processed = await input.client.preprocess({
      filename: file.safeName,
      mimeType: file.mimeType,
      buffer: original,
      profile: input.profile
    });
    return this.persistPreprocessingArtifacts({
      principal: input.principal,
      documentFileId: file.id,
      profile: input.profile,
      pages: processed.pages,
      correlationId: input.correlationId ?? null
    });
  }

  async runTesseractOcr(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    language: string;
    client: DocumentTesseractOcrClient;
  }): Promise<{
    text: string;
    confidence: number;
    tokens?: DocumentOcrToken[];
    latencyMs?: number;
    warnings?: string[];
    pageCount?: number;
    metadata?: Record<string, unknown>;
  }> {
    const file = await this.options.repository.findById(input.principal.tenantId, input.documentFileId);
    if (!file || file.deletedAt) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    const original = await this.options.storage.getObject({ bucket: file.bucket, objectKey: file.objectKey });
    return input.client.recognize({
      filename: file.safeName,
      mimeType: file.mimeType,
      buffer: original,
      language: input.language
    });
  }

  async runCustomOcr(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    checkpoint: string;
    client: DocumentCustomOcrClient;
  }): Promise<{
    text: string;
    confidence: number;
    tokens?: DocumentOcrToken[];
    latencyMs?: number;
    warnings?: string[];
    pageCount?: number;
    metadata?: Record<string, unknown>;
  }> {
    const file = await this.options.repository.findById(input.principal.tenantId, input.documentFileId);
    if (!file || file.deletedAt) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    const original = await this.options.storage.getObject({ bucket: file.bucket, objectKey: file.objectKey });
    return input.client.recognize({
      filename: file.safeName,
      mimeType: file.mimeType,
      buffer: original,
      checkpoint: input.checkpoint
    });
  }

  async signedDownloadUrl(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    expiresInSeconds?: number;
    correlationId?: string | null;
  }): Promise<{ url: string; expiresInSeconds: number }> {
    const file = await this.options.repository.findById(input.principal.tenantId, input.documentFileId);
    if (!file || file.deletedAt) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    const expiresInSeconds = Math.min(Math.max(input.expiresInSeconds ?? 300, 30), 900);
    const result = {
      url: await this.options.storage.createSignedGetUrl({
        bucket: file.bucket,
        objectKey: file.objectKey,
        expiresInSeconds
      }),
      expiresInSeconds
    };
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.download_url.created",
      resourceType: "DocumentFile",
      resourceId: file.id,
      correlationId: input.correlationId ?? null,
      metadata: {
        workspaceId: file.workspaceId,
        kind: file.kind,
        mimeType: file.mimeType,
        expiresInSeconds
      }
    });
    return result;
  }

  private async toPublicPage(page: StoredDocumentPage): Promise<PublicDocumentPage> {
    const processedImageUrl =
      page.processedBucket && page.processedKey
        ? await this.options.storage.createSignedGetUrl({
            bucket: page.processedBucket,
            objectKey: page.processedKey,
            expiresInSeconds: 300
          })
        : null;
    return toPublicPage(page, processedImageUrl);
  }

  async delete(input: {
    principal: AuthPrincipal;
    documentFileId: string;
    correlationId?: string | null;
  }): Promise<void> {
    const deleted = await this.options.repository.markDeleted({
      tenantId: input.principal.tenantId,
      documentFileId: input.documentFileId,
      actorUserId: input.principal.userId
    });
    if (!deleted) throw new DocumentError("DOCUMENT_NOT_FOUND", 404);
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.deleted",
      resourceType: "DocumentFile",
      resourceId: deleted.id,
      correlationId: input.correlationId ?? null,
      metadata: {
        workspaceId: deleted.workspaceId,
        kind: deleted.kind,
        mimeType: deleted.mimeType
      }
    });
  }

  private assertUpload(originalName: string, mimeType: string, buffer: Buffer): { mimeType: string; extensionMismatch: boolean; warnings: PublicDocumentUploadWarning[] } {
    if (!originalName.trim()) throw new DocumentError("FILENAME_REQUIRED");
    if (buffer.byteLength === 0) throw new DocumentError("EMPTY_FILE");
    if (buffer.byteLength > this.maxBytes) throw new DocumentError("FILE_TOO_LARGE", 413);
    const normalizedClaim = normalizeUploadMimeType(mimeType);
    if (normalizedClaim === null) throw new DocumentError("UNSUPPORTED_MEDIA_TYPE", 415);
    const sniffed = sniffMimeType(buffer);
    if (!sniffed) {
      throw new DocumentError("MIME_SIGNATURE_MISMATCH", 415);
    }
    const extensionMimeType = mimeTypeFromExtension(originalName);
    if (!extensionMimeType && hasFilenameExtension(originalName)) throw new DocumentError("MIME_SIGNATURE_MISMATCH", 415);

    const claimMismatch = normalizedClaim !== "AUTO" && sniffed !== normalizedClaim;
    const extensionMismatch = Boolean(extensionMimeType && extensionMimeType !== sniffed);
    if ((claimMismatch && !isSafeImageMismatch(sniffed, normalizedClaim)) || (extensionMismatch && !isSafeImageMismatch(sniffed, extensionMimeType))) {
      throw new DocumentError("MIME_SIGNATURE_MISMATCH", 415);
    }

    const warnings: PublicDocumentUploadWarning[] = [];
    if (extensionMismatch) {
      warnings.push(extensionMismatchWarning(originalName, sniffed));
    }
    return { mimeType: sniffed, extensionMismatch, warnings };
  }

  private async findCachedDuplicate(tenantId: string, sha256: string): Promise<StoredDocumentFile | null> {
    try {
      const cached = await this.options.cache?.getHotState<{ documentFileId: string }>(duplicateUploadCacheKey(tenantId, sha256));
      if (!cached?.documentFileId) return null;
      const document = await this.options.repository.findById(tenantId, cached.documentFileId);
      if (!document || document.deletedAt || document.sha256 !== sha256) return null;
      return document;
    } catch {
      return null;
    }
  }

  private async rememberDuplicate(tenantId: string, sha256: string, documentFileId: string): Promise<void> {
    try {
      await this.options.cache?.setHotState({
        key: duplicateUploadCacheKey(tenantId, sha256),
        ttlSeconds: 24 * 60 * 60,
        value: { documentFileId, sha256 }
      });
    } catch {
      // Duplicate cache is an optimization; durable SHA-256 uniqueness remains in the repository/database.
    }
  }

  private async writeAudit(input: SeedAuditLogInput): Promise<void> {
    try {
      await this.options.audit?.create(input);
    } catch {
      // Document persistence and object storage remain authoritative; audit failures should not break document workflows.
    }
  }

  private async afterDocumentCreated(input: {
    principal: AuthPrincipal;
    created: StoredDocumentFile;
    upload: { mimeType: string; extensionMismatch: boolean; warnings: PublicDocumentUploadWarning[] };
    clientMimeType: string;
    correlationId?: string | null;
    source: "direct" | "resumable";
  }): Promise<void> {
    await this.writeAudit({
      tenantId: input.principal.tenantId,
      actorUserId: input.principal.userId,
      action: "document.uploaded",
      resourceType: "DocumentFile",
      resourceId: input.created.id,
      correlationId: input.correlationId ?? null,
      metadata: {
        workspaceId: input.created.workspaceId,
        kind: input.created.kind,
        mimeType: input.created.mimeType,
        sizeBytes: input.created.sizeBytes.toString(),
        sha256: input.created.sha256,
        safeName: input.created.safeName,
        clientMimeType: input.clientMimeType || "missing",
        detectedMimeType: input.upload.mimeType,
        extensionMismatch: input.upload.extensionMismatch,
        uploadSource: input.source,
        warnings: input.upload.warnings
      }
    });

    await this.options.events?.publish({
      tenantId: input.principal.tenantId,
      topic: "document.uploaded",
      aggregateId: input.created.id,
      correlationId: input.correlationId ?? null,
      payload: {
        documentFileId: input.created.id,
        workspaceId: input.created.workspaceId,
        kind: input.created.kind,
        mimeType: input.created.mimeType,
        sizeBytes: input.created.sizeBytes.toString(),
        sha256: input.created.sha256
      }
    });

    await this.options.jobs?.enqueue({
      principal: input.principal,
      queue: "preprocessing",
      jobType: "document.preprocess",
      dedupeKey: `preprocess:${input.created.id}:TESSERACT_OPTIMIZED`,
      eventTopic: "ocr.job.created",
      aggregateId: input.created.id,
      correlationId: input.correlationId ?? null,
      payload: {
        documentFileId: input.created.id,
        profile: "TESSERACT_OPTIMIZED",
        runTesseractAfter: this.options.enqueueTesseractAfterPreprocessing === true
      }
    });
  }

  private async requireUploadSession(tenantId: string, uploadSessionId: string): Promise<StoredUploadSession> {
    const session = await this.options.repository.findUploadSession({ tenantId, uploadSessionId });
    if (!session) throw new DocumentError("UPLOAD_SESSION_NOT_FOUND", 404);
    return session;
  }

  private async expireUploadSessionIfNeeded(session: StoredUploadSession): Promise<StoredUploadSession> {
    if (session.status === "COMPLETED" || session.status === "CANCELED" || session.status === "EXPIRED" || session.status === "FAILED") {
      return session;
    }
    if (session.expiresAt.getTime() > Date.now()) return session;
    return (
      (await this.options.repository.updateUploadSession({
        tenantId: session.tenantId,
        uploadSessionId: session.id,
        status: "EXPIRED",
        failureReason: "UPLOAD_SESSION_EXPIRED"
      })) ?? session
    );
  }

  private async assertUploadSessionOpen(session: StoredUploadSession, options: { allowPaused: boolean }): Promise<void> {
    const checked = await this.expireUploadSessionIfNeeded(session);
    if (checked.status === "PAUSED" && !options.allowPaused) throw new DocumentError("UPLOAD_PAUSED", 409);
    if (!["INITIATED", "UPLOADING", ...(options.allowPaused ? ["PAUSED" as const] : [])].includes(checked.status)) {
      throw new DocumentError("UPLOAD_SESSION_NOT_ACTIVE", 409);
    }
  }

  private async removeChunkObjects(chunks: StoredUploadChunk[]): Promise<void> {
    await Promise.all(
      chunks
        .filter((chunk) => chunk.status === "UPLOADED")
        .map((chunk) => this.options.storage.removeObject({ bucket: chunk.bucket, objectKey: chunk.objectKey }).catch(() => undefined))
    );
  }

  private publicUploadStatus(session: StoredUploadSession, chunks: StoredUploadChunk[]): PublicUploadSessionStatus {
    return {
      upload: toPublicUploadSession(session),
      uploadedChunks: uploadedChunkIndexes(chunks),
      missingChunks: missingChunkIndexes(session, chunks),
      chunks: chunks.map(toPublicUploadChunk)
    };
  }
}

export function duplicateUploadCacheKey(tenantId: string, sha256: string): string {
  return `document-duplicate:${tenantId}:${sha256}`;
}

export type PublicDocumentFile = {
  id: string;
  workspaceId: string;
  kind: DocumentKind;
  originalName: string;
  safeName: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  createdAt: string;
};

export type PublicDocumentUploadWarning = {
  code: "EXTENSION_CONTENT_MISMATCH";
  originalExtension: string;
  detectedMimeType: string;
  message: string;
};

export type PublicDocumentPage = {
  id: string;
  documentFileId: string;
  pageNumber: number;
  width: number | null;
  height: number | null;
  processedBucket: string | null;
  processedKey: string | null;
  processedImageUrl: string | null;
  preprocessingProfile: string | null;
  qualityScore: string | null;
  createdAt: string;
};

export type PublicUploadSession = {
  id: string;
  workspaceId: string;
  kind: DocumentKind;
  originalName: string;
  safeName: string;
  clientMimeType: string;
  totalSizeBytes: string;
  chunkSizeBytes: number;
  totalChunks: number;
  status: StoredUploadSession["status"];
  finalSha256: string | null;
  documentFileId: string | null;
  failureReason: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
};

export type PublicUploadChunk = {
  chunkIndex: number;
  sizeBytes: number;
  clientCrc32: string;
  serverCrc32: string;
  status: StoredUploadChunk["status"];
  retryCount: number;
  uploadedAt: string | null;
};

export type PublicUploadSessionStatus = {
  upload: PublicUploadSession;
  uploadedChunks: number[];
  missingChunks: number[];
  chunks: PublicUploadChunk[];
};

export type PublicUploadChunkResult = {
  chunk: PublicUploadChunk;
  uploadedChunks: number[];
  missingChunks: number[];
  duplicate: boolean;
};

export type PublicDocumentSearchResult = {
  document: PublicDocumentFile;
  score: number;
  matchSources: string[];
  snippets: string[];
  extraction: {
    documentType: string;
    merchantName: string | null;
    date: string | null;
    totalMinor: string | null;
    currency: string | null;
    reviewRequired: boolean;
  } | null;
};

export function toPublicDocument(file: StoredDocumentFile): PublicDocumentFile {
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    kind: file.kind,
    originalName: file.originalName,
    safeName: file.safeName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes.toString(),
    sha256: file.sha256,
    createdAt: file.createdAt.toISOString()
  };
}

function encodeDocumentCursor(cursor: DocumentListCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), "utf8").toString(
    "base64url"
  );
}

function decodeDocumentCursor(value: string): DocumentListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || parsed.id.length === 0) {
      throw new Error("invalid cursor payload");
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error("invalid cursor date");
    return { createdAt, id: parsed.id };
  } catch {
    throw new DocumentError("INVALID_DOCUMENT_CURSOR", 400);
  }
}

export function toPublicPage(page: StoredDocumentPage, processedImageUrl: string | null): PublicDocumentPage {
  return {
    id: page.id,
    documentFileId: page.documentFileId,
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    processedBucket: page.processedBucket,
    processedKey: page.processedKey,
    processedImageUrl,
    preprocessingProfile: page.preprocessingProfile,
    qualityScore: page.qualityScore?.toString() ?? null,
    createdAt: page.createdAt.toISOString()
  };
}

function toPublicUploadSession(session: StoredUploadSession): PublicUploadSession {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    kind: session.kind,
    originalName: session.originalName,
    safeName: session.safeName,
    clientMimeType: session.clientMimeType,
    totalSizeBytes: session.totalSizeBytes.toString(),
    chunkSizeBytes: session.chunkSizeBytes,
    totalChunks: session.totalChunks,
    status: session.status,
    finalSha256: session.finalSha256,
    documentFileId: session.documentFileId,
    failureReason: session.failureReason,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null
  };
}

function toPublicUploadChunk(chunk: StoredUploadChunk): PublicUploadChunk {
  return {
    chunkIndex: chunk.chunkIndex,
    sizeBytes: chunk.sizeBytes,
    clientCrc32: chunk.clientCrc32,
    serverCrc32: chunk.serverCrc32,
    status: chunk.status,
    retryCount: chunk.retryCount,
    uploadedAt: chunk.uploadedAt?.toISOString() ?? null
  };
}

function uploadedChunkIndexes(chunks: StoredUploadChunk[]): number[] {
  return chunks
    .filter((chunk) => chunk.status === "UPLOADED")
    .map((chunk) => chunk.chunkIndex)
    .sort((a, b) => a - b);
}

function missingChunkIndexes(session: StoredUploadSession, chunks: StoredUploadChunk[]): number[] {
  const uploaded = new Set(uploadedChunkIndexes(chunks));
  const missing: number[] = [];
  for (let index = 0; index < session.totalChunks; index += 1) {
    if (!uploaded.has(index)) missing.push(index);
  }
  return missing;
}

function expectedChunkSize(session: StoredUploadSession, chunkIndex: number): number {
  const start = chunkIndex * session.chunkSizeBytes;
  const remaining = Number(session.totalSizeBytes - BigInt(start));
  return Math.min(session.chunkSizeBytes, remaining);
}

function uploadChunkObjectKey(session: StoredUploadSession, chunkIndex: number): string {
  return [
    "tenants",
    session.tenantId,
    "workspaces",
    session.workspaceId,
    "uploads",
    session.id,
    `chunk-${chunkIndex.toString().padStart(6, "0")}.part`
  ].join("/");
}

function normalizeCrc32(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{8}$/.test(normalized) ? normalized : null;
}

function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 4) {
    const leTiff = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
    const beTiff = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
    if (leTiff || beTiff) return "image/tiff";
  }
  return null;
}

function normalizeUploadMimeType(value: string): string | "AUTO" | null {
  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (["image/jpg", "image/pjpeg", "image/x-jpeg", "image/x-jpg", "image/jfif"].includes(normalized)) {
    return "image/jpeg";
  }
  if (["image/x-ms-bmp", "image/x-bmp"].includes(normalized)) {
    return "image/bmp";
  }
  if (["application/octet-stream", "application/x-octet-stream", "binary/octet-stream", "text/plain", ""].includes(normalized)) {
    return "AUTO";
  }
  return isSupportedUploadMimeType(normalized) ? normalized : null;
}

function mimeTypeFromExtension(originalName: string): string | null {
  const extension = originalName.trim().toLowerCase().split(".").pop() ?? "";
  const allowed: Record<string, string[]> = {
    "image/jpeg": ["jpg", "jpeg", "jfif", "jpe"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "image/tiff": ["tif", "tiff"],
    "image/bmp": ["bmp"],
    "image/gif": ["gif"],
    "application/pdf": ["pdf"]
  };
  for (const [mimeType, extensions] of Object.entries(allowed)) {
    if (extensions.includes(extension)) return mimeType;
  }
  return null;
}

function hasFilenameExtension(originalName: string): boolean {
  const lastSegment = originalName.trim().split(/[\\/]/).pop() ?? "";
  return /\.[^.]+$/.test(lastSegment);
}

function isSafeImageMismatch(detectedMimeType: string, claimedMimeType: string | "AUTO" | null): boolean {
  if (!claimedMimeType || claimedMimeType === "AUTO") return true;
  return isCoreImageMimeType(detectedMimeType) && isCoreImageMimeType(claimedMimeType);
}

function isCoreImageMimeType(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/tiff", "image/bmp", "image/gif"].includes(mimeType);
}

function extensionMismatchWarning(originalName: string, detectedMimeType: string): PublicDocumentUploadWarning {
  const extension = originalName.trim().toLowerCase().split(".").pop() ?? "";
  const detectedLabel = mimeTypeDisplayName(detectedMimeType);
  return {
    code: "EXTENSION_CONTENT_MISMATCH",
    originalExtension: extension,
    detectedMimeType,
    message: `Dosya adı .${extension} ile bitiyor ancak içeriği ${detectedLabel}. Dosya ${detectedLabel} olarak işlendi.`
  };
}

function mimeTypeDisplayName(mimeType: string): string {
  if (mimeType === "image/jpeg") return "JPEG";
  if (mimeType === "image/png") return "PNG";
  if (mimeType === "image/webp") return "WebP";
  if (mimeType === "image/tiff") return "TIFF";
  if (mimeType === "image/bmp") return "BMP";
  if (mimeType === "image/gif") return "GIF";
  if (mimeType === "application/pdf") return "PDF";
  return mimeType;
}

function isPreprocessingProfile(value: string): boolean {
  return (preprocessingProfiles as readonly string[]).includes(value);
}

function assertPageMetadata(
  pageNumber: number,
  width: number | null | undefined,
  height: number | null | undefined,
  qualityScore: number | null | undefined
): void {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new DocumentError("INVALID_PAGE_NUMBER");
  if (width !== null && width !== undefined && (!Number.isInteger(width) || width < 1)) {
    throw new DocumentError("INVALID_PAGE_WIDTH");
  }
  if (height !== null && height !== undefined && (!Number.isInteger(height) || height < 1)) {
    throw new DocumentError("INVALID_PAGE_HEIGHT");
  }
  if (
    qualityScore !== null &&
    qualityScore !== undefined &&
    (!Number.isFinite(qualityScore) || qualityScore < 0 || qualityScore > 1)
  ) {
    throw new DocumentError("INVALID_QUALITY_SCORE");
  }
}

function decodeProcessedImage(processedImageBase64: string, mimeType: string): Buffer {
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new DocumentError("UNSUPPORTED_PREPROCESSED_IMAGE_TYPE", 415);
  }
  const normalized = processedImageBase64.trim();
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new DocumentError("INVALID_PREPROCESSED_IMAGE_BASE64");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength === 0 || sniffMimeType(buffer) !== mimeType) {
    throw new DocumentError("PREPROCESSED_IMAGE_SIGNATURE_MISMATCH", 415);
  }
  return buffer;
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function scoreDocumentSearchResult(
  document: StoredDocumentFile,
  extraction: PersistedExtraction | null,
  terms: readonly string[],
  rawQuery: string
): PublicDocumentSearchResult | null {
  const sources = searchableDocumentFields(document, extraction);
  const hits = sources
    .map((source) => {
      const normalized = normalizeSearchText(source.value);
      const matchedTerms = terms.filter((term) => normalized.includes(term));
      return { ...source, matchedTerms };
    })
    .filter((source) => source.matchedTerms.length > 0);
  if (hits.length === 0) return null;
  const matchedTermCount = new Set(hits.flatMap((hit) => hit.matchedTerms)).size;
  const weightedHitScore = hits.reduce((score, hit) => score + hit.weight * hit.matchedTerms.length, 0);
  return {
    document: toPublicDocument(document),
    score: Math.round((matchedTermCount * 10 + weightedHitScore) * 100) / 100,
    matchSources: [...new Set(hits.map((hit) => hit.label))],
    snippets: [...new Set(hits.flatMap((hit) => buildSnippet(hit.value, rawQuery)))].slice(0, 3),
    extraction: extraction
      ? {
          documentType: extraction.extracted.documentType,
          merchantName: extraction.extracted.merchantName,
          date: extraction.extracted.date,
          totalMinor: extraction.extracted.total?.amountMinor.toString() ?? null,
          currency: extraction.extracted.total?.currency ?? extraction.extracted.currency ?? null,
          reviewRequired: extraction.issues.length > 0 || extraction.reviewState?.status === "NEEDS_REVIEW"
        }
      : null
  };
}

function searchableDocumentFields(document: StoredDocumentFile, extraction: PersistedExtraction | null): Array<{ label: string; value: string; weight: number }> {
  const fields = [
    { label: "filename", value: document.originalName, weight: 2.5 },
    { label: "safeName", value: document.safeName, weight: 1.5 },
    { label: "kind", value: document.kind, weight: 1 }
  ];
  if (!extraction) return fields;
  const lineItemNames = extraction.extracted.lineItems.map((item) => item.name).join(" ");
  return [
    ...fields,
    { label: "merchantName", value: extraction.extracted.merchantName ?? "", weight: 4 },
    { label: "receiptNumber", value: extraction.extracted.receiptNumber ?? "", weight: 3 },
    { label: "documentType", value: extraction.extracted.documentType, weight: 2 },
    { label: "lineItems", value: lineItemNames, weight: 2 },
    { label: "ocrSnippet", value: extraction.extracted.normalizedText, weight: 0.75 }
  ].filter((field) => field.value.trim().length > 0);
}

function buildSnippet(value: string, rawQuery: string): string[] {
  const normalizedValue = normalizeSearchText(value);
  const firstTerm = normalizeSearchText(rawQuery).split(/\s+/).find(Boolean);
  if (!firstTerm) return [];
  const index = normalizedValue.indexOf(firstTerm);
  if (index < 0) return [];
  const start = Math.max(0, index - 60);
  const end = Math.min(value.length, index + rawQuery.length + 100);
  const snippet = value.slice(start, end).replace(/\s+/g, " ").trim();
  return snippet ? [snippet] : [];
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
