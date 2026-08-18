import { expect, test } from "@playwright/test";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("uploads a large document through resumable CRC chunks with pause and resume", async ({ page }) => {
  test.setTimeout(180_000);

  const suffix = Date.now().toString(36);
  const fileName = `large-resumable-${suffix}.png`;
  const largePng = Buffer.alloc(21 * 1024 * 1024, 0);
  pngSignature.copy(largePng, 0);

  await page.route("**/documents/uploads/**/chunks/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });

  await page.goto("/register?lang=en&theme=dark");
  await page.getByLabel("Workspace name").fill(`Resumable Tenant ${suffix}`);
  await page.getByLabel("Workspace slug").fill(`resumable-${suffix}`);
  await page.getByRole("textbox", { name: "Workspace", exact: true }).fill("Finance");
  await page.getByLabel("Display name").fill("Resumable Owner");
  await page.getByLabel("Email").fill(`resumable-${suffix}@example.com`);
  await page.getByLabel("Password").fill("very-secure-password");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard(\?.*)?$/);

  await page.goto("/documents/upload?lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: "Document intake and upload" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "image/png",
    buffer: largePng
  });

  await expect(page.getByText("Chunked upload", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByText("Chunk progress", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Upload paused.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Resume" }).click();

  await expect(page.getByText("Chunked upload completed.", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(`Uploaded - ${fileName}`, { exact: true })).toBeVisible();
  await expect(page.getByText(fileName).first()).toBeVisible();
});
