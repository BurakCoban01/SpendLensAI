import { Client as MinioClient } from "minio";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";

const runLiveDocumentStorageTests =
  process.env.SPENDLENS_LIVE_DOCUMENT_STORAGE_TESTS === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.MINIO_ENDPOINT);
const liveDescribe = runLiveDocumentStorageTests ? describe : describe.skip;

liveDescribe("document routes live MinIO storage", () => {
  const prisma = new PrismaClient();
  const slug = `docs-live-${Date.now()}`;
  const bucket = process.env.MINIO_BUCKET_DOCUMENTS || "spendlens-documents";
  let app: FastifyInstance;
  let tenantId = "";
  let accessToken = "";

  beforeAll(async () => {
    app = await buildApp();
    await prisma.$connect();
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Live Docs Tenant",
        tenantSlug: slug,
        workspaceName: "Finance",
        email: `${slug}@example.com`,
        displayName: "Live Docs Owner",
        password: "very-secure-password"
      }
    });
    expect(register.statusCode).toBe(201);
    const body = register.json();
    tenantId = body.tenant.id;
    accessToken = body.tokens.accessToken;
  });

  afterAll(async () => {
    await removeTenantObjects(bucket, tenantId);
    if (tenantId) {
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.workerJob.deleteMany({ where: { tenantId } });
      await prisma.outboxEvent.deleteMany({ where: { tenantId } });
      await prisma.documentPage.deleteMany({ where: { tenantId } });
      await prisma.documentFile.deleteMany({ where: { tenantId } });
      await prisma.receiptDocument.deleteMany({ where: { tenantId } });
      await prisma.invoiceDocument.deleteMany({ where: { tenantId } });
      await prisma.session.deleteMany({ where: { tenantId } });
      await prisma.aPIKey.deleteMany({ where: { tenantId } });
      await prisma.userRole.deleteMany({ where: { tenantId } });
      await prisma.rolePermission.deleteMany({ where: { tenantId } });
      await prisma.role.deleteMany({ where: { tenantId } });
      await prisma.workspace.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
    await app?.close();
  });

  it("stores, signs, deduplicates and soft-deletes a document through MinIO", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { tenantId, name: "Finance" } });
    const content = pngBytes("live-minio");
    const upload = await app.inject({
      method: "POST",
      url: `/documents/upload?workspaceId=${workspace.id}&kind=RECEIPT`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-correlation-id": "corr-live-document-upload",
        ...multipartHeaders("boundary-live")
      },
      payload: multipartBody("boundary-live", "../../Live Receipt.PNG", "image/png", content)
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json();
    expect(uploaded.document.safeName).toBe("live-receipt.png");
    expect(uploaded.duplicate).toBe(false);

    const row = await prisma.documentFile.findFirstOrThrow({ where: { id: uploaded.document.id, tenantId } });
    expect(row.bucket).toBe(bucket);
    expect(row.objectKey).toMatch(
      new RegExp(`^tenants/${tenantId}/workspaces/${workspace.id}/documents/[0-9a-f-]{36}/live-receipt\\.png$`)
    );
    expect(row.objectKey).not.toContain("..");

    const signed = await app.inject({
      method: "POST",
      url: `/documents/${uploaded.document.id}/download-url?expiresInSeconds=60`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-live-document-download" }
    });
    expect(signed.statusCode).toBe(200);
    const download = await fetch(signed.json().url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(content);

    const duplicate = await app.inject({
      method: "POST",
      url: `/documents/upload?workspaceId=${workspace.id}&kind=RECEIPT`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...multipartHeaders("boundary-live-duplicate")
      },
      payload: multipartBody("boundary-live-duplicate", "duplicate.png", "image/png", content)
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true, document: { id: uploaded.document.id } });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/documents/${uploaded.document.id}`,
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": "corr-live-document-delete" }
    });
    expect(deleted.statusCode).toBe(204);

    const signedAfterDelete = await app.inject({
      method: "POST",
      url: `/documents/${uploaded.document.id}/download-url`,
      headers: { authorization: `Bearer ${accessToken}` }
    });
    expect(signedAfterDelete.statusCode).toBe(404);

    const audit = await prisma.auditLog.findMany({
      where: { tenantId, resourceType: "DocumentFile", resourceId: uploaded.document.id },
      orderBy: { createdAt: "asc" }
    });
    expect(audit.map((log) => log.action)).toEqual(
      expect.arrayContaining(["document.uploaded", "document.download_url.created", "document.deleted"])
    );
    expect(JSON.stringify(audit)).not.toContain(row.objectKey);
    expect(JSON.stringify(audit)).not.toContain(signed.json().url);
  });
});

function pngBytes(suffix = ""): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, suffix.length]);
}

function multipartHeaders(boundary: string) {
  return { "content-type": `multipart/form-data; boundary=${boundary}` };
}

function multipartBody(boundary: string, filename: string, mimeType: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        `Content-Type: ${mimeType}`,
        "",
        ""
      ].join("\r\n")
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

async function removeTenantObjects(bucket: string, tenantId: string): Promise<void> {
  if (!tenantId || !process.env.MINIO_ENDPOINT) return;
  const client = minioClient();
  try {
    if (!(await client.bucketExists(bucket))) return;
    const prefix = `tenants/${tenantId}/`;
    const objects: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = client.listObjects(bucket, prefix, true);
      stream.on("data", (object) => {
        if (object.name) objects.push(object.name);
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    if (objects.length > 0) await client.removeObjects(bucket, objects);
  } catch {
    // Cleanup is best effort; test assertions already prove storage behavior.
  }
}

function minioClient(): MinioClient {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? "http://localhost:19002");
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80,
    useSSL: endpoint.protocol === "https:",
    accessKey: process.env.MINIO_ROOT_USER || "spendlens",
    secretKey: process.env.MINIO_ROOT_PASSWORD || "spendlens_local_minio_password"
  });
}
