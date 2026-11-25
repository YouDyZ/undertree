/**
 * Words of LaTeX source for the in-browser Hunspell check (#62): skips commands, math, comments,
 * verbatim-like environments, URLs and arguments that are identifiers (`\cite`, `\ref`, `\label`, ...).
 * Offsets are UTF-16 indexes into the given text, so they stay valid in the CodeMirror document.
 */
export interface Word {
  from: number;
  to: number;
  text: string;
}

/** Commands whose first argument(s) are code, not prose (starred forms are covered). */
const SKIP_ARGS: Record<string, number> = {
  ...Object.fromEntries(
    (
      "ref eqref autoref cref Cref pageref nameref vref label url href input include includegraphics " +
      "includepdf usepackage RequirePackage documentclass bibliography bibliographystyle addbibresource " +
      "graphicspath hspace vspace setlength textcolor color colorbox pagecolor pagestyle thispagestyle " +
      "bibitem index hypersetup lstinputlisting newtheorem DeclareMathOperator"
    )
      .split(" ")
      .map((c) => [c, 1])
  ),
  newcommand: 2,
  renewcommand: 2,
  providecommand: 2,
  newenvironment: 3,
  renewenvironment: 3,
};

/** Mandatory arguments of environments that are specs, not prose (`tabularx{width}{cols}`). */
const ENV_ARGS: Record<string, number> = {
  tabular: 1,
  "tabular*": 2,
  tabularx: 2,
  tabulary: 2,
  array: 1,
  longtable: 1,
  supertabular: 1,
  minipage: 1,
  multicols: 1,
};

const CITE =/^(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)$/;

/** Environments whose content is skipped up to the matching `\end`. */
const SKIP_ENVS = new Set(
  (
    "verbatim Verbatim lstlisting minted comment equation align gather multline flalign alignat " +
    "eqnarray displaymath math tikzpicture filecontents algorithm algorithmic"
  ).split(" ")
);

const URL_AT = /^(?:https?:\/\/|www\.)[^\s{}]*/;
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/uy;

function skipSpace(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i] as string)) i++;
  return i;
}

/** Index after the balanced group starting at `i` (`\{` ignored), or `i` if there is none. */
function skipGroup(t: string, i: number, open: string, close: string): number {
  if (t[i] !== open) return i;
  let depth = 0;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (c === "\\") j++;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return t.length;
}

/** Index after `n` arguments (optional `[..]` groups in between) of the command ending at `i`. */
function skipArgs(t: string, i: number, n: number): number {
  for (let k = 0; k < n; k++) {
    for (let j = skipSpace(t, i); t[j] === "["; j = skipSpace(t, i)) i = skipGroup(t, j, "[", "]");
    const j = skipSpace(t, i);
    if (t[j] === "{") i = skipGroup(t, j, "{", "}");
    else if (t[j] === "\\") i = j + 1 + (/^(?:[a-zA-Z]+|.)/.exec(t.slice(j + 1, j + 40))?.[0].length ?? 0);
    else break;
  }
  return i;
}

/** Math and `\verb` that is not closed within this many characters is taken as unclosed (no quadratic scans). */
const MAX_SPAN = 2000;

/** Index after the next `needle` within `MAX_SPAN` chars of `from`, or -1 (`$` honours `\$`). */
function after(t: string, needle: string, from: number): number {
  const stop = Math.min(t.length, from + MAX_SPAN);
  if (needle.startsWith("\\")) {
    const k = t.slice(from, stop).indexOf(needle);
    return k < 0 ? -1 : from + k + needle.length;
  }
  for (let j = from; j < stop; j++) {
    if (t[j] === "\\") j++;
    else if (t.startsWith(needle, j)) return j + needle.length;
  }
  return -1;
}

/** Not prose: identifiers, numbers, e-mail addresses, acronyms, camelCase (LaTeX, BibTeX). */
function isProse(t: string, from: number, to: number): boolean {
  const w = t.slice(from, to);
  return !(
    /[\d_@]/.test(t[from - 1] ?? "") ||
    /[\d_@]/.test(t[to] ?? "") ||
    w.length < 2 ||
    w === w.toUpperCase() ||
    /\p{Ll}\p{Lu}/u.test(w)
  );
}

export function extractWords(text: string): Word[] {
  const out: Word[] = [];
  const begin = text.indexOf("\\begin{document}");
  let i = begin < 0 ? 0 : begin + "\\begin{document}".length;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "%") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "$") {
      const dbl = text[i + 1] === "$";
      const close = after(text, dbl ? "$$" : "$", i + (dbl ? 2 : 1));
      i = close < 0 ? i + 1 : close;
    } else if (c === "\\") {
      const name = /^[a-zA-Z]+/.exec(text.slice(i + 1, i + 40))?.[0];
      if (!name) {
        // \( and \[ open math; \\ \% \& and friends are skipped as a pair
        const d = text[i + 1];
        const close = d === "(" ? after(text, "\\)", i + 2) : d === "[" ? after(text, "\\]", i + 2) : -1;
        i = close < 0 ? i + 2 : close;
        continue;
      }
      let end = i + 1 + name.length;
      if (text[end] === "*") end++;
      if (name === "begin" || name === "end") {
        const arg = /^\{([^{}]*)\}/.exec(text.slice(end, end + 80));
        i = end + (arg?.[0].length ?? 0);
        const env = arg?.[1] ?? "";
        const base = env.replace(/\*$/, "");
        if (name === "begin" && SKIP_ENVS.has(base)) {
          const close = text.indexOf(`\\end{${env}}`, i);
          i = close < 0 ? text.length : close;
        } else if (name === "begin") {
          // placement and column specs: \begin{figure}[htbp], \begin{tabular}{|l|p{3cm}|}
          if (text[i] === "[") i = skipGroup(text, i, "[", "]");
          i = skipArgs(text, i, ENV_ARGS[env] ?? ENV_ARGS[base] ?? 0);
        }
      } else if (name === "verb") {
        const delim = text[end];
        const close = delim ? after(text, delim, end + 1) : -1;
        i = close < 0 ? end : close;
      } else {
        i = skipArgs(text, end, CITE.test(name) ? 1 : (SKIP_ARGS[name] ?? 0));
      }
    } else {
      const url = c === "h" || c === "w" ? URL_AT.exec(text.slice(i, i + 2000)) : null;
      if (url) {
        i += url[0].length;
        continue;
      }
      WORD.lastIndex = i;
      const w = WORD.exec(text);
      if (!w) {
        i++;
        continue;
      }
      const from = i;
      i += w[0].length;
      if (isProse(text, from, i)) out.push({ from, to: i, text: w[0] });
      // user@example.org: the domain is no prose either
      if (text[i] === "@") i += /^@[\w.-]*/.exec(text.slice(i, i + 200))?.[0].length ?? 1;
    }
  }
  return out;
}

export type HunspellLang = "de" | "en";

/** LanguageTool code ("de-DE", "en-US", "auto", ...) → dictionary; unknown → English. */
export function hunspellLang(code: string | undefined): HunspellLang {
  return code?.toLowerCase().startsWith("de") ? "de" : "en";
}
