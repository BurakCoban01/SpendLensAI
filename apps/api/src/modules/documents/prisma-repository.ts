import { Prisma, PrismaClient } from "@prisma/client";
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

export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async workspaceExists(tenantId: string, workspaceId: string): Promise<boolean> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, tenantId, archivedAt: null },
      select: { id: true }
    });
    return Boolean(workspace);
  }

  async findBySha256(tenantId: string, sha256: string): Promise<StoredDocumentFile | null> {
    return this.prisma.documentFile.findUnique({ where: { tenantId_sha256: { tenantId, sha256 } } });
  }

  async findById(tenantId: string, documentFileId: string): Promise<StoredDocumentFile | null> {
    return this.prisma.documentFile.findFirst({ where: { id: documentFileId, tenantId } });
  }

  async list(input: { tenantId: string; workspaceId?: string }): Promise<StoredDocumentFile[]> {
    return this.prisma.documentFile.findMany({
      where: {
        tenantId: input.tenantId,
        deletedAt: null,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async listPage(input: DocumentListPageInput): Promise<StoredDocumentFile[]> {
    const cursorFilter = input.cursor
      ? {
          OR: [
            { createdAt: { lt: input.cursor.createdAt } },
            { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } }
          ]
        }
      : undefined;
    return this.prisma.documentFile.findMany({
      where: {
        tenantId: input.tenantId,
        deletedAt: null,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.search
          ? {
              OR: [
                { originalName: { contains: input.search, mode: "insensitive" } },
                { safeName: { contains: input.search, mode: "insensitive" } }
              ]
            }
          : {}),
        ...(input.createdFrom || input.createdTo
          ? {
              createdAt: {
                ...(input.createdFrom ? { gte: input.createdFrom } : {}),
                ...(input.createdTo ? { lte: input.createdTo } : {})
              }
            }
          : {}),
        ...(cursorFilter ? { AND: cursorFilter } : {})
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit
    });
  }

  async listPages(input: { tenantId: string; documentFileId: string }): Promise<StoredDocumentPage[]> {
    return this.prisma.documentPage.findMany({
      where: { tenantId: input.tenantId, documentFileId: input.documentFileId },
      orderBy: { pageNumber: "asc" }
    });
  }

  async upsertDocumentPage(input: UpsertDocumentPageInput): Promise<StoredDocumentPage> {
    const data = {
      width: input.width ?? null,
      height: input.height ?? null,
      processedBucket: input.processedBucket ?? null,
      processedKey: input.processedKey ?? null,
      preprocessingProfile: input.preprocessingProfile ?? null,
      qualityScore:
        input.qualityScore === null || input.qualityScore === undefined
          ? null
          : new Prisma.Decimal(input.qualityScore.toFixed(4))
    };
    return this.prisma.documentPage.upsert({
      where: {
        tenantId_documentFileId_pageNumber: {
          tenantId: input.tenantId,
          documentFileId: input.documentFileId,
          pageNumber: input.pageNumber
        }
      },
      create: {
        tenantId: input.tenantId,
        documentFileId: input.documentFileId,
        pageNumber: input.pageNumber,
        ...data
      },
      update: data
    });
  }

  async createUploadedDocument(input: CreateDocumentInput): Promise<StoredDocumentFile> {
    return this.prisma.$transaction(async (tx) => {
      const receipt =
        input.kind === "RECEIPT"
          ? await tx.receiptDocument.create({
              data: {
                tenantId: input.tenantId,
                workspaceId: input.workspaceId,
                createdById: input.createdById
              },
              select: { id: true }
            })
          : null;
      const invoice =
        input.kind === "INVOICE"
          ? await tx.invoiceDocument.create({
              data: {
                tenantId: input.tenantId,
                workspaceId: input.workspaceId,
                createdById: input.createdById
              },
              select: { id: true }
            })
          : null;

      const file = await tx.documentFile.create({
        data: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          kind: input.kind,
          receiptId: receipt?.id ?? null,
          invoiceId: invoice?.id ?? null,
          originalName: input.originalName,
          safeName: input.safeName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          bucket: input.bucket,
          objectKey: input.objectKey,
          createdById: input.createdById
        }
      });

      return file;
    });
  }

  async createUploadSession(input: CreateUploadSessionInput): Promise<StoredUploadSession> {
    return this.prisma.uploadSession.create({
      data: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        originalName: input.originalName,
        safeName: input.safeName,
        clientMimeType: input.clientMimeType,
        totalSizeBytes: input.totalSizeBytes,
        chunkSizeBytes: input.chunkSizeBytes,
        totalChunks: input.totalChunks,
        createdById: input.createdById,
        expiresAt: input.expiresAt
      }
    });
  }

  async findUploadSession(input: { tenantId: string; uploadSessionId: string }): Promise<StoredUploadSession | null> {
    return this.prisma.uploadSession.findFirst({ where: { id: input.uploadSessionId, tenantId: input.tenantId } });
  }

  async listUploadChunks(input: { tenantId: string; uploadSessionId: string }): Promise<StoredUploadChunk[]> {
    return this.prisma.uploadChunk.findMany({
      where: { tenantId: input.tenantId, uploadSessionId: input.uploadSessionId },
      orderBy: { chunkIndex: "asc" }
    });
  }

  async findUploadChunk(input: {
    tenantId: string;
    uploadSessionId: string;
    chunkIndex: number;
  }): Promise<StoredUploadChunk | null> {
    return this.prisma.uploadChunk.findUnique({
      where: {
        tenantId_uploadSessionId_chunkIndex: {
          tenantId: input.tenantId,
          uploadSessionId: input.uploadSessionId,
          chunkIndex: input.chunkIndex
        }
      }
    });
  }

  async upsertUploadChunk(input: UpsertUploadChunkInput): Promise<StoredUploadChunk> {
    const data = {
      sizeBytes: input.sizeBytes,
      clientCrc32: input.clientCrc32,
      serverCrc32: input.serverCrc32,
      bucket: input.bucket,
      objectKey: input.objectKey,
      status: input.status,
      uploadedAt: input.status === "UPLOADED" ? new Date() : null,
      ...(input.incrementRetryCount ? { retryCount: { increment: 1 } } : {})
    };
    return this.prisma.uploadChunk.upsert({
      where: {
        tenantId_uploadSessionId_chunkIndex: {
          tenantId: input.tenantId,
          uploadSessionId: input.uploadSessionId,
          chunkIndex: input.chunkIndex
        }
      },
      create: {
        tenantId: input.tenantId,
        uploadSessionId: input.uploadSessionId,
        chunkIndex: input.chunkIndex,
        sizeBytes: input.sizeBytes,
        clientCrc32: input.clientCrc32,
        serverCrc32: input.serverCrc32,
        bucket: input.bucket,
        objectKey: input.objectKey,
        status: input.status,
        retryCount: input.incrementRetryCount ? 1 : 0,
        uploadedAt: input.status === "UPLOADED" ? new Date() : null
      },
      update: data
    });
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
    return this.prisma.uploadSession.update({
      where: { id: existing.id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.finalSha256 !== undefined ? { finalSha256: input.finalSha256 } : {}),
        ...(input.documentFileId !== undefined ? { documentFileId: input.documentFileId } : {}),
        ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {})
      }
    });
  }

  async markDeleted(input: {
    tenantId: string;
    documentFileId: string;
    actorUserId: string;
    correlationId?: string | null;
  }): Promise<StoredDocumentFile | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.documentFile.findFirst({
        where: { id: input.documentFileId, tenantId: input.tenantId, deletedAt: null }
      });
      if (!existing) return null;
      const deleted = await tx.documentFile.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() }
      });
      return deleted;
    });
  }
}
