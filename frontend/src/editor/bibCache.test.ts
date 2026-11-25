import { describe, expect, it } from "vitest";
import { type BibTreeEntryLike, collectBibPaths, syncBibCache } from "./bibCache";
import { extractBibEntries } from "./latexCompletion";

describe("bibCache", () => {
  it("loads all discovered .bib files beyond 20 with bounded concurrency", async () => {
    const entries: BibTreeEntryLike[] = [
      { kind: "file", path: "main.tex" },
      ...Array.from({ length: 25 }, (_, i) => ({
        kind: "file" as const,
        path: `refs/chapter-${String(i + 1).padStart(2, "0")}.bib`,
      })),
    ];

    expect(collectBibPaths(entries)).toHaveLength(25);

    const cache = new Map<string, string>();
    let active = 0;
    let maxActive = 0;

    await syncBibCache(
      entries,
      cache,
      async (path) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        const num = /\d+/.exec(path)?.[0] ?? "0";
        return `@article{ref${num}, title = {Paper ${num}}}`;
      },
      { concurrency: 4 }
    );

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(cache.size).toBe(25);

    const citations = extractBibEntries(Array.from(cache.values()));
    expect(citations).toHaveLength(25);
    expect(citations.some((c) => c.key === "ref25")).toBe(true);
  });

  it("prunes stale .bib entries and keeps loading when one file fails", async () => {
    const cache = new Map<string, string>([
      ["removed.bib", "@article{old, title = {Old}}"],
      ["keep.bib", "@article{existing, title = {Existing}}"],
    ]);

    const entries: BibTreeEntryLike[] = [
      { kind: "file", path: "keep.bib" },
      { kind: "file", path: "broken.bib" },
      { kind: "file", path: "new.bib" },
    ];

    await syncBibCache(entries, cache, async (path) => {
      if (path === "broken.bib") {
        throw new Error("Network error");
      }
      return `@book{key_${path.replace(/\W+/g, "_")}, title = {Loaded}}`;
    });

    expect(cache.has("removed.bib")).toBe(false);
    expect(cache.has("broken.bib")).toBe(false);
    expect(cache.has("keep.bib")).toBe(true);
    expect(cache.has("new.bib")).toBe(true);
  });
});
