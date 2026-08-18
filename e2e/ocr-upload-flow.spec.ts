import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

test.skip(!process.env.OCR_SERVICE_URL, "OCR service is required for the live OCR acceptance flow.");

test("uploads Turkish JPEG, WebP and PDF fixtures, discovers OCR text, and creates an expense from extraction", async ({ page, request }) => {
  test.setTimeout(420_000);

  const suffix = Date.now().toString(36);
  const tenantName = `OCR Tenant ${suffix}`;
  const tenantSlug = `ocr-${suffix}`;
  const workspaceName = "Finance";
  const fixtureDir = join(process.cwd(), "docs", "KullanilanDokumanlar", "tr");
  const jpegFileName = "valid-fis-01.jpg";
  const webpFileName = "valid-fis-02.webp";
  const pdfFileName = "valid-fatura-01.pdf";
  const mislabeledFileName = "valid-mislabeled-webp-as-jpg.jpg";

  const apiPort = process.env.SPENDLENS_E2E_API_PORT ?? "4100";
  const apiBaseUrl = process.env.SPENDLENS_E2E_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;
  await expect
    .poll(async () => (await request.get(`${apiBaseUrl}/health/ready`)).status(), { timeout: 60_000 })
    .toBe(200);
  const register = await request.post(`${apiBaseUrl}/auth/register`, {
    data: {
      tenantName,
      tenantSlug,
      workspaceName,
      email: `ocr-${suffix}@example.com`,
      displayName: "OCR Owner",
      password: "very-secure-password"
    }
  });
  expect(register.status()).toBe(201);
  const authSession = await register.json();
  await page.addInitScript((session) => {
    window.localStorage.setItem("spendlens.auth", JSON.stringify(session));
  }, authSession);
  await page.goto("/dashboard?lang=tr&theme=dark");
  await expect(page).toHaveURL(/\/dashboard(\?.*)?$/, { timeout: 60_000 });

  const uploadLink = page.getByRole("link", { name: /Open document upload|Upload document|Belge yüklemeyi aç|Belge yükle/ }).first();
  await expect(uploadLink).toBeVisible({ timeout: 30_000 });
  await Promise.all([page.waitForURL(/\/documents\/upload(\?.*)?$/, { timeout: 30_000 }), uploadLink.click()]);
  await expect(page.getByRole("heading", { name: /Document intake and upload|Belge kabul ve yükleme/ })).toBeVisible();
  await uploadFixture(page, join(fixtureDir, jpegFileName), jpegFileName);
  await uploadFixture(page, join(fixtureDir, webpFileName), webpFileName);
  await uploadFixture(page, join(fixtureDir, mislabeledFileName), mislabeledFileName);
  await expect(page.getByText("Dosya adı .jpg ile bitiyor ancak içeriği WebP. Dosya WebP olarak işlendi.")).toBeVisible();
  await uploadFixture(page, join(fixtureDir, pdfFileName), pdfFileName);

  const jpegReviewRow = page.getByText(jpegFileName, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'md:grid-cols')][1]");
  await expect(jpegReviewRow.getByRole("link", { name: /Review OCR|OCR incele/ })).toHaveAttribute("href", /documentId=/, { timeout: 30_000 });
  await jpegReviewRow.getByRole("link", { name: /Review OCR|OCR incele/ }).click();
  await expect(documentSelect(page).locator("option:checked")).toHaveText(jpegFileName);
  await expect(page.getByRole("heading", { name: /OCR workspace|OCR çalışma alanı/ })).toBeVisible();
  await runOcrUntilText(page, jpegFileName, /SPENDLENS|FİŞ NO|FIS NO|GENEL TOPLAM|TOPLAM/);
  await expect(page.getByRole("heading", { name: /Raw OCR text|Ham OCR metni/ })).toBeVisible();
  await expect(page.locator("body")).toContainText("SPENDLENS MARKET", { timeout: 120_000 });

  const createExtraction = page.getByRole("button", { name: /Create extraction|Çıkarım oluştur/ });
  if ((await createExtraction.count()) > 0 && (await createExtraction.isEnabled())) await createExtraction.click();
  await expect(page.getByRole("heading", { name: /Extraction result|Çıkarım sonucu/ })).toBeVisible();
  await expect(page.locator("body")).toContainText("64,50 TRY");
  await expect(page.locator("body")).toContainText("72,05 TRY");
  await expect(page.locator("body")).not.toContainText("LINE_TOTAL_MISMATCH");
  await expect(page.getByRole("button", { name: /Extraction ready|Çıkarım hazır/ })).toBeDisabled();
  await expect(page.getByRole("heading", { name: /Normalized OCR text|Normalleştirilmiş OCR metni/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Field source and confidence|Alan kaynağı ve güven skoru/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Run Worker|Worker çalıştır/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Worker complete|Worker tamamlandı/ })).toBeVisible();

  await page.getByRole("button", { name: /Create expense|Gider oluştur/ }).click();
  await expect(page.getByText(/Expense draft created|Gider taslağı oluşturuldu|Expense created|Gider oluşturuldu/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Worker complete|Worker tamamlandı/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /OCR history|OCR geçmişi/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Expense ready|Gider hazır/ })).toBeDisabled();
  await expect(page.locator("body")).toContainText(/Historical \/ repeated jobs|Geçmiş \/ tekrar eden işler|OCR, çıkarım ve gider oluşturma akışı/);
  await expect(page.locator("body")).not.toContainText(/extraction\.from_text\s+Queued\s+0%/i);
  await page.reload();
  await expect(documentSelect(page).locator("option:checked")).toHaveText(jpegFileName);
  await expect(page.getByRole("button", { name: /Worker complete|Worker tamamlandı/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Expense ready|Gider hazır/ })).toBeDisabled();
  await expect(page.locator("body")).toContainText(/Expense created|Gider oluşturuldu/);
  await expect(page.locator("body")).not.toContainText(/extraction\.from_text\s+Queued\s+0%/i);
  await page.goto("/expenses?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: /Expenses|Giderler/ })).toBeVisible();
  await expect(page.locator("body")).toContainText(/OCR document|OCR belgesi/, { timeout: 30_000 });

  await page.goto("/documents/ocr?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: /OCR workspace|OCR çalışma alanı/ })).toBeVisible();
  await runOcrUntilText(page, webpFileName, /SPENDLENS|FİŞ NO|FIS NO|GENEL TOPLAM|TOPLAM/);
  await runOcrUntilText(page, pdfFileName, /SPENDLENS|FATURA NO|GENEL TOPLAM|TOPLAM/);

  await expect(page.getByRole("heading", { name: /Raw OCR text|Ham OCR metni/ })).toBeVisible();
  await expect(page.locator("body")).toContainText("SPENDLENS MARKET", { timeout: 120_000 });

});

async function uploadFixture(page: Page, path: string, fileName: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(path);
  await page.getByRole("button", { name: /Upload document|Belgeyi yükle/ }).click();
  await expect(page.getByText(new RegExp(`(Uploaded|Yüklendi) - ${fileName}`))).toBeVisible({ timeout: 30_000 });
}

async function runOcrUntilText(page: Page, fileName: string, expectedText: RegExp): Promise<void> {
  await documentSelect(page).selectOption({ label: fileName });
  await expect(page.locator("body")).toContainText(`${fileName} -`, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /OCR pipeline|OCR işlem hattı/ })).toBeVisible();
  await page.getByRole("button", { name: /Start OCR|OCR başlat/ }).click();
  await expect(
    page.getByText(
      /Tesseract OCR kuyruğu hazır|Tesseract OCR queue is ready|Tesseract OCR kuyruğa alındı|Tesseract OCR was queued|Seçili motor: Tesseract OCR|Selected engine: Tesseract OCR|yeni OCR işi kuyruğa alındı|new OCR job was queued/
    )
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByText(/Ön işleme tamamlandı\. Şimdi Tesseract OCR çalıştırılmalı\.|Tesseract OCR kuyruğa alındı\. Worker çalıştırıldığında ham OCR metni oluşacak\.|ön işleme ve Tesseract OCR|preprocessing and Tesseract OCR|Tesseract OCR/i)
      .first()
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Run Worker|Worker çalıştır/ }).click();
  await expect(
    page
      .locator("p")
      .filter({ hasText: /Worker sonucu:.*(Ham OCR metni(?: ve çıkarım sonucu)? oluştu|Raw OCR text(?: and extraction)? (?:was|were) created)/ })
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("heading", { name: /Raw OCR text|Ham OCR metni/ })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("body")).toContainText(expectedText, { timeout: 120_000 });
}

function documentSelect(page: Page) {
  return page.getByLabel(/Belge|Document/);
}
