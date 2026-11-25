import { expect, test } from "@playwright/test";
import { type TestBackendHandle, startTestBackend } from "./harness";

let backend: TestBackendHandle;

test.beforeAll(async () => {
  backend = await startTestBackend();
});

test.afterAll(async () => {
  await backend?.stop();
});

async function loginAsAlice(page: import("@playwright/test").Page, suffix = ""): Promise<void> {
  await page.goto(`${backend.baseUrl}${suffix}`);
  await page.getByPlaceholder(/Username/i).fill("alice");
  await page.getByRole("button", { name: /Anmelden/i }).click();
  await expect(page.locator(".user-chip")).toBeVisible();
}

test.describe("Guided Onboarding Tour (#31)", () => {
  test("launches from Topbar, steps through all spotlight targets, persists completion, and supports ?tour=1", async ({
    page,
  }) => {
    await loginAsAlice(page);

    // Unseen indicator dot visible before first tour completion
    const tourBtn = page.locator(".tour-trigger-btn");
    await expect(tourBtn).toBeVisible();
    await expect(tourBtn.locator(".tour-unseen-dot")).toBeVisible();

    // Dismissing with Escape before finishing must NOT mark the tour completed (#29 review)
    await tourBtn.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(tourBtn.locator(".tour-unseen-dot")).toBeVisible();

    // Launch tour and complete all 6 steps
    await tourBtn.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Willkommen bei Undertree");
    await expect(dialog).toContainText("Schritt 1 von 6");

    // Step 2: File tree spotlight
    await dialog.getByRole("button", { name: "Weiter" }).click();
    await expect(dialog).toContainText("Dateibaum & Git-Submodule");
    await expect(page.locator(".tour-spotlight")).toBeVisible();

    // Step 3 via keyboard ArrowRight: Collaborative Editor
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("Kollaborativer LaTeX-Editor");
    await expect(dialog).toContainText("Strg + S");

    // Step 4: PDF Viewer
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("PDF-Vorschau, Hot-Reload & Diagnostics");

    // Step 5: Git Panel
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("Git & Submodule direkt in der UI");

    // Step 6: Live Status -> Finish
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("Live-Status & Sitzung");
    await dialog.getByRole("button", { name: "Fertig" }).click();

    await expect(dialog).toBeHidden();
    await expect(tourBtn.locator(".tour-unseen-dot")).toHaveCount(0);

    // Completion persists across reload
    await page.reload();
    await expect(tourBtn).toBeVisible();
    await expect(tourBtn.locator(".tour-unseen-dot")).toHaveCount(0);

    // Direct start via ?tour=1 query param & dismiss via Escape
    await page.goto(`${backend.baseUrl}/?tour=1`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
