import fs from "node:fs";
import { defineConfig } from "@playwright/test";

function resolveChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return candidates.find((p) => fs.existsSync(p));
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    headless: true,
    launchOptions: {
      executablePath: resolveChromiumExecutable(),
      args: ["--no-sandbox", "--disable-crash-reporter"],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: "/tmp/undertree-pw-config",
        XDG_CACHE_HOME: "/tmp/undertree-pw-cache",
      },
    },
    trace: "on-first-retry",
  },
});
