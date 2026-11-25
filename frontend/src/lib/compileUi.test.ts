import { describe, expect, it } from "vitest";
import type { Diagnostic, Tree } from "../api";
import {
  clampZoom,
  compareCompileTimestamp,
  listTexRoots,
  pdfDownloadName,
  pickDefaultRoot,
  recordCompileBaseline,
  shouldAcceptFallbackPollResult,
  summarizeDiagnostics,
} from "./compileUi";

const sampleTree: Tree = {
  repos: [
    {
      path: "",
      name: "research",
      kind: "parent",
      initialized: true,
      branch: "main",
      head: "1111111",
    },
    {
      path: "papers/icml",
      name: "icml",
      kind: "submodule",
      initialized: true,
      branch: "main",
      head: "2222222",
    },
    {
      path: "papers/neurips",
      name: "neurips",
      kind: "submodule",
      initialized: true,
      branch: "main",
      head: "3333333",
    },
  ],
  entries: [
    { path: "README.md", kind: "file", repo: "" },
    { path: "appendix.tex", kind: "file", repo: "" },
    { path: "main.tex", kind: "file", repo: "" },
    { path: "papers/icml/sections/intro.tex", kind: "file", repo: "papers/icml" },
    { path: "papers/icml/main.tex", kind: "file", repo: "papers/icml" },
    { path: "papers/icml/refs.bib", kind: "file", repo: "papers/icml" },
    { path: "papers/neurips/main.tex", kind: "file", repo: "papers/neurips" },
    { path: "papers/neurips/figs", kind: "dir", repo: "papers/neurips" },
    { path: "papers/neurips/figs/chart.png", kind: "file", repo: "papers/neurips" },
  ],
};

describe("listTexRoots", () => {
  it("returns empty list when tree is null", () => {
    expect(listTexRoots(null)).toEqual([]);
  });

  it("lists all .tex files with main.tex prioritized first (shallower first)", () => {
    expect(listTexRoots(sampleTree)).toEqual([
      "main.tex",
      "papers/icml/main.tex",
      "papers/neurips/main.tex",
      "appendix.tex",
      "papers/icml/sections/intro.tex",
    ]);
  });
});

describe("pickDefaultRoot", () => {
  const roots = listTexRoots(sampleTree);

  it("returns null when there are no roots", () => {
    expect(pickDefaultRoot([], "main.tex", null)).toBeNull();
  });

  it("keeps currentRoot if it still exists in roots", () => {
    expect(pickDefaultRoot(roots, "papers/icml/sections/intro.tex", "papers/neurips/main.tex")).toBe(
      "papers/neurips/main.tex"
    );
  });

  it("falls back when currentRoot is no longer present", () => {
    expect(pickDefaultRoot(roots, "papers/icml/sections/intro.tex", "deleted/main.tex")).toBe(
      "papers/icml/sections/intro.tex"
    );
  });

  it("picks the active .tex file when no valid currentRoot is set", () => {
    expect(pickDefaultRoot(roots, "appendix.tex", null)).toBe("appendix.tex");
  });

  it("picks main.tex in the same repo/submodule when activePath is a non-tex file", () => {
    expect(pickDefaultRoot(roots, "papers/icml/refs.bib", null)).toBe("papers/icml/main.tex");
    expect(pickDefaultRoot(roots, "papers/neurips/figs/chart.png", null)).toBe(
      "papers/neurips/main.tex"
    );
    expect(pickDefaultRoot(roots, "papers/neurips/figs/chart.png", null, sampleTree)).toBe(
      "papers/neurips/main.tex"
    );
  });

  it("respects repo boundaries when tree metadata is provided", () => {
    const subOnlyRoots = ["papers/icml/main.tex", "docs/main.tex"];
    const treeWithDocs: Tree = {
      repos: sampleTree.repos,
      entries: [
        { path: "papers/icml/main.tex", kind: "file", repo: "papers/icml" },
        { path: "docs/main.tex", kind: "file", repo: "" },
        { path: "notes/todo.md", kind: "file", repo: "" },
      ],
    };
    expect(pickDefaultRoot(subOnlyRoots, "notes/todo.md", null, treeWithDocs)).toBe(
      "docs/main.tex"
    );
  });

  it("falls back to the first root when no activePath is open", () => {
    expect(pickDefaultRoot(roots, null, null)).toBe("main.tex");
  });
});

describe("summarizeDiagnostics", () => {
  it("counts severities and sorts errors before warnings before badboxes stably", () => {
    const input: Diagnostic[] = [
      { severity: "badbox", file: "main.tex", line: 10, message: "Overfull \\hbox" },
      { severity: "warning", file: "main.tex", line: 5, message: "Citation undefined" },
      { severity: "error", file: "intro.tex", line: 42, message: "Undefined control sequence" },
      { severity: "warning", file: "intro.tex", line: 12, message: "Reference undefined" },
      { severity: "error", file: "main.tex", line: 3, message: "Missing $ inserted" },
    ];

    const summary = summarizeDiagnostics(input);
    expect(summary.errors).toBe(2);
    expect(summary.warnings).toBe(2);
    expect(summary.badboxes).toBe(1);
    expect(summary.total).toBe(5);
    expect(summary.sorted.map((d) => `${d.severity}:${d.line}`)).toEqual([
      "error:42",
      "error:3",
      "warning:5",
      "warning:12",
      "badbox:10",
    ]);
    // Must not mutate input
    expect(input[0]?.severity).toBe("badbox");
  });

  it("handles empty diagnostics", () => {
    expect(summarizeDiagnostics([])).toEqual({
      errors: 0,
      warnings: 0,
      badboxes: 0,
      total: 0,
      sorted: [],
    });
  });
});

describe("zoom & filename helpers", () => {
  it("clamps zoom to valid bounds", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(5)).toBe(3);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("derives pdf download filename from tex root", () => {
    expect(pdfDownloadName("papers/icml/main.tex")).toBe("main.pdf");
    expect(pdfDownloadName("Thesis.TEX")).toBe("Thesis.pdf");
  });
});


describe("compile fallback poll baseline reconciliation (#30)", () => {
  it("rejects stale prior result when queued event arrives before delayed initial GET", () => {
    const priorStartedAt = "2026-11-23T15:00:00.000Z";
    const queuedAtMs = Date.parse("2026-11-23T15:05:00.000Z");
    const newStartedAt = "2026-11-23T15:05:01.000Z";

    // Case A: delayed initial GET arrives AFTER queued event and seeds baseline without touching UI
    let baseline: string | null = null;
    baseline = recordCompileBaseline(baseline, priorStartedAt);
    expect(baseline).toBe(priorStartedAt);

    // Fallback poll returns the old prior result -> must be rejected
    expect(shouldAcceptFallbackPollResult(baseline, queuedAtMs, priorStartedAt)).toBe(false);

    // Fallback poll returns the new compile result -> accepted
    expect(shouldAcceptFallbackPollResult(baseline, queuedAtMs, newStartedAt)).toBe(true);

    // Case B: even if initial GET never returned at all, old prior result before queuedAtMs is rejected
    expect(shouldAcceptFallbackPollResult(null, queuedAtMs, priorStartedAt)).toBe(false);
    expect(shouldAcceptFallbackPollResult(null, queuedAtMs, newStartedAt)).toBe(true);
  });

  it("never downgrades a newer terminal baseline with a stale GET response", () => {
    const priorStartedAt = "2026-11-23T15:00:00.000Z";
    const newerTerminalAt = "2026-11-23T15:05:01.000Z";

    const baseline = recordCompileBaseline(newerTerminalAt, priorStartedAt);
    expect(baseline).toBe(newerTerminalAt);
    expect(compareCompileTimestamp(priorStartedAt, newerTerminalAt)).toBeLessThan(0);
  });
});
