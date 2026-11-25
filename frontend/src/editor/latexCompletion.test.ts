import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { LATEX_COMMANDS } from "./latexCatalog";
import {
  type LatexCompletionOptions,
  createLatexCompletionSource,
  extractBibEntries,
  extractLabels,
  findOpenEnvironments,
} from "./latexCompletion";

async function queryCompletions(
  doc: string,
  pos = doc.length,
  explicit = false,
  options?: LatexCompletionOptions
) {
  const state = EditorState.create({ doc });
  const source = createLatexCompletionSource(options);
  const ctx = new CompletionContext(state, pos, explicit);
  return await source(ctx);
}

describe("latexCatalog", () => {
  it("contains at least 120 LaTeX commands", () => {
    expect(LATEX_COMMANDS.length).toBeGreaterThanOrEqual(120);
  });
});

describe("extractLabels", () => {
  it("extracts unique labels across documents and ignores comments", () => {
    const doc1 = `
      \\section{Intro}\\label{sec:intro}
      % \\label{sec:commented}
      50\\% done \\label{eq:rate}
    `;
    const doc2 = `
      \\label{sec:intro}
      \\label{fig:arch}
    `;
    expect(extractLabels([doc1, doc2])).toEqual(["sec:intro", "eq:rate", "fig:arch"]);
  });
});

describe("extractBibEntries", () => {
  it("parses BibTeX entries with nested braces and quotes", () => {
    const bib = `
      % @article{commented_key, title={Ignore}}
      @string{icml = "ICML"}
      @article{knuth1984,
        author = {Donald E. Knuth},
        title = {Literate {Programming}},
        year = 1984,
      }
      @inproceedings{vaswani2017attention,
        author = "Ashish Vaswani and Noam Shazeer",
        title = "Attention Is All You Need",
        year = {2017}
      }
    `;
    const entries = extractBibEntries([bib]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      key: "knuth1984",
      type: "article",
      author: "Donald E. Knuth",
      title: "Literate Programming",
      year: "1984",
    });
    expect(entries[1]).toEqual({
      key: "vaswani2017attention",
      type: "inproceedings",
      author: "Ashish Vaswani and Noam Shazeer",
      title: "Attention Is All You Need",
      year: "2017",
    });
  });
});

describe("findOpenEnvironments", () => {
  it("tracks nested open environments and ignores comments and closed pairs", () => {
    const src = `
      \\begin{document}
        % \\begin{ignored}
        \\begin{figure}
          \\begin{center}
          \\end{center}
          \\begin{itemize}
    `;
    expect(findOpenEnvironments(src)).toEqual(["document", "figure", "itemize"]);
  });
});

describe("createLatexCompletionSource", () => {
  it("completes environments after \\begin{ with fuzzy matching and full block snippet", async () => {
    const res = await queryCompletions("\\begin{algn");
    expect(res).not.toBeNull();
    expect(res!.filter).toBe(false);
    expect(res!.options[0]?.label).toBe("align");
    expect(typeof res!.options[0]?.apply).toBe("function");

    // Consumes auto-closed trailing brace so no stray `}` remains
    const withBrace = await queryCompletions("\\begin{fig}", "\\begin{fig".length);
    expect(withBrace).not.toBeNull();
    expect(withBrace!.from).toBe(0);
    expect(withBrace!.to).toBe("\\begin{fig}".length);
    expect(withBrace!.options[0]?.label).toBe("figure");
  });

  it("ranks the innermost open environment first after \\end{ with boost 99", async () => {
    const doc = [
      "\\begin{document}",
      "  \\begin{figure}",
      "    \\begin{itemize}",
      "      \\item Eins",
      "    \\end{",
    ].join("\n");

    const res = await queryCompletions(doc);
    expect(res).not.toBeNull();
    expect(res!.options[0]?.label).toBe("itemize");
    expect(res!.options[0]?.boost).toBe(99);
    expect(res!.options[1]?.label).toBe("figure");
  });

  it("completes labels inside \\ref{, \\eqref{, \\autoref{, \\cref{ from current and context docs", async () => {
    const doc = "\\label{sec:intro}\nSee \\ref{fg";
    const res = await queryCompletions(doc, doc.length, false, {
      getContextTexts: () => ["\\begin{figure}\\label{fig:pipeline}\\end{figure}"],
    });
    expect(res).not.toBeNull();
    expect(res!.options.map((o) => o.label)).toContain("fig:pipeline");
    expect(res!.options[0]?.label).toBe("fig:pipeline");

    const eqRes = await queryCompletions("\\label{eq:energy}\n\\eqref{en");
    expect(eqRes?.options[0]?.label).toBe("eq:energy");

    const crefRes = await queryCompletions("\\label{sec:a}\\label{sec:b}\n\\cref{sec:a, sb");
    expect(crefRes?.options[0]?.label).toBe("sec:b");
  });

  it("completes BibTeX keys inside \\cite{, \\parencite{, \\citep{ with title/author detail", async () => {
    const bib = `
      @article{einstein1905,
        author = {Albert Einstein},
        title = {Zur Elektrodynamik bewegter Körper},
        year = {1905}
      }
      @book{knuth1984,
        author = {Donald E. Knuth},
        title = {The TeXbook},
        year = {1984}
      }
    `;
    const res = await queryCompletions("As shown in \\cite[p. 4]{ein", undefined, false, {
      getBibTexts: () => [bib],
    });
    expect(res).not.toBeNull();
    expect(res!.options[0]?.label).toBe("einstein1905");
    expect(res!.options[0]?.detail).toContain("Albert Einstein");
    expect(res!.options[0]?.detail).toContain("1905");

    const parenRes = await queryCompletions("\\parencite{kn", undefined, false, {
      getBibTexts: () => [bib],
    });
    expect(parenRes?.options[0]?.label).toBe("knuth1984");
  });

  it("fuzzy-matches LaTeX commands and \\begin{env} shortcuts after \\", async () => {
    const incg = await queryCompletions("\\incg");
    expect(incg?.options[0]?.label).toBe("\\includegraphics");

    const ssec = await queryCompletions("\\ssec");
    expect(ssec?.options[0]?.label).toBe("\\subsection");

    const tb = await queryCompletions("\\tb");
    expect(tb?.options.slice(0, 3).map((o) => o.label)).toContain("\\textbf");

    const bfig = await queryCompletions("\\bfig");
    expect(bfig?.options[0]?.label).toBe("\\begin{figure}");

    const alpha = await queryCompletions("\\alp");
    expect(alpha?.options[0]?.label).toBe("\\alpha");

    // Does not trigger after \\ line break
    expect(await queryCompletions("a \\\\")).toBeNull();
  });

  it("offers Emmet completions at word start without backslash", async () => {
    const fig = await queryCompletions("fig");
    expect(fig).not.toBeNull();
    expect(fig!.options[0]?.label).toBe("fig");
    expect(fig!.options[0]?.type).toBe("keyword");
    expect(fig!.options[0]?.detail).toMatch(/^Emmet · /);

    const grid = await queryCompletions("  table2x3");
    expect(grid?.options[0]?.label).toBe("table2x3");

    const list = await queryCompletions("item*3");
    expect(list?.options[0]?.label).toBe("item*3");
  });

  it("suppresses implicit completions inside line comments", async () => {
    expect(await queryCompletions("% \\sec")).toBeNull();
    expect(await queryCompletions("% fig")).toBeNull();
  });
});
