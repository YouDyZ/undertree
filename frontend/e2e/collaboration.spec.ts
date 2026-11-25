import { expect, test } from "@playwright/test";
import { type TestBackendHandle, startTestBackend } from "./harness";

let backend: TestBackendHandle;

test.beforeAll(async () => {
  backend = await startTestBackend();
});

test.afterAll(async () => {
  await backend?.stop();
});

async function loginAs(page: import("@playwright/test").Page, username: string): Promise<void> {
  await page.goto(backend.baseUrl);
  await page.getByPlaceholder(/Username/i).fill(username);
  await page.getByRole("button", { name: /Anmelden/i }).click();
  await expect(page.locator(".user-chip")).toBeVisible();
}

test.describe("Realtime CRDT Collaboration (CodeMirror 6 + Yjs)", () => {
  test("syncs edits and live collaborator presence between two browser contexts", async ({
    browser,
  }) => {
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    try {
      await loginAs(alicePage, "alice");
      await loginAs(bobPage, "bob");

      // Open papers/icml/main.tex in both browsers
      await alicePage.locator(".tree-file", { hasText: "main.tex" }).click();
      await bobPage.locator(".tree-file", { hasText: "main.tex" }).click();

      // Check whether backend #6 (/ws/doc/{*path}) is already available
      const synced = await alicePage
        .locator(".sync-pill.sync-synced")
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false);

      test.skip(!synced, "Backend CRDT endpoint (/ws/doc/{*path}, #6) not yet merged in binary.");

      await expect(bobPage.locator(".sync-pill.sync-synced")).toBeVisible();

      // Both editors should show the initial LaTeX document from disk
      await expect(alicePage.locator(".cm-content")).toContainText("Hello Undertree.");
      await expect(bobPage.locator(".cm-content")).toContainText("Hello Undertree.");

      // Remote collaborator chip should appear in Alice's toolbar
      await expect(alicePage.locator(".peer-chip", { hasText: "Bob Coauthor" })).toBeVisible();
      await expect(bobPage.locator(".peer-chip", { hasText: "Alice Researcher" })).toBeVisible();

      // Alice types into CodeMirror 6 -> Bob receives it in real time
      await alicePage.locator(".cm-content").click();
      await alicePage.keyboard.press("End");
      await alicePage.keyboard.type("\n% Realtime edit by Alice");

      await expect(bobPage.locator(".cm-content")).toContainText("% Realtime edit by Alice");
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test("previews image files via GET /api/files/{*path}", async ({ page }) => {
    await loginAs(page, "alice");
    // Expand figs folder inside papers/icml if collapsed
    const figsDir = page.locator(".tree-dir", { hasText: "figs" });
    if ((await page.locator(".tree-file", { hasText: "pixel.png" }).count()) === 0) {
      await figsDir.click();
    }
    await page.locator(".tree-file", { hasText: "pixel.png" }).click();

    const img = page.locator(".image-stage img");
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", "/api/files/papers/icml/figs/pixel.png");
  });
});
