import { expect, test, type Page } from "@playwright/test";

test("mobile dashboard keeps core workflows reachable and basic controls named", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });

  const suffix = `mobile-${Date.now().toString(36)}`;
  await registerTenant(page, suffix);

  await expect(page).toHaveURL(/\/dashboard(\?.*)?$/);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Workspace: Mobile Finance")).toBeVisible();
  await expect(page.getByRole("link", { name: "Upload document" }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInteractiveControlsNamed(page);

  const menuButton = page.getByRole("button", { name: "Open menu" });
  await menuButton.click();
  const mobileNavigation = page.getByRole("dialog", { name: "Mobile navigation" });
  const closeButton = page.getByRole("button", { name: "Close menu" });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Documents" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "OCR workspace" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Expenses" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Reports" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "OCR models" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(closeButton).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => mobileNavigation.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(mobileNavigation).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");

  await page.getByRole("link", { name: "Upload document" }).first().click();
  await expect(page.getByRole("heading", { name: "Document intake and upload" })).toBeVisible();
  await expect(page.getByText("There are no documents in this workspace yet. Upload the first one to start the OCR flow.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInteractiveControlsNamed(page);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Loading workspace and session settings.")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /Session inventory/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Sign out all sessions" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectInteractiveControlsNamed(page);
});

async function registerTenant(page: Page, suffix: string): Promise<void> {
  await page.goto("/register");
  await expectNoHorizontalOverflow(page);
  await expectInteractiveControlsNamed(page);
  await page.getByLabel("Workspace name").fill(`Mobile Tenant ${suffix}`);
  await page.getByLabel("Workspace slug").fill(`mobile-${suffix}`);
  await page.getByRole("textbox", { name: "Workspace", exact: true }).fill("Mobile Finance");
  await page.getByLabel("Display name").fill("Mobile Owner");
  await page.getByLabel("Email").fill(`mobile-${suffix}@example.com`);
  await page.getByLabel("Password").fill("very-secure-password");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 30_000 });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const documentElement = document.documentElement;
    return Math.max(0, documentElement.scrollWidth - documentElement.clientWidth);
  });
  expect(overflow).toBeLessThanOrEqual(2);
}

async function expectInteractiveControlsNamed(page: Page): Promise<void> {
  const unnamed = await page.locator("a,button,input,select,textarea").evaluateAll((elements) =>
    {
      function nameFor(element: Element): string {
        const ariaLabel = element.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;

        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          return labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
        }

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          if (element.id) {
            const explicitLabel = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
            if (explicitLabel?.textContent) return explicitLabel.textContent;
          }
          const parentLabel = element.closest("label");
          if (parentLabel?.textContent) return parentLabel.textContent;
          return element.getAttribute("placeholder") ?? element.getAttribute("title") ?? "";
        }

        return element.textContent ?? element.getAttribute("title") ?? "";
      }

      return elements
        .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        })
        .filter((element) => {
          if (element instanceof HTMLInputElement && element.type === "hidden") return false;
          return nameFor(element).trim().length === 0;
        })
        .map((element) => {
          const tag = element.tagName.toLowerCase();
          const type = element instanceof HTMLInputElement ? `[type=${element.type}]` : "";
          return `${tag}${type}`;
        });
    }
  );
  expect(unnamed).toEqual([]);
}
