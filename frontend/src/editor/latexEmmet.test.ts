import { snippet } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { extractEmmetExprBefore, getEmmetSuggestions, parseLatexEmmet } from "./latexEmmet";

function expandInState(expr: string): string {
  const exp = parseLatexEmmet(expr);
  expect(exp).not.toBeNull();
  let state = EditorState.create({ doc: expr });
  const apply = snippet(exp!.template);
  apply(
    {
      state,
      dispatch(tr) {
        state = tr.state;
      },
    },
    null,
    0,
    expr.length
  );
  return state.doc.toString();
}

describe("parseLatexEmmet", () => {
  it("expands itemize, enumerate, and description lists with multipliers", () => {
    const ul = parseLatexEmmet("ul>li*3")!;
    expect(ul).not.toBeNull();
    expect(ul.template).toContain("\\begin{itemize}");
    expect(ul.template.match(/\\item /g)).toHaveLength(3);
    expect(ul.template).toContain("\\end{itemize}");

    const item = parseLatexEmmet("item*4")!;
    expect(item.template.match(/\\item /g)).toHaveLength(4);

    const itemize = parseLatexEmmet("itemize*2")!;
    expect(itemize.template).toContain("\\begin{itemize}");
    expect(itemize.template.match(/\\item /g)).toHaveLength(2);

    const ol = parseLatexEmmet("ol>li*2")!;
    expect(ol.template).toContain("\\begin{enumerate}");
    expect(ol.template.match(/\\item /g)).toHaveLength(2);

    const en = parseLatexEmmet("enum*3")!;
    expect(en.template).toContain("\\begin{enumerate}");
    expect(en.template.match(/\\item /g)).toHaveLength(3);

    const enFull = parseLatexEmmet("enumerate*2")!;
    expect(enFull.template).toContain("\\begin{enumerate}");

    const dl = parseLatexEmmet("dl>dt*2")!;
    expect(dl.template).toContain("\\begin{description}");
    expect(dl.template.match(/\\item\[/g)).toHaveLength(2);

    const desc = parseLatexEmmet("desc*3")!;
    expect(desc.template).toContain("\\begin{description}");
    expect(desc.template.match(/\\item\[/g)).toHaveLength(3);

    // Bounds check: 1 <= N <= 20
    expect(parseLatexEmmet("item*0")).toBeNull();
    expect(parseLatexEmmet("item*21")).toBeNull();
    expect(parseLatexEmmet("item*20")).not.toBeNull();
  });

  it("expands tableRxC, tabRxC, and tabularRxC grids", () => {
    const tbl = parseLatexEmmet("table2x3")!;
    expect(tbl).not.toBeNull();
    expect(tbl.template).toContain("\\begin{table}[htbp]");
    expect(tbl.template).toContain("\\begin{tabular}{lcc}");
    expect(tbl.template).toContain("\\caption{");
    expect(tbl.template).toContain("\\label{tab:");
    expect(tbl.template).toContain("${1} & ${2} & ${3} \\\\");
    expect(tbl.template).toContain("${4} & ${5} & ${6} \\\\");

    const tab = parseLatexEmmet("tab3x2")!;
    expect(tab.template).toContain("\\begin{tabular}{lc}");
    expect(tab.template).toContain("${5} & ${6}");

    const tabular = parseLatexEmmet("tabular2x2")!;
    expect(tabular.template).not.toContain("\\begin{table}");
    expect(tabular.template).toContain("\\begin{tabular}{lc}");
    expect(tabular.template).toContain("${1} & ${2} \\\\");
    expect(tabular.template).toContain("${3} & ${4} \\\\");

    // Bounds check: 1 <= R,C <= 12
    expect(parseLatexEmmet("table0x2")).toBeNull();
    expect(parseLatexEmmet("table13x2")).toBeNull();
    expect(parseLatexEmmet("table2x13")).toBeNull();
  });

  it("expands math matrices and cases", () => {
    for (const kind of ["pmatrix", "bmatrix", "vmatrix", "Bmatrix", "matrix"]) {
      const m = parseLatexEmmet(`${kind}2x3`)!;
      expect(m, kind).not.toBeNull();
      expect(m.template).toContain(`\\begin{${kind}}`);
      expect(m.template).toContain("${1} & ${2} & ${3} \\\\");
      expect(m.template).toContain("${4} & ${5} & ${6}");
      expect(m.template).toContain(`\\end{${kind}}`);
    }

    const cs = parseLatexEmmet("cases3")!;
    expect(cs).not.toBeNull();
    expect(cs.template).toContain("\\begin{cases}");
    expect(cs.template.match(/\\text\{if \}/g)).toHaveLength(3);
    expect(cs.template).toContain("\\end{cases}");
  });

  it("expands arbitrary environments via env:<name>", () => {
    const al = parseLatexEmmet("env:align*")!;
    expect(al.template).toBe("\\begin{align*}\n  ${1}\n\\end{align*}${0}");

    const thm = parseLatexEmmet("env:theorem")!;
    expect(thm.template).toBe("\\begin{theorem}\n  ${1}\n\\end{theorem}${0}");

    const wrapped = parseLatexEmmet("env:center>Hallo")!;
    expect(wrapped.template).toBe("\\begin{center}\n  Hallo\n\\end{center}${0}");
  });

  it("expands all short abbreviations", () => {
    const expectedAbbrs = [
      "sec",
      "ssec",
      "sssec",
      "par",
      "fig",
      "img",
      "eq",
      "eq*",
      "al",
      "al*",
      "fr",
      "bf",
      "it",
      "tt",
      "emph",
      "ul",
      "href",
      "url",
      "frac",
      "sum",
      "int",
      "lim",
      "prod",
      "thm",
      "lem",
      "def",
      "proof",
      "lst",
      "doc",
    ];
    for (const abbr of expectedAbbrs) {
      expect(parseLatexEmmet(abbr), `abbreviation "${abbr}"`).not.toBeNull();
    }
    expect(parseLatexEmmet("doc")!.template).toContain("\\documentclass");
    expect(parseLatexEmmet("doc")!.template).toContain("\\begin{document}");
  });

  it("expands wrapper syntax with >", () => {
    expect(expandInState("bf>Wichtig")).toBe("\\textbf{Wichtig}");
    expect(expandInState("sec>Einleitung")).toBe("\\section{Einleitung}");
    expect(expandInState("eq>E=mc^2")).toContain("\\begin{equation}\n  E=mc^2\n");
    expect(expandInState("it>Kursiv")).toBe("\\textit{Kursiv}");
    expect(expandInState("url>https://example.com")).toBe("\\url{https://example.com}");
  });

  it("produces valid CodeMirror snippets that preserve LaTeX row breaks \\\\", () => {
    const expanded = expandInState("pmatrix2x2");
    expect(expanded).toBe("\\begin{pmatrix}\n   &  \\\\\n   & \n\\end{pmatrix}");
  });
});

describe("extractEmmetExprBefore", () => {
  it("extracts Emmet tokens at line start or after whitespace", () => {
    expect(extractEmmetExprBefore("item*3", 6)).toEqual({ expr: "item*3", fromOffset: 0 });
    expect(extractEmmetExprBefore("  table2x3", 10)).toEqual({ expr: "table2x3", fromOffset: 2 });
    expect(extractEmmetExprBefore("Text bf>Wichtig", 15)).toEqual({
      expr: "bf>Wichtig",
      fromOffset: 5,
    });
  });

  it("ignores backslash commands and comments", () => {
    expect(extractEmmetExprBefore("\\sec", 4)).toBeNull();
    expect(extractEmmetExprBefore("% fig", 5)).toBeNull();
    expect(extractEmmetExprBefore("50\\% fig", 8)).toEqual({ expr: "fig", fromOffset: 5 });
  });
});

describe("getEmmetSuggestions", () => {
  it("surfaces exact dynamic expressions at the top", () => {
    const res = getEmmetSuggestions("table2x3");
    expect(res[0]?.label).toBe("table2x3");

    const listRes = getEmmetSuggestions("item*3");
    expect(listRes[0]?.label).toBe("item*3");
  });

  it("surfaces matching short Emmet triggers", () => {
    const figRes = getEmmetSuggestions("fig");
    expect(figRes[0]?.label).toBe("fig");
  });
});
