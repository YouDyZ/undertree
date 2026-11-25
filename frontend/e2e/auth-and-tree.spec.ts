import { expect, test } from "@playwright/test";
import { type TestBackendHandle, startTestBackend } from "./harness";

let backend: TestBackendHandle;

test.beforeAll(async () => {
  backend = await startTestBackend();
});

test.afterAll(async () => {
  await backend?.stop();
});

test.describe("Auth (OAuth-only + Dev-Login) & Submodule File Tree", () => {
  test("renders OAuth-only login screen without password fields and shows OAuth error banners", async ({
    page,
  }) => {
    await page.goto(`${backend.baseUrl}/login?error=not_registered`);

    // Must never render a password input (OAuth-only requirement #13)
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

    // OAuth buttons rendered from GET /api/auth/providers
    await expect(page.getByRole("link", { name: /Mit GitHub anmelden/i })).toHaveAttribute(
      "href",
      "/api/auth/oauth/github/start"
    );
    await expect(page.getByRole("link", { name: /Mit Google anmelden/i })).toHaveAttribute(
      "href",
      "/api/auth/oauth/google/start"
    );

    // Error banner for ?error=not_registered
    await expect(page.getByRole("alert")).toContainText(/nicht für dieses Undertree-Workspace/i);

    await page.goto(`${backend.baseUrl}/login?error=oauth_denied`);
    await expect(page.getByRole("alert")).toContainText(/abgebrochen/i);
  });

  test("logs in via dev-login, displays parent + initialized & uninitialized submodules, creates/deletes files, and logs out", async ({
    page,
  }) => {
    await page.goto(backend.baseUrl);

    await page.getByPlaceholder(/Username/i).fill("alice");
    await page.getByRole("button", { name: /Anmelden/i }).click();

    // Authenticated AppShell + live /ws/events badge
    await expect(page.locator(".user-name")).toHaveText("Alice Researcher");
    await expect(page.locator(".badge-admin")).toHaveText("Admin");
    await expect(page.locator(".ws-pill")).toHaveText(/Live/);

    // File tree distinguishes Parent Repo, initialized Submodule (icml), and uninitialized Submodule (neurips)
    await expect(page.locator(".sidebar .badge-parent")).toHaveText("ROOT");

    const icmlRow = page.locator(".tree-submodule", { hasText: "icml" });
    await expect(icmlRow).toBeVisible();
    await expect(icmlRow.locator(".badge-submodule")).toHaveText("SUB");

    const neuripsRow = page.locator(".tree-submodule.is-uninitialized", { hasText: "neurips" });
    await expect(neuripsRow).toBeVisible();
    await expect(neuripsRow.locator(".badge-uninit")).toHaveText("nicht init.");

    // Expand icml if needed and verify main.tex is present
    await expect(page.locator(".tree-file", { hasText: "main.tex" })).toBeVisible();

    // Session persists across full page reload
    await page.reload();
    await expect(page.locator(".user-name")).toHaveText("Alice Researcher");

    // Create a new file via sidebar UI -> PUT /api/files/...
    await page.getByTitle("Neue Datei anlegen").click();
    await page.locator(".create-file-form input").fill("papers/icml/e2e-notes.tex");
    await page.getByRole("button", { name: "Erstellen" }).click();

    await expect(page.locator(".tree-file", { hasText: "e2e-notes.tex" })).toBeVisible();
    await expect(page.locator(".editor-tab", { hasText: "e2e-notes.tex" })).toBeVisible();

    // Delete the created file via sidebar UI -> DELETE /api/files/...
    page.once("dialog", (dialog) => dialog.accept());
    const notesRow = page.locator(".tree-file", { hasText: "e2e-notes.tex" });
    await notesRow.hover();
    await notesRow.getByTitle("e2e-notes.tex löschen").click();

    await expect(page.locator(".tree-file", { hasText: "e2e-notes.tex" })).toHaveCount(0);

    // Failed logout (e.g. HTTP 500) must keep user logged in and show an error toast (#19)
    await page.route("**/api/auth/logout", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "db busy" } }),
      })
    );
    await page.getByRole("button", { name: "Abmelden" }).click();
    await expect(page.locator(".toast-error")).toContainText(/Abmelden fehlgeschlagen/i);
    await expect(page.locator(".user-name")).toHaveText("Alice Researcher");
    await page.unroute("**/api/auth/logout");

    // Successful logout clears session and returns to login screen
    await page.getByRole("button", { name: "Abmelden" }).click();
    await expect(page.locator(".login-card")).toBeVisible();
  });
});
