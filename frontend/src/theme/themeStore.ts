import { useEffect, useState } from "preact/hooks";

export type AppThemeMode = "system" | "light" | "dark";
export type ResolvedAppTheme = "light" | "dark";

export type EditorThemeId =
  | "one-dark"
  | "dracula"
  | "monokai"
  | "nord"
  | "overleaf-light"
  | "github-light"
  | "solarized-light"
  | "one-light";

export const APP_THEME_STORAGE_KEY = "undertree.app-theme.v1";
export const EDITOR_THEME_STORAGE_KEY = "undertree.editor-theme.v1";

const VALID_APP_THEMES: ReadonlySet<string> = new Set<AppThemeMode>(["system", "light", "dark"]);

const VALID_EDITOR_THEMES: ReadonlySet<string> = new Set<EditorThemeId>([
  "one-dark",
  "dracula",
  "monokai",
  "nord",
  "overleaf-light",
  "github-light",
  "solarized-light",
  "one-light",
]);

export interface ThemeSettingsSnapshot {
  appTheme: AppThemeMode;
  resolvedAppTheme: ResolvedAppTheme;
  editorTheme: EditorThemeId;
}

type ThemeListener = (snapshot: ThemeSettingsSnapshot) => void;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function isAppThemeMode(value: unknown): value is AppThemeMode {
  return typeof value === "string" && VALID_APP_THEMES.has(value);
}

export function isEditorThemeId(value: unknown): value is EditorThemeId {
  return typeof value === "string" && VALID_EDITOR_THEMES.has(value);
}

export function resolveAppTheme(
  mode: AppThemeMode,
  systemPrefersDark: boolean
): ResolvedAppTheme {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  return systemPrefersDark ? "dark" : "light";
}

export function defaultEditorThemeFor(resolved: ResolvedAppTheme): EditorThemeId {
  return resolved === "light" ? "overleaf-light" : "one-dark";
}

export function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredAppTheme(storage: StorageLike | null = getBrowserStorage()): AppThemeMode {
  if (!storage) return "system";
  try {
    const raw = storage.getItem(APP_THEME_STORAGE_KEY);
    return isAppThemeMode(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function readStoredEditorTheme(
  storage: StorageLike | null = getBrowserStorage()
): EditorThemeId | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(EDITOR_THEME_STORAGE_KEY);
    return isEditorThemeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string, storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore quota/privacy-mode errors
  }
}

export function applyAppTheme(
  mode: AppThemeMode,
  systemPrefersDark: boolean = getSystemPrefersDark()
): ResolvedAppTheme {
  const resolved = resolveAppTheme(mode, systemPrefersDark);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  return resolved;
}

let currentSnapshot: ThemeSettingsSnapshot = {
  appTheme: "system",
  resolvedAppTheme: "dark",
  editorTheme: "one-dark",
};

const listeners = new Set<ThemeListener>();
let detachMediaListener: (() => void) | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener(currentSnapshot);
  }
}

export function getThemeSettings(): ThemeSettingsSnapshot {
  return currentSnapshot;
}

export function subscribeThemeSettings(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAppTheme(mode: AppThemeMode): void {
  if (!isAppThemeMode(mode)) return;
  writeStorageItem(APP_THEME_STORAGE_KEY, mode);
  const resolved = applyAppTheme(mode);
  if (
    currentSnapshot.appTheme === mode &&
    currentSnapshot.resolvedAppTheme === resolved
  ) {
    return;
  }
  currentSnapshot = {
    ...currentSnapshot,
    appTheme: mode,
    resolvedAppTheme: resolved,
  };
  notify();
}

export function setEditorTheme(id: EditorThemeId): void {
  if (!isEditorThemeId(id)) return;
  writeStorageItem(EDITOR_THEME_STORAGE_KEY, id);
  if (currentSnapshot.editorTheme === id) {
    return;
  }
  currentSnapshot = {
    ...currentSnapshot,
    editorTheme: id,
  };
  notify();
}

export function initTheme(): () => void {
  if (detachMediaListener) {
    detachMediaListener();
    detachMediaListener = null;
  }

  const appTheme = readStoredAppTheme();
  const prefersDark = getSystemPrefersDark();
  const resolvedAppTheme = applyAppTheme(appTheme, prefersDark);
  const storedEditor = readStoredEditorTheme();
  const editorTheme = storedEditor ?? defaultEditorThemeFor(resolvedAppTheme);

  currentSnapshot = {
    appTheme,
    resolvedAppTheme,
    editorTheme,
  };
  notify();

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      if (currentSnapshot.appTheme !== "system") return;
      const nextResolved = applyAppTheme("system", event.matches);
      if (nextResolved !== currentSnapshot.resolvedAppTheme) {
        currentSnapshot = {
          ...currentSnapshot,
          resolvedAppTheme: nextResolved,
        };
        notify();
      }
    };
    media.addEventListener("change", onChange);
    detachMediaListener = () => {
      media.removeEventListener("change", onChange);
    };
    return () => {
      if (detachMediaListener) {
        detachMediaListener();
        detachMediaListener = null;
      }
    };
  }

  return () => {};
}

export function useThemeSettings() {
  const [snapshot, setSnapshot] = useState<ThemeSettingsSnapshot>(() => getThemeSettings());

  useEffect(() => {
    setSnapshot(getThemeSettings());
    return subscribeThemeSettings(setSnapshot);
  }, []);

  return {
    appTheme: snapshot.appTheme,
    resolvedAppTheme: snapshot.resolvedAppTheme,
    editorTheme: snapshot.editorTheme,
    setAppTheme,
    setEditorTheme,
  };
}
