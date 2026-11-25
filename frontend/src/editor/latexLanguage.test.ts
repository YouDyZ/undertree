import { StringStream, ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  bibtexStreamParser,
  getLatexLanguageExtension,
  isBibtexFile,
  isLatexDocumentFile,
  isLatexSyntaxFile,
  latexLanguage,
  latexStreamParser,
} from "./latexLanguage";

interface Token {
  text: string;
  type: string | null;
}

function tokenizeLatex(source: string): Token[] {
  const state = latexStreamParser.startState!(2);
  const tokens: Token[] = [];
  for (const line of source.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const type = latexStreamParser.token(stream, state);
      const text = stream.current();
      if (text.length > 0) {
        tokens.push({ text, type });
      }
    }
  }
  return tokens;
}

function tokenizeBibtex(source: string): Token[] {
  const state = bibtexStreamParser.startState!(2);
  const tokens: Token[] = [];
  for (const line of source.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const type = bibtexStreamParser.token(stream, state);
      const text = stream.current();
      if (text.length > 0) {
        tokens.push({ text, type });
      }
    }
  }
  return tokens;
}

describe("latexLanguage file helpers", () => {
  it("recognizes LaTeX and BibTeX file extensions", () => {
    expect(isLatexDocumentFile("main.tex")).toBe(true);
    expect(isLatexDocumentFile("macros.sty")).toBe(true);
    expect(isLatexDocumentFile("paper.cls")).toBe(true);
    expect(isLatexDocumentFile("article.ltx")).toBe(true);
    expect(isLatexDocumentFile("package.dtx")).toBe(true);
    expect(isLatexDocumentFile("package.ins")).toBe(true);
    expect(isBibtexFile("refs.bib")).toBe(true);
    expect(isLatexSyntaxFile("refs.bib")).toBe(true);
    expect(isLatexSyntaxFile("package.dtx")).toBe(true);
    expect(isLatexSyntaxFile("package.ins")).toBe(true);
    expect(isLatexSyntaxFile("README.md")).toBe(false);
    expect(getLatexLanguageExtension("main.tex")).not.toBeNull();
    expect(getLatexLanguageExtension("package.dtx")).not.toBeNull();
    expect(getLatexLanguageExtension("package.ins")).not.toBeNull();
    expect(getLatexLanguageExtension("refs.bib")).not.toBeNull();
    expect(getLatexLanguageExtension("README.md")).toBeNull();
  });
});

describe("latexStreamParser", () => {
  it("tokenizes comments without breaking escaped percent \\%", () => {
    const tokens = tokenizeLatex("50\\% fertig % kommentar");
    const escaped = tokens.find((t) => t.text === "\\%");
    const comment = tokens.find((t) => t.text === "% kommentar");
    expect(escaped?.type).not.toBe("comment");
    expect(comment?.type).toBe("comment");
  });

  it("tokenizes \\begin{figure} and \\end{align*} with keyword, brace, and typeName", () => {
    const tokens = tokenizeLatex("\\begin{figure}\n\\end{align*}");
    expect(tokens.filter((t) => t.text === "\\begin")[0]?.type).toBe("keyword");
    expect(tokens.filter((t) => t.text === "figure")[0]?.type).toBe("typeName");
    expect(tokens.filter((t) => t.text === "\\end")[0]?.type).toBe("keyword");
    expect(tokens.filter((t) => t.text === "align*")[0]?.type).toBe("typeName");
    expect(tokens.filter((t) => t.text === "{" || t.text === "}").every((t) => t.type === "brace")).toBe(
      true
    );
  });

  it("tokenizes structural commands as keyword and generic macros as variableName", () => {
    const tokens = tokenizeLatex("\\documentclass[12pt]{article}\n\\section{Intro}\n\\textbf{Hi}");
    expect(tokens.find((t) => t.text === "\\documentclass")?.type).toBe("keyword");
    expect(tokens.find((t) => t.text === "[")?.type).toBe("squareBracket");
    expect(tokens.find((t) => t.text === "12pt")?.type).toBe("number");
    expect(tokens.find((t) => t.text === "]")?.type).toBe("squareBracket");
    expect(tokens.find((t) => t.text === "\\section")?.type).toBe("keyword");
    expect(tokens.find((t) => t.text === "\\textbf")?.type).toBe("variableName");
  });

  it("tokenizes reference & citation commands as meta and their keys as atom", () => {
    const tokens = tokenizeLatex("\\label{fig:foo} \\ref{fig:foo} \\cite[p. 4]{knuth1984, einstein1905}");
    expect(tokens.find((t) => t.text === "\\label")?.type).toBe("meta");
    expect(tokens.find((t) => t.text === "\\ref")?.type).toBe("meta");
    expect(tokens.find((t) => t.text === "\\cite")?.type).toBe("meta");
    expect(tokens.filter((t) => t.text === "fig:foo").every((t) => t.type === "atom")).toBe(true);
    expect(tokens.find((t) => t.text === "knuth1984")?.type).toBe("atom");
    expect(tokens.find((t) => t.text === "einstein1905")?.type).toBe("atom");
  });

  it("tokenizes inline/display math and math environments distinctly", () => {
    const inline = tokenizeLatex("$x_i + \\alpha^2$");
    expect(inline.filter((t) => t.text === "$").every((t) => t.type === "operator")).toBe(true);
    expect(inline.find((t) => t.text === "x")?.type).toBe("string");
    expect(inline.find((t) => t.text === "_")?.type).toBe("operator");
    expect(inline.find((t) => t.text === "\\alpha")?.type).toBe("variableName");
    expect(inline.find((t) => t.text === "^")?.type).toBe("operator");
    expect(inline.find((t) => t.text === "2")?.type).toBe("number");

    const envMath = tokenizeLatex("\\begin{align}\n  a &= b\n\\end{align}\nText");
    expect(envMath.find((t) => t.text === "align")?.type).toBe("typeName");
    expect(envMath.find((t) => t.text === "a")?.type).toBe("string");
    expect(envMath.find((t) => t.text === "&")?.type).toBe("operator");
    expect(envMath.find((t) => t.text === "Text")?.type).toBeNull();
  });

  it("tokenizes dimensions like 0.8\\textwidth cleanly", () => {
    const tokens = tokenizeLatex("\\includegraphics[width=0.8\\textwidth]{plot.pdf}");
    expect(tokens.find((t) => t.text === "0.8")?.type).toBe("number");
    expect(tokens.find((t) => t.text === "\\textwidth")?.type).toBe("variableName");
  });

  it("integrates cleanly into CodeMirror 6 syntax tree without warnings", () => {
    const doc = "\\section{Test}\n\\begin{equation}\n  E = mc^2\n\\end{equation}";
    const state = EditorState.create({ doc, extensions: [latexLanguage] });
    const tree = ensureSyntaxTree(state, doc.length, 500);
    expect(tree).not.toBeNull();
    expect(tree!.length).toBe(doc.length);
  });
});

describe("bibtexStreamParser", () => {
  it("tokenizes BibTeX entries, keys, fields, values, and comments", () => {
    const bib = `% refs\n@article{knuth1984,\n  author = {Knuth},\n  year = 1984\n}`;
    const tokens = tokenizeBibtex(bib);
    expect(tokens.find((t) => t.text === "% refs")?.type).toBe("comment");
    expect(tokens.find((t) => t.text === "@article")?.type).toBe("keyword");
    expect(tokens.find((t) => t.text === "knuth1984")?.type).toBe("atom");
    expect(tokens.find((t) => t.text === "author")?.type).toBe("propertyName");
    expect(tokens.find((t) => t.text === "1984")?.type).toBe("number");
  });

  it("tokenizes parenthesized BibTeX entries and nested delimiters cleanly", () => {
    const bib = `@article(knuth1984,\n  author = {Knuth (Donald)},\n  year = 1984\n)\n@book{lamport1994,\n  title = {LaTeX}\n}`;
    const tokens = tokenizeBibtex(bib);
    expect(tokens.find((t) => t.text === "@article")?.type).toBe("keyword");
    expect(tokens.filter((t) => t.text === "(" || t.text === ")").map((t) => t.type)).toEqual([
      "paren",
      "paren",
    ]);
    expect(tokens.find((t) => t.text === "knuth1984")?.type).toBe("atom");
    expect(tokens.find((t) => t.text === "author")?.type).toBe("propertyName");
    expect(tokens.find((t) => t.text === "Knuth (Donald)")?.type).toBe("string");
    expect(tokens.find((t) => t.text === "1984")?.type).toBe("number");
    expect(tokens.find((t) => t.text === "@book")?.type).toBe("keyword");
    expect(tokens.find((t) => t.text === "lamport1994")?.type).toBe("atom");
    expect(tokens.find((t) => t.text === "title")?.type).toBe("propertyName");
  });
});
