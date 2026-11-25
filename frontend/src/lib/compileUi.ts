import type { Diagnostic, DiagnosticSeverity, Repo, Tree } from "../api";
import { isTexFile } from "./tree";

export interface DiagnosticsSummary {
  errors: number;
  warnings: number;
  badboxes: number;
  total: number;
  sorted: Diagnostic[];
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  badbox: 2,
};

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

function isMainTex(path: string): boolean {
  return basename(path).toLowerCase() === "main.tex";
}

function pathDepth(path: string): number {
  let depth = 0;
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] === "/") depth += 1;
  }
  return depth;
}

function findRepoForPath(repos: Repo[], path: string): string {
  let best = "";
  for (const repo of repos) {
    if (repo.kind === "submodule" && repo.path) {
      if (path === repo.path || path.startsWith(`${repo.path}/`)) {
        if (repo.path.length > best.length) {
          best = repo.path;
        }
      }
    }
  }
  return best;
}

/**
 * Returns a sorted list of all `.tex` files in the workspace.
 * `main.tex` files are prioritized ahead of other `.tex` files (shallower first).
 */
export function listTexRoots(tree: Tree | null): string[] {
  if (!tree) return [];

  const seen = new Set<string>();
  const texFiles: string[] = [];
  for (const entry of tree.entries) {
    if (entry.kind === "file" && isTexFile(entry.path) && !seen.has(entry.path)) {
      seen.add(entry.path);
      texFiles.push(entry.path);
    }
  }

  texFiles.sort((a, b) => {
    const aMain = isMainTex(a);
    const bMain = isMainTex(b);
    if (aMain !== bMain) return aMain ? -1 : 1;
    if (aMain && bMain) {
      const depthDiff = pathDepth(a) - pathDepth(b);
      if (depthDiff !== 0) return depthDiff;
    }
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });

  return texFiles;
}

/**
 * Picks the default LaTeX root file according to priority:
 * 1. Keep `currentRoot` if it still exists in `roots`.
 * 2. Use `activePath` if it is itself a `.tex` file in `roots`.
 * 3. Prefer a `main.tex` in the same repo (and closest ancestor directory) as `activePath`.
 * 4. Fall back to the first `.tex` file in `roots`.
 */
export function pickDefaultRoot(
  roots: string[],
  activePath: string | null,
  currentRoot: string | null,
  tree?: Tree | null
): string | null {
  if (roots.length === 0) return null;

  if (currentRoot && roots.includes(currentRoot)) {
    return currentRoot;
  }

  if (activePath && isTexFile(activePath) && roots.includes(activePath)) {
    return activePath;
  }

  if (activePath) {
    const mainRoots = roots.filter(isMainTex);
    if (mainRoots.length > 0) {
      let scopedMains = mainRoots;
      if (tree) {
        const activeRepo = findRepoForPath(tree.repos, activePath);
        scopedMains = mainRoots.filter(
          (candidate) => findRepoForPath(tree.repos, candidate) === activeRepo
        );
      }

      if (scopedMains.length > 0) {
        // Walk ancestor directories from innermost to outermost.
        let dir = dirname(activePath);
        while (true) {
          const match = scopedMains.find((candidate) => dirname(candidate) === dir);
          if (match) return match;
          if (!dir) break;
          dir = dirname(dir);
        }

        // Fallback: main.tex sharing the longest directory prefix with activePath
        // (or any main.tex in the same repo when `tree` was supplied).
        const activeParts = dirname(activePath).split("/").filter(Boolean);
        let bestMatch: string | null = null;
        let bestPrefixLen = 0;
        for (const candidate of scopedMains) {
          const candParts = dirname(candidate).split("/").filter(Boolean);
          let common = 0;
          while (
            common < activeParts.length &&
            common < candParts.length &&
            activeParts[common] === candParts[common]
          ) {
            common += 1;
          }
          if (common > bestPrefixLen) {
            bestPrefixLen = common;
            bestMatch = candidate;
          }
        }
        if (bestMatch) return bestMatch;
        if (tree) return scopedMains[0] ?? null;
      }
    }
  }

  return roots[0] ?? null;
}

/**
 * Counts errors, warnings and badboxes and returns a new array sorted with
 * errors first, then warnings, then badboxes (preserving relative order within each severity).
 */
export function summarizeDiagnostics(diagnostics: Diagnostic[]): DiagnosticsSummary {
  let errors = 0;
  let warnings = 0;
  let badboxes = 0;

  for (const diag of diagnostics) {
    if (diag.severity === "error") errors += 1;
    else if (diag.severity === "warning") warnings += 1;
    else if (diag.severity === "badbox") badboxes += 1;
  }

  const sorted = [...diagnostics].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );

  return {
    errors,
    warnings,
    badboxes,
    total: diagnostics.length,
    sorted,
  };
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3.0;
export const ZOOM_STEP = 0.15;

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(scale * 100) / 100));
}

export function pdfDownloadName(root: string): string {
  const base = basename(root);
  return base.replace(/\.tex$/i, "") + ".pdf";
}


/**
 * Compares two RFC 3339 timestamps. Returns > 0 if `a` is newer than `b`,
 * < 0 if `a` is older than `b`, or 0 if equal.
 */
export function compareCompileTimestamp(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
    if (aMs !== bMs) return aMs - bMs;
  }
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/**
 * Seeds or advances the known completed-compile baseline without ever
 * downgrading a newer terminal timestamp.
 */
export function recordCompileBaseline(
  currentBaseline: string | null,
  candidateStartedAt: string
): string {
  if (currentBaseline === null) return candidateStartedAt;
  return compareCompileTimestamp(candidateStartedAt, currentBaseline) > 0
    ? candidateStartedAt
    : currentBaseline;
}

/**
 * Decides whether a `GET /api/compile` fallback-poll response represents a
 * newer compile completion rather than a stale prior build.
 */
export function shouldAcceptFallbackPollResult(
  baselineStartedAt: string | null,
  activeCompileQueuedAtMs: number | null,
  candidateStartedAt: string
): boolean {
  if (baselineStartedAt !== null) {
    return compareCompileTimestamp(candidateStartedAt, baselineStartedAt) > 0;
  }
  if (activeCompileQueuedAtMs !== null) {
    const candidateMs = Date.parse(candidateStartedAt);
    if (Number.isFinite(candidateMs) && candidateMs < activeCompileQueuedAtMs - 1000) {
      return false;
    }
  }
  return true;
}
