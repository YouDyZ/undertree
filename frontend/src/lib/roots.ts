import { ApiError, type FixedTexCompiler, type RootFile, type TexCompiler } from "../api";

const ENGINE_LABELS: Record<TexCompiler, string> = {
  auto: "Automatisch",
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};

const ROOT_STORAGE_PREFIX = "undertree.selected-root.v1.";

function getStorage(): Storage | null {
  try {
    if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) {
      return null;
    }
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function pathDepth(path: string): number {
  let depth = 0;
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] === "/") depth += 1;
  }
  return depth;
}

function isMainTex(path: string): boolean {
  return basename(path).toLowerCase() === "main.tex";
}

export function formatEngineLabel(engine: FixedTexCompiler | TexCompiler): string {
  return ENGINE_LABELS[engine];
}

export function formatEngineReason(reason: string): string {
  if (reason === "magic_comment") {
    return "über % !TEX program";
  }
  if (reason === "default") {
    return "Standard";
  }
  if (reason === "fixed") {
    return "fest eingestellt";
  }
  if (reason.startsWith("package:")) {
    const pkg = reason.slice("package:".length).trim();
    return pkg ? `wegen ${pkg}` : "Standard";
  }
  return reason || "Standard";
}

export function formatAutoCompilerStatus(engine: FixedTexCompiler, reason: string): string {
  return `Automatisch (erkannt: ${formatEngineLabel(engine)}, ${formatEngineReason(reason)})`;
}

export function formatDetectedEngineBadge(engine: FixedTexCompiler, reason?: string): string {
  if (reason && reason !== "fixed") {
    return `${formatEngineLabel(engine)} (${formatEngineReason(reason)})`;
  }
  return formatEngineLabel(engine);
}

export function loadSavedProjectRoot(pid: number): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(`${ROOT_STORAGE_PREFIX}${pid}`);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveProjectRoot(pid: number, root: string | null): void {
  const storage = getStorage();
  if (!storage) return;
  const key = `${ROOT_STORAGE_PREFIX}${pid}`;
  try {
    if (!root) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, root);
    }
  } catch {
    // Ignore quota or private-browsing storage errors
  }
}

/** Project main files (`Project.main_files`) with `path` first; the others keep their order. */
export function withMainFileFirst(files: readonly string[], path: string): string[] {
  return [path, ...files.filter((f) => f !== path)];
}

/** Adds (at the end) or removes `path` from the main files. */
export function toggleMainFile(
  files: readonly string[],
  path: string,
  checked: boolean
): string[] {
  const rest = files.filter((f) => f !== path);
  return checked ? [...rest, path] : rest;
}

/** Roots to offer as main files: all detected ones plus stale entries, so they can be unchecked. */
export function mainFileOptions(
  roots: readonly RootFile[],
  mainFiles: readonly string[]
): string[] {
  const paths = roots.map((r) => r.path);
  return [...paths, ...mainFiles.filter((f) => !paths.includes(f))];
}

/**
 * The local view choice worth remembering: the project's first main file is the default anyway,
 * so selecting it clears the override and later main file changes apply on this device too.
 */
export function viewRootToStore(root: string | null, mainFiles: readonly string[]): string | null {
  return root !== null && root === mainFiles[0] ? null : root;
}

export function pickProjectRoot(
  roots: readonly RootFile[],
  savedRoot: string | null,
  currentRoot: string | null,
  mainFiles: readonly string[] = []
): string | null {
  if (roots.length === 0) return null;

  if (currentRoot && roots.some((r) => r.path === currentRoot)) {
    return currentRoot;
  }

  if (savedRoot && roots.some((r) => r.path === savedRoot)) {
    return savedRoot;
  }

  const mainFile = mainFiles.find((m) => roots.some((r) => r.path === m));
  if (mainFile) {
    return mainFile;
  }

  let bestMain: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const root of roots) {
    if (!isMainTex(root.path)) continue;
    const depth = pathDepth(root.path);
    if (depth < bestDepth) {
      bestDepth = depth;
      bestMain = root.path;
    }
  }
  if (bestMain !== null) {
    return bestMain;
  }

  return roots[0]?.path ?? null;
}

export function formatCompileError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "no_root") {
      return "Keine zugehörige LaTeX-Root-Datei gefunden.";
    }
    if (err.status === 404) {
      return err.message || "Datei oder Projekt nicht gefunden.";
    }
    return err.message || "Kompilierung konnte nicht gestartet werden.";
  }

  if (err instanceof Error && err.message) {
    return err.message;
  }

  return "Kompilierung konnte nicht gestartet werden.";
}

export type RootSelectorState = "select" | "single" | "loading" | "error" | "empty";

/**
 * Prevents an initial GET /compile?root=... fetch from overwriting an active or
 * newly queued compile state (e.g. when Ctrl+S resolved an included file to another root).
 */
export function shouldApplyInitialCompileFetch(opts: {
  isPendingQueued: boolean;
  activeCompileQueuedAtMs: number | null;
  fetchGen: number;
  currentGen: number;
}): boolean {
  return (
    !opts.isPendingQueued &&
    opts.activeCompileQueuedAtMs === null &&
    opts.fetchGen === opts.currentGen
  );
}

/**
 * Resolves the toolbar root control state so API errors never render a permanent loading pill.
 */
export function resolveRootSelectorState(opts: {
  rootsCount: number;
  loading: boolean;
  error: string | null;
}): RootSelectorState {
  if (opts.rootsCount > 1) return "select";
  if (opts.rootsCount === 1) return "single";
  if (opts.loading) return "loading";
  if (opts.error) return "error";
  return "empty";
}
