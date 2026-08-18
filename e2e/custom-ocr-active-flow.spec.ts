import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test.skip(process.env.SPENDLENS_CUSTOM_OCR_ACCEPTANCE !== "1", "Set SPENDLENS_CUSTOM_OCR_ACCEPTANCE=1 after running the local Custom OCR bootstrap.");
test.skip(!process.env.OCR_SERVICE_URL, "OCR service is required for the live Custom OCR acceptance flow.");

test("logged-in demo user sees Custom OCR real-fixture success or an explicit blocked state", async ({ page, request }) => {
  test.setTimeout(420_000);

  const apiPort = process.env.SPENDLENS_E2E_API_PORT ?? "4100";
  const apiBaseUrl = process.env.SPENDLENS_E2E_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;
  await expect.poll(async () => (await request.get(`${apiBaseUrl}/health/ready`)).status(), { timeout: 60_000 }).toBe(200);

  const suffix = Date.now().toString(36);
  const login = await request.post(`${apiBaseUrl}/auth/login`, {
    data: {
      tenantSlug: "demo",
      email: "demo.owner@spendlens.local",
      password: "SpendLensDemo!2026"
    }
  });
  expect(login.status()).toBe(200);
  const authSession = await login.json();
  await page.addInitScript((session) => {
    window.localStorage.setItem("spendlens.auth", JSON.stringify(session));
  }, authSession);

  const fileName = `custom-ocr-${suffix}.jpg`;
  const fixturePath = join(process.cwd(), "docs", "KullanilanDokumanlar", "tr", "valid-fis-01.jpg");

  await page.goto("/documents/upload?lang=tr&theme=dark");
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "image/jpeg",
    buffer: uniqueJpegBuffer(fixturePath, suffix)
  });
  await page.getByRole("button", { name: /Upload document|Belgeyi yükle/ }).click();
  await expect(page.locator("body")).toContainText(
    new RegExp(`((Uploaded|Yüklendi) - ${escapeRegExp(fileName)})|(Aynı belge zaten kayıtlı|already registered)`),
    { timeout: 30_000 }
  );

  const uploadedRow = page.getByText(fileName, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'md:grid-cols')][1]");
  const ocrHref = await uploadedRow.getByRole("link", { name: /Review OCR|OCR incele/ }).getAttribute("href");
  expect(ocrHref).toBeTruthy();
  const documentId = new URL(ocrHref!, page.url()).searchParams.get("documentId");
  expect(documentId).toBeTruthy();
  await page.goto(ocrHref!);
  await expect(page.getByRole("heading", { name: /OCR workspace|OCR çalışma alanı/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel(/Belge|Document/).locator("option:checked")).toHaveText(fileName, { timeout: 30_000 });

  await page.getByLabel(/OCR motoru|OCR engine/).selectOption("CUSTOM_CRNN");
  await expect(page.locator("body")).toContainText(/Aktif Custom OCR modeli|Active Custom OCR model|Aktif Custom OCR modeli yok|No active Custom OCR model is registered/, {
    timeout: 30_000
  });
  await expect(page.getByText(/Aktif Custom OCR modeli yok|No active Custom OCR model is registered/)).toHaveCount(0);
  await waitForOcrServiceReady(request, apiBaseUrl, authSession.tokens.accessToken);
  await page.reload();
  await expect(page.getByLabel(/Belge|Document/).locator("option:checked")).toHaveText(fileName, { timeout: 30_000 });
  await page.getByLabel(/OCR motoru|OCR engine/).selectOption("CUSTOM_CRNN");
  await expect(page.getByText(/Aktif Custom OCR modeli yok|No active Custom OCR model is registered/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /OCR başlat|Start OCR/ })).toBeEnabled({ timeout: 30_000 });

  await page.getByRole("button", { name: /OCR başlat|Start OCR/ }).click();
  await expect(page.locator("body")).toContainText(
    /Seçili motor: Custom OCR|Selected engine: Custom OCR|Custom OCR kuyruğa alındı|Custom OCR was queued|Custom OCR sonucu hazır|Custom OCR result is ready|OCR ve çıkarım sonucu hazır|OCR and extraction are ready/,
    { timeout: 30_000 }
  );

  await runWorkerUntilCustomOcrSucceeds(page, request, apiBaseUrl, authSession.tokens.accessToken, documentId!);
  const persistedRun = await successfulCustomOcrRun(request, apiBaseUrl, authSession.tokens.accessToken, documentId!);
  expect(persistedRun).not.toBeNull();
  const normalizedText = persistedRun!.normalizedJson?.metadata?.normalizedText ?? "";
  const normalizedSnippetRecall = ["SPENDLENS MARKET", "FİŞ NO", "TARİH", "GENEL TOPLAM", "72,05", "ÖDEME", "TRY"].filter(
    (snippet) => normalizedText.toLocaleUpperCase("tr-TR").includes(snippet)
  ).length;
  expect(normalizedSnippetRecall).toBeGreaterThanOrEqual(6);
  expect(normalizedText).toContain("ÜRÜN KDV TUTAR");
  expect(normalizedText).toContain("SÜT %10 32,50 TL");
  expect(persistedRun!.normalizedJson?.metadata?.quality?.pipelineBundle?.pipelineVersion).toMatch(/^custom-ocr-pipeline-v\d+/);
  expect(persistedRun!.normalizedJson?.metadata?.quality?.pipelineBundle?.pairwiseRouter).toBeTruthy();
  await page.reload();
  await expect(page.getByLabel(/Belge|Document/).locator("option:checked")).toHaveText(fileName, { timeout: 30_000 });
  await page.getByLabel(/OCR motoru|OCR engine/).selectOption("CUSTOM_CRNN");

  await expect
    .poll(() => extractionForDocument(request, apiBaseUrl, authSession.tokens.accessToken, documentId!), {
      timeout: 120_000,
      intervals: [2_000, 4_000, 8_000]
    })
    .toMatchObject({
      extracted: {
        merchantName: "SPENDLENS MARKET SANDBOX",
        date: "2026-06-02",
        currency: "TRY",
        total: { amountMinor: "7205", currency: "TRY" }
      }
    });

  await expect(page.getByRole("heading", { name: /Ham OCR metni|Raw OCR text/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("body")).toContainText(/Seçilen motor\s*CUSTOM_CRNN|Selected engine\s*CUSTOM_CRNN/i);
  await expect(page.getByRole("heading", { name: /OCR geçmişi|OCR history/ })).toBeVisible();
  await expect(page.getByText("CUSTOM_CRNN", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/CUSTOM_OCR_ACTIVE_MODEL_NOT_FOUND|CUSTOM_OCR_MODEL_ARTIFACT_UNAVAILABLE/);

  const bodyText = await page.locator("body").innerText();
  const snippetRecall = ["SPENDLENS", "MARKET", "TOPLAM", "64,50", "TRY"].filter((snippet) =>
    bodyText.toLocaleUpperCase("tr-TR").includes(snippet)
  ).length;
  if (snippetRecall < 3) {
    await expect(page.locator("body")).toContainText(
      /düşük güven|low confidence|inceleme|review|CUSTOM_OCR_LOW_REAL_DOCUMENT_CONFIDENCE|GARBAGE_OCR_TEXT|otomatik çıkarım\/gider oluşturulamaz/i
    );
    await expect(page.getByRole("button", { name: /Gider oluştur|Create expense/ })).toBeDisabled();
  }

  await page.goto(`/review?lang=tr&theme=dark&documentId=${encodeURIComponent(documentId!)}`);
  await page.getByText(/Gelişmiş belge ve etiketleme araçlarını aç|Open advanced document and annotation tools/).click();
  await expect(page.getByRole("heading", { name: /OCR inceleme karşılaştırması|OCR review comparison/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("CUSTOM_CRNN", { exact: true }).first()).toBeVisible();
});

async function runWorkerUntilCustomOcrSucceeds(
  page: Page,
  request: APIRequestContext,
  apiBaseUrl: string,
  accessToken: string,
  documentId: string
): Promise<void> {
  const workerButton = page.getByRole("button", { name: /Worker çalıştır|Run Worker/ }).first();
  if ((await workerButton.count()) > 0 && (await workerButton.isEnabled().catch(() => false))) {
    await workerButton.click({ timeout: 180_000 });
  }
  await expect
    .poll(() => hasSucceededCustomOcrRun(request, apiBaseUrl, accessToken, documentId), {
      timeout: 240_000,
      intervals: [2_000, 4_000, 8_000]
    })
    .toBe(true);
}

async function hasSucceededCustomOcrRun(
  request: APIRequestContext,
  apiBaseUrl: string,
  accessToken: string,
  documentId: string
): Promise<boolean> {
  return Boolean(await successfulCustomOcrRun(request, apiBaseUrl, accessToken, documentId));
}

async function successfulCustomOcrRun(
  request: APIRequestContext,
  apiBaseUrl: string,
  accessToken: string,
  documentId: string
): Promise<{
  engine?: string;
  status?: string;
  normalizedJson?: {
    metadata?: {
      normalizedText?: string;
      quality?: { pipelineBundle?: { pipelineVersion?: string; pairwiseRouter?: string } };
    };
  };
} | null> {
  const response = await request.get(`${apiBaseUrl}/documents/${encodeURIComponent(documentId)}/ocr-runs`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (response.status() !== 200) return null;
  const payload = (await response.json()) as {
    jobs?: Array<{
      runs?: Array<{
        engine?: string;
        status?: string;
        normalizedJson?: {
          metadata?: {
            normalizedText?: string;
            quality?: { pipelineBundle?: { pipelineVersion?: string; pairwiseRouter?: string } };
          };
        };
      }>;
    }>;
  };
  return payload.jobs?.flatMap((job) => job.runs ?? []).find((run) => run.engine === "CUSTOM_CRNN" && run.status === "SUCCEEDED") ?? null;
}

async function waitForOcrServiceReady(
  request: APIRequestContext,
  apiBaseUrl: string,
  accessToken: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${apiBaseUrl}/admin/health`, {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        if (response.status() !== 200) return "unavailable";
        const payload = (await response.json()) as { checks?: { ocrService?: { status?: string } } };
        return payload.checks?.ocrService?.status ?? "unknown";
      },
      { timeout: 120_000, intervals: [2_000, 4_000, 8_000] }
    )
    .toBe("ok");
}

async function extractionForDocument(
  request: APIRequestContext,
  apiBaseUrl: string,
  accessToken: string,
  documentId: string
): Promise<{
  extracted: {
    merchantName?: string | null;
    date?: string | null;
    currency?: string | null;
    total?: { amountMinor?: string; currency?: string } | null;
    lineItems?: Array<{ name?: string; total?: { amountMinor?: string; currency?: string } }>;
  };
} | null> {
  const response = await request.get(`${apiBaseUrl}/documents/${encodeURIComponent(documentId)}/extraction`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (response.status() === 404) return null;
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    extracted: {
      merchantName?: string | null;
      date?: string | null;
      currency?: string | null;
      total?: { amountMinor?: string; currency?: string } | null;
      lineItems?: Array<{ name?: string; total?: { amountMinor?: string; currency?: string } }>;
    };
  };
  expect(payload.extracted.lineItems?.map((item) => item.name)).toEqual(["EKMEK", "SÜT", "KAHVE"]);
  expect(payload.extracted.lineItems?.map((item) => item.total?.amountMinor)).toEqual(["2000", "3250", "1200"]);
  return payload;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueJpegBuffer(path: string, suffix: string): Buffer {
  const original = readFileSync(path);
  const comment = Buffer.from(`SpendLens Custom OCR acceptance ${suffix}`, "utf8");
  const segment = Buffer.alloc(comment.length + 4);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  segment.writeUInt16BE(comment.length + 2, 2);
  comment.copy(segment, 4);
  return Buffer.concat([original.subarray(0, 2), segment, original.subarray(2)]);
}
