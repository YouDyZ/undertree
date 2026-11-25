import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { SpellIssue } from "../api";
import { getReadOnlyExtension } from "./readOnly";
import {
  canApplySpellActions,
  filterIssues,
  isKnownWord,
  issueSeverity,
  spellChunk,
} from "./spellcheck";

const issue = (start: number, end: number, category = "TYPOS", rule = "SPELLER"): SpellIssue => ({
  start,
  end,
  message: "m",
  short: "",
  rule,
  category,
  replacements: [],
});

describe("spellChunk", () => {
  it("sends small documents whole", () => {
    expect(spellChunk("Hallo Welt", [])).toEqual({ text: "Hallo Welt", start: 0 });
  });

  it("sends the visible paragraphs of large documents, without the preamble", () => {
    const doc = "\\usepackage{x}\n\\begin{document}\nA a.\n\nB b.\n  \nC c.\n\nD d.";
    const at = (s: string) => doc.indexOf(s);
    // B to C visible
    const chunk = spellChunk(doc, [{ from: at("B") + 1, to: at("C") + 1 }], 10);
    expect(chunk).toEqual({ text: "B b.\n  \nC c.", start: at("B") });
    // everything visible: from the end of \begin{document}
    const all = spellChunk(doc, [{ from: 0, to: doc.length }], 10);
    expect(all?.start).toBe(at("\nA"));
    expect(all?.text.endsWith("D d.")).toBe(true);
    expect(spellChunk(doc, [], 10)).toBeNull();
  });
});

describe("filterIssues", () => {
  const doc = "Ein Fehlr und Projektwort, LaTeX.";
  const at = (w: string) => [doc.indexOf(w), doc.indexOf(w) + w.length] as const;

  it("drops dictionary words (exact or lowercase), ignored rules and bad offsets", () => {
    const issues = [
      issue(...at("Fehlr")),
      issue(...at("Projektwort")),
      issue(...at("LaTeX")),
      issue(...at("und"), "GRAMMAR", "DE_CASE"),
      issue(...at("Ein"), "GRAMMAR", "OTHER"),
      issue(30, 99),
    ];
    const words = new Set(["projektwort", "LaTeX"]);
    const kept = filterIssues(issues, doc, words, new Set(["DE_CASE"]));
    expect(kept.map((i) => doc.slice(i.start, i.end))).toEqual(["Fehlr", "Ein"]);
  });

  it("matches words case-sensitively plus lowercase", () => {
    const words = new Set(["foo", "BaR"]);
    expect(isKnownWord("Foo", words)).toBe(true);
    expect(isKnownWord("BaR", words)).toBe(true);
    expect(isKnownWord("bar", words)).toBe(false);
  });

  it("underlines spelling red and grammar blue", () => {
    expect(issueSeverity(issue(0, 1))).toBe("error");
    expect(issueSeverity(issue(0, 1, "GRAMMAR"))).toBe("hint");
  });

  it("disables mutating spellcheck actions in read-only states", () => {
    const editableState = EditorState.create({ doc: "Tex", extensions: [getReadOnlyExtension(false)] });
    const readOnlyState = EditorState.create({ doc: "Tex", extensions: [getReadOnlyExtension(true)] });
    expect(canApplySpellActions(editableState.readOnly)).toBe(true);
    expect(canApplySpellActions(readOnlyState.readOnly)).toBe(false);
  });
});
