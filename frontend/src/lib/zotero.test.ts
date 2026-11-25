import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import {
  buildCollectionTree,
  flattenCollectionTree,
  formatZoteroError,
  isZoteroRowControlDisabled,
  shouldApplyProjectScopedResult,
  validateBibTargetPath,
  zoteroLinkTitle,
} from "./zotero";

describe("buildCollectionTree & flattenCollectionTree", () => {
  it("builds a deterministic sorted hierarchy and flattens with indentation", () => {
    const tree = buildCollectionTree([
      { key: "C2", name: "Zebra", parent: "R1" },
      { key: "R2", name: "Beta", parent: null },
      { key: "C1", name: "Alpha Sub", parent: "R1" },
      { key: "R1", name: "Alpha", parent: null },
      { key: "G1", name: "Deep", parent: "C1" },
    ]);

    expect(tree.map((n) => n.key)).toEqual(["R1", "R2"]);
    expect(tree[0]?.children.map((n) => n.key)).toEqual(["C1", "C2"]);
    expect(tree[0]?.children[0]?.children.map((n) => n.key)).toEqual(["G1"]);

    const flat = flattenCollectionTree(tree);
    expect(flat).toEqual([
      { key: "R1", name: "Alpha", depth: 0, label: "Alpha" },
      { key: "C1", name: "Alpha Sub", depth: 1, label: "\u00A0\u00A0└ Alpha Sub" },
      { key: "G1", name: "Deep", depth: 2, label: "\u00A0\u00A0\u00A0\u00A0└ Deep" },
      { key: "C2", name: "Zebra", depth: 1, label: "\u00A0\u00A0└ Zebra" },
      { key: "R2", name: "Beta", depth: 0, label: "Beta" },
    ]);
  });

  it("promotes items with missing parents to root level", () => {
    const tree = buildCollectionTree([
      { key: "A", name: "Orphan", parent: "MISSING" },
      { key: "B", name: "Child", parent: "A" },
    ]);

    expect(tree.map((n) => n.key)).toEqual(["A"]);
    expect(tree[0]?.children.map((n) => n.key)).toEqual(["B"]);
  });

  it("handles self-references and parent cycles without infinite loops or dropped nodes", () => {
    const tree = buildCollectionTree([
      { key: "SELF", name: "Self", parent: "SELF" },
      { key: "A", name: "Alpha", parent: "B" },
      { key: "B", name: "Beta", parent: "A" },
    ]);

    const flat = flattenCollectionTree(tree);
    expect(flat.map((x) => x.key).sort()).toEqual(["A", "B", "SELF"]);
    // Self-referential node is a root
    expect(tree.some((n) => n.key === "SELF")).toBe(true);
  });

  it("deduplicates duplicate collection keys", () => {
    const tree = buildCollectionTree([
      { key: "A", name: "First", parent: null },
      { key: "A", name: "Duplicate", parent: null },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("First");
  });
});

describe("validateBibTargetPath", () => {
  it("accepts valid workspace-relative .bib paths and trims whitespace", () => {
    expect(validateBibTargetPath("  references.bib  ")).toEqual({
      ok: true,
      path: "references.bib",
    });
    expect(validateBibTargetPath("papers/icml/refs.bib")).toEqual({
      ok: true,
      path: "papers/icml/refs.bib",
    });
    expect(validateBibTargetPath("Refs.BIB")).toEqual({
      ok: true,
      path: "Refs.BIB",
    });
  });

  it("rejects empty paths, leading slashes, traversal, invalid segments, and non-.bib suffixes", () => {
    expect(validateBibTargetPath("")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("   ")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("/references.bib")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("../references.bib")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("papers/../refs.bib")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("papers/./refs.bib")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("papers//refs.bib")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("papers\\refs.bib")).toMatchObject({ ok: false });
    expect(validateBibTargetPath(".git/refs.bib")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("references.tex")).toMatchObject({ ok: false });
    expect(validateBibTargetPath("references")).toMatchObject({ ok: false });
  });
});

describe("formatZoteroError", () => {
  it("formats Zotero API errors in clear German", () => {
    expect(
      formatZoteroError(new ApiError(400, "invalid_request", "bad key"), "Fallback", "connect")
    ).toContain("API-Key");

    expect(
      formatZoteroError(new ApiError(400, "invalid_request", "bad"), "Fallback")
    ).toContain("API-Key");

    expect(
      formatZoteroError(new ApiError(400, "zotero_forbidden", "no access"), "Fallback")
    ).toContain("Berechtigung");

    expect(
      formatZoteroError(new ApiError(413, "too_large", "limit"), "Fallback")
    ).toContain("20.000 Einträge");
    expect(
      formatZoteroError(new ApiError(413, "too_large", "limit"), "Fallback")
    ).toContain("8 MiB");

    expect(
      formatZoteroError(new ApiError(409, "conflict", "disconnected"), "Fallback")
    ).toContain("getrennt");

    expect(
      formatZoteroError(new ApiError(502, "remote_failed", "429"), "Fallback")
    ).toMatch(/nicht erreichbar|Rate-Limit/);

    expect(
      formatZoteroError(new ApiError(404, "not_found", "missing"), "Fallback")
    ).toContain("nicht gefunden");
  });

  it("handles network errors and unknown values", () => {
    expect(formatZoteroError(new TypeError("Failed to fetch"), "Fallback")).toContain("Netzwerkfehler");
    expect(formatZoteroError(new Error("boom"), "Fallback")).toBe("boom");
    expect(formatZoteroError("weird", "Fallback")).toBe("Fallback");
  });
});

describe("project-scoped Zotero loading & global busy guard", () => {
  it("ignores stale responses from another project or older generation", () => {
    expect(shouldApplyProjectScopedResult(42, 42, 3, 3)).toBe(true);
    expect(shouldApplyProjectScopedResult(41, 42, 3, 3)).toBe(false);
    expect(shouldApplyProjectScopedResult(42, 42, 2, 3)).toBe(false);
  });

  it("disables refresh/unlink across all rows while any row operation is active or disconnected", () => {
    expect(isZoteroRowControlDisabled({ refreshingPath: null, unlinkingPath: null })).toBe(false);
    expect(
      isZoteroRowControlDisabled({ refreshingPath: "refs/a.bib", unlinkingPath: null })
    ).toBe(true);
    expect(
      isZoteroRowControlDisabled({ refreshingPath: null, unlinkingPath: "refs/b.bib" })
    ).toBe(true);
    expect(
      isZoteroRowControlDisabled({ refreshingPath: null, unlinkingPath: null, disconnected: true })
    ).toBe(true);
  });
});

describe("zoteroLinkTitle", () => {
  it("shows format, last sync and the sync error", () => {
    const base = { format: "bibtex", last_synced_at: null, last_error: null };
    expect(zoteroLinkTitle(base)).toBe("Mit Zotero verknüpft (BibTeX)");
    const t = zoteroLinkTitle({
      format: "biblatex",
      last_synced_at: "2026-11-24T10:00:00Z",
      last_error: "Zotero unreachable",
    });
    expect(t).toMatch(/BibLaTeX\) — zuletzt: .*2026.* — Fehler: Zotero unreachable$/);
  });
});
