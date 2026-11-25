import { describe, expect, it } from "vitest";
import {
  classifyDiffLine,
  coAuthorsForCommit,
  coAuthorsOfRepo,
  statusOfRepo,
  describeGitStatus,
  formatCommitDate,
  formatRelativeRepoPath,
  parseUnifiedDiff,
} from "./gitUi";

describe("coAuthorsForCommit", () => {
  const detected = [{ username: "bob" }, { username: "carol" }];

  it("leaves detection to the server while nobody is unchecked", () => {
    expect(coAuthorsForCommit(detected, new Set())).toBeUndefined();
    expect(coAuthorsForCommit(detected, new Set(["gone"]))).toBeUndefined();
  });

  it("sends exactly the checked co-authors otherwise", () => {
    expect(coAuthorsForCommit(detected, new Set(["bob"]))).toEqual(["carol"]);
    expect(coAuthorsForCommit(detected, new Set(["bob", "carol"]))).toEqual([]);
  });
});

describe("describeGitStatus", () => {
  it("interprets unstaged modifications and deletions", () => {
    const mod = describeGitStatus(" ", "M");
    expect(mod.code).toBe("M");
    expect(mod.kind).toBe("modified");
    expect(mod.cssClass).toBe("git-badge-modified");
    expect(mod.staged).toBe(false);
    expect(mod.unstaged).toBe(true);

    const del = describeGitStatus(" ", "D");
    expect(del.code).toBe("D");
    expect(del.kind).toBe("deleted");
    expect(del.cssClass).toBe("git-badge-deleted");
  });

  it("interprets staged additions, renames, copies, and dual-state files", () => {
    const added = describeGitStatus("A", " ");
    expect(added.code).toBe("A");
    expect(added.kind).toBe("added");
    expect(added.staged).toBe(true);
    expect(added.unstaged).toBe(false);
    expect(added.label).toContain("staged");

    const renamed = describeGitStatus("R", " ");
    expect(renamed.code).toBe("R");
    expect(renamed.kind).toBe("renamed");
    expect(renamed.cssClass).toBe("git-badge-renamed");

    const copied = describeGitStatus("C", " ");
    expect(copied.code).toBe("C");
    expect(copied.kind).toBe("copied");
    expect(copied.cssClass).toBe("git-badge-copied");

    const both = describeGitStatus("M", "M");
    expect(both.code).toBe("MM");
    expect(both.kind).toBe("modified");
    expect(both.staged).toBe(true);
    expect(both.unstaged).toBe(true);
    expect(both.label).toContain("staged + lokal");

    const addedThenMod = describeGitStatus("A", "M");
    expect(addedThenMod.code).toBe("AM");
    expect(addedThenMod.kind).toBe("added");
  });

  it("interprets untracked and conflict codes", () => {
    const untracked = describeGitStatus("?", "?");
    expect(untracked.code).toBe("?");
    expect(untracked.kind).toBe("untracked");
    expect(untracked.cssClass).toBe("git-badge-untracked");
    expect(untracked.isUntracked).toBe(true);
    expect(untracked.isConflict).toBe(false);

    for (const [x, y] of [
      ["U", "U"],
      ["A", "A"],
      ["D", "D"],
      ["U", "D"],
      ["A", "U"],
    ] as const) {
      const conflict = describeGitStatus(x, y);
      expect(conflict.kind).toBe("conflict");
      expect(conflict.cssClass).toBe("git-badge-conflict");
      expect(conflict.isConflict).toBe(true);
    }
  });
});

describe("unified diff parsing", () => {
  it("classifies meta, hunk, add, del, and context lines accurately", () => {
    expect(classifyDiffLine("diff --git a/main.tex b/main.tex")).toBe("meta");
    expect(classifyDiffLine("index 1234..5678 100644")).toBe("meta");
    expect(classifyDiffLine("--- a/main.tex")).toBe("meta");
    expect(classifyDiffLine("+++ b/main.tex")).toBe("meta");
    expect(classifyDiffLine("\\ No newline at end of file")).toBe("meta");
    expect(classifyDiffLine("@@ -10,4 +10,5 @@ \\section{Intro}")).toBe("hunk");
    expect(classifyDiffLine("+\\textbf{new}")).toBe("add");
    expect(classifyDiffLine("-\\textbf{old}")).toBe("del");
    expect(classifyDiffLine(" unchanged line")).toBe("ctx");
  });

  it("parses unified diffs with accurate old/new line numbers", () => {
    const raw = [
      "diff --git a/intro.tex b/intro.tex",
      "index 1111111..2222222 100644",
      "--- a/intro.tex",
      "+++ b/intro.tex",
      "@@ -3,4 +3,4 @@",
      " \\section{Intro}",
      "-Old sentence.",
      "+New sentence.",
      " End.",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(raw);
    expect(parsed).toHaveLength(9);

    expect(parsed[0]).toEqual({
      kind: "meta",
      text: "diff --git a/intro.tex b/intro.tex",
      oldLine: null,
      newLine: null,
    });
    expect(parsed[4]).toEqual({
      kind: "hunk",
      text: "@@ -3,4 +3,4 @@",
      oldLine: null,
      newLine: null,
    });
    expect(parsed[5]).toEqual({
      kind: "ctx",
      text: " \\section{Intro}",
      oldLine: 3,
      newLine: 3,
    });
    expect(parsed[6]).toEqual({
      kind: "del",
      text: "-Old sentence.",
      oldLine: 4,
      newLine: null,
    });
    expect(parsed[7]).toEqual({
      kind: "add",
      text: "+New sentence.",
      oldLine: null,
      newLine: 4,
    });
    expect(parsed[8]).toEqual({
      kind: "ctx",
      text: " End.",
      oldLine: 5,
      newLine: 5,
    });
  });

  it("returns empty array for empty or whitespace-only diffs", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("   \n")).toEqual([]);
  });
});

describe("path and date helpers", () => {
  it("strips repo prefix for submodule files only", () => {
    expect(formatRelativeRepoPath("papers/icml/intro.tex", "papers/icml")).toBe("intro.tex");
    expect(formatRelativeRepoPath("README.md", "")).toBe("README.md");
    expect(formatRelativeRepoPath("other/file.tex", "papers/icml")).toBe("other/file.tex");
  });

  it("formats valid ISO commit dates and falls back on invalid strings", () => {
    expect(formatCommitDate("2025-05-09T14:07:00Z")).toMatch(/^\d{2}\.\d{2}\.2025 \d{2}:\d{2}$/);
    expect(formatCommitDate("not-a-date")).toBe("not-a-date");
  });
});

describe("coAuthorsOfRepo", () => {
  const detected = { repo: "paper", list: [{ username: "bob", display_name: "Bob" }] };

  it("returns the list for the repo it was loaded for", () => {
    expect(coAuthorsOfRepo(detected, "paper")).toEqual(detected.list);
  });

  it("returns nothing after switching repos, before the new request resolves", () => {
    expect(coAuthorsOfRepo(detected, "")).toEqual([]);
    // so the commit sends no explicit co_authors and the server detects them itself
    expect(coAuthorsForCommit(coAuthorsOfRepo(detected, ""), new Set(["bob"]))).toBeUndefined();
  });
});

describe("statusOfRepo", () => {
  const status = { repo: "paper", files: [{ path: "paper/main.tex" }] };

  it("keeps the status of the active repo", () => {
    expect(statusOfRepo(status, "paper")).toBe(status);
  });

  it("hides a status that has not caught up with a repo switch", () => {
    // no files → no selected paths → commit button disabled, no co-author request
    expect(statusOfRepo(status, "")).toBeNull();
    expect(statusOfRepo(null, "paper")).toBeNull();
  });
});
