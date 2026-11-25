import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  autocompletion,
  snippetCompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { fuzzyMatch, indicesToMatchRanges } from "./fuzzy";
import { LATEX_COMMANDS, LATEX_ENVIRONMENTS, buildEnvSnippet } from "./latexCatalog";
import { extractEmmetExprBefore, getEmmetSuggestions } from "./latexEmmet";

export interface LatexCompletionOptions {
  getContextTexts?: () => string[];
  getBibTexts?: () => string[];
}

export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
}

const IGNORED_BIB_TYPES = new Set(["comment", "preamble", "string"]);

/**
 * Strips unescaped `% ...` LaTeX comments line-by-line while preserving line structure.
 */
export function stripLatexComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%") {
          let backslashes = 0;
          for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
          if (backslashes % 2 === 0) {
            return line.slice(0, i);
          }
        }
      }
      return line;
    })
    .join("\n");
}

function isInsideLineComment(lineText: string, col: number): boolean {
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
 * Extracts unique `\label{...}` keys across one or more LaTeX documents, ignoring comments.
 */
export function extractLabels(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  const labelRe = /\\label\{([^{}\s]+)\}/g;

  for (const text of texts) {
    if (!text) continue;
    const cleaned = stripLatexComments(text);
    labelRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = labelRe.exec(cleaned)) !== null) {
      const key = m[1];
      if (key && !seen.has(key)) {
        seen.add(key);
        labels.push(key);
      }
    }
  }
  return labels;
}

function cleanBibValue(raw: string): string {
  return raw.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

function parseBibField(body: string, fieldName: string): string | undefined {
  const re = new RegExp(`(?:^|[,\\s])${fieldName}\\s*=\\s*`, "i");
  const m = re.exec(body);
  if (!m) return undefined;

  let i = m.index + m[0].length;
  const startChar = body[i];
  if (startChar === "{") {
    let depth = 0;
    const start = i + 1;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return cleanBibValue(body.slice(start, i));
        }
      }
    }
    return cleanBibValue(body.slice(start));
  }
  if (startChar === '"') {
    const start = i + 1;
    i++;
    for (; i < body.length; i++) {
      if (body[i] === '"' && body[i - 1] !== "\\") {
        return cleanBibValue(body.slice(start, i));
      }
    }
    return cleanBibValue(body.slice(start));
  }
  // Bare value (e.g. year = 2024)
  const bareMatch = /^[^,\s}]+/.exec(body.slice(i));
  return bareMatch ? cleanBibValue(bareMatch[0]) : undefined;
}

/**
 * Extracts BibTeX entries (`@article{key, ...}`) from one or more `.bib` texts.
 */
export function extractBibEntries(texts: readonly string[]): BibEntry[] {
  const seen = new Set<string>();
  const entries: BibEntry[] = [];
  const headRe = /@([a-zA-Z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/g;

  for (const text of texts) {
    if (!text) continue;
    const cleaned = stripLatexComments(text);
    headRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = headRe.exec(cleaned)) !== null) {
      const type = (m[1] ?? "").toLowerCase();
      const key = m[2] ?? "";
      if (!key || IGNORED_BIB_TYPES.has(type) || seen.has(key)) continue;

      // Scan forward from opening delimiter to matching closing delimiter
      const openDelimPos = cleaned.indexOf("{", m.index);
      const openParenPos = cleaned.indexOf("(", m.index);
      const useParen =
        openParenPos >= 0 && (openDelimPos < 0 || openParenPos < openDelimPos);
      const openCh = useParen ? "(" : "{";
      const closeCh = useParen ? ")" : "}";
      const bodyStart = m.index + m[0].length;

      let depth = 1;
      let end = bodyStart;
      while (end < cleaned.length && depth > 0) {
        const ch = cleaned[end];
        if (ch === openCh) depth++;
        else if (ch === closeCh) depth--;
        end++;
      }
      const body = cleaned.slice(bodyStart, Math.max(bodyStart, end - 1));
      const title = parseBibField(body, "title");
      const author = parseBibField(body, "author");
      const year = parseBibField(body, "year");

      seen.add(key);
      entries.push({ key, type, title, author, year });
    }
  }
  return entries;
}

function formatBibDetail(entry: BibEntry): string {
  const parts: string[] = [];
  if (entry.author) {
    const firstAuthor = entry.author.split(/\s+and\s+/i)[0]?.trim() ?? entry.author;
    parts.push(entry.year ? `${firstAuthor} (${entry.year})` : firstAuthor);
  } else if (entry.year) {
    parts.push(entry.year);
  }
  if (entry.title) {
    parts.push(entry.title);
  }
  const summary = parts.join(" · ") || `@${entry.type}`;
  return summary.length > 64 ? `${summary.slice(0, 61)}…` : summary;
}

/**
 * Scans LaTeX source before cursor and returns the stack of currently open environments
 * (innermost environment at the end of the returned array).
 */
export function findOpenEnvironments(docTextBeforeCursor: string): string[] {
  const cleaned = stripLatexComments(docTextBeforeCursor);
  const stack: string[] = [];
  const envRe = /\\(begin|end)\{([a-zA-Z0-9*_-]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = envRe.exec(cleaned)) !== null) {
    const kind = m[1];
    const name = m[2];
    if (!name) continue;
    if (kind === "begin") {
      stack.push(name);
    } else if (kind === "end") {
      // Pop matching environment (or innermost matching if nested unclosed env exists)
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) {
        stack.splice(idx);
      }
    }
  }
  return stack;
}

function makeResult(
  from: number,
  to: number | undefined,
  options: Completion[],
  matchMap: WeakMap<Completion, number[]>
): CompletionResult | null {
  if (options.length === 0) return null;
  return {
    from,
    ...(to !== undefined ? { to } : {}),
    options,
    filter: false,
    getMatch(completion: Completion) {
      return matchMap.get(completion) ?? [];
    },
  };
}

const REF_REGEX =
  /\\(?:ref|eqref|autoref|pageref|nameref|vref|cref|Cref)\{(?:[^{}]*,)?\s*([^,{}\s]*)$/;
const CITE_REGEX =
  /\\(?:cite|parencite|textcite|autocite|citep|citet|citealp|citealt|citeauthor|citeyear|footcite|nocite|fullcite|supercite)(?:\[[^\]]*\])*\{(?:[^{}]*,)?\s*([^,{}\s]*)$/;
const BEGIN_REGEX = /\\begin\{([a-zA-Z0-9*_-]*)$/;
const END_REGEX = /\\end\{([a-zA-Z0-9*_-]*)$/;
const CMD_REGEX = /\\([a-zA-Z@*]*)$/;

const MAX_COMMAND_RESULTS = 50;

export function createLatexCompletionSource(options?: LatexCompletionOptions): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const col = context.pos - line.from;
    if (!context.explicit && isInsideLineComment(line.text, col)) {
      return null;
    }

    const matchMap = new WeakMap<Completion, number[]>();

    // 1. Inside \begin{...
    const beginMatch = context.matchBefore(BEGIN_REGEX);
    if (beginMatch) {
      const query = BEGIN_REGEX.exec(beginMatch.text)?.[1] ?? "";
      const hasTrailingBrace =
        context.state.doc.sliceString(context.pos, context.pos + 1) === "}";
      const to = hasTrailingBrace ? context.pos + 1 : context.pos;

      const ranked: { completion: Completion; score: number }[] = [];
      for (const env of LATEX_ENVIRONMENTS) {
        const res = fuzzyMatch(query, env.name);
        if (!res) continue;
        const comp = snippetCompletion(buildEnvSnippet(env), {
          label: env.name,
          detail: env.detail,
          type: "type",
          boost: env.boost,
        });
        matchMap.set(comp, indicesToMatchRanges(res.matchedIndices));
        ranked.push({ completion: comp, score: res.score + (env.boost ?? 0) * 0.4 });
      }
      ranked.sort((a, b) => b.score - a.score || a.completion.label.localeCompare(b.completion.label));
      return makeResult(
        beginMatch.from,
        to,
        ranked.map((r) => r.completion),
        matchMap
      );
    }

    // 2. Inside \end{...
    const endMatch = context.matchBefore(END_REGEX);
    if (endMatch) {
      const query = END_REGEX.exec(endMatch.text)?.[1] ?? "";
      const nameFrom = endMatch.from + "\\end{".length;
      const hasTrailingBrace =
        context.state.doc.sliceString(context.pos, context.pos + 1) === "}";
      const to = hasTrailingBrace ? context.pos + 1 : context.pos;

      const openStack = findOpenEnvironments(context.state.doc.sliceString(0, endMatch.from));
      const openPriority = new Map<string, number>();
      // Innermost open env gets rank 0 -> boost 99
      for (let i = openStack.length - 1; i >= 0; i--) {
        const envName = openStack[i];
        if (envName && !openPriority.has(envName)) {
          const depthFromTop = openStack.length - 1 - i;
          openPriority.set(envName, depthFromTop);
        }
      }

      const seen = new Set<string>();
      const ranked: { completion: Completion; score: number }[] = [];

      // Add open environments first (even custom ones not in catalog)
      for (const [envName, depth] of openPriority.entries()) {
        seen.add(envName);
        const res = fuzzyMatch(query, envName);
        if (!res) continue;
        const boost = depth === 0 ? 99 : Math.max(50, 85 - depth * 10);
        const comp: Completion = {
          label: envName,
          detail: depth === 0 ? "Offene Umgebung schließen" : "Äußere offene Umgebung",
          type: "type",
          boost,
          apply: `${envName}}`,
        };
        matchMap.set(comp, indicesToMatchRanges(res.matchedIndices));
        ranked.push({ completion: comp, score: 1000 - depth * 50 + res.score });
      }

      for (const env of LATEX_ENVIRONMENTS) {
        if (seen.has(env.name)) continue;
        const res = fuzzyMatch(query, env.name);
        if (!res) continue;
        const comp: Completion = {
          label: env.name,
          detail: env.detail,
          type: "type",
          apply: `${env.name}}`,
        };
        matchMap.set(comp, indicesToMatchRanges(res.matchedIndices));
        ranked.push({ completion: comp, score: res.score + (env.boost ?? 0) * 0.2 });
      }

      ranked.sort((a, b) => b.score - a.score || a.completion.label.localeCompare(b.completion.label));
      return makeResult(
        nameFrom,
        to,
        ranked.map((r) => r.completion),
        matchMap
      );
    }

    // 3. Inside \ref{, \eqref{, \autoref{, \pageref{, \cref{, \Cref{
    const refMatch = context.matchBefore(REF_REGEX);
    if (refMatch) {
      const query = REF_REGEX.exec(refMatch.text)?.[1] ?? "";
      const from = context.pos - query.length;
      const texts = [context.state.doc.toString(), ...(options?.getContextTexts?.() ?? [])];
      const labels = extractLabels(texts);

      const ranked: { completion: Completion; score: number }[] = [];
      for (const label of labels) {
        const res = fuzzyMatch(query, label);
        if (!res) continue;
        const comp: Completion = {
          label,
          detail: "Label",
          type: "constant",
        };
        matchMap.set(comp, indicesToMatchRanges(res.matchedIndices));
        ranked.push({ completion: comp, score: res.score });
      }
      ranked.sort((a, b) => b.score - a.score || a.completion.label.localeCompare(b.completion.label));
      return makeResult(
        from,
        context.pos,
        ranked.map((r) => r.completion),
        matchMap
      );
    }

    // 4. Inside \cite{, \parencite{, \textcite{, \autocite{, \citep{, \citet{, \footcite{
    const citeMatch = context.matchBefore(CITE_REGEX);
    if (citeMatch) {
      const query = CITE_REGEX.exec(citeMatch.text)?.[1] ?? "";
      const from = context.pos - query.length;
      const bibTexts = [...(options?.getBibTexts?.() ?? [])];
      const currentText = context.state.doc.toString();
      if (currentText.includes("@")) {
        bibTexts.push(currentText);
      }
      const entries = extractBibEntries(bibTexts);

      const ranked: { completion: Completion; score: number }[] = [];
      for (const entry of entries) {
        const keyMatch = fuzzyMatch(query, entry.key);
        let score: number | null = keyMatch ? keyMatch.score + 20 : null;
        let highlightRanges: number[] = keyMatch ? indicesToMatchRanges(keyMatch.matchedIndices) : [];

        if (score === null && query.length > 0) {
          const metaText = `${entry.author ?? ""} ${entry.title ?? ""}`.trim();
          const metaMatch = metaText ? fuzzyMatch(query, metaText) : null;
          if (metaMatch) {
            score = metaMatch.score;
            highlightRanges = [];
          }
        }
        if (score === null) continue;

        const comp: Completion = {
          label: entry.key,
          detail: formatBibDetail(entry),
          type: "text",
        };
        matchMap.set(comp, highlightRanges);
        ranked.push({ completion: comp, score });
      }
      ranked.sort((a, b) => b.score - a.score || a.completion.label.localeCompare(b.completion.label));
      return makeResult(
        from,
        context.pos,
        ranked.map((r) => r.completion),
        matchMap
      );
    }

    // 5. After \... command completion (commands + \begin{env} shortcuts)
    const cmdMatch = context.matchBefore(CMD_REGEX);
    if (cmdMatch) {
      // Ignore `\\` line breaks
      const charBefore =
        cmdMatch.from > 0 ? context.state.doc.sliceString(cmdMatch.from - 1, cmdMatch.from) : "";
      if (charBefore !== "\\") {
        const query = CMD_REGEX.exec(cmdMatch.text)?.[1] ?? "";
        const ranked: { completion: Completion; score: number }[] = [];

        for (const cmd of LATEX_COMMANDS) {
          const targetWithoutSlash = cmd.label.slice(1);
          const res = fuzzyMatch(query, targetWithoutSlash);
          if (!res) continue;

          const base: Completion = {
            label: cmd.label,
            detail: cmd.detail,
            type: cmd.type,
            ...(cmd.boost !== undefined ? { boost: cmd.boost } : {}),
          };
          const comp = cmd.snippet ? snippetCompletion(cmd.snippet, base) : base;
          matchMap.set(comp, indicesToMatchRanges(res.matchedIndices, 1));
          ranked.push({
            completion: comp,
            score: res.score + (cmd.boost ?? 0) * 0.4,
          });
        }

        // Also offer `\begin{env}` entries so fuzzy queries like `\bfig` match `\begin{figure}`
        if (query.length > 0) {
          for (const env of LATEX_ENVIRONMENTS) {
            const labelWithoutSlash = `begin{${env.name}}`;
            const res = fuzzyMatch(query, labelWithoutSlash);
            if (!res) continue;

            const comp = snippetCompletion(buildEnvSnippet(env), {
              label: `\\${labelWithoutSlash}`,
              detail: env.detail,
              type: "type",
              boost: env.boost,
            });
            matchMap.set(comp, indicesToMatchRanges(res.matchedIndices, 1));
            ranked.push({
              completion: comp,
              score: res.score + (env.boost ?? 0) * 0.35,
            });
          }
        }

        ranked.sort(
          (a, b) => b.score - a.score || a.completion.label.localeCompare(b.completion.label)
        );
        return makeResult(
          cmdMatch.from,
          context.pos,
          ranked.slice(0, MAX_COMMAND_RESULTS).map((r) => r.completion),
          matchMap
        );
      }
    }

    // 6. Plain word start without `\`: Emmet suggestions (e.g. fig, item*3, table2x3, sec, eq)
    const candidate = extractEmmetExprBefore(line.text, col);
    if (candidate && (candidate.expr.length >= 2 || context.explicit)) {
      const suggestions = getEmmetSuggestions(candidate.expr, context.explicit);
      if (suggestions.length > 0) {
        const from = line.from + candidate.fromOffset;
        const completions = suggestions.slice(0, 15).map((s) => {
          const comp = snippetCompletion(s.template, {
            label: s.label,
            detail: `Emmet · ${s.detail}`,
            type: "keyword",
          });
          matchMap.set(comp, indicesToMatchRanges(s.matchedIndices));
          return comp;
        });
        return makeResult(from, context.pos, completions, matchMap);
      }
    }

    return null;
  };
}

export function latexAutocompletion(options?: LatexCompletionOptions): Extension {
  return autocompletion({
    override: [createLatexCompletionSource(options)],
    filterStrict: false,
    activateOnTyping: true,
    maxRenderedOptions: 40,
  });
}
