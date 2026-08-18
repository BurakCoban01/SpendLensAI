import { expect, test } from "@playwright/test";
import { join } from "node:path";

test("runs a browser smoke path against Docker-backed persistence and object storage", async ({ page, request }) => {
  test.skip(process.env.SPENDLENS_E2E_DOCKER !== "1", "Docker-backed E2E is opt-in.");
  test.setTimeout(180_000);

  const apiBaseUrl = process.env.SPENDLENS_E2E_API_BASE_URL ?? "http://127.0.0.1:4101";
  const suffix = Date.now().toString(36);
  const fixtureName = "valid-fis-03.png";
  const fixturePath = join(process.cwd(), "docs", "KullanilanDokumanlar", "tr", fixtureName);

  const ready = await request.get(`${apiBaseUrl}/health/ready`);
  expect(ready.ok()).toBeTruthy();

  await page.goto("/register?lang=en&theme=dark");
  await page.getByLabel("Workspace name").fill(`Docker Tenant ${suffix}`);
  await page.getByLabel("Workspace slug").fill(`docker-${suffix}`);
  await page.getByRole("textbox", { name: "Workspace", exact: true }).fill("Docker Finance");
  await page.getByLabel("Display name").fill("Docker Owner");
  await page.getByLabel("Email").fill(`docker-${suffix}@example.com`);
  await page.getByLabel("Password").fill("very-secure-password");
  const registerResponse = page.waitForResponse((response) => response.url().includes("/auth/register") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create workspace" }).click();
  expect((await registerResponse).status()).toBe(201);
  await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 30_000 });

  const session = await page.evaluate(() => {
    const raw = window.localStorage.getItem("spendlens.auth");
    if (!raw) throw new Error("E2E_SESSION_MISSING");
    return JSON.parse(raw) as { tokens: { accessToken: string } };
  });

  const adminHealth = await request.get(`${apiBaseUrl}/admin/health`, {
    headers: { authorization: `Bearer ${session.tokens.accessToken}` }
  });
  expect(adminHealth.status(), await adminHealth.text()).toBe(200);
  const healthBody = (await adminHealth.json()) as {
    checks: Record<string, { status: string }>;
    operations: {
      storageUsage: { backend: string; connected: boolean };
      featureFlags: Array<{ key: string; enabled: boolean }>;
    };
  };
  expect(healthBody.checks.postgres.status).toBe("ok");
  expect(healthBody.checks.redis.status).toBe("ok");
  expect(healthBody.checks.kafka.status).toBe("ok");
  expect(healthBody.checks.minio.status).toBe("ok");
  expect(healthBody.operations.storageUsage.backend).toBe("minio");
  expect(healthBody.operations.storageUsage.connected).toBe(true);
  const flags = Object.fromEntries(healthBody.operations.featureFlags.map((flag) => [flag.key, flag.enabled]));
  expect(flags.memoryAdapters).toBe(false);
  expect(flags.kafkaProducer).toBe(true);
  expect(flags.redisRateLimit).toBe(true);
  expect(flags.minioStorage).toBe(true);

  await page.locator('a[href^="/documents/upload"]').first().click();
  await expect(page.getByRole("heading", { name: /Document intake and upload|Document intake/ })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByText(`Uploaded - ${fixtureName}`)).toBeVisible();
  await expect(page.getByText(fixtureName).first()).toBeVisible();
  await expect(page.getByText("1 saved")).toBeVisible();
  await page.getByRole("button", { name: "Signed URL" }).click();
  const signedUrl = page.locator("div").filter({ hasText: /Download URL/ }).locator(".font-mono").last();
  await expect(signedUrl).toContainText(/(?:localhost|127\.0\.0\.1):19002/);
  await expect(signedUrl).not.toContainText("memory://");

  await page.reload();
  await expect(page.getByText(fixtureName).first()).toBeVisible();
  await expect(page.getByText("1 saved")).toBeVisible();
});
