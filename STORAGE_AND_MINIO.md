# Storage And MinIO

MinIO stores:

- original receipt, invoice and PDF files
- processed image derivatives
- OCR artifacts
- model artifacts
- exported reports and datasets

Object keys must be tenant-scoped and derived from safe generated IDs, not raw user filenames.

## Implemented Document Storage Flow

The API document module stores original uploads with object keys shaped as:

```text
tenants/{tenantId}/workspaces/{workspaceId}/documents/{generatedDocumentId}/{safeFilename}
```

Upload handling currently includes:

- supported MIME allow-list: JPEG, PNG, WebP, TIFF and PDF
- binary signature verification for each supported format
- safe filename normalization and traversal segment removal
- SHA-256 duplicate detection per tenant
- tenant-scoped workspace existence checks
- `DocumentFile` metadata persistence
- receipt/invoice document row creation based on selected kind
- audit log writes for upload and delete
- signed read URL generation through MinIO presigned URLs
- soft deletion of document metadata

The test suite uses `InMemoryDocumentStorage` behind the same `DocumentStorage` contract. Local runtime verification against real MinIO is still pending until Docker Compose is healthy again.
