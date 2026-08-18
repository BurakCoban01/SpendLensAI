import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const apiBaseUrl = process.env.SPENDLENS_DEMO_API_BASE_URL ?? "http://localhost:18621";
const fixtureDir = resolve("data/demo-fixtures/demo-fixtures");
const targetDocumentCount = 20;

const auth = await api("/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    tenantSlug: "demo",
    email: "demo.owner@spendlens.local",
    password: "SpendLensDemo!2026"
  })
});
const headers = { authorization: `Bearer ${auth.tokens.accessToken}` };
const workspaceResult = await api("/workspaces", { headers });
const workspace = workspaceResult.workspaces[0];
if (!workspace) throw new Error("Demo çalışma alanı bulunamadı. Önce `pnpm db:seed` çalıştırın.");

const existing = await api(`/documents?workspaceId=${encodeURIComponent(workspace.id)}&limit=50`, { headers });
let documentCount = existing.documents.length;
let uploaded = 0;
let duplicate = 0;

if (documentCount < targetDocumentCount) {
  const filenames = (await readdir(fixtureDir))
    .filter((filename) => [".jpg", ".jpeg", ".png", ".webp", ".pdf"].includes(extname(filename).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, "tr"));
  for (const filename of filenames) {
    if (documentCount >= targetDocumentCount) break;
    const path = resolve(fixtureDir, filename);
    const bytes = await readFile(path);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType(filename) }), filename);
    const result = await api(
      `/documents/upload?workspaceId=${encodeURIComponent(workspace.id)}&kind=${documentKind(filename)}`,
      { method: "POST", headers, body: form }
    );
    if (result.duplicate) duplicate += 1;
    else {
      uploaded += 1;
      documentCount += 1;
    }
  }
}

const exportsResult = await api(`/reports/exports?workspaceId=${encodeURIComponent(workspace.id)}`, { headers });
const existingTypes = new Set(exportsResult.exportJobs.map((job) => job.type));
const month = new Date().toISOString().slice(0, 7);
const reportTypes = ["monthly_expense_report_pdf", "category_breakdown_csv", "approval_evidence_csv"];
let generatedReports = 0;
for (const type of reportTypes) {
  if (existingTypes.has(type)) continue;
  await api("/reports/exports", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace.id, type, month })
  });
  generatedReports += 1;
}

const completedJobs = await api("/admin/jobs?status=SUCCEEDED&limit=200", { headers });
const hasCompletedOcr = completedJobs.jobs.some((job) => ["ocr.tesseract", "ocr.custom_crnn"].includes(job.jobType));
const hasCompletedExtraction = completedJobs.jobs.some((job) => job.jobType === "extraction.from_text");
let demoPipeline = "reused";

if (!hasCompletedOcr || !hasCompletedExtraction) {
  const documentsResult = await api(`/documents?workspaceId=${encodeURIComponent(workspace.id)}&limit=50`, { headers });
  const receipt = documentsResult.documents.find(
    (document) => document.kind === "RECEIPT" && document.mimeType.startsWith("image/")
  );
  if (!receipt) throw new Error("Demo OCR akışı için işlenebilir sentetik fiş bulunamadı.");

  await api(`/admin/operations/documents/${encodeURIComponent(receipt.id)}/reprocess`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      stages: ["preprocess", "tesseract"],
      preprocessingProfile: "TESSERACT_OPTIMIZED",
      language: "tur+eng"
    })
  });
  const pipeline = await api("/admin/jobs/run-document-ocr-pipeline", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      documentFileId: receipt.id,
      drainUntil: "extraction",
      maxSteps: 8,
      stopOnFailure: true,
      workerId: "demo-bootstrap-worker"
    })
  });
  if (!pipeline.rawOcrAvailable || !pipeline.extractionAvailable || !pipeline.canProceed) {
    throw new Error(`Demo OCR akışı tamamlanamadı: ${pipeline.failureReason ?? pipeline.skippedReason ?? "UNKNOWN_PIPELINE_ERROR"}`);
  }
  demoPipeline = "created";
}

console.log(
  JSON.stringify(
    {
      tenant: "demo",
      workspace: workspace.name,
      email: "demo.owner@spendlens.local",
      password: "SpendLensDemo!2026",
      documentCount,
      uploaded,
      duplicate,
      generatedReports,
      demoPipeline
    },
    null,
    2
  )
);

async function api(path, init = {}) {
  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, init);
  } catch (error) {
    throw new Error(`Demo API erişilemedi (${apiBaseUrl}). Önce \`pnpm dev\` ile uygulamayı başlatın.`, { cause: error });
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} başarısız: ${body?.error?.code ?? response.status}`);
  }
  return body;
}

function documentKind(filename) {
  if (/fatura/i.test(filename)) return "INVOICE";
  if (/dekont/i.test(filename)) return "OTHER";
  return "RECEIPT";
}

function mimeType(filename) {
  const extension = extname(filename).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}
