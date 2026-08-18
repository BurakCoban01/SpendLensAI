import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

test("captures product screenshots for implemented flows", async ({ page }) => {
  test.setTimeout(420_000);

  const suffix = Date.now().toString(36);
  const tenantName = `Portfolio Tenant ${suffix}`;
  const screenshotsDir = "docs/screenshots";
  const fixtureDir = join(process.cwd(), "data", "demo-fixtures");
  const webpFileName = "valid-fis-02.webp";
  mkdirSync(screenshotsDir, { recursive: true });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/?lang=en&theme=dark");
  await page.screenshot({ path: `${screenshotsDir}/01-home.png`, fullPage: true });

  await page.goto("/register?lang=en&theme=dark");
  await page.screenshot({ path: `${screenshotsDir}/02-register.png`, fullPage: true });

  await page.getByLabel(/Workspace name|Tenant adı/).fill(tenantName);
  await page.getByLabel(/Workspace slug|Tenant kısa adı/).fill(`portfolio-${suffix}`);
  await page.getByRole("textbox", { name: /Workspace|Çalışma alanı/ }).fill("Finans");
  await page.getByLabel(/Display name|Görünen ad/).fill("Portfolio Owner");
  await page.getByLabel(/Email|E-posta/).fill(`portfolio-${suffix}@example.com`);
  await page.getByLabel(/Password|Parola/).fill("very-secure-password");
  await page.getByRole("button", { name: /Create workspace|Çalışma alanı oluştur/ }).click();

  await expect(page.getByRole("heading", { name: tenantName })).toBeVisible({ timeout: 60_000 });
  const authSession = await page.evaluate(() => window.localStorage.getItem("spendlens.auth"));
  if (!authSession) throw new Error("PORTFOLIO_AUTH_SESSION_MISSING");
  await page.screenshot({ path: `${screenshotsDir}/03-dashboard.png`, fullPage: true });

  await page.locator('a[href^="/documents/upload"]').first().click();
  await expect(page.getByRole("heading", { name: /Document intake and upload|Document intake|Belge yükleme/ })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(join(fixtureDir, webpFileName));
  await page.getByRole("button", { name: /Upload document|Belgeyi yükle/ }).click();
  await expect(page.getByText(new RegExp(`(Uploaded|Yüklendi) - ${webpFileName}`))).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/04-document-intake.png`, fullPage: true });

  await page.locator('a[href^="/documents/ocr"]').first().click();
  await expect(page.getByRole("heading", { name: /OCR workspace|OCR çalışma alanı/ })).toBeVisible();
  await page.locator("select").nth(1).selectOption({ label: webpFileName });
  await expect(page.locator("body")).toContainText(`${webpFileName} -`, { timeout: 30_000 });
  await page.getByRole("button", { name: /Start OCR|OCR başlat/ }).click();
  await expect(page.getByText(/OCR job\(s\) queued|OCR jobs queued|OCR işi kuyruğa alındı/)).toBeVisible({ timeout: 30_000 });
  const rawOcrHeading = page.getByRole("heading", { name: /Raw OCR text|Ham OCR metni/ });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await rawOcrHeading.isVisible().catch(() => false)) break;
    const workerButton = page.getByRole("button", { name: /Run Worker|Worker çalıştır/ });
    if (await workerButton.isEnabled().catch(() => false)) {
      await workerButton.click();
    }
    await page.waitForTimeout(3000);
  }
  if (await rawOcrHeading.isVisible().catch(() => false)) {
    await expect(page.locator("body")).toContainText(/SPENDLENS|TOPLAM|GENEL TOPLAM/);
  } else {
    await expect(page.getByRole("heading", { name: /OCR history|OCR geçmişi/ })).toBeVisible();
  }
  await page.screenshot({ path: `${screenshotsDir}/05-ocr-comparison.png`, fullPage: true });

  await page.goto("/review?lang=en&theme=dark");
  if (await page.getByRole("link", { name: "Sign in" }).isVisible().catch(() => false)) {
    await page.evaluate((session) => window.localStorage.setItem("spendlens.auth", session), authSession);
    await page.reload();
  }
  await expect(page.getByRole("heading", { name: /Review|İnceleme/ })).toBeVisible();
  await page
    .getByLabel(/OCR text for extraction|OCR metni/)
    .fill(["PORTFOLIO MARKET", "FIS NO: PF-2026", "TARIH: 20.05.2026 SAAT 10:15", "KALEM 125,00 TL", "KDV 25,00 TL", "TOPLAM 150,00 TL"].join("\n"));
  await page.getByRole("button", { name: /Run extraction|Extraction çalıştır|Çıkarım/ }).click();
  await expect(page.getByText("150,00 TRY")).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/06-review.png`, fullPage: true });

  await page.goto("/expenses?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: /Expenses|Giderler/ })).toBeVisible();
  await page.getByLabel(/Title|Başlık/).fill("Portfolio office supplies");
  await page.getByLabel(/Amount|Tutar/).fill("150,00");
  await page.getByLabel(/Date|Tarih/).fill("2026-05-20T10:15");
  await page.getByLabel(/Merchant|Satıcı/).fill("Portfolio Market");
  await page.getByRole("button", { name: /Create expense|Gider oluştur/ }).click();
  await expect(page.getByText(/Expense created\.|Gider oluşturuldu/)).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/07-expenses.png`, fullPage: true });

  await page.goto("/budgets?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: /Budgets|Bütçeler/ })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/08-budgets.png`, fullPage: true });

  await page.goto("/reports?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: /Reports|Raporlar/ })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/09-reports.png`, fullPage: true });

  await page.goto("/models?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: /Models|Modeller/ })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/10-models.png`, fullPage: true });

  await page.goto("/admin/health?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: /Operations|Operasyon/ })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/11-operations.png`, fullPage: true });
});
