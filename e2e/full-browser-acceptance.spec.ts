import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

const expiredSessionPayload = {
  tokens: { accessToken: "expired-token", refreshToken: "expired-refresh" },
  tenant: { id: "tenant", name: "Expired Tenant", slug: "expired" },
  user: { id: "user", email: "expired@example.com", displayName: "Expired User" }
};

test.skip(!process.env.OCR_SERVICE_URL, "OCR service is required for the full browser OCR acceptance flow.");

test("full browser acceptance covers primary pages, session refresh and truthful OCR expense flows", async ({ page }) => {
  test.setTimeout(600_000);

  const suffix = Date.now().toString(36);
  await page.goto("/register?lang=tr&theme=dark");
  await page.getByLabel(/Çalışma alanı adı|Workspace name/).fill(`Full Browser ${suffix}`);
  await page.getByLabel(/Çalışma alanı kısa adı|Workspace slug/).fill(`full-browser-${suffix}`);
  await page.getByRole("textbox", { name: "Çalışma alanı", exact: true }).fill("Finans");
  await page.getByLabel(/Görünen ad|Display name/).fill("Full Browser Owner");
  await page.getByLabel(/E-posta|Email/).fill(`full-browser-${suffix}@example.com`);
  await page.getByLabel(/Parola|Password/).fill("very-secure-password");
  await page.getByRole("button", { name: /Çalışma alanı oluştur|Create workspace/ }).click();
  await expect(page).toHaveURL(/\/dashboard(\?.*)?$/, { timeout: 60_000 });

  await verifySessionRefreshRecovery(page);
  await smokePrimaryPages(page);
  await verifySettingsAiAutomation(page, suffix);
  await smokeMobileDashboard(page);
  await verifyCategoryTraining(page, suffix);
  await verifyStandardReceiptOcrFlow(page);
  await verifyBankTransferOcrFlow(page);
  await verifyPaymentProofGating(page);
  await verifyInvoiceLikeReviewExtraction(page);
});

for (const route of ["/dashboard?lang=tr", "/documents/upload?lang=tr", "/models?lang=tr", "/admin/health?lang=tr"]) {
  test(`expired session recovery exposes sign-in actions on ${route}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript((session) => {
      window.localStorage.setItem("spendlens.auth", JSON.stringify(session));
    }, expiredSessionPayload);
    await page.goto(route);
    await expect(page.getByRole("link", { name: /Giriş yap|Sign in/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("link", { name: /Kayıt ol|Register/ })).toBeVisible();
  });
}

async function smokePrimaryPages(page: Page): Promise<void> {
  const routes = [
    "/?lang=tr&theme=dark",
    "/register?lang=tr&theme=dark",
    "/login?lang=tr&theme=dark",
    "/dashboard?lang=tr&theme=dark",
    "/documents/upload?lang=tr&theme=dark",
    "/documents/ocr?lang=tr&theme=dark",
    "/review?lang=tr&theme=dark",
    "/expenses?lang=tr&theme=dark",
    "/approvals?lang=tr&theme=dark",
    "/budgets?lang=tr&theme=dark",
    "/reports?lang=tr&theme=dark",
    "/models?lang=tr&theme=dark",
    "/settings?lang=tr&theme=dark",
    "/admin/health?lang=tr&theme=dark",
    "/admin/jobs?lang=tr&theme=dark",
    "/admin/events?lang=tr&theme=dark",
    "/admin/cache?lang=tr&theme=dark",
    "/admin/audit?lang=tr&theme=dark"
  ];

  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("main")).not.toContainText(/yükleniyor|\bloading\b/i, { timeout: 60_000 });
    await expect(page.locator("body")).not.toContainText(new RegExp("Session error|Oturum hatası|TensorFlow|Keras|\\u00c3|\\u00c2|\\u00e2\\u20ac|\\ufffd", "i"));
  }
}

async function verifySessionRefreshRecovery(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem("spendlens.auth");
    if (!raw) throw new Error("Missing stored session");
    const session = JSON.parse(raw) as {
      tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number };
      tokenExpiresAt?: number;
    };
    session.tokens.accessToken = "expired-access-token-for-refresh-retry";
    session.tokenExpiresAt = Date.now() + 10 * 60 * 1000;
    window.localStorage.setItem("spendlens.auth", JSON.stringify(session));
  });
  await page.goto("/dashboard?lang=tr&theme=dark");
  await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem("spendlens.auth");
        return raw ? (JSON.parse(raw) as { tokens: { accessToken: string } }).tokens.accessToken : "";
      }),
      { timeout: 60_000 }
    )
    .not.toBe("expired-access-token-for-refresh-retry");
  await expect(page.locator("body")).not.toContainText(/Oturum hatası|Session error|Giriş yap|Sign in/);
}

async function verifySettingsAiAutomation(page: Page, suffix: string): Promise<void> {
  await page.goto("/settings?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: /Ayarlar|Settings/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).toContainText(/AI ve otomasyon|AI and automation/, { timeout: 30_000 });
  await expect(page.locator("body")).toContainText(/Harici LLM kapalı|External LLM is off/);
  await expect(page.locator("body")).toContainText(/Webhook otomasyonu|Webhook automation/);
  await page.getByLabel(/Webhook URL/).fill(`https://example.test/spendlens-${suffix}`);
  await page.getByLabel(/Olaylar|Events/).fill("expense.created");
  await page.getByRole("button", { name: /Webhook oluştur|Create webhook/ }).click();
  await expect(page.locator("body")).toContainText(/Tek seferlik webhook sırrı|One-time webhook secret/, { timeout: 30_000 });
  await expect(page.locator("body")).toContainText(/HMAC SHA-256/);
}

async function smokeMobileDashboard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard?lang=tr&theme=dark");
  await expect(page.locator("main")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(4);
  await page.setViewportSize({ width: 1366, height: 900 });
}

async function verifyCategoryTraining(page: Page, suffix: string): Promise<void> {
  await page.goto("/models?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: /Models/ })).toBeVisible();
  await expect(page.getByText(/TensorFlow|Keras/)).toHaveCount(0);
  await page.getByText("Open training tools", { exact: true }).click();
  const seed = String(100 + (Number.parseInt(suffix.slice(-2), 36) % 800));
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Start category training" }) }).first();
  await form.getByLabel("Category seed").fill(seed);
  await form.getByLabel("Samples per category").fill("4");
  await form.getByRole("button", { name: "Start category training" }).click();
  await page.getByText("Open advanced model records", { exact: true }).click();
  await expect(page.getByText(`category-ml-v1-seed-${seed}`).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("body")).not.toContainText(/Category training failed|TensorFlow|Keras/i);
  await expect(page.getByText(/SUCCEEDED|Succeeded|Tamamlandı/).first()).toBeVisible();
}

async function verifyStandardReceiptOcrFlow(page: Page): Promise<void> {
  const fixturePath = join(process.cwd(), "docs", "KullanilanDokumanlar", "tr", "valid-fis-01.jpg");
  await uploadAndOpenOcr(page, fixturePath, "valid-fis-01.jpg");
  await runOcrUntilText(page, /SPENDLENS|FİŞ NO|FIS NO|GENEL TOPLAM|TOPLAM/);

  await ensureExtractionVisible(page);
  await expect(page.locator("body")).toContainText(/Fiş \/ market belgesi|Perakende fişi|Retail receipt|retail_receipt/);
  await expect(page.locator("body")).not.toContainText(/Bilinmeyen belge|Unknown document/);
  await expect(page.locator("body")).toContainText(/SPENDLENS MARKET/);
  await expect(page.locator("body")).toContainText("64,50 TRY");
  await expect(page.locator("body")).toContainText("72,05 TRY");
  await expect(page.locator("body")).not.toContainText("LINE_TOTAL_MISMATCH");

  await page.getByRole("button", { name: /Gider oluştur|Create expense/ }).click();
  await expect(page.getByText(/Gider taslağı oluşturuldu|Gider oluşturuldu|Expense created/).first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await waitForOcrWorkspaceReload(page);
  await expect(page.getByRole("button", { name: /Gider hazır|Expense ready/ })).toBeDisabled({ timeout: 30_000 });
  await expect(page.locator("body")).toContainText(/Gider oluşturuldu|Expense created/);
  await page.goto("/expenses?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: /Giderler|Expenses/ })).toBeVisible();
  await expect(page.locator("body")).toContainText(/OCR belgesi|OCR document/);
}

async function verifyBankTransferOcrFlow(page: Page): Promise<void> {
  const fixturePath = join(process.cwd(), "docs", "KullanilanDokumanlar", "zb_ornek_receipt.webp");
  await uploadAndOpenOcr(page, fixturePath, "zb_ornek_receipt.webp");
  await runOcrUntilText(page, /FAST|Ziraat|Tutar|Dekont|04042023/);

  await ensureExtractionVisible(page);
  await expect(page.locator("body")).toContainText(/Banka işlem dekontu|Bank transfer receipt/);
  await expect(page.locator("body")).toContainText("640,00 TRY");
  await expect(page.locator("body")).not.toContainText("4042023,22 TRY");
  await expect(page.getByRole("button", { name: /^Gider oluştur$|^Create expense$/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Onayla ve gider taslağı oluştur/ })).toBeVisible();

  await page.getByRole("button", { name: /Onayla ve gider taslağı oluştur/ }).click();
  await expect(page.getByText(/Gider oluşturuldu: .*640,00 TRY|Expense created: .*640,00 TRY/)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await waitForOcrWorkspaceReload(page);
  await expect(page.getByRole("button", { name: /Gider hazır|Expense ready/ })).toBeDisabled({ timeout: 30_000 });
  await expect(page.locator("body")).toContainText(/Geçmiş \/ tekrar eden işler|OCR, çıkarım ve gider oluşturma akışı/);
}

async function verifyPaymentProofGating(page: Page): Promise<void> {
  const fixturePath = join(process.cwd(), "docs", "KullanilanDokumanlar", "vb_ornek_receipt.webp");
  await uploadAndOpenOcr(page, fixturePath, "vb_ornek_receipt.webp");
  await runOcrUntilText(page, /Vakif|Vakıf|KARE|ODEME|İSLEM|ISLEM|Dekont/);

  await ensureExtractionVisible(page);
  await expect(page.locator("body")).toContainText(/Ödeme kanıtı|Payment proof|Destekleyici belge|Gider oluşturulamaz/);
  await expect(page.locator("body")).not.toContainText(/20210600488120604,00 TRY|20210004811120604,00 TRY/);
  const pageText = await page.locator("body").innerText();
  const currentWorkerJobs =
    pageText
      .split(/Belgeye ba\u011fl\u0131 Worker i\u015fleri|Document worker jobs/)[1]
      ?.split(/Ge\u00e7mi\u015f \/ tekrar eden i\u015fler|Historical \/ repeated jobs/)[0] ?? pageText;
  expect(currentWorkerJobs).not.toMatch(/extraction\.from_text\s*(Kuyrukta|Queued)\s*0%/);
  expect(pageText).not.toMatch(/extraction\.from_text[\s\S]{0,160}(Kuyrukta|Queued)[\s\S]{0,80}0%/);
  expect(pageText).toMatch(/extraction\.from_text[\s\S]{0,160}(Tamamlandı|Succeeded)[\s\S]{0,80}100%/);
  await expect(page.getByRole("button", { name: /^Gider oluştur$|^Create expense$/ })).toBeDisabled();
}

async function verifyInvoiceLikeReviewExtraction(page: Page): Promise<void> {
  await page.goto("/review?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: /İnceleme|Review/ })).toBeVisible({ timeout: 30_000 });
  await page.getByText(/Gelişmiş belge ve etiketleme araçlarını aç|Open advanced document and annotation tools/, { exact: true }).click();
  await page
    .getByLabel(/Çıkarım için OCR metni|OCR text for extraction/)
    .fill(
      [
        "dg ÖRNEK FATURA",
        "Seri-Sira No A4",
        "Aydin V.D. Tarih 05/21/2026",
        "Cinsi Miktarı Fiyatı(t) Tutari(t)",
        "| Uriin1 1 50 50",
        "| Ürün2 | 4 | 100 | 400 |",
        "Ürün3 2 80 160 .",
        "Toplam #610",
        "Genel Toplam %610"
      ].join("\n")
    );
  await page.getByRole("button", { name: /Çıkarım çalıştır|Run extraction/ }).click();
  await expect(page.locator("body")).toContainText(/Fatura|FATURA|Invoice|invoice/, { timeout: 30_000 });
  await expect(page.locator("body")).toContainText("2026-05-21");
  await expect(page.locator("body")).toContainText("610,00 TRY");
  await expect(page.locator("body")).toContainText(/İnceleme|review/i);
}

async function uploadAndOpenOcr(page: Page, fixturePath: string, fileName: string): Promise<void> {
  await page.goto("/documents/upload?lang=tr&theme=dark");
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await page.getByRole("button", { name: /Belgeyi yükle|Upload document/ }).click();
  await expect(page.getByText(new RegExp(`(Yüklendi|Uploaded) - ${escapeRegExp(fileName)}`))).toBeVisible({ timeout: 120_000 });
  const uploadedRow = page.getByText(fileName, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'md:grid-cols')][1]");
  await uploadedRow.getByRole("link", { name: /OCR incele|Review OCR/ }).click();
  await expect(page.getByRole("heading", { name: /OCR çalışma alanı|OCR workspace/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel(/Belge|Document/).locator("option:checked")).toHaveText(fileName, { timeout: 30_000 });
}

async function runOcrUntilText(page: Page, expectedText: RegExp): Promise<void> {
  const startButton = page.getByRole("button", { name: /OCR başlat|Start OCR/ });
  if (await startButton.isEnabled().catch(() => false)) {
    await startButton.click();
    await expect(page.getByText(/Seçili motor: Tesseract OCR|Selected engine: Tesseract OCR|Tesseract OCR kuyruğa alındı/)).toBeVisible({
      timeout: 30_000
    });
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await page.getByRole("heading", { name: /Ham OCR metni|Raw OCR text/ }).isVisible().catch(() => false)) break;
    if (await page.locator("body").getByText(expectedText).first().isVisible().catch(() => false)) break;
    const workerButton = page.getByRole("button", { name: /Worker çalıştır:|Run Worker:/ }).first();
    if ((await workerButton.count()) > 0 && (await workerButton.isEnabled().catch(() => false))) {
      await workerButton.click({ timeout: 10_000 });
    }
    await page.waitForTimeout(3000);
  }
  await expect(page.getByRole("heading", { name: /Ham OCR metni|Raw OCR text/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("body")).toContainText(expectedText, { timeout: 120_000 });
}

async function ensureExtractionVisible(page: Page): Promise<void> {
  const createExtraction = page.getByRole("button", { name: /Çıkarım oluştur|Create extraction/ });
  if ((await createExtraction.count()) > 0 && (await createExtraction.isEnabled())) await createExtraction.click();
  await expect(page.getByRole("heading", { name: /Çıkarım sonucu|Extraction result/ })).toBeVisible({ timeout: 30_000 });
}

async function waitForOcrWorkspaceReload(page: Page): Promise<void> {
  await expect(page.getByText(/Belge ve OCR sonuçları yükleniyor|Documents and OCR results are loading/)).toHaveCount(0, {
    timeout: 30_000
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
