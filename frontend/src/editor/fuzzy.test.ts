import { describe, expect, it } from "vitest";
import { fuzzyMatch, indicesToMatchRanges } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches case-insensitive LaTeX subsequences", () => {
    const cases: [string, string][] = [
      ["bfig", "begin{figure}"],
      ["incg", "\\includegraphics"],
      ["ssec", "\\subsection"],
      ["algn", "align"],
      ["tb", "\\textbf"],
      ["ti", "\\textit"],
      ["EQ", "equation"],
    ];

    for (const [query, target] of cases) {
      const res = fuzzyMatch(query, target);
      expect(res, `expected "${query}" to match "${target}"`).not.toBeNull();
      expect(res!.matchedIndices).toHaveLength(query.length);
      // Matched indices must be strictly increasing and correspond to query characters
      for (let i = 0; i < query.length; i++) {
        const idx = res!.matchedIndices[i]!;
        expect(target[idx]!.toLowerCase()).toBe(query[i]!.toLowerCase());
        if (i > 0) {
          expect(idx).toBeGreaterThan(res!.matchedIndices[i - 1]!);
        }
      }
    }
  });

  it("returns null when query is not a subsequence or longer than target", () => {
    expect(fuzzyMatch("xyz", "section")).toBeNull();
    expect(fuzzyMatch("ces", "sec")).toBeNull();
    expect(fuzzyMatch("figures", "fig")).toBeNull();
  });

  it("returns neutral zero score for empty query", () => {
    expect(fuzzyMatch("", "\\section")).toEqual({ score: 0, matchedIndices: [] });
  });

  it("ranks exact > prefix > scattered subsequence", () => {
    const exact = fuzzyMatch("section", "\\section")!;
    const prefix = fuzzyMatch("section", "\\section*")!;
    const subseq = fuzzyMatch("section", "\\subsection")!;

    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(subseq.score);
  });

  it("rewards consecutive runs and word boundaries over scattered matches", () => {
    const boundary = fuzzyMatch("bf", "\\begin{figure}")!;
    const scattered = fuzzyMatch("bf", "\\bibliographystyle{foo}")!;
    expect(boundary.score).toBeGreaterThan(scattered.score);

    // Consecutive `sec` in `\subsection` should align to index 4,5,6 rather than 1,5,6
    const ssec = fuzzyMatch("sec", "\\subsection")!;
    expect(ssec.matchedIndices).toEqual([4, 5, 6]);
  });

  it("prefers shorter candidates on equal prefix", () => {
    const shorter = fuzzyMatch("sub", "\\subset")!;
    const longer = fuzzyMatch("sub", "\\subsection")!;
    expect(shorter.score).toBeGreaterThan(longer.score);
  });

  it("penalizes large gaps", () => {
    const tight = fuzzyMatch("al", "align")!;
    const gappy = fuzzyMatch("al", "a________l")!;
    expect(tight.score).toBeGreaterThan(gappy.score);
  });
});

describe("indicesToMatchRanges", () => {
  it("merges consecutive indices into [from, to] pairs with optional offset", () => {
    expect(indicesToMatchRanges([])).toEqual([]);
    expect(indicesToMatchRanges([0, 1, 2, 5, 6])).toEqual([0, 3, 5, 7]);
    expect(indicesToMatchRanges([0, 2, 3], 1)).toEqual([1, 2, 3, 5]);
  });
});
