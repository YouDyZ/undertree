import type { Tree } from "../api";
import { isBibtexFile } from "./latexLanguage";

export const DEFAULT_BIB_LOAD_CONCURRENCY = 6;

export type BibTreeEntryLike = Pick<Tree["entries"][number], "kind" | "path">;

export interface SyncBibCacheOptions {
  concurrency?: number;
  isCancelled?: () => boolean;
}

/**
 * Returns all `.bib` file paths from `entries` in discovery order without truncation.
 */
export function collectBibPaths(entries: readonly BibTreeEntryLike[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "file" && isBibtexFile(entry.path)) {
      paths.push(entry.path);
    }
  }
  return paths;
}

/**
 * Synchronizes `cache` with all `.bib` files in `entries`, pruning removed paths and
 * fetching all discovered `.bib` files using a bounded worker pool.
 */
export async function syncBibCache(
  entries: readonly BibTreeEntryLike[],
  cache: Map<string, string>,
  loadFile: (path: string) => Promise<string>,
  options: SyncBibCacheOptions = {}
): Promise<void> {
  const bibPaths = collectBibPaths(entries);
  const validPaths = new Set(bibPaths);
  for (const cachedPath of cache.keys()) {
    if (!validPaths.has(cachedPath)) {
      cache.delete(cachedPath);
    }
  }

  if (bibPaths.length === 0) return;

  const isCancelled = options.isCancelled ?? (() => false);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? DEFAULT_BIB_LOAD_CONCURRENCY, bibPaths.length)
  );
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (!isCancelled()) {
      const idx = nextIndex++;
      if (idx >= bibPaths.length) return;
      const path = bibPaths[idx]!;
      try {
        const text = await loadFile(path);
        if (!isCancelled()) {
          cache.set(path, text);
        }
      } catch {
        // Non-blocking background load for citation completions
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
