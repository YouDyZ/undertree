import { afterEach, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { EDITOR_THEMES, getEditorThemeExtension } from "./editorThemes";
import {
  APP_THEME_STORAGE_KEY,
  EDITOR_THEME_STORAGE_KEY,
  applyAppTheme,
  defaultEditorThemeFor,
  getThemeSettings,
  initTheme,
  readStoredAppTheme,
  readStoredEditorTheme,
  resolveAppTheme,
  setAppTheme,
  setEditorTheme,
  subscribeThemeSettings,
} from "./themeStore";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function stubBrowserEnv(prefersDark: boolean) {
  const storage = new MemoryStorage();
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    },
  };

  const docEl = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
  };

  vi.stubGlobal("window", {
    localStorage: storage,
    matchMedia: () => mediaQuery,
  });
  vi.stubGlobal("document", {
    documentElement: docEl,
  });

  const emitSystemChange = (nextDark: boolean) => {
    mediaQuery.matches = nextDark;
    for (const cb of listeners) {
      cb({ matches: nextDark } as MediaQueryListEvent);
    }
  };

  return { storage, docEl, emitSystemChange };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("themeStore", () => {
  it("resolves app theme modes correctly against system preference", () => {
    expect(resolveAppTheme("system", true)).toBe("dark");
    expect(resolveAppTheme("system", false)).toBe("light");
    expect(resolveAppTheme("light", true)).toBe("light");
    expect(resolveAppTheme("light", false)).toBe("light");
    expect(resolveAppTheme("dark", true)).toBe("dark");
    expect(resolveAppTheme("dark", false)).toBe("dark");
  });

  it("reads valid stored themes and falls back safely on invalid values", () => {
    const storage = new MemoryStorage();
    expect(readStoredAppTheme(storage)).toBe("system");
    expect(readStoredEditorTheme(storage)).toBeNull();

    storage.setItem(APP_THEME_STORAGE_KEY, "light");
    storage.setItem(EDITOR_THEME_STORAGE_KEY, "solarized-light");
    expect(readStoredAppTheme(storage)).toBe("light");
    expect(readStoredEditorTheme(storage)).toBe("solarized-light");

    storage.setItem(APP_THEME_STORAGE_KEY, "sepia-invalid");
    storage.setItem(EDITOR_THEME_STORAGE_KEY, "nonexistent-theme");
    expect(readStoredAppTheme(storage)).toBe("system");
    expect(readStoredEditorTheme(storage)).toBeNull();
  });

  it("applies dataset.theme and colorScheme on documentElement", () => {
    const { docEl } = stubBrowserEnv(false);
    expect(applyAppTheme("dark", false)).toBe("dark");
    expect(docEl.dataset.theme).toBe("dark");
    expect(docEl.style.colorScheme).toBe("dark");

    expect(applyAppTheme("system", false)).toBe("light");
    expect(docEl.dataset.theme).toBe("light");
    expect(docEl.style.colorScheme).toBe("light");
  });

  it("initializes defaults, persists app & editor theme independently, and reacts to system changes", () => {
    const { storage, docEl, emitSystemChange } = stubBrowserEnv(false);
    const cleanup = initTheme();

    // First load with system light and empty storage -> light UI + light default editor theme
    expect(getThemeSettings()).toEqual({
      appTheme: "system",
      resolvedAppTheme: "light",
      editorTheme: defaultEditorThemeFor("light"),
    });
    expect(docEl.dataset.theme).toBe("light");

    // Pick a dark editor theme while keeping light UI (Overleaf-style independence)
    const seen: string[] = [];
    const unsub = subscribeThemeSettings((snap) => {
      seen.push(`${snap.appTheme}:${snap.resolvedAppTheme}:${snap.editorTheme}`);
    });

    setEditorTheme("dracula");
    expect(storage.getItem(EDITOR_THEME_STORAGE_KEY)).toBe("dracula");
    expect(getThemeSettings().editorTheme).toBe("dracula");
    expect(getThemeSettings().resolvedAppTheme).toBe("light");

    // Live OS dark-mode switch while appTheme === "system"
    emitSystemChange(true);
    expect(getThemeSettings().resolvedAppTheme).toBe("dark");
    expect(docEl.dataset.theme).toBe("dark");
    expect(getThemeSettings().editorTheme).toBe("dracula");

    // Explicit appTheme overrides system changes
    setAppTheme("light");
    expect(storage.getItem(APP_THEME_STORAGE_KEY)).toBe("light");
    expect(docEl.dataset.theme).toBe("light");

    emitSystemChange(true);
    expect(getThemeSettings().resolvedAppTheme).toBe("light");
    expect(seen).toContain("system:light:dracula");
    expect(seen).toContain("system:dark:dracula");
    expect(seen).toContain("light:light:dracula");

    unsub();
    cleanup();
  });
});

describe("editorThemes", () => {
  it("exposes all 8 themes split evenly into dark and light groups with swatches", () => {
    expect(EDITOR_THEMES).toHaveLength(8);
    const ids = EDITOR_THEMES.map((t) => t.id);
    expect(ids).toEqual([
      "one-dark",
      "dracula",
      "monokai",
      "nord",
      "overleaf-light",
      "github-light",
      "solarized-light",
      "one-light",
    ]);

    const darkThemes = EDITOR_THEMES.filter((t) => t.group === "dark");
    const lightThemes = EDITOR_THEMES.filter((t) => t.group === "light");
    expect(darkThemes).toHaveLength(4);
    expect(lightThemes).toHaveLength(4);

    for (const theme of EDITOR_THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
      expect(theme.swatch.bg).toMatch(/^#/);
      expect(theme.swatch.fg).toMatch(/^#/);
      expect(theme.swatch.accent).toMatch(/^#/);
      expect(theme.swatch.keyword).toMatch(/^#/);
    }
  });

  it("builds valid CodeMirror 6 extensions for every theme and supports live Compartment reconfiguration", () => {
    const sampleLatex = [
      "% Comment line",
      "\\documentclass[11pt]{article}",
      "\\usepackage{amsmath}",
      "\\begin{document}",
      "\\section{Introduction}\\label{sec:intro}",
      "See \\ref{sec:intro} and \\cite{knuth84}: $E = mc^2 + 42$.",
      "\\end{document}",
    ].join("\n");

    const compartment = new Compartment();
    const firstTheme = EDITOR_THEMES[0]!;
    let state = EditorState.create({
      doc: sampleLatex,
      extensions: [StreamLanguage.define(stex), compartment.of(getEditorThemeExtension(firstTheme.id))],
    });

    for (const theme of EDITOR_THEMES) {
      const ext = getEditorThemeExtension(theme.id);
      expect(ext).toBeDefined();
      const tr = state.update({
        effects: compartment.reconfigure(ext),
      });
      state = tr.state;
      expect(state.doc.toString()).toBe(sampleLatex);
    }
  });
});
