import {
  acceptCompletion,
  closeCompletion,
  hasNextSnippetField,
  hasPrevSnippetField,
  nextSnippetField,
  prevSnippetField,
  snippet,
} from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { fuzzyMatch } from "./fuzzy";

export interface EmmetExpansion {
  template: string;
  label: string;
  detail: string;
}

export interface EmmetSuggestion extends EmmetExpansion {
  trigger: string;
  score: number;
  matchedIndices: number[];
}

const MAX_LIST_ITEMS = 20;
const MAX_GRID_DIM = 12;

function escapeSnippetLiteral(text: string): string {
  // CodeMirror's snippet parser treats `\{` and `\}` as escaped braces and strips the backslash,
  // and interprets `${...}` / `#{...}` as placeholders.
  return text
    .replace(/\\([{}])/g, "\\\\$1")
    .replace(/([#$])\{/g, "$1\\{");
}

interface ShortDef {
  trigger: string;
  label: string;
  detail: string;
  template: string;
  wrap?: (escapedContent: string) => string;
}

const SHORT_EMMET_DEFS: readonly ShortDef[] = [
  {
    trigger: "sec",
    label: "sec",
    detail: "\\section{…}",
    template: "\\section{${1:Titel}}${0}",
    wrap: (c) => `\\section{${c}}\${0}`,
  },
  {
    trigger: "ssec",
    label: "ssec",
    detail: "\\subsection{…}",
    template: "\\subsection{${1:Unterabschnitt}}${0}",
    wrap: (c) => `\\subsection{${c}}\${0}`,
  },
  {
    trigger: "sssec",
    label: "sssec",
    detail: "\\subsubsection{…}",
    template: "\\subsubsection{${1:Unterunterabschnitt}}${0}",
    wrap: (c) => `\\subsubsection{${c}}\${0}`,
  },
  {
    trigger: "par",
    label: "par",
    detail: "\\paragraph{…}",
    template: "\\paragraph{${1:Absatz}}${0}",
    wrap: (c) => `\\paragraph{${c}}\${0}`,
  },
  {
    trigger: "fig",
    label: "fig",
    detail: "figure-Umgebung mit Grafik",
    template:
      "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=${1:0.8}\\textwidth]{${2:datei}}\n  \\caption{${3:Bildunterschrift}}\n  \\label{fig:${4:name}}\n\\end{figure}${0}",
  },
  {
    trigger: "img",
    label: "img",
    detail: "\\includegraphics{…}",
    template: "\\includegraphics[width=${1:0.8}\\textwidth]{${2:datei}}${0}",
    wrap: (c) => `\\includegraphics[width=\${1:0.8}\\textwidth]{${c}}\${0}`,
  },
  {
    trigger: "eq",
    label: "eq",
    detail: "equation-Umgebung",
    template: "\\begin{equation}\n  ${1}\n  \\label{eq:${2:name}}\n\\end{equation}${0}",
    wrap: (c) => `\\begin{equation}\n  ${c}\n  \\label{eq:\${1:name}}\n\\end{equation}\${0}`,
  },
  {
    trigger: "eq*",
    label: "eq*",
    detail: "equation*-Umgebung",
    template: "\\begin{equation*}\n  ${1}\n\\end{equation*}${0}",
    wrap: (c) => `\\begin{equation*}\n  ${c}\n\\end{equation*}\${0}`,
  },
  {
    trigger: "al",
    label: "al",
    detail: "align-Umgebung",
    template: "\\begin{align}\n  ${1} &= ${2}\n\\end{align}${0}",
    wrap: (c) => `\\begin{align}\n  ${c}\n\\end{align}\${0}`,
  },
  {
    trigger: "al*",
    label: "al*",
    detail: "align*-Umgebung",
    template: "\\begin{align*}\n  ${1} &= ${2}\n\\end{align*}${0}",
    wrap: (c) => `\\begin{align*}\n  ${c}\n\\end{align*}\${0}`,
  },
  {
    trigger: "fr",
    label: "fr",
    detail: "Beamer frame-Umgebung",
    template: "\\begin{frame}{${1:Folientitel}}\n  ${2}\n\\end{frame}${0}",
    wrap: (c) => `\\begin{frame}{${c}}\n  \${1}\n\\end{frame}\${0}`,
  },
  {
    trigger: "bf",
    label: "bf",
    detail: "\\textbf{…}",
    template: "\\textbf{${1}}${0}",
    wrap: (c) => `\\textbf{${c}}\${0}`,
  },
  {
    trigger: "it",
    label: "it",
    detail: "\\textit{…}",
    template: "\\textit{${1}}${0}",
    wrap: (c) => `\\textit{${c}}\${0}`,
  },
  {
    trigger: "tt",
    label: "tt",
    detail: "\\texttt{…}",
    template: "\\texttt{${1}}${0}",
    wrap: (c) => `\\texttt{${c}}\${0}`,
  },
  {
    trigger: "emph",
    label: "emph",
    detail: "\\emph{…}",
    template: "\\emph{${1}}${0}",
    wrap: (c) => `\\emph{${c}}\${0}`,
  },
  {
    trigger: "ul",
    label: "ul",
    detail: "\\underline{…}",
    template: "\\underline{${1}}${0}",
    wrap: (c) => `\\underline{${c}}\${0}`,
  },
  {
    trigger: "href",
    label: "href",
    detail: "\\href{url}{text}",
    template: "\\href{${1:https://example.com}}{${2:Linktext}}${0}",
    wrap: (c) => `\\href{${c}}{\${1:Linktext}}\${0}`,
  },
  {
    trigger: "url",
    label: "url",
    detail: "\\url{…}",
    template: "\\url{${1:https://example.com}}${0}",
    wrap: (c) => `\\url{${c}}\${0}`,
  },
  {
    trigger: "frac",
    label: "frac",
    detail: "\\frac{a}{b}",
    template: "\\frac{${1:a}}{${2:b}}${0}",
  },
  {
    trigger: "sum",
    label: "sum",
    detail: "\\sum_{i=1}^{n}",
    template: "\\sum_{${1:i=1}}^{${2:n}} ${0}",
  },
  {
    trigger: "int",
    label: "int",
    detail: "\\int_{a}^{b}",
    template: "\\int_{${1:a}}^{${2:b}} ${3:f(x)} \\, \\mathrm{d}${4:x}${0}",
  },
  {
    trigger: "lim",
    label: "lim",
    detail: "\\lim_{n \\to \\infty}",
    template: "\\lim_{${1:n \\to \\infty}} ${0}",
  },
  {
    trigger: "prod",
    label: "prod",
    detail: "\\prod_{i=1}^{n}",
    template: "\\prod_{${1:i=1}}^{${2:n}} ${0}",
  },
  {
    trigger: "thm",
    label: "thm",
    detail: "theorem-Umgebung",
    template: "\\begin{theorem}\n  ${1}\n\\end{theorem}${0}",
    wrap: (c) => `\\begin{theorem}\n  ${c}\n\\end{theorem}\${0}`,
  },
  {
    trigger: "lem",
    label: "lem",
    detail: "lemma-Umgebung",
    template: "\\begin{lemma}\n  ${1}\n\\end{lemma}${0}",
    wrap: (c) => `\\begin{lemma}\n  ${c}\n\\end{lemma}\${0}`,
  },
  {
    trigger: "def",
    label: "def",
    detail: "definition-Umgebung",
    template: "\\begin{definition}\n  ${1}\n\\end{definition}${0}",
    wrap: (c) => `\\begin{definition}\n  ${c}\n\\end{definition}\${0}`,
  },
  {
    trigger: "proof",
    label: "proof",
    detail: "proof-Umgebung",
    template: "\\begin{proof}\n  ${1}\n\\end{proof}${0}",
    wrap: (c) => `\\begin{proof}\n  ${c}\n\\end{proof}\${0}`,
  },
  {
    trigger: "lst",
    label: "lst",
    detail: "lstlisting-Codeblock",
    template: "\\begin{lstlisting}[language=${1:Python}, caption={${2:Code}}]\n${3}\n\\end{lstlisting}${0}",
  },
  {
    trigger: "doc",
    label: "doc",
    detail: "Minimales LaTeX-Dokument",
    template:
      "\\documentclass[11pt,a4paper]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath,amssymb,graphicx}\n\n\\title{${1:Titel}}\n\\author{${2:Autor}}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n${0}\n\\end{document}",
  },
];

const SHORT_EMMET_MAP = new Map<string, ShortDef>(SHORT_EMMET_DEFS.map((d) => [d.trigger, d]));

// Representative dynamic examples surfaced in autocomplete hints
const EXAMPLE_EMMET_TRIGGERS: readonly string[] = [
  "item*3",
  "enum*3",
  "desc*2",
  "ul>li*3",
  "ol>li*3",
  "table2x3",
  "tabular2x3",
  "pmatrix2x2",
  "bmatrix2x2",
  "cases2",
];

function buildListTemplate(kind: "itemize" | "enumerate" | "description", count: number): string {
  const lines: string[] = [`\\begin{${kind}}`];
  if (kind === "description") {
    let tab = 1;
    for (let i = 1; i <= count; i++) {
      lines.push(`  \\item[\${${tab}:Begriff ${i}}] \${${tab + 1}:Beschreibung ${i}}`);
      tab += 2;
    }
  } else {
    for (let i = 1; i <= count; i++) {
      lines.push(`  \\item \${${i}}`);
    }
  }
  lines.push(`\\end{${kind}}\${0}`);
  return lines.join("\n");
}

function buildGridRows(rows: number, cols: number, indent: string, startTab = 1): {
  lines: string[];
  nextTab: number;
} {
  let tab = startTab;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      cells.push(`\${${tab++}}`);
    }
    const ending = r < rows - 1 ? " \\\\" : "";
    lines.push(`${indent}${cells.join(" & ")}${ending}`);
  }
  return { lines, nextTab: tab };
}

function colSpec(cols: number): string {
  return cols === 1 ? "l" : `l${"c".repeat(cols - 1)}`;
}

/**
 * Parses an Emmet-like LaTeX abbreviation into a CodeMirror snippet template.
 * Returns null if `expr` is not a recognized Emmet pattern.
 */
export function parseLatexEmmet(expr: string): EmmetExpansion | null {
  if (!expr) return null;

  // 1. Lists with multiplier: ul>li*N, item*N, itemize*N, ol>li*N, enum*N, enumerate*N, dl>dt*N, desc*N
  const listMatch = /^(ul>li|item|itemize|ol>li|enum|enumerate|dl>dt|desc)(?:\*(\d+))?$/.exec(expr);
  if (listMatch) {
    const head = listMatch[1] ?? "";
    const countStr = listMatch[2];
    // Plain `item`, `itemize`, `enum`, `enumerate`, `desc` without `*N` should only match if `*N` or `>` form
    if (countStr !== undefined || head.includes(">")) {
      const count = countStr !== undefined ? Number(countStr) : 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_LIST_ITEMS) return null;

      if (head === "ul>li" || head === "item" || head === "itemize") {
        return {
          label: expr,
          detail: `itemize-Liste (${count} Einträge)`,
          template: buildListTemplate("itemize", count),
        };
      }
      if (head === "ol>li" || head === "enum" || head === "enumerate") {
        return {
          label: expr,
          detail: `enumerate-Liste (${count} Einträge)`,
          template: buildListTemplate("enumerate", count),
        };
      }
      if (head === "dl>dt" || head === "desc") {
        return {
          label: expr,
          detail: `description-Liste (${count} Einträge)`,
          template: buildListTemplate("description", count),
        };
      }
    }
  }

  // 2. Full table + tabular: tableRxC / tabRxC
  const tableMatch = /^(?:table|tab)(\d+)x(\d+)$/.exec(expr);
  if (tableMatch) {
    const rows = Number(tableMatch[1]);
    const cols = Number(tableMatch[2]);
    if (rows < 1 || rows > MAX_GRID_DIM || cols < 1 || cols > MAX_GRID_DIM) return null;

    const { lines: bodyLines, nextTab } = buildGridRows(rows, cols, "    ", 1);
    const captionTab = nextTab;
    const labelTab = nextTab + 1;
    // Put \\ on all rows inside tabular with booktabs rules
    const tabularLines: string[] = [];
    for (let r = 0; r < bodyLines.length; r++) {
      const line = bodyLines[r] ?? "";
      tabularLines.push(r === bodyLines.length - 1 ? `${line} \\\\` : line);
      if (r === 0 && rows > 1) {
        tabularLines.push("    \\midrule");
      }
    }
    const template = [
      "\\begin{table}[htbp]",
      "  \\centering",
      `  \\caption{\${${captionTab}:Tabellenüberschrift}}`,
      `  \\label{tab:\${${labelTab}:name}}`,
      `  \\begin{tabular}{${colSpec(cols)}}`,
      "    \\toprule",
      ...tabularLines,
      "    \\bottomrule",
      "  \\end{tabular}",
      "\\end{table}${0}",
    ].join("\n");
    return {
      label: expr,
      detail: `Tabelle ${rows}×${cols} mit Caption`,
      template,
    };
  }

  // 3. Pure tabular: tabularRxC
  const tabularMatch = /^tabular(\d+)x(\d+)$/.exec(expr);
  if (tabularMatch) {
    const rows = Number(tabularMatch[1]);
    const cols = Number(tabularMatch[2]);
    if (rows < 1 || rows > MAX_GRID_DIM || cols < 1 || cols > MAX_GRID_DIM) return null;

    const { lines: bodyLines } = buildGridRows(rows, cols, "  ", 1);
    const formattedRows = bodyLines.map((line, idx) =>
      idx === bodyLines.length - 1 ? `${line} \\\\` : line
    );
    const template = [
      `\\begin{tabular}{${colSpec(cols)}}`,
      "  \\toprule",
      ...formattedRows,
      "  \\bottomrule",
      "\\end{tabular}${0}",
    ].join("\n");
    return {
      label: expr,
      detail: `tabular ${rows}×${cols}`,
      template,
    };
  }

  // 4. Math matrices: pmatrixRxC, bmatrixRxC, vmatrixRxC, BmatrixRxC, VmatrixRxC, matrixRxC
  const matrixMatch = /^(pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix|matrix)(\d+)x(\d+)$/.exec(expr);
  if (matrixMatch) {
    const env = matrixMatch[1] ?? "matrix";
    const rows = Number(matrixMatch[2]);
    const cols = Number(matrixMatch[3]);
    if (rows < 1 || rows > MAX_GRID_DIM || cols < 1 || cols > MAX_GRID_DIM) return null;

    const { lines } = buildGridRows(rows, cols, "  ", 1);
    const template = [`\\begin{${env}}`, ...lines, `\\end{${env}}\${0}`].join("\n");
    return {
      label: expr,
      detail: `${env} ${rows}×${cols}`,
      template,
    };
  }

  // 5. Cases: casesN
  const casesMatch = /^cases(\d+)$/.exec(expr);
  if (casesMatch) {
    const count = Number(casesMatch[1]);
    if (count < 1 || count > MAX_GRID_DIM) return null;
    let tab = 1;
    const lines: string[] = ["\\begin{cases}"];
    for (let i = 0; i < count; i++) {
      const valTab = tab++;
      const condTab = tab++;
      const ending = i < count - 1 ? " \\\\" : "";
      lines.push(`  \${${valTab}} & \\text{if } \${${condTab}}${ending}`);
    }
    lines.push("\\end{cases}${0}");
    return {
      label: expr,
      detail: `cases (${count} Fälle)`,
      template: lines.join("\n"),
    };
  }

  // 6. Arbitrary environment: env:<name> (optionally with >content)
  const envMatch = /^env:([a-zA-Z][a-zA-Z0-9*_-]*)(?:>(.+))?$/.exec(expr);
  if (envMatch) {
    const envName = envMatch[1] ?? "";
    const wrapped = envMatch[2];
    const body = wrapped !== undefined ? escapeSnippetLiteral(wrapped) : "${1}";
    return {
      label: expr,
      detail: `${envName}-Umgebung`,
      template: `\\begin{${envName}}\n  ${body}\n\\end{${envName}}\${0}`,
    };
  }

  // 7. Short exact abbreviation
  const shortDef = SHORT_EMMET_MAP.get(expr);
  if (shortDef) {
    return {
      label: shortDef.label,
      detail: shortDef.detail,
      template: shortDef.template,
    };
  }

  // 8. Wrapper syntax: <abbr>><content>, e.g. bf>Wichtig, sec>Einleitung, eq>E=mc^2
  const gtIdx = expr.indexOf(">");
  if (gtIdx > 0 && gtIdx < expr.length - 1) {
    const prefix = expr.slice(0, gtIdx);
    const content = expr.slice(gtIdx + 1);
    const def = SHORT_EMMET_MAP.get(prefix);
    if (def?.wrap) {
      return {
        label: expr,
        detail: `${def.detail} mit Inhalt`,
        template: def.wrap(escapeSnippetLiteral(content)),
      };
    }
  }

  return null;
}

/**
 * Returns ranked Emmet suggestions for the autocomplete popup.
 */
export function getEmmetSuggestions(query: string, explicit = false): EmmetSuggestion[] {
  const results: EmmetSuggestion[] = [];
  const seen = new Set<string>();

  // Exact dynamic or static Emmet expression always ranks highest
  const direct = parseLatexEmmet(query);
  if (direct) {
    seen.add(direct.label);
    results.push({
      trigger: direct.label,
      label: direct.label,
      detail: direct.detail,
      template: direct.template,
      score: 500,
      matchedIndices: Array.from({ length: direct.label.length }, (_, i) => i),
    });
  }

  // Match static shortcuts + representative dynamic patterns
  const candidates: { trigger: string; expansion: EmmetExpansion }[] = [
    ...SHORT_EMMET_DEFS.map((d) => ({
      trigger: d.trigger,
      expansion: { label: d.label, detail: d.detail, template: d.template },
    })),
  ];
  for (const ex of EXAMPLE_EMMET_TRIGGERS) {
    const parsed = parseLatexEmmet(ex);
    if (parsed) {
      candidates.push({ trigger: ex, expansion: parsed });
    }
  }

  const qLower = query.toLowerCase();
  for (const cand of candidates) {
    if (seen.has(cand.trigger)) continue;
    if (query.length === 0) {
      if (!explicit) continue;
      seen.add(cand.trigger);
      results.push({
        trigger: cand.trigger,
        ...cand.expansion,
        score: 0,
        matchedIndices: [],
      });
      continue;
    }

    const match = fuzzyMatch(query, cand.trigger);
    if (!match) continue;

    // Avoid noisy false matches during normal prose typing unless explicit or strong prefix/subsequence
    const isPrefix = cand.trigger.toLowerCase().startsWith(qLower);
    if (!explicit && !isPrefix && match.score < 32) continue;

    seen.add(cand.trigger);
    results.push({
      trigger: cand.trigger,
      ...cand.expansion,
      score: match.score,
      matchedIndices: match.matchedIndices,
    });
  }

  results.sort((a, b) => b.score - a.score || a.trigger.localeCompare(b.trigger));
  return results;
}

function hasUnescapedPercentBefore(lineText: string, col: number): boolean {
  for (let i = 0; i < col; i++) {
    if (lineText[i] === "%") {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && lineText[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) return true;
    }
  }
  return false;
}

/**
 * Extracts a candidate Emmet token immediately before `col` on `lineText`.
 * Rejects comments, backslash commands, and tokens embedded inside a word.
 */
export function extractEmmetExprBefore(
  lineText: string,
  col: number
): { expr: string; fromOffset: number } | null {
  if (col <= 0) return null;
  if (hasUnescapedPercentBefore(lineText, col)) return null;

  const before = lineText.slice(0, col);
  // Scan backwards until whitespace
  let start = col;
  while (start > 0 && !/\s/.test(before[start - 1] ?? "")) {
    start--;
  }
  const token = before.slice(start);
  if (!token) return null;
  // Never treat LaTeX commands (\sec) or braced arguments (\ref{sec}) as Emmet expressions
  if (token.startsWith("\\") || token.startsWith("{") || token.includes("\\begin{")) {
    return null;
  }
  return { expr: token, fromOffset: start };
}

/**
 * Expands a valid Emmet expression directly before the cursor using CodeMirror's snippet engine.
 */
export function expandLatexEmmetCommand(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;

  const line = view.state.doc.lineAt(sel.head);
  const col = sel.head - line.from;
  const candidate = extractEmmetExprBefore(line.text, col);
  if (!candidate) return false;

  const expansion = parseLatexEmmet(candidate.expr);
  if (!expansion) return false;

  closeCompletion(view);
  const from = line.from + candidate.fromOffset;
  const to = sel.head;
  snippet(expansion.template)(view, null, from, to);
  return true;
}

/**
 * High-precedence Tab / Shift-Tab keymap for LaTeX:
 * - Tab: active snippet next field -> Emmet expansion -> accept completion -> indentWithTab
 * - Shift-Tab: active snippet prev field -> indentWithTab shift
 */
export function createLatexEmmetKeymap(): Extension {
  return Prec.high(
    keymap.of([
      {
        key: "Tab",
        run(view) {
          if (view.state.readOnly) return false;
          if (hasNextSnippetField(view.state) && nextSnippetField(view)) {
            return true;
          }
          if (expandLatexEmmetCommand(view)) {
            return true;
          }
          if (acceptCompletion(view)) {
            return true;
          }
          return indentWithTab.run ? indentWithTab.run(view) : false;
        },
        shift(view) {
          if (view.state.readOnly) return false;
          if (hasPrevSnippetField(view.state) && prevSnippetField(view)) {
            return true;
          }
          return indentWithTab.shift ? indentWithTab.shift(view) : false;
        },
      },
    ])
  );
}
