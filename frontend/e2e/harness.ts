import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface TestBackendHandle {
  baseUrl: string;
  workspaceDir: string;
  dataDir: string;
  stop: () => Promise<void>;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@undertree.local",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@undertree.local",
    },
  });
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Could not allocate free port")));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health: ${String(lastError)}`);
}

/**
 * Resolves the compiled `undertree` Rust binary path.
 * Override with `UNDERTREE_BIN=/path/to/undertree`.
 */
export function resolveUndertreeBinary(): string | null {
  if (process.env.UNDERTREE_BIN && fs.existsSync(process.env.UNDERTREE_BIN)) {
    return process.env.UNDERTREE_BIN;
  }
  const candidates = [
    path.resolve(process.cwd(), "../target/debug/undertree"),
    path.resolve(process.cwd(), "../target/release/undertree"),
    path.resolve(process.cwd(), "../../../target/debug/undertree"),
    path.resolve(process.cwd(), "../../../target/release/undertree"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Creates a temporary workspace containing:
 * - Parent Git repo with `README.md`
 * - Initialized submodule `papers/icml` containing `main.tex` + 1x1 PNG `figs/pixel.png`
 * - Uninitialized submodule `papers/neurips`
 */
function createSampleWorkspace(rootDir: string): string {
  const remotesDir = path.join(rootDir, "remotes");
  const icmlRemote = path.join(remotesDir, "icml.git");
  const neuripsRemote = path.join(remotesDir, "neurips.git");
  const workspaceDir = path.join(rootDir, "workspace");

  fs.mkdirSync(icmlRemote, { recursive: true });
  fs.mkdirSync(neuripsRemote, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Create icml submodule source repo
  runGit(icmlRemote, ["init", "-b", "main"]);
  fs.writeFileSync(
    path.join(icmlRemote, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello Undertree.\n\\end{document}\n"
  );
  fs.mkdirSync(path.join(icmlRemote, "figs"), { recursive: true });
  // Minimal valid 1x1 PNG
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  fs.writeFileSync(path.join(icmlRemote, "figs/pixel.png"), pngBytes);
  runGit(icmlRemote, ["add", "."]);
  runGit(icmlRemote, ["commit", "-m", "Initial icml paper"]);

  // Create neurips submodule source repo
  runGit(neuripsRemote, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(neuripsRemote, "paper.tex"), "\\documentclass{article}\n");
  runGit(neuripsRemote, ["add", "."]);
  runGit(neuripsRemote, ["commit", "-m", "Initial neurips paper"]);

  // Create parent repo + attach both submodules, then deinit neurips so it is uninitialized
  runGit(workspaceDir, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "# Research Parent Repo\n");
  runGit(workspaceDir, ["add", "README.md"]);
  runGit(workspaceDir, ["commit", "-m", "Initial parent commit"]);

  runGit(workspaceDir, ["-c", "protocol.file.allow=always", "submodule", "add", icmlRemote, "papers/icml"]);
  runGit(workspaceDir, ["-c", "protocol.file.allow=always", "submodule", "add", neuripsRemote, "papers/neurips"]);
  runGit(workspaceDir, ["commit", "-m", "Add icml and neurips submodules"]);
  runGit(workspaceDir, ["submodule", "deinit", "-f", "papers/neurips"]);

  return workspaceDir;
}

/**
 * Starts an isolated `undertree serve` backend for Playwright E2E tests.
 * If `UNDERTREE_E2E_URL` is set, connects directly to that external instance instead.
 */
export async function startTestBackend(): Promise<TestBackendHandle> {
  if (process.env.UNDERTREE_E2E_URL) {
    return {
      baseUrl: process.env.UNDERTREE_E2E_URL.replace(/\/+$/, ""),
      workspaceDir: process.env.UNDERTREE_WORKSPACE ?? "",
      dataDir: process.env.UNDERTREE_DATA ?? "",
      stop: async () => {},
    };
  }

  const bin = resolveUndertreeBinary();
  if (!bin) {
    throw new Error(
      "Could not locate `undertree` binary. Run `cargo build` or set UNDERTREE_BIN / UNDERTREE_E2E_URL."
    );
  }

  const staticDir = path.resolve(process.cwd(), "dist");
  if (!fs.existsSync(path.join(staticDir, "index.html"))) {
    throw new Error("frontend/dist/index.html missing. Run `npm run build` before E2E tests.");
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "undertree-e2e-"));
  const workspaceDir = createSampleWorkspace(tmpRoot);
  const dataDir = path.join(tmpRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UNDERTREE_WORKSPACE: workspaceDir,
    UNDERTREE_DATA: dataDir,
    UNDERTREE_BIND: `127.0.0.1:${port}`,
    UNDERTREE_PUBLIC_URL: baseUrl,
    UNDERTREE_STATIC_DIR: staticDir,
    UNDERTREE_DEV_LOGIN: "true",
    UNDERTREE_GITHUB_CLIENT_ID: "e2e-dummy-github-id",
    UNDERTREE_GITHUB_CLIENT_SECRET: "e2e-dummy-github-secret",
    UNDERTREE_GOOGLE_CLIENT_ID: "e2e-dummy-google-id",
    UNDERTREE_GOOGLE_CLIENT_SECRET: "e2e-dummy-google-secret",
    // Allow local file:// remotes inside the ephemeral E2E workspace for submodule-update tests
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
  };

  // Seed two test users via admin CLI
  execFileSync(
    bin,
    ["user", "add", "alice", "--display-name", "Alice Researcher", "--email", "alice@example.org", "--admin"],
    { env, stdio: "pipe" }
  );
  execFileSync(
    bin,
    ["user", "add", "bob", "--display-name", "Bob Coauthor", "--email", "bob@example.org"],
    { env, stdio: "pipe" }
  );

  const logs: string[] = [];
  const child: ChildProcess = spawn(bin, ["serve"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));

  try {
    await waitForHealth(baseUrl);
  } catch (err) {
    child.kill("SIGTERM");
    throw new Error(`${String(err)}\nBackend logs:\n${logs.join("")}`);
  }

  return {
    baseUrl,
    workspaceDir,
    dataDir,
    stop: async () => {
      if (!child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
            resolve();
          }, 3000);
        });
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
