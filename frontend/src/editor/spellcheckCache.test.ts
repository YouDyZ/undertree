import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpellIssue } from "../api";
import { SpellState, cacheTag } from "./spellcheck";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getDictionary: () => Promise.resolve({ words: [], disabled_rules: [] }),
}));

const issue = (start: number, end: number): SpellIssue => ({
  start,
  end,
  message: "m",
  short: "",
  rule: "R",
  category: "TYPOS",
  replacements: [],
});

const chunk = { text: "Hallo Welt", start: 0 };

describe("SpellState cache", () => {
  it("keeps results of different providers apart (no stale [] from a disabled LanguageTool)", async () => {
    const state = new SpellState();
    const lt = vi.fn(() => Promise.resolve([] as SpellIssue[]));
    const hs = vi.fn(() => Promise.resolve([issue(0, 5)]));
    expect(await state.check(lt, "a.tex", chunk, "languagetool")).toEqual([]);
    expect(await state.check(hs, "a.tex", chunk, "hunspell:auto")).toHaveLength(1);
    // both cached under their own key
    await state.check(lt, "a.tex", chunk, "languagetool");
    await state.check(hs, "a.tex", chunk, "hunspell:auto");
    expect(lt).toHaveBeenCalledTimes(1);
    expect(hs).toHaveBeenCalledTimes(1);
  });

  it("does not cache an answer that was requested before clearCache", async () => {
    const state = new SpellState();
    let release: (v: SpellIssue[]) => void = () => undefined;
    const slow = vi.fn(() => new Promise<SpellIssue[]>((r) => (release = r)));
    const pendingCheck = state.check(slow, "a.tex", chunk, "languagetool");
    state.clearCache();
    release([]);
    expect(await pendingCheck).toEqual([]);
    await state.check(slow.mockResolvedValue([issue(0, 5)]), "a.tex", chunk, "languagetool");
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("caches again after the clear and shifts offsets by the chunk start", async () => {
    const state = new SpellState();
    const src = vi.fn((req: { start: number }) => Promise.resolve([issue(req.start + 1, req.start + 3)]));
    const out = await state.check(src, "a.tex", { text: "xyz", start: 10 }, "t");
    expect(out.map((i) => [i.start, i.end])).toEqual([[11, 13]]);
    const again = await state.check(src, "a.tex", { text: "xyz", start: 20 }, "t");
    expect(again.map((i) => [i.start, i.end])).toEqual([[21, 23]]);
    expect(src).toHaveBeenCalledTimes(1);
  });
});

describe("cacheTag", () => {
  it("differs per provider and Hunspell language", () => {
    expect(cacheTag("languagetool")).toBe("languagetool");
    expect(cacheTag("hunspell")).toBe("hunspell:auto");
  });
});

afterEach(() => vi.restoreAllMocks());
