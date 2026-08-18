import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crc32Hex } from "@spendlens/shared";
import { buildApp } from "../../app";
import { InMemoryAuthRepository } from "../auth/memory-repository";
import { InMemoryExtractionRepository } from "../extraction/memory-repository";
import { InMemoryDocumentRepository } from "./memory-repository";
import { InMemoryDocumentStorage } from "./storage";

describe("document routes", () => {
  let app: FastifyInstance;
  let accessToken: string;
  let otherAccessToken: string;
  let tenantId: string;
  let otherTenantId: string;
  let documentRepository: InMemoryDocumentRepository;
  let extractionRepository: InMemoryExtractionRepository;
  let documentStorage: InMemoryDocumentStorage;

  beforeAll(async () => {
    documentRepository = new InMemoryDocumentRepository();
    extractionRepository = new InMemoryExtractionRepository();
    documentStorage = new InMemoryDocumentStorage();
    app = await buildApp({
      authRepository: new InMemoryAuthRepository(),
      documentRepository,
      extractionRepository,
      documentStorage
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Docs Tenant",
        tenantSlug: "docs",
        workspaceName: "Finance",
        email: "owner@example.com",
        displayName: "Owner",
        password: "very-secure-password"
      }
    });
    const body = register.json();
    accessToken = body.tokens.accessToken;
    tenantId = body.tenant.id;
    documentRepository.addWorkspace(body.tenant.id, "workspace_1");

    const otherRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Other Docs Tenant",
        tenantSlug: "other-docs",
        workspaceName: "Finance",
        email: "other-owner@example.com",
        displayName: "Other Owner",
        password: "very-secure-password"
      }
    });
    const otherBody = otherRegister.json();
    otherAccessToken = otherBody.tokens.accessToken;
    otherTenantId = otherBody.tenant.id;
    documentRepository.addWorkspace(otherBody.tenant.id, "workspace_1");
  });

  afterAll(async () => {
    await app.close();
  });

  it("uploads, deduplicates, signs and deletes tenant-scoped document files", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-correlation-id": "corr-document-upload",
        ...multipartHeaders("boundary")
      },
      payload: multipartBody("boundary", "../../Receipt 001.PNG", "image/png", pngBytes())
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json();
    expect(uploaded.document.safeName).toBe("receipt-001.png");
    expect(uploaded.duplicate).toBe(false);

    const duplicate = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary2")
      },
      payload: multipartBody("boundary2", "same.png", "image/png", pngBytes())
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    expect(duplicate.json().document.id).toBe(uploaded.document.id);

    const list = await app.inject({
      method: "GET",
      url: "/documents?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().documents).toHaveLength(1);

    const signed = await app.inject({
      method: "POST",
      url: `/documents/${uploaded.document.id}/download-url?expiresInSeconds=60`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-document-download" }
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().url).toContain("memory://spendlens-documents/");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/documents/${uploaded.document.id}`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-document-delete" }
    });
    expect(deleted.statusCode).toBe(204);

    const audit = await app.inject({
      method: "GET",
      url: `/admin/audit?resourceType=DocumentFile&limit=20`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    const documentAudit = audit.json().logs.filter((log: { resourceId: string }) => log.resourceId === uploaded.document.id);
    expect(documentAudit.map((log: { action: string }) => log.action)).toEqual(
      expect.arrayContaining(["document.uploaded", "document.download_url.created", "document.deleted"])
    );
    expect(documentAudit.find((log: { action: string }) => log.action === "document.uploaded")).toMatchObject({
      correlationId: "corr-document-upload",
      metadata: {
        workspaceId: "workspace_1",
        kind: "RECEIPT",
        mimeType: "image/png",
        safeName: "receipt-001.png"
      }
    });
    expect(documentAudit.find((log: { action: string }) => log.action === "document.download_url.created")).toMatchObject({
      correlationId: "corr-document-download",
      metadata: { expiresInSeconds: 60 }
    });
    expect(documentAudit.find((log: { action: string }) => log.action === "document.deleted")?.correlationId).toBe(
      "corr-document-delete"
    );
    const serializedAudit = JSON.stringify(documentAudit);
    expect(serializedAudit).not.toContain(signed.json().url);
    expect(serializedAudit).not.toContain("memory://");
    expect(serializedAudit).not.toContain("objectKey");

    const signedAfterDelete = await app.inject({
      method: "POST",
      url: `/documents/${uploaded.document.id}/download-url`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(signedAfterDelete.statusCode).toBe(404);
  });

  it("rejects unsupported or spoofed uploads before storage", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=INVOICE",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary3")
      },
      payload: multipartBody("boundary3", "invoice.pdf", "application/pdf", pngBytes())
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("MIME_SIGNATURE_MISMATCH");
  });

  it("accepts browser JPEG MIME variants, safe image mismatches and rejects unsafe JPEG mismatches", async () => {
    const variants = [
      { name: "receipt-jpeg.jpg", mimeType: "image/jpeg" },
      { name: "receipt-jpg.jpg", mimeType: "image/jpg" },
      { name: "receipt-pjpeg.jpg", mimeType: "image/pjpeg" },
      { name: "receipt-octet.jpg", mimeType: "application/octet-stream" },
      { name: "receipt-missing.jpeg", mimeType: null }
    ];

    for (const [index, variant] of variants.entries()) {
      const boundary = `boundary-jpeg-${index}`;
      const upload = await app.inject({
        method: "POST",
        url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...multipartHeaders(boundary)
        },
        payload: multipartBody(boundary, variant.name, variant.mimeType, jpegBytes(index))
      });
      expect(upload.statusCode).toBe(201);
      expect(upload.json().document.mimeType).toBe("image/jpeg");
    }

    const pdfSpoof = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary-pdf-spoof")
      },
      payload: multipartBody("boundary-pdf-spoof", "spoofed.jpg", "application/octet-stream", Buffer.from("%PDF-1.7\n", "utf8"))
    });
    expect(pdfSpoof.statusCode).toBe(415);
    expect(pdfSpoof.json().error.code).toBe("MIME_SIGNATURE_MISMATCH");

    const pngMismatch = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary-png-spoof")
      },
      payload: multipartBody("boundary-png-spoof", "spoofed.jpg", "image/jpeg", pngBytes("spoof"))
    });
    expect(pngMismatch.statusCode).toBe(201);
    expect(pngMismatch.json().document.mimeType).toBe("image/png");
    expect(pngMismatch.json().warnings).toEqual([
      expect.objectContaining({
        code: "EXTENSION_CONTENT_MISMATCH",
        originalExtension: "jpg",
        detectedMimeType: "image/png"
      })
    ]);
  });

  it("persists preprocessing page artifacts and lists signed page access", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary-preprocess-upload")
      },
      payload: multipartBody("boundary-preprocess-upload", "preprocess.png", "image/png", pngBytes("preprocess"))
    });
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json().document.id;

    const persisted = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/preprocessing-artifacts`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-correlation-id": "corr-preprocess-1"
      },
      payload: {
        profile: "TESSERACT_OPTIMIZED",
        pages: [
          {
            pageNumber: 1,
            width: 420,
            height: 620,
            qualityScore: 0.8421,
            mimeType: "image/png",
            processedImageBase64: pngBytes("processed-page").toString("base64"),
            decisions: {
              deskew_angle: -1.25,
              adaptive_threshold: true
            }
          }
        ]
      }
    });
    expect(persisted.statusCode).toBe(200);
    const body = persisted.json();
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].pageNumber).toBe(1);
    expect(body.pages[0].preprocessingProfile).toBe("TESSERACT_OPTIMIZED");
    expect(body.pages[0].qualityScore).toBe("0.8421");
    expect(body.pages[0].processedImageUrl).toContain("memory://spendlens-documents/");
    expect(body.manifestObjectKey).toContain("preprocessing-manifest.json");
    expect(documentStorage.hasObject("spendlens-documents", body.pages[0].processedKey)).toBe(true);
    expect(documentStorage.hasObject("spendlens-documents", body.manifestObjectKey)).toBe(true);
    const manifest = documentStorage.readObject("spendlens-documents", body.manifestObjectKey);
    expect(manifest?.toString("utf8")).toContain("\"pageCount\": 1");

    const listed = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/pages`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().pages).toHaveLength(1);
    expect(listed.json().pages[0].processedImageUrl).toContain("memory://spendlens-documents/");

    const audit = await app.inject({
      method: "GET",
      url: `/admin/audit?action=document.preprocessing_artifacts.persisted&resourceType=DocumentFile&limit=10`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: documentId,
          correlationId: "corr-preprocess-1",
          metadata: expect.objectContaining({
            workspaceId: "workspace_1",
            profile: "TESSERACT_OPTIMIZED",
            pageCount: 1,
            manifestPresent: true
          })
        })
      ])
    );
    expect(JSON.stringify(audit.json().logs)).not.toContain(body.manifestObjectKey);
  });

  it("searches tenant-scoped documents and latest extraction snippets without exposing other tenants", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary-search-owned")
      },
      payload: multipartBody("boundary-search-owned", "market-spendlens.png", "image/png", pngBytes("search-owned"))
    });
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json().document.id;

    const extraction = await app.inject({
      method: "POST",
      url: `/documents/${documentId}/extraction`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        text: [
          "SPENDLENS MARKET SANDBOX",
          "FIS NO: SEARCH-001",
          "TARIH 10.06.2026",
          "TOPLAM 72,05 TL"
        ].join("\n")
      }
    });
    expect(extraction.statusCode).toBe(200);

    const otherUpload = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: {
        authorization: `Bearer ${otherAccessToken}`,
        ...multipartHeaders("boundary-search-other")
      },
      payload: multipartBody("boundary-search-other", "other-spendlens.png", "image/png", pngBytes("search-other"))
    });
    expect(otherUpload.statusCode).toBe(201);

    const search = await app.inject({
      method: "GET",
      url: "/documents/search?q=spendlens&workspaceId=workspace_1&limit=5",
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-document-search" }
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().queryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(search.json().results).toHaveLength(1);
    expect(search.json().results[0]).toMatchObject({
      document: { id: documentId, originalName: "market-spendlens.png" },
      extraction: {
        documentType: "retail_receipt",
        merchantName: "SPENDLENS MARKET SANDBOX",
        totalMinor: "7205",
        currency: "TRY"
      }
    });
    expect(search.json().results[0].matchSources).toEqual(expect.arrayContaining(["filename", "merchantName"]));
    expect(search.json().results[0].snippets.join(" ")).toContain("SPENDLENS MARKET SANDBOX");

    const otherSearch = await app.inject({
      method: "GET",
      url: "/documents/search?q=spendlens&workspaceId=workspace_1",
      headers: { authorization: `Bearer ${otherAccessToken}` }
    });
    expect(otherSearch.statusCode).toBe(200);
    expect(otherSearch.json().results.map((result: { document: { id: string } }) => result.document.id)).not.toContain(documentId);

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?action=document.search.performed&resourceType=DocumentFile&limit=10",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          correlationId: "corr-document-search",
          metadata: expect.objectContaining({
            mode: "local_lexical",
            resultCount: 1,
            queryHash: search.json().queryHash
          })
        })
      ])
    );
    expect(JSON.stringify(audit.json().logs)).not.toContain("spendlens");
  });

  it("uploads a document through resumable chunks with CRC, pause/resume and final SHA-256 validation", async () => {
    const file = largePngBytes(600_000, "resumable-success");
    const chunkSizeBytes = 256 * 1024;
    const init = await app.inject({
      method: "POST",
      url: "/documents/uploads/init",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        workspaceId: "workspace_1",
        kind: "RECEIPT",
        filename: "large-receipt.png",
        mimeType: "image/png",
        totalSizeBytes: file.byteLength,
        chunkSizeBytes
      }
    });
    expect(init.statusCode).toBe(201);
    const uploadId = init.json().upload.id;
    expect(init.json().missingChunks).toEqual([0, 1, 2]);

    const firstChunk = file.subarray(0, chunkSizeBytes);
    const first = await putChunk(app, accessToken, uploadId, 0, firstChunk);
    expect(first.statusCode).toBe(200);
    expect(first.json().uploadedChunks).toEqual([0]);

    const paused = await app.inject({
      method: "POST",
      url: `/documents/uploads/${uploadId}/pause`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().upload.status).toBe("PAUSED");

    const blockedWhilePaused = await putChunk(app, accessToken, uploadId, 1, file.subarray(chunkSizeBytes, chunkSizeBytes * 2));
    expect(blockedWhilePaused.statusCode).toBe(409);
    expect(blockedWhilePaused.json().error.code).toBe("UPLOAD_PAUSED");

    const resumed = await app.inject({
      method: "POST",
      url: `/documents/uploads/${uploadId}/resume`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().upload.status).toBe("UPLOADING");

    const duplicate = await putChunk(app, accessToken, uploadId, 0, firstChunk);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);

    const badCrc = await app.inject({
      method: "PUT",
      url: `/documents/uploads/${uploadId}/chunks/1`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/octet-stream",
        "x-client-crc32": "00000000"
      },
      payload: file.subarray(chunkSizeBytes, chunkSizeBytes * 2)
    });
    expect(badCrc.statusCode).toBe(422);
    expect(badCrc.json().error.code).toBe("CHUNK_CRC_MISMATCH");

    for (let index = 1; index < 3; index += 1) {
      const start = index * chunkSizeBytes;
      const uploaded = await putChunk(app, accessToken, uploadId, index, file.subarray(start, Math.min(start + chunkSizeBytes, file.byteLength)));
      expect(uploaded.statusCode).toBe(200);
    }

    const status = await app.inject({
      method: "GET",
      url: `/documents/uploads/${uploadId}/status`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().missingChunks).toEqual([]);

    const complete = await app.inject({
      method: "POST",
      url: `/documents/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { sha256: sha256Hex(file) }
    });
    expect(complete.statusCode).toBe(201);
    expect(complete.json().duplicate).toBe(false);
    expect(complete.json().document).toMatchObject({
      originalName: "large-receipt.png",
      mimeType: "image/png",
      sha256: sha256Hex(file)
    });
    expect(complete.json().upload.upload.status).toBe("COMPLETED");

    const list = await app.inject({
      method: "GET",
      url: "/documents?workspaceId=workspace_1",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(list.json().documents.some((document: { id: string }) => document.id === complete.json().document.id)).toBe(true);
  });

  it("keeps resumable upload sessions tenant-scoped and supports DELETE cancel", async () => {
    const file = largePngBytes(300_000, "tenant-isolated-upload");
    const chunkSizeBytes = 256 * 1024;
    const init = await initUpload(app, accessToken, "tenant-owned.png", "image/png", file.byteLength, chunkSizeBytes);
    expect(init.statusCode).toBe(201);
    const uploadId = init.json().upload.id;
    const chunk = await putChunk(app, accessToken, uploadId, 0, file.subarray(0, chunkSizeBytes));
    expect(chunk.statusCode).toBe(200);

    const otherStatus = await app.inject({
      method: "GET",
      url: `/documents/uploads/${uploadId}/status`,
      headers: { authorization: `Bearer ${otherAccessToken}` }
    });
    expect(otherStatus.statusCode).toBe(404);
    expect(otherStatus.json().error.code).toBe("UPLOAD_SESSION_NOT_FOUND");

    const otherChunk = await putChunk(app, otherAccessToken, uploadId, 1, file.subarray(chunkSizeBytes));
    expect(otherChunk.statusCode).toBe(404);
    expect(otherChunk.json().error.code).toBe("UPLOAD_SESSION_NOT_FOUND");

    const otherComplete = await app.inject({
      method: "POST",
      url: `/documents/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${otherAccessToken}` },
      payload: { sha256: sha256Hex(file) }
    });
    expect(otherComplete.statusCode).toBe(404);
    expect(otherComplete.json().error.code).toBe("UPLOAD_SESSION_NOT_FOUND");

    const ownerChunkKey = `tenants/${tenantId}/workspaces/workspace_1/uploads/${uploadId}/chunk-000000.part`;
    const otherChunkKey = `tenants/${otherTenantId}/workspaces/workspace_1/uploads/${uploadId}/chunk-000000.part`;
    expect(documentStorage.hasObject("spendlens-documents", ownerChunkKey)).toBe(true);
    expect(documentStorage.hasObject("spendlens-documents", otherChunkKey)).toBe(false);

    const canceled = await app.inject({
      method: "DELETE",
      url: `/documents/uploads/${uploadId}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().upload.status).toBe("CANCELED");
    expect(documentStorage.hasObject("spendlens-documents", ownerChunkKey)).toBe(false);
  });

  it("rejects incomplete, unsafe or canceled resumable uploads", async () => {
    const file = largePngBytes(300_000, "resumable-incomplete");
    const chunkSizeBytes = 256 * 1024;
    const init = await initUpload(app, accessToken, "incomplete.png", "image/png", file.byteLength, chunkSizeBytes);
    const uploadId = init.json().upload.id;
    await putChunk(app, accessToken, uploadId, 0, file.subarray(0, chunkSizeBytes));

    const incomplete = await app.inject({
      method: "POST",
      url: `/documents/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { sha256: sha256Hex(file) }
    });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error.code).toBe("INCOMPLETE_UPLOAD");

    const unsafe = Buffer.from("%PDF-1.7\nsynthetic", "utf8");
    const unsafeInit = await initUpload(app, accessToken, "unsafe.jpg", "application/octet-stream", unsafe.byteLength, 256 * 1024);
    const unsafeId = unsafeInit.json().upload.id;
    const unsafeChunk = await putChunk(app, accessToken, unsafeId, 0, unsafe);
    expect(unsafeChunk.statusCode).toBe(200);
    const unsafeComplete = await app.inject({
      method: "POST",
      url: `/documents/uploads/${unsafeId}/complete`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { sha256: sha256Hex(unsafe) }
    });
    expect(unsafeComplete.statusCode).toBe(415);
    expect(unsafeComplete.json().error.code).toBe("MIME_SIGNATURE_MISMATCH");

    const cancelFile = largePngBytes(300_000, "resumable-cancel");
    const cancelInit = await initUpload(app, accessToken, "cancel.png", "image/png", cancelFile.byteLength, chunkSizeBytes);
    const cancelId = cancelInit.json().upload.id;
    const cancelChunk = await putChunk(app, accessToken, cancelId, 0, cancelFile.subarray(0, chunkSizeBytes));
    expect(cancelChunk.statusCode).toBe(200);
    const chunkObjectKey = `tenants/${tenantId}/workspaces/workspace_1/uploads/${cancelId}/chunk-000000.part`;
    expect(documentStorage.hasObject("spendlens-documents", chunkObjectKey)).toBe(true);
    const canceled = await app.inject({
      method: "POST",
      url: `/documents/uploads/${cancelId}/cancel`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().upload.status).toBe("CANCELED");
    expect(documentStorage.hasObject("spendlens-documents", chunkObjectKey)).toBe(false);
  });

  it("requires document upload permission", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/documents/upload?workspaceId=workspace_1&kind=RECEIPT",
      headers: multipartHeaders("boundary4"),
      payload: multipartBody("boundary4", "receipt.png", "image/png", pngBytes())
    });
    expect(response.statusCode).toBe(401);
  });

  it("paginates and filters document summaries without crossing tenants", async () => {
    const prefix = "pagination-proof";
    const uploadedIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const boundary = `pagination-${index}`;
      const kind = index % 2 === 0 ? "RECEIPT" : "INVOICE";
      const upload = await app.inject({
        method: "POST",
        url: `/documents/upload?workspaceId=workspace_1&kind=${kind}`,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...multipartHeaders(boundary)
        },
        payload: multipartBody(boundary, `${prefix}-${index}.png`, "image/png", pngBytes("x".repeat(20 + index)))
      });
      expect(upload.statusCode).toBe(201);
      uploadedIds.push(upload.json().document.id);
    }

    const seenIds: string[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ workspaceId: "workspace_1", search: prefix, limit: "3" });
      if (cursor) params.set("cursor", cursor);
      const page = await app.inject({
        method: "GET",
        url: `/documents?${params.toString()}`,
        headers: { authorization: `Bearer ${accessToken}` }
      });
      expect(page.statusCode).toBe(200);
      expect(page.json().documents.length).toBeLessThanOrEqual(3);
      seenIds.push(...page.json().documents.map((document: { id: string }) => document.id));
      cursor = page.json().nextCursor;
    } while (cursor);

    expect(new Set(seenIds)).toEqual(new Set(uploadedIds));
    expect(seenIds).toHaveLength(uploadedIds.length);

    const invoices = await app.inject({
      method: "GET",
      url: `/documents?workspaceId=workspace_1&search=${prefix}&kind=INVOICE&limit=50`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(invoices.statusCode).toBe(200);
    expect(invoices.json().documents).toHaveLength(3);
    expect(invoices.json().documents.every((document: { kind: string }) => document.kind === "INVOICE")).toBe(true);

    const invalidCursor = await app.inject({
      method: "GET",
      url: "/documents?workspaceId=workspace_1&cursor=not-a-cursor",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().error.code).toBe("INVALID_DOCUMENT_CURSOR");

    const ownDocument = await app.inject({
      method: "GET",
      url: `/documents/${uploadedIds[0]}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(ownDocument.statusCode).toBe(200);
    expect(ownDocument.json().document.id).toBe(uploadedIds[0]);

    const otherTenantDocument = await app.inject({
      method: "GET",
      url: `/documents/${uploadedIds[0]}`,
      headers: { authorization: `Bearer ${otherAccessToken}` }
    });
    expect(otherTenantDocument.statusCode).toBe(404);
  });
});

function pngBytes(suffix = ""): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, suffix.length]);
}

function multipartHeaders(boundary: string) {
  return { "content-type": `multipart/form-data; boundary=${boundary}` };
}

function multipartBody(boundary: string, filename: string, mimeType: string | null, content: Buffer): Buffer {
  const headers = [`--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${filename}"`];
  if (mimeType !== null) headers.push(`Content-Type: ${mimeType}`);
  return Buffer.concat([
    Buffer.from([...headers, "", ""].join("\r\n")),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

function jpegBytes(seed = 0): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    seed & 0xff,
    0xff,
    0xd9
  ]);
}

async function initUpload(
  app: FastifyInstance,
  accessToken: string,
  filename: string,
  mimeType: string,
  totalSizeBytes: number,
  chunkSizeBytes: number
) {
  return app.inject({
    method: "POST",
    url: "/documents/uploads/init",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      workspaceId: "workspace_1",
      kind: "RECEIPT",
      filename,
      mimeType,
      totalSizeBytes,
      chunkSizeBytes
    }
  });
}

async function putChunk(app: FastifyInstance, accessToken: string, uploadId: string, chunkIndex: number, content: Buffer) {
  return app.inject({
    method: "PUT",
    url: `/documents/uploads/${uploadId}/chunks/${chunkIndex}`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/octet-stream",
      "x-client-crc32": crc32Hex(content)
    },
    payload: content
  });
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function largePngBytes(size: number, label: string): Buffer {
  const buffer = Buffer.alloc(size, 0x20);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  Buffer.from(label, "utf8").copy(buffer, 16);
  return buffer;
}
