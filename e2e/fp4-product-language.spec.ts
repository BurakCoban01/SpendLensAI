import { expect, test, type Page } from "@playwright/test";

test("demo account keeps product language and safe document actions across affected routes", async ({ page, request }) => {
  const apiBaseUrl = process.env.SPENDLENS_E2E_API_BASE_URL ?? "http://127.0.0.1:18621";
  const login = await request.post(`${apiBaseUrl}/auth/login`, {
    data: {
      tenantSlug: "demo",
      email: "demo.owner@spendlens.local",
      password: "SpendLensDemo!2026"
    }
  });
  expect(login.status()).toBe(200);
  const session = await login.json();
  await page.addInitScript((storedSession) => {
    window.localStorage.setItem("spendlens.auth", JSON.stringify(storedSession));
  }, session);
  await page.setViewportSize({ width: 390, height: 844 });

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/documents/upload?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: "Belge kabul ve yükleme" })).toBeVisible({ timeout: 30_000 });
  const prepareDocumentLink = page.getByRole("button", { name: "Belgeyi aç/indir" }).first();
  await expect(prepareDocumentLink).toBeVisible();
  await prepareDocumentLink.click();
  await expect(page.getByText("Belge bağlantısı hazır.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Belgeyi aç/indir" })).toHaveAttribute("target", "_blank");
  await expect(page.locator("body")).not.toContainText(/X-Amz-|spendlens-documents\//i);
  await expectNoHorizontalOverflow(page);

  await page.goto("/documents/ocr?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: "OCR workspace" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Advanced manual OCR comparison")).toBeVisible();
  await page.getByText("Advanced manual OCR comparison").click();
  await expect(page.getByRole("button", { name: "Save manual comparison" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto("/review?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: "İnceleme", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByText("Gelişmiş belge ve etiketleme araçlarını aç", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "OCR inceleme karşılaştırması" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/storage adapter|object-storage|raw JSON/i);
  await expectNoHorizontalOverflow(page);

  await page.goto("/approvals?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: "Onaylar" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(/HTTP_\d+|Prisma|Fastify|stack trace/i);
  await expectNoHorizontalOverflow(page);

  await page.goto("/reports?lang=tr&theme=dark");
  await expect(page.getByRole("heading", { name: "Raporlar" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Dışa aktarma dosyaları güvenli biçimde hazırlanır ve geçmişte izlenebilir.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/object-storage|storage adapter/i);
  await expectNoHorizontalOverflow(page);

  expect(pageErrors).toEqual([]);
});

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  expect(overflow).toBeLessThanOrEqual(2);
}
