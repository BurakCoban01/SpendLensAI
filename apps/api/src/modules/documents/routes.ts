import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateRequest, requirePermission } from "../auth/routes";
import type { AuthService } from "../auth/service";
import { AuthError } from "../auth/service";
import { DocumentError, DocumentService } from "./service";

const UploadQuerySchema = z.object({
  workspaceId: z.string().min(1),
  kind: z.enum(["RECEIPT", "INVOICE", "OTHER"])
});

const ListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  kind: z.enum(["RECEIPT", "INVOICE", "OTHER"]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20)
});

const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  workspaceId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(25).optional()
});

const ParamsSchema = z.object({
  id: z.string().min(1)
});

const DownloadQuerySchema = z.object({
  expiresInSeconds: z.coerce.number().int().positive().max(900).optional()
});

const PreprocessingArtifactBodySchema = z.object({
  profile: z.enum([
    "DEFAULT",
    "TESSERACT_OPTIMIZED",
    "CUSTOM_MODEL_OPTIMIZED",
    "LOW_LIGHT",
    "THERMAL_RECEIPT",
    "CRUMPLED_RECEIPT"
  ]),
  pages: z
    .array(
      z.object({
        pageNumber: z.number().int().positive(),
        width: z.number().int().positive().nullable().optional(),
        height: z.number().int().positive().nullable().optional(),
        qualityScore: z.number().min(0).max(1).nullable().optional(),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        processedImageBase64: z.string().min(1),
        decisions: z.record(z.unknown()).optional()
      })
    )
    .min(1)
});

const UploadInitBodySchema = z.object({
  workspaceId: z.string().min(1),
  kind: z.enum(["RECEIPT", "INVOICE", "OTHER"]),
  filename: z.string().min(1).max(260),
  mimeType: z.string().max(120).optional().default("application/octet-stream"),
  totalSizeBytes: z.number().int().positive(),
  chunkSizeBytes: z.number().int().positive()
});

const UploadParamsSchema = z.object({
  uploadId: z.string().min(1)
});

const UploadChunkParamsSchema = z.object({
  uploadId: z.string().min(1),
  chunkIndex: z.coerce.number().int().min(0)
});

const UploadCompleteBodySchema = z.object({
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/)
});

export async function registerDocumentRoutes(
  app: FastifyInstance,
  auth: AuthService,
  documents: DocumentService,
  maxFileSize: number
): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: maxFileSize,
      files: 1
    }
  });

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: maxFileSize }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/documents/upload", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const query = UploadQuerySchema.parse(request.query);
      const part = await request.file();
      if (!part) throw new DocumentError("FILE_REQUIRED");
      const buffer = await part.toBuffer();
      const result = await documents.upload({
        principal,
        workspaceId: query.workspaceId,
        kind: query.kind,
        originalName: part.filename,
        mimeType: part.mimetype,
        buffer,
        correlationId: correlationId(request)
      });
      reply.code(result.duplicate ? 200 : 201);
      return result;
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.get("/documents", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.read");
      const query = ListQuerySchema.parse(request.query);
      return await documents.listPage({
        principal,
        limit: query.limit,
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.createdFrom ? { createdFrom: query.createdFrom } : {}),
        ...(query.createdTo ? { createdTo: query.createdTo } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {})
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.get("/documents/search", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.read");
      const query = SearchQuerySchema.parse(request.query);
      return await documents.search({
        principal,
        query: query.q,
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.post("/documents/uploads/init", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const body = UploadInitBodySchema.parse(request.body);
      reply.code(201);
      return await documents.initUploadSession({
        principal,
        workspaceId: body.workspaceId,
        kind: body.kind,
        originalName: body.filename,
        mimeType: body.mimeType,
        totalSizeBytes: body.totalSizeBytes,
        chunkSizeBytes: body.chunkSizeBytes,
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.put("/documents/uploads/:uploadId/chunks/:chunkIndex", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const params = UploadChunkParamsSchema.parse(request.params);
      const clientCrc32 = request.headers["x-client-crc32"];
      if (typeof clientCrc32 !== "string") throw new DocumentError("INVALID_CHUNK_CRC");
      if (!Buffer.isBuffer(request.body)) throw new DocumentError("CHUNK_BODY_REQUIRED");
      return await documents.uploadChunk({
        principal,
        uploadSessionId: params.uploadId,
        chunkIndex: params.chunkIndex,
        clientCrc32,
        buffer: request.body,
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.get("/documents/uploads/:uploadId/status", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const params = UploadParamsSchema.parse(request.params);
      return await documents.uploadStatus({ principal, uploadSessionId: params.uploadId });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.post("/documents/uploads/:uploadId/complete", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const params = UploadParamsSchema.parse(request.params);
      const body = UploadCompleteBodySchema.parse(request.body);
      reply.code(201);
      return await documents.completeUpload({
        principal,
        uploadSessionId: params.uploadId,
        sha256: body.sha256,
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.post("/documents/uploads/:uploadId/pause", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const params = UploadParamsSchema.parse(request.params);
      return await documents.pauseUpload({ principal, uploadSessionId: params.uploadId });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.post("/documents/uploads/:uploadId/resume", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const params = UploadParamsSchema.parse(request.params);
      return await documents.resumeUpload({ principal, uploadSessionId: params.uploadId });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.post("/documents/uploads/:uploadId/cancel", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const params = UploadParamsSchema.parse(request.params);
      return await documents.cancelUpload({
        principal,
        uploadSessionId: params.uploadId,
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.delete("/documents/uploads/:uploadId", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.upload");
      const params = UploadParamsSchema.parse(request.params);
      return await documents.cancelUpload({
        principal,
        uploadSessionId: params.uploadId,
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.get("/documents/:id", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.read");
      const params = ParamsSchema.parse(request.params);
      return { document: await documents.get(principal, params.id) };
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.post("/documents/:id/download-url", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.read");
      const params = ParamsSchema.parse(request.params);
      const query = DownloadQuerySchema.parse(request.query);
      return await documents.signedDownloadUrl({
        principal,
        documentFileId: params.id,
        correlationId: correlationId(request),
        ...(query.expiresInSeconds ? { expiresInSeconds: query.expiresInSeconds } : {})
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.get("/documents/:id/pages", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.read");
      const params = ParamsSchema.parse(request.params);
      return { pages: await documents.listPages({ principal, documentFileId: params.id }) };
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.post("/documents/:id/preprocessing-artifacts", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "ocr.run");
      const params = ParamsSchema.parse(request.params);
      const body = PreprocessingArtifactBodySchema.parse(request.body);
      return await documents.persistPreprocessingArtifacts({
        principal,
        documentFileId: params.id,
        profile: body.profile,
        pages: body.pages.map((page) => ({
          pageNumber: page.pageNumber,
          width: page.width ?? null,
          height: page.height ?? null,
          qualityScore: page.qualityScore ?? null,
          mimeType: page.mimeType,
          processedImageBase64: page.processedImageBase64,
          decisions: page.decisions ?? {}
        })),
        correlationId: correlationId(request)
      });
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });

  app.delete("/documents/:id", async (request, reply) => {
    try {
      const principal = await authenticateRequest(auth, request);
      requirePermission(auth, principal, "documents.delete");
      const params = ParamsSchema.parse(request.params);
      await documents.delete({ principal, documentFileId: params.id, correlationId: correlationId(request) });
      reply.code(204);
      return null;
    } catch (error) {
      return sendDocumentError(reply, error);
    }
  });
}

function sendDocumentError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) {
    reply.code(400);
    return { error: { code: "VALIDATION_ERROR", issues: error.issues } };
  }
  if (error instanceof AuthError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  if (error instanceof DocumentError) {
    reply.code(error.statusCode);
    return { error: { code: error.code } };
  }
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR" } };
}

function correlationId(request: FastifyRequest): string | null {
  const value = request.headers["x-correlation-id"];
  return typeof value === "string" ? value : null;
}
