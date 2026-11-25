import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RootFile } from "../api";
import {
  formatAutoCompilerStatus,
  formatCompileError,
  formatDetectedEngineBadge,
  formatEngineLabel,
  formatEngineReason,
  loadSavedProjectRoot,
  mainFileOptions,
  pickProjectRoot,
  resolveRootSelectorState,
  saveProjectRoot,
  shouldApplyInitialCompileFetch,
  toggleMainFile,
  viewRootToStore,
  withMainFileFirst,
} from "./roots";

const root = (path: string, repo = "", engine: RootFile["engine"] = "pdflatex", reason = "default"): RootFile => ({
  path,
  repo,
  engine,
  reason,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engine formatting", () => {
  it("formats compiler and fixed engine labels", () => {
    expect(formatEngineLabel("auto")).toBe("Automatisch");
    expect(formatEngineLabel("pdflatex")).toBe("pdfLaTeX");
    expect(formatEngineLabel("xelatex")).toBe("XeLaTeX");
    expect(formatEngineLabel("lualatex")).toBe("LuaLaTeX");
  });

  it("formats detection reasons", () => {
    expect(formatEngineReason("magic_comment")).toBe("über % !TEX program");
    expect(formatEngineReason("package:fontspec")).toBe("wegen fontspec");
    expect(formatEngineReason("package:luacode")).toBe("wegen luacode");
    expect(formatEngineReason("package:")).toBe("Standard");
    expect(formatEngineReason("default")).toBe("Standard");
    expect(formatEngineReason("fixed")).toBe("fest eingestellt");
    expect(formatEngineReason("custom_reason")).toBe("custom_reason");
  });

  it("formats auto compiler status and detected engine badge", () => {
    expect(formatAutoCompilerStatus("xelatex", "package:fontspec")).toBe(
      "Automatisch (erkannt: XeLaTeX, wegen fontspec)"
    );
    expect(formatAutoCompilerStatus("lualatex", "magic_comment")).toBe(
      "Automatisch (erkannt: LuaLaTeX, über % !TEX program)"
    );
    expect(formatDetectedEngineBadge("xelatex", "package:fontspec")).toBe(
      "XeLaTeX (wegen fontspec)"
    );
    expect(formatDetectedEngineBadge("pdflatex", "fixed")).toBe("pdfLaTeX");
    expect(formatDetectedEngineBadge("pdflatex")).toBe("pdfLaTeX");
  });
});

describe("saved project root storage", () => {
  it("saves, loads, and clears per-project root selection", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });

    expect(loadSavedProjectRoot(7)).toBeNull();

    saveProjectRoot(7, "papers/icml/main.tex");
    saveProjectRoot(8, "thesis.tex");
    expect(store.get("undertree.selected-root.v1.7")).toBe("papers/icml/main.tex");
    expect(loadSavedProjectRoot(7)).toBe("papers/icml/main.tex");
    expect(loadSavedProjectRoot(8)).toBe("thesis.tex");

    saveProjectRoot(7, null);
    expect(loadSavedProjectRoot(7)).toBeNull();
    expect(loadSavedProjectRoot(8)).toBe("thesis.tex");
  });

  it("handles missing or throwing localStorage gracefully", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });

    expect(loadSavedProjectRoot(1)).toBeNull();
    expect(() => saveProjectRoot(1, "main.tex")).not.toThrow();
    expect(() => saveProjectRoot(1, null)).not.toThrow();
  });
});

describe("pickProjectRoot", () => {
  it("returns null when there are no roots", () => {
    expect(pickProjectRoot([], "main.tex", "other.tex")).toBeNull();
  });

  it("keeps currentRoot if it is still present", () => {
    const roots = [root("a/thesis.tex"), root("main.tex"), root("papers/icml/main.tex", "papers/icml")];
    expect(pickProjectRoot(roots, "main.tex", "a/thesis.tex")).toBe("a/thesis.tex");
  });

  it("falls back to savedRoot when currentRoot is absent or stale", () => {
    const roots = [root("a/thesis.tex"), root("main.tex"), root("papers/icml/main.tex", "papers/icml")];
    expect(pickProjectRoot(roots, "papers/icml/main.tex", "deleted.tex")).toBe("papers/icml/main.tex");
    expect(pickProjectRoot(roots, "papers/icml/main.tex", null)).toBe("papers/icml/main.tex");
  });

  it("prefers shallowest main.tex when neither currentRoot nor savedRoot matches", () => {
    const roots = [
      root("appendix.tex"),
      root("a/deep/nested/main.tex"),
      root("papers/icml/main.tex", "papers/icml"),
      root("papers/neurips/main.tex", "papers/neurips"),
    ];
    expect(pickProjectRoot(roots, "gone.tex", null)).toBe("papers/icml/main.tex");

    const withTopMain = [...roots, root("main.tex")];
    expect(pickProjectRoot(withTopMain, null, null)).toBe("main.tex");
  });

  it("falls back to the first root when no main.tex exists", () => {
    const roots = [root("article.tex"), root("slides/deck.tex")];
    expect(pickProjectRoot(roots, null, null)).toBe("article.tex");
  });
});

describe("formatCompileError", () => {
  it("formats no_root and other API/generic errors cleanly in German", () => {
    expect(formatCompileError(new ApiError(400, "no_root", "no root"))).toBe(
      "Keine zugehörige LaTeX-Root-Datei gefunden."
    );
    expect(formatCompileError(new ApiError(404, "not_found", "Datei fehlt"))).toBe("Datei fehlt");
    expect(formatCompileError(new Error("Netzwerkfehler"))).toBe("Netzwerkfehler");
    expect(formatCompileError("unexpected")).toBe("Kompilierung konnte nicht gestartet werden.");
  });
});

describe("shouldApplyInitialCompileFetch", () => {
  it("ignores fetched terminal compile state while a pending queued compile/root is active", () => {
    expect(
      shouldApplyInitialCompileFetch({
        isPendingQueued: true,
        activeCompileQueuedAtMs: 1000,
        fetchGen: 2,
        currentGen: 2,
      })
    ).toBe(false);

    expect(
      shouldApplyInitialCompileFetch({
        isPendingQueued: false,
        activeCompileQueuedAtMs: 1000,
        fetchGen: 2,
        currentGen: 2,
      })
    ).toBe(false);

    expect(
      shouldApplyInitialCompileFetch({
        isPendingQueued: false,
        activeCompileQueuedAtMs: null,
        fetchGen: 1,
        currentGen: 2,
      })
    ).toBe(false);

    expect(
      shouldApplyInitialCompileFetch({
        isPendingQueued: false,
        activeCompileQueuedAtMs: null,
        fetchGen: 2,
        currentGen: 2,
      })
    ).toBe(true);
  });
});

describe("resolveRootSelectorState", () => {
  it("exposes error state on failed initial load instead of remaining in permanent loading", () => {
    expect(resolveRootSelectorState({ rootsCount: 0, loading: true, error: null })).toBe("loading");
    expect(resolveRootSelectorState({ rootsCount: 0, loading: false, error: "Netzwerkfehler" })).toBe(
      "error"
    );
    expect(resolveRootSelectorState({ rootsCount: 0, loading: false, error: null })).toBe("empty");
    expect(resolveRootSelectorState({ rootsCount: 1, loading: false, error: null })).toBe("single");
    expect(resolveRootSelectorState({ rootsCount: 2, loading: false, error: null })).toBe("select");
  });
});

describe("main files", () => {
  it("pickProjectRoot prefers the first existing main file over auto detection", () => {
    const roots = [root("main.tex"), root("papers/a/paper.tex", "papers/a")];
    expect(pickProjectRoot(roots, null, null, ["gone.tex", "papers/a/paper.tex"])).toBe(
      "papers/a/paper.tex"
    );
    // a local view choice still wins, no main file falls back to auto detection
    expect(pickProjectRoot(roots, "main.tex", null, ["papers/a/paper.tex"])).toBe("main.tex");
    expect(pickProjectRoot(roots, null, null, [])).toBe("main.tex");
  });

  it("withMainFileFirst moves or adds to the front", () => {
    expect(withMainFileFirst(["a.tex", "b.tex"], "b.tex")).toEqual(["b.tex", "a.tex"]);
    expect(withMainFileFirst(["a.tex"], "c.tex")).toEqual(["c.tex", "a.tex"]);
    expect(withMainFileFirst([], "a.tex")).toEqual(["a.tex"]);
  });

  it("toggleMainFile appends or removes", () => {
    expect(toggleMainFile(["a.tex"], "b.tex", true)).toEqual(["a.tex", "b.tex"]);
    expect(toggleMainFile(["a.tex", "b.tex"], "a.tex", false)).toEqual(["b.tex"]);
    expect(toggleMainFile(["a.tex"], "a.tex", true)).toEqual(["a.tex"]);
  });

  it("mainFileOptions keeps stale entries unchecked-able", () => {
    expect(mainFileOptions([root("a.tex"), root("b.tex")], ["b.tex", "old.tex"])).toEqual([
      "a.tex",
      "b.tex",
      "old.tex",
    ]);
  });

  it("viewRootToStore clears the override for the default main file", () => {
    expect(viewRootToStore("a.tex", ["a.tex", "b.tex"])).toBeNull();
    expect(viewRootToStore("b.tex", ["a.tex", "b.tex"])).toBe("b.tex");
    expect(viewRootToStore("a.tex", [])).toBe("a.tex");
    expect(viewRootToStore(null, [])).toBeNull();
  });
});
