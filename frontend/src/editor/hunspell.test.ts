import { readFileSync } from "node:fs";
import nspell from "nspell";
import { describe, expect, it, vi } from "vitest";
import type { RootFile } from "../api";
import { MAX_WORD_LENGTH, isCompound } from "./compound";
import { rootLanguage } from "./hunspellClient";
import { extractWords, hunspellLang } from "./latexWords";
import { SOURCES, SPELL_PROVIDERS, resolveProvider } from "./spellcheck";

/** The words found, each checked against its own offsets in `src`. */
function words(src: string): string[] {
  const found = extractWords(src);
  for (const w of found) expect(src.slice(w.from, w.to)).toBe(w.text);
  return found.map((w) => w.text);
}

describe("extractWords", () => {
  it("finds words with exact UTF-16 offsets, including umlauts and apostrophes", () => {
    const src = "Größe ist wichtig, don't panic 😀 Übung";
    expect(words(src)).toEqual(["Größe", "ist", "wichtig", "don't", "panic", "Übung"]);
    const übung = extractWords(src).at(-1);
    expect(übung?.from).toBe(src.indexOf("Übung"));
  });

  it("skips commands but keeps the text in their arguments", () => {
    expect(words("\\section{Einleitung} \\textbf{fett} \\emph{kursiv}")).toEqual([
      "Einleitung",
      "fett",
      "kursiv",
    ]);
  });

  it("skips comments, but not an escaped percent sign", () => {
    expect(words("Hallo % verborgen\nWelt 50\\% mehr")).toEqual(["Hallo", "Welt", "mehr"]);
  });

  it("skips inline and display math", () => {
    expect(words("Es gilt $x = alpha$ und $$beta + gamma$$ sowie \\(delta\\) und \\[epsilon\\] fertig \\$ ok")).toEqual([
      "Es",
      "gilt",
      "und",
      "sowie",
      "und",
      "fertig",
      "ok",
    ]);
  });

  it("skips verbatim-like and math environments", () => {
    const src =
      "Vorher\n\\begin{verbatim}\nfoo bar\n\\end{verbatim}\n\\begin{equation*}\nbaz\n\\end{equation*}\n\\begin{itemize}\n\\item Nachher\n\\end{itemize}\n\\verb|qux quux| Ende";
    expect(words(src)).toEqual(["Vorher", "Nachher", "Ende"]);
  });

  it("skips the arguments of cite, ref, label, url and friends", () => {
    const src =
      "Siehe \\cite[S.~3]{mueller2020} und \\ref{sec:intro}, \\label{fig:abc} \\autoref{tab:x} \\href{https://example.org/foo}{Link} \\url{https://x.org} \\includegraphics[width=3cm]{bild} danach";
    expect(words(src)).toEqual(["Siehe", "und", "Link", "danach"]);
  });

  it("skips URLs in running text, e-mail addresses, acronyms, camelCase and tokens with digits", () => {
    expect(words("Auf https://example.org/pfad?q=wort steht NASA, LaTeX, abc123, 3D und a@b.de Ende")).toEqual([
      "Auf",
      "steht",
      "und",
      "Ende",
    ]);
  });

  it("skips the preamble and the definition name of \\newcommand", () => {
    const src = "\\documentclass{article}\\usepackage{foo}\\newcommand{\\meinbefehl}{x}\n\\begin{document}\nText \\newcommand\\xyz{Abc} hier\n\\end{document}";
    expect(words(src)).toEqual(["Text", "hier"]);
  });

  it("skips float placement and column specs", () => {
    const src =
      "\\begin{figure}[htbp]\nBild\n\\end{figure}\n\\begin{tabular}{|l|p{3cm}|r|}\nZelle\n\\end{tabular}\n\\begin{tabularx}{\\textwidth}{lX}\nSpalte\n\\end{tabularx}\n\\begin{tabular}[t]{cc} Oben\n\\begin{itemize}\n[Text] Liste";
    expect(words(src)).toEqual(["Bild", "Zelle", "Spalte", "Oben", "Text", "Liste"]);
  });

  it("scans unclosed math and \\verb only a bounded distance (no quadratic blow-up)", () => {
    for (const unit of ["\\(", "\\[", "$", "\\verb|"]) {
      const t0 = Date.now();
      expect(extractWords(`${unit} wort `.repeat(20_000)).length).toBeGreaterThan(0);
      expect(Date.now() - t0, unit).toBeLessThan(2000);
    }
    const t0 = Date.now();
    extractWords("\\(".repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("handles unbalanced input without hanging or throwing", () => {
    expect(words("Anfang $ offen und \\textbf{ unvollständig")).toEqual(["Anfang", "offen", "und", "unvollständig"]);
    expect(words("\\begin{verbatim} nie geschlossen")).toEqual([]);
  });
});

describe("isCompound", () => {
  const known = new Set(["Zusammen", "Fassung", "Wort", "Buch", "Haus", "Tür", "Arbeit", "Zimmer"]);
  const correct = (w: string) => known.has(w);

  it("accepts known parts with or without linking element, up to three parts", () => {
    expect(isCompound("Zusammenfassung", correct)).toBe(true);
    expect(isCompound("Wörterbuch", (w) => correct(w) || w === "Wörter")).toBe(true);
    expect(isCompound("Arbeitszimmer", correct)).toBe(true);
    expect(isCompound("Hauswortbuch", correct)).toBe(true);
  });

  it("rejects unknown parts, lower-case compound starts, short parts and too many parts", () => {
    expect(isCompound("Wortxyz", correct)).toBe(false);
    expect(isCompound("hausbuch", correct)).toBe(false);
    expect(isCompound("Hausab", correct)).toBe(false);
    expect(isCompound("HausTürWortBuchHaus", correct)).toBe(false);
  });

  it("does not even try words of 40 letters or more", () => {
    const calls = vi.fn(() => true);
    expect(isCompound("a".repeat(MAX_WORD_LENGTH), calls)).toBe(false);
    expect(calls).not.toHaveBeenCalled();
    expect(isCompound("a".repeat(MAX_WORD_LENGTH - 1), () => true)).toBe(true);
  });

  it("works against the real German dictionary", () => {
    const dir = "node_modules/dictionary-de/index.";
    const spell = nspell(readFileSync(`${dir}aff`, "utf8"), readFileSync(`${dir}dic`, "utf8"));
    const ok = (w: string) => spell.correct(w) || isCompound(w, (x) => spell.correct(x));
    for (const w of ["Zusammenfassung", "Wörterbuch", "Literaturverzeichnis", "Netzwerkprotokoll", "Einleitung"])
      expect(ok(w), w).toBe(true);
    for (const w of ["Rechtschreibfehlr", "Zuxammenfassung", "Asdfgh"]) expect(ok(w), w).toBe(false);
    expect(spell.suggest("Rechtschreibung").length).toBe(0);
  }, 20_000);
});

describe("hunspellLang", () => {
  it("maps LanguageTool codes to dictionaries, unknown and auto to English", () => {
    expect(hunspellLang("de-DE")).toBe("de");
    expect(hunspellLang("de")).toBe("de");
    expect(hunspellLang("DE-AT")).toBe("de");
    expect(hunspellLang("en-US")).toBe("en");
    expect(hunspellLang("fr")).toBe("en");
    expect(hunspellLang("auto")).toBe("en");
    expect(hunspellLang(undefined)).toBe("en");
  });
});

describe("rootLanguage", () => {
  const root = (path: string, language?: string): RootFile => ({
    path,
    repo: "",
    engine: "pdflatex",
    reason: "",
    language,
  });

  it("prefers the file's own root, then the first concrete language", () => {
    const all = [root("a.tex", "auto"), root("b.tex", "de-DE"), root("c.tex", "en-US")];
    expect(rootLanguage("c.tex", all)).toBe("en-US");
    expect(rootLanguage("sub/x.tex", all)).toBe("de-DE");
    expect(rootLanguage("x.tex", [root("a.tex", "auto")])).toBeUndefined();
    expect(rootLanguage("x.tex", [])).toBeUndefined();
  });
});

describe("provider selection", () => {
  it("honours a valid stored choice", () => {
    expect(resolveProvider("hunspell", false)).toBe("hunspell");
    expect(resolveProvider("languagetool", true)).toBe("languagetool");
    expect(resolveProvider("off", true)).toBe("off");
  });

  it("defaults to LanguageTool, or to Hunspell when the server has none", () => {
    expect(resolveProvider(null, false)).toBe("languagetool");
    expect(resolveProvider("kaputt", false)).toBe("languagetool");
    expect(resolveProvider(null, true)).toBe("hunspell");
  });

  it("offers a source for every provider except off", () => {
    const ids = SPELL_PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(["languagetool", "hunspell", "off"]);
    for (const id of ids) expect(id === "off" || typeof SOURCES[id]).toBe(id === "off" ? true : "function");
  });
});
