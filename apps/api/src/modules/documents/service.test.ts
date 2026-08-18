import { describe, expect, it } from "vitest";
import type { AuthPrincipal } from "../auth/types";
import { InMemoryCacheStore } from "../cache/memory-store";
import { CacheService } from "../cache/service";
import { InMemoryDocumentRepository } from "./memory-repository";
import { DocumentError, DocumentService, duplicateUploadCacheKey } from "./service";
import { InMemoryDocumentStorage } from "./storage";

const principal: AuthPrincipal = {
  tenantId: "tenant_1",
  userId: "user_1",
  sessionId: "session_1",
  email: "owner@example.com",
  displayName: "Owner",
  roles: ["OWNER"],
  permissions: ["documents.upload", "documents.read", "documents.delete"]
};

describe("DocumentService", () => {
  it("stores validated uploads with safe metadata and detects duplicates by hash", async () => {
    const repository = new InMemoryDocumentRepository();
    repository.addWorkspace(principal.tenantId, "workspace_1");
    const storage = new InMemoryDocumentStorage();
    const service = new DocumentService({ repository, storage, bucket: "documents" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    const first = await service.upload({
      principal,
      workspaceId: "workspace_1",
      kind: "RECEIPT",
      originalName: "../../Receipt 001.PNG",
      mimeType: "image/png",
      buffer: png
    });

    expect(first.duplicate).toBe(false);
    expect(first.document.safeName).toBe("receipt-001.png");
    expect(first.document.sha256).toMatch(/^[a-f0-9]{64}$/);

    const duplicate = await service.upload({
      principal,
      workspaceId: "workspace_1",
      kind: "RECEIPT",
      originalName: "copy.png",
      mimeType: "image/png",
      buffer: png
    });

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.document.id).toBe(first.document.id);
  });

  it("uses cache as a best-effort duplicate upload quick check while confirming repository state", async () => {
    const repository = new CountingDocumentRepository();
    repository.addWorkspace(principal.tenantId, "workspace_1");
    const cacheStore = new InMemoryCacheStore();
    const service = new DocumentService({
      repository,
      storage: new InMemoryDocumentStorage(),
      bucket: "documents",
      cache: new CacheService(cacheStore)
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

    const first = await service.upload({
      principal,
      workspaceId: "workspace_1",
      kind: "RECEIPT",
      originalName: "receipt-cache.png",
      mimeType: "image/png",
      buffer: png
    });
    expect(repository.findBySha256Calls).toBe(1);

    const duplicate = await service.upload({
      principal,
      workspaceId: "workspace_1",
      kind: "RECEIPT",
      originalName: "receipt-cache-copy.png",
      mimeType: "image/png",
      buffer: png
    });

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.document.id).toBe(first.document.id);
    expect(repository.findBySha256Calls).toBe(1);
    expect(repository.findByIdCalls).toBe(1);
    await expect(cacheStore.getJson(duplicateUploadCacheKey(principal.tenantId, first.document.sha256))).resolves.toMatchObject({
      documentFileId: first.document.id,
      sha256: first.document.sha256
    });
  });

  it("rejects MIME claims that do not match file signatures", async () => {
    const service = new DocumentService({
      repository: seededRepository(),
      storage: new InMemoryDocumentStorage(),
      bucket: "documents"
    });

    await expect(
      service.upload({
        principal,
        workspaceId: "workspace_1",
        kind: "INVOICE",
        originalName: "invoice.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      })
    ).rejects.toMatchObject(new DocumentError("MIME_SIGNATURE_MISMATCH", 415));
  });

  it("accepts safe JPEG aliases and canonicalizes stored MIME type", async () => {
    const service = new DocumentService({
      repository: seededRepository(),
      storage: new InMemoryDocumentStorage(),
      bucket: "documents"
    });

    for (const [index, mimeType] of ["image/jpeg", "image/jpg", "image/pjpeg", "image/jpg; charset=binary", "application/octet-stream", ""].entries()) {
      const result = await service.upload({
        principal,
        workspaceId: "workspace_1",
        kind: "RECEIPT",
        originalName: index === 5 ? `receipt-${index}.jpeg` : `receipt-${index}.jpg`,
        mimeType,
        buffer: jpegBytes(index)
      });
      expect(result.document.mimeType).toBe("image/jpeg");
      expect(result.document.safeName.endsWith(index === 5 ? ".jpeg" : ".jpg")).toBe(true);
    }
  });

  it("accepts core safe OCR signatures and stores canonical MIME metadata", async () => {
    const repository = seededRepository();
    const storage = new InMemoryDocumentStorage();
    const service = new DocumentService({
      repository,
      storage,
      bucket: "documents"
    });

    const variants = [
      { name: "receipt.jpg", mimeType: "image/jpeg", expected: "image/jpeg", buffer: jpegBytes(1) },
      { name: "receipt.png", mimeType: "image/png", expected: "image/png", buffer: pngBytes(2) },
      { name: "receipt.webp", mimeType: "image/webp", expected: "image/webp", buffer: webpBytes(3) },
      { name: "receipt.tiff", mimeType: "image/tiff", expected: "image/tiff", buffer: tiffBytes(4) },
      { name: "receipt.bmp", mimeType: "image/x-ms-bmp", expected: "image/bmp", buffer: bmpBytes(5) },
      { name: "receipt.gif", mimeType: "image/gif", expected: "image/gif", buffer: gifBytes(6) },
      { name: "invoice.pdf", mimeType: "application/pdf", expected: "application/pdf", buffer: pdfBytes(7) }
    ];

    for (const variant of variants) {
      const result = await service.upload({
        principal,
        workspaceId: "workspace_1",
        kind: variant.expected === "application/pdf" ? "INVOICE" : "RECEIPT",
        originalName: variant.name,
        mimeType: variant.mimeType,
        buffer: variant.buffer
      });
      const stored = await repository.findById(principal.tenantId, result.document.id);
      expect(result.document.mimeType).toBe(variant.expected);
      expect(stored?.mimeType).toBe(variant.expected);
      expect(storage.readObjectMetadata(stored!.bucket, stored!.objectKey)).toMatchObject({
        "x-amz-meta-client-mime-type": variant.mimeType,
        "x-amz-meta-detected-mime-type": variant.expected,
        "x-amz-meta-canonical-mime-type": variant.expected,
        "x-amz-meta-extension-mismatch": "false"
      });
    }
  });

  it("accepts a mislabeled WebP JPG as WebP and returns a Turkish warning", async () => {
    const repository = seededRepository();
    const storage = new InMemoryDocumentStorage();
    const service = new DocumentService({
      repository,
      storage,
      bucket: "documents"
    });

    const result = await service.upload({
      principal,
      workspaceId: "workspace_1",
      kind: "RECEIPT",
      originalName: "valid-mislabeled-webp-as-jpg.jpg",
      mimeType: "image/jpeg",
      buffer: webpBytes(42)
    });
    const stored = await repository.findById(principal.tenantId, result.document.id);

    expect(result.document.mimeType).toBe("image/webp");
    expect(result.warnings).toEqual([
      {
        code: "EXTENSION_CONTENT_MISMATCH",
        originalExtension: "jpg",
        detectedMimeType: "image/webp",
        message: "Dosya adı .jpg ile bitiyor ancak içeriği WebP. Dosya WebP olarak işlendi."
      }
    ]);
    expect(storage.readObjectMetadata(stored!.bucket, stored!.objectKey)).toMatchObject({
      "x-amz-meta-original-filename": "valid-mislabeled-webp-as-jpg.jpg",
      "x-amz-meta-client-mime-type": "image/jpeg",
      "x-amz-meta-detected-mime-type": "image/webp",
      "x-amz-meta-canonical-mime-type": "image/webp",
      "x-amz-meta-extension-mismatch": "true"
    });
  });

  it("rejects spoofed JPEG filenames when content signature is not JPEG", async () => {
    const service = new DocumentService({
      repository: seededRepository(),
      storage: new InMemoryDocumentStorage(),
      bucket: "documents"
    });

    await expect(
      service.upload({
        principal,
        workspaceId: "workspace_1",
        kind: "RECEIPT",
        originalName: "spoofed.pdf",
        mimeType: "image/jpeg",
        buffer: jpegBytes(99)
      })
    ).rejects.toMatchObject(new DocumentError("MIME_SIGNATURE_MISMATCH", 415));

    await expect(
      service.upload({
        principal,
        workspaceId: "workspace_1",
        kind: "RECEIPT",
        originalName: "spoofed.jpg",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("%PDF-1.7\n%spoof", "utf8")
      })
    ).rejects.toMatchObject(new DocumentError("MIME_SIGNATURE_MISMATCH", 415));
  });

  it("rejects uploads into workspaces outside the tenant scope", async () => {
    const service = new DocumentService({
      repository: new InMemoryDocumentRepository(),
      storage: new InMemoryDocumentStorage(),
      bucket: "documents"
    });

    await expect(
      service.upload({
        principal,
        workspaceId: "missing_workspace",
        kind: "RECEIPT",
        originalName: "receipt.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      })
    ).rejects.toMatchObject(new DocumentError("WORKSPACE_NOT_FOUND", 404));
  });
});

function seededRepository(): InMemoryDocumentRepository {
  const repository = new InMemoryDocumentRepository();
  repository.addWorkspace(principal.tenantId, "workspace_1");
  return repository;
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

function pngBytes(seed = 0): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed & 0xff]);
}

function webpBytes(seed = 0): Buffer {
  return Buffer.from([
    0x52,
    0x49,
    0x46,
    0x46,
    0x0c,
    0x00,
    0x00,
    0x00,
    0x57,
    0x45,
    0x42,
    0x50,
    seed & 0xff
  ]);
}

function tiffBytes(seed = 0): Buffer {
  return Buffer.from([0x49, 0x49, 0x2a, 0x00, seed & 0xff]);
}

function bmpBytes(seed = 0): Buffer {
  return Buffer.from([0x42, 0x4d, seed & 0xff, 0x00]);
}

function gifBytes(seed = 0): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, seed & 0xff]);
}

function pdfBytes(seed = 0): Buffer {
  return Buffer.from(`%PDF-1.7\n%${seed}\n`, "utf8");
}

class CountingDocumentRepository extends InMemoryDocumentRepository {
  findBySha256Calls = 0;
  findByIdCalls = 0;

  override async findBySha256(tenantId: string, sha256: string) {
    this.findBySha256Calls += 1;
    return super.findBySha256(tenantId, sha256);
  }

  override async findById(tenantId: string, documentFileId: string) {
    this.findByIdCalls += 1;
    return super.findById(tenantId, documentFileId);
  }
}
