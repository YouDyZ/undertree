import { describe, expect, it } from "vitest";
import type { GitStatus } from "../api";
import {
  formatAutoPushInterval,
  hasPendingGitWork,
  reminderSummary,
  shouldRemindCommit,
} from "./gitReminder";

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    repo: "",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    ...overrides,
  };
}

describe("gitReminder helpers", () => {
  it("formats standard and custom intervals", () => {
    expect(formatAutoPushInterval(0)).toBe("Aus");
    expect(formatAutoPushInterval(300)).toBe("Alle 5 Minuten");
    expect(formatAutoPushInterval(7200)).toBe("Alle 2 Stunden");
    expect(formatAutoPushInterval(90)).toBe("Alle 90 Sekunden");
  });

  it("detects pending work from modified files or ahead count", () => {
    expect(hasPendingGitWork(null)).toBe(false);
    expect(hasPendingGitWork(status())).toBe(false);
    expect(
      hasPendingGitWork(status({ files: [{ path: "main.tex", index: " ", worktree: "M" }] }))
    ).toBe(true);
    expect(hasPendingGitWork(status({ ahead: 2 }))).toBe(true);
  });

  it("reminds only when auto-push is off, threshold elapsed, and not snoozed", () => {
    const start = 1_000_000;
    const threshold = 15 * 60 * 1000;
    expect(shouldRemindCommit(null, start + threshold, null, 0)).toBe(false);
    expect(shouldRemindCommit(start, start + threshold - 1, null, 0)).toBe(false);
    expect(shouldRemindCommit(start, start + threshold, null, 0)).toBe(true);
    expect(shouldRemindCommit(start, start + threshold, start + threshold + 1000, 0)).toBe(false);
    expect(shouldRemindCommit(start, start + threshold, start + threshold - 1, 0)).toBe(true);
    expect(shouldRemindCommit(start, start + threshold, null, 300)).toBe(false);
  });

  it("builds concise German summary text", () => {
    expect(reminderSummary(null)).toBe("");
    expect(
      reminderSummary(
        status({
          ahead: 1,
          files: [
            { path: "a.tex", index: " ", worktree: "M" },
            { path: "b.tex", index: "?", worktree: "?" },
          ],
        })
      )
    ).toBe("2 ungespeicherte Git-Änderungen, 1 lokaler Commit nicht gepusht");
  });
});
