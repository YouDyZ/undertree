import { expect, test } from "@playwright/test";
import { type TestBackendHandle, startTestBackend } from "./harness";

let backend: TestBackendHandle;

test.beforeAll(async () => {
  backend = await startTestBackend();
});

test.afterAll(async () => {
  await backend?.stop();
});

async function loginAsAlice(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(backend.baseUrl);
  await page.getByPlaceholder(/Username/i).fill("alice");
  await page.getByRole("button", { name: /Anmelden/i }).click();
  await expect(page.locator(".user-chip")).toBeVisible();
  await expect(page.locator(".ws-pill")).toHaveText(/Live/);
}

test.describe("LaTeX Compile + PDF.js Hot-Reload (#8/#10) & Git Submodule UI (#9/#11)", () => {
  test("compiles LaTeX to PDF.js canvas, auto-recompiles errors with diagnostics jump-to-line & raw log, and hot-reloads on fix", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await loginAsAlice(page);

    // Open papers/icml/main.tex in CodeMirror 6
    await page.locator(".tree-file", { hasText: "main.tex" }).click();
    await expect(page.locator(".sync-pill.sync-synced")).toBeVisible();

    // PDF panel selects papers/icml/main.tex as root
    await expect(page.locator(".pdf-root-pill")).toHaveText("papers/icml/main.tex");

    // Trigger manual compile via Compile button
    const [compileRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/compile") && r.request().method() === "POST"),
      page.locator(".pdf-compile-btn").click(),
    ]);
    expect(compileRes.status(), await compileRes.text()).toBe(202);
    await expect(page.locator(".pdf-status-pill")).toContainText(/OK/, { timeout: 25_000 });
    await expect(page.locator(".pdf-page-indicator")).toContainText("1 / 1");

    // Verify PDF.js rendered a real non-empty canvas
    const canvas = page.locator(".pdf-pages canvas").first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(50);
    expect(box?.height ?? 0).toBeGreaterThan(50);

    // Introduce a LaTeX error on line 4 -> triggers CRDT update -> disk flush -> auto-recompile
    const brokenTex = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Line three ok.",
      "\\undefinedundertreecmd",
      "\\end{document}",
      "",
    ].join("\n");
    const putBroken = await page.request.put(`${backend.baseUrl}/api/files/papers/icml/main.tex`, {
      data: brokenTex,
    });
    expect(putBroken.status()).toBe(204);

    // Auto-recompile should fail and auto-open the Diagnostics drawer with an ERROR entry
    await expect(page.locator(".pdf-status-pill")).toContainText(/Fehler/, { timeout: 25_000 });
    await expect(page.locator(".pdf-drawer")).toBeVisible();

    const errorDiag = page.locator(".diag-row.is-clickable", { hasText: "ERROR" }).first();
    await expect(errorDiag).toBeVisible();
    await expect(errorDiag).toContainText("papers/icml/main.tex:4");

    // Clicking the diagnostic jumps the CodeMirror 6 cursor to line 4
    await errorDiag.click();
    await expect(page.locator(".editor-statusbar")).toContainText("Ln 4,");

    // Switch to Raw Log tab and confirm pdflatex/latexmk output is loaded
    await page.getByRole("tab", { name: "Raw Log" }).click();
    await expect(page.locator(".pdf-drawer-body pre")).toContainText(/undefinedundertreecmd/i);

    // Fix the LaTeX document -> auto-recompile succeeds and PDF hot-reloads cleanly
    const fixedTex = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Hello Undertree Updated.",
      "\\end{document}",
      "",
    ].join("\n");
    const putFixed = await page.request.put(`${backend.baseUrl}/api/files/papers/icml/main.tex`, {
      data: fixedTex,
    });
    expect(putFixed.status()).toBe(204);

    await expect(page.locator(".pdf-status-pill")).toContainText(/OK/, { timeout: 25_000 });
    await expect(page.locator(".pdf-pages canvas").first()).toBeVisible();
  });

  test("commits inside a submodule, commits submodule pointer in parent repo, and initializes an uninitialized submodule via GitPanel UI", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await loginAsAlice(page);

    // Modify papers/icml/main.tex so submodule has a dirty file
    const updatedTex =
      "\\documentclass{article}\n\\begin{document}\nGit panel E2E update.\n\\end{document}\n";
    const putRes = await page.request.put(`${backend.baseUrl}/api/files/papers/icml/main.tex`, {
      data: updatedTex,
    });
    expect(putRes.status()).toBe(204);

    // Open Git drawer from topbar
    await page.locator(".topbar").getByRole("button", { name: "Git" }).click();
    await expect(page.locator(".git-repo-selector")).toBeVisible();

    // Select submodule papers/icml
    await page.locator(".git-repo-chip", { hasText: "papers/icml" }).click();
    await expect(page.locator(".git-file-row", { hasText: "main.tex" })).toBeVisible();

    // Open unified diff for main.tex
    await page.locator(".git-file-row .git-file-btn", { hasText: "main.tex" }).click();
    await expect(page.locator(".git-diff-box, .git-diff-pre, pre")).toContainText(
      "Git panel E2E update."
    );

    // Commit inside submodule papers/icml
    await page.locator(".git-commit-input").fill("E2E submodule commit");
    await page.locator(".git-commit-btn").click();
    await expect(page.getByText("Arbeitsverzeichnis ist sauber.")).toBeVisible();

    // Verify commit appears in Verlauf (Git log)
    await page.getByRole("tab", { name: /Verlauf/i }).click();
    await expect(page.locator(".git-panel-body")).toContainText("E2E submodule commit");

    // Switch back to Parent Repo (ROOT) -> submodule pointer papers/icml is modified -> commit it!
    await page.locator(".git-repo-chip", { hasText: "ROOT" }).click();
    await page.getByRole("tab", { name: /Änderungen/i }).click();
    await expect(page.locator(".git-file-row", { hasText: "papers/icml" })).toBeVisible();

    await page.locator(".git-commit-input").fill("Update icml submodule pointer");
    await page.locator(".git-commit-btn").click();
    await expect(page.getByText("Arbeitsverzeichnis ist sauber.")).toBeVisible();

    // Select uninitialized submodule papers/neurips -> initialize via UI button
    await page.locator(".git-repo-chip", { hasText: "papers/neurips" }).click();
    await expect(page.locator(".git-uninit-card")).toBeVisible();
    await page.locator(".git-uninit-card button").click();

    // Once initialized, neurips is no longer marked uninitialized in the FileTree
    await expect(page.locator(".tree-submodule.is-uninitialized", { hasText: "neurips" })).toHaveCount(
      0,
      { timeout: 15_000 }
    );
  });
});
