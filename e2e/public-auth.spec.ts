import { expect, test, type Page } from "@playwright/test";

test("public home stays product-focused and usable across mobile dark and desktop light", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/?lang=tr&theme=dark");

  await expect(page.getByRole("heading", { name: "SpendLens AI" })).toBeVisible();
  await expect(page.getByText("Fiş ve faturaları gider kayıtlarına dönüştürün.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Giriş yap" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Hesap oluştur" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Koyu tema etkin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dil: Türkçe" })).toBeVisible();
  await expect(page.locator('img[src*="spendlens-receipt-sample"]')).toHaveJSProperty("complete", true);
  await expect(page.locator("body")).not.toContainText(/PostgreSQL|Redis|Redpanda|Kafka|MinIO|rol sayısı|konu sayısı/i);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?lang=en&theme=light");
  await expect(page.getByText("Turn receipts and invoices into expense records.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Light theme enabled" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("auth forms expose localized field validation and keep mobile controls clear", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/login?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: "Giriş yap" })).toBeVisible();
  await page.getByLabel("E-posta").fill("gecersiz");
  await page.getByLabel("Parola").fill("x");
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByText("Geçerli bir e-posta adresi girin.")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto("/register?lang=tr&theme=dark");
  await page.getByLabel("Çalışma alanı adı").fill("Mobil Test");
  await page.getByLabel("Çalışma alanı kısa adı").fill("mobil-test");
  await page.getByLabel("Çalışma alanı", { exact: true }).fill("Finans");
  await page.getByLabel("Görünen ad").fill("Test Kullanıcısı");
  await page.getByLabel("E-posta").fill("test@example.com");
  await page.getByLabel("Parola").fill("kisa");
  await page.getByRole("button", { name: "Çalışma alanı oluştur" }).click();
  await expect(page.getByText("Parola en az 12 karakter olmalıdır.")).toBeVisible();
  await expect(page.getByText("En az 12 karakter kullanın.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  expect(overflow).toBeLessThanOrEqual(2);
}
