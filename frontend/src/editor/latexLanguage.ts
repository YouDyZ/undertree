import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

const LATEX_EXTENSIONS = new Set([".tex", ".sty", ".cls", ".ltx", ".dtx", ".ins"]);

export function isBibtexFile(path: string): boolean {
  return path.toLowerCase().endsWith(".bib");
}

export function isLatexDocumentFile(path: string): boolean {
  const lower = path.toLowerCase();
  const idx = lower.lastIndexOf(".");
  return idx >= 0 && LATEX_EXTENSIONS.has(lower.slice(idx));
}

export function isLatexSyntaxFile(path: string): boolean {
  return isLatexDocumentFile(path) || isBibtexFile(path);
}

const STRUCTURAL_COMMANDS = new Set([
  "documentclass",
  "usepackage",
  "RequirePackage",
  "ProvidesPackage",
  "ProvidesClass",
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "title",
  "author",
  "date",
  "maketitle",
  "tableofcontents",
  "listoffigures",
  "listoftables",
  "input",
  "include",
  "includeonly",
  "bibliography",
  "bibliographystyle",
  "addbibresource",
  "printbibliography",
  "newcommand",
  "renewcommand",
  "providecommand",
  "DeclareMathOperator",
  "newenvironment",
  "renewenvironment",
  "newtheorem",
  "item",
  "caption",
  "appendix",
  "frontmatter",
  "mainmatter",
  "backmatter",
]);

const REFERENCE_COMMANDS = new Set([
  "label",
  "ref",
  "eqref",
  "autoref",
  "pageref",
  "nameref",
  "vref",
  "cref",
  "Cref",
  "cpageref",
  "cite",
  "parencite",
  "textcite",
  "autocite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "footcite",
  "nocite",
  "fullcite",
  "supercite",
]);

const MATH_ENVIRONMENTS = new Set([
  "math",
  "displaymath",
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "flalign",
  "flalign*",
  "alignat",
  "alignat*",
  "eqnarray",
  "eqnarray*",
  "split",
  "cases",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
]);

type MathMode = "none" | "inline-dollar" | "display-dollar" | "inline-paren" | "display-bracket" | "env";
type PendingArg = "none" | "begin-env" | "end-env" | "ref-key";

export interface LatexParserState {
  mathMode: MathMode;
  mathEnvName: string | null;
  pendingArg: PendingArg;
  inArg: PendingArg;
  optionalDepth: number;
}

const DIMENSION_UNITS = /^(?:pt|bp|pc|dd|cc|sp|mm|cm|in|ex|em|mu|px)\b/;

function readCommandName(stream: StringStream): string {
  // Already consumed leading backslash
  if (stream.match(/^[a-zA-Z@]+\*?/)) {
    return stream.current().slice(1);
  }
  if (stream.eat(/^./)) {
    return stream.current().slice(1);
  }
  return "";
}

export const latexStreamParser: StreamParser<LatexParserState> = {
  name: "latex",
  startState(): LatexParserState {
    return {
      mathMode: "none",
      mathEnvName: null,
      pendingArg: "none",
      inArg: "none",
      optionalDepth: 0,
    };
  },
  copyState(state: LatexParserState): LatexParserState {
    return { ...state };
  },
  token(stream: StringStream, state: LatexParserState): string | null {
    // 1. Inside a special brace argument: \begin{env}, \end{env}, \ref{key}, \cite{key}
    if (state.inArg !== "none") {
      if (stream.eat("}")) {
        state.inArg = "none";
        return "brace";
      }
      if (state.inArg === "begin-env" || state.inArg === "end-env") {
        if (stream.match(/[^}%]+/)) {
          const envName = stream.current().trim();
          if (state.inArg === "begin-env" && MATH_ENVIRONMENTS.has(envName)) {
            state.mathMode = "env";
            state.mathEnvName = envName;
          } else if (
            state.inArg === "end-env" &&
            state.mathMode === "env" &&
            (state.mathEnvName === envName || MATH_ENVIRONMENTS.has(envName))
          ) {
            state.mathMode = "none";
            state.mathEnvName = null;
          }
          return "typeName";
        }
      } else if (state.inArg === "ref-key") {
        if (stream.eat(",")) {
          return "operator";
        }
        if (stream.eatSpace()) {
          return null;
        }
        if (stream.match(/[^},%\s]+/)) {
          return "atom";
        }
      }
      // Comment inside unclosed arg
      if (stream.peek() === "%") {
        stream.skipToEnd();
        return "comment";
      }
      stream.next();
      return null;
    }

    // 2. Skip whitespace (preserve pendingArg across whitespace/optional args)
    if (stream.eatSpace()) {
      return null;
    }

    // 3. Comments: unescaped % to end of line
    if (stream.peek() === "%") {
      stream.skipToEnd();
      return "comment";
    }

    // 4. Pending argument handling (supports optional [...] before {arg} for \cite[p. 1]{key})
    if (state.pendingArg !== "none") {
      if (stream.peek() === "[") {
        stream.next();
        state.optionalDepth++;
        return "squareBracket";
      }
      if (state.optionalDepth > 0) {
        if (stream.peek() === "]") {
          stream.next();
          state.optionalDepth--;
          return "squareBracket";
        }
        // Let normal tokenization proceed inside [...] without dropping pendingArg
      } else if (stream.peek() === "{") {
        stream.next();
        state.inArg = state.pendingArg;
        state.pendingArg = "none";
        return "brace";
      } else {
        // Not followed by [ or { -> cancel pendingArg
        state.pendingArg = "none";
      }
    }

    const ch = stream.peek();

    // 5. Dollar math delimiters: $$ and $
    if (ch === "$") {
      if (stream.match("$$")) {
        if (state.mathMode === "display-dollar") {
          state.mathMode = "none";
        } else if (state.mathMode === "none") {
          state.mathMode = "display-dollar";
        }
        return "operator";
      }
      stream.next();
      if (state.mathMode === "inline-dollar") {
        state.mathMode = "none";
      } else if (state.mathMode === "none") {
        state.mathMode = "inline-dollar";
      }
      return "operator";
    }

    // 6. Backslash commands, escapes, and \( \) \[ \] math delimiters
    if (ch === "\\") {
      // Inline/display math delimiters \( \) \[ \]
      if (stream.match("\\(")) {
        if (state.mathMode === "none") state.mathMode = "inline-paren";
        return "operator";
      }
      if (stream.match("\\)")) {
        if (state.mathMode === "inline-paren") state.mathMode = "none";
        return "operator";
      }
      if (stream.match("\\[")) {
        if (state.mathMode === "none") state.mathMode = "display-bracket";
        return "operator";
      }
      if (stream.match("\\]")) {
        if (state.mathMode === "display-bracket") state.mathMode = "none";
        return "operator";
      }

      stream.next(); // consume '\'
      const rawName = readCommandName(stream);
      const baseName = rawName.endsWith("*") ? rawName.slice(0, -1) : rawName;

      if (rawName === "begin") {
        state.pendingArg = "begin-env";
        state.optionalDepth = 0;
        return "keyword";
      }
      if (rawName === "end") {
        state.pendingArg = "end-env";
        state.optionalDepth = 0;
        return "keyword";
      }
      if (REFERENCE_COMMANDS.has(baseName)) {
        state.pendingArg = "ref-key";
        state.optionalDepth = 0;
        return "meta";
      }
      if (STRUCTURAL_COMMANDS.has(baseName)) {
        return "keyword";
      }

      // Escaped single punctuation like \%, \$, \&, \\, \{, \}
      if (rawName.length === 1 && !/[a-zA-Z@]/.test(rawName)) {
        return state.mathMode !== "none" ? "operator" : "escape";
      }

      return "variableName";
    }

    // 7. Braces and brackets
    if (ch === "{" || ch === "}") {
      stream.next();
      return "brace";
    }
    if (ch === "[" || ch === "]") {
      stream.next();
      if (ch === "]" && state.optionalDepth > 0) {
        state.optionalDepth--;
      }
      return "squareBracket";
    }

    // 8. Numbers and TeX dimensions (e.g. 12pt, 0.8\textwidth -> 0.8 as "number")
    if (stream.match(/^(?:\d+\.\d+|\d+|\.\d+)/)) {
      stream.match(DIMENSION_UNITS);
      return "number";
    }

    // 9. Math operators (^, _, &, =, +, -, etc.)
    if (ch === "^" || ch === "_" || ch === "&" || ch === "~") {
      stream.next();
      return "operator";
    }

    // 10. Inside math mode: highlight math operators and math content distinctly
    if (state.mathMode !== "none") {
      if (stream.match(/^[=+\-*/<>!|,;:]/)) {
        return "operator";
      }
      if (stream.match(/^[^\\${}[\]^_&~%=+\-*/<>!|,;:\d\s]+/)) {
        return "string";
      }
      stream.next();
      return "string";
    }

    // 11. Plain prose outside math mode
    if (!stream.match(/^[^\\${}[\]^_&~%\d\s]+/)) {
      stream.next();
    }
    return null;
  },
  languageData: {
    commentTokens: { line: "%" },
  },
};

export interface BibtexParserState {
  expectEntryOpen: boolean;
  expectEntryKey: boolean;
  entryDelimiter: "{" | "(" | null;
  inString: boolean;
  braceDepth: number;
  parenDepth: number;
}

export const bibtexStreamParser: StreamParser<BibtexParserState> = {
  name: "bibtex",
  startState(): BibtexParserState {
    return {
      expectEntryOpen: false,
      expectEntryKey: false,
      entryDelimiter: null,
      inString: false,
      braceDepth: 0,
      parenDepth: 0,
    };
  },
  copyState(state: BibtexParserState): BibtexParserState {
    return { ...state };
  },
  token(stream: StringStream, state: BibtexParserState): string | null {
    if (state.inString) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\" && !stream.eol()) {
          stream.next();
        } else if (ch === '"') {
          state.inString = false;
          break;
        }
      }
      return "string";
    }

    if (stream.eatSpace()) return null;

    if (stream.peek() === "%") {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.match(/^@[a-zA-Z]+/)) {
      const entryType = stream.current().slice(1).toLowerCase();
      state.expectEntryOpen = entryType !== "comment" && entryType !== "preamble";
      state.expectEntryKey = false;
      return "keyword";
    }

    if (state.expectEntryOpen) {
      if (stream.eat("{")) {
        state.entryDelimiter = "{";
        state.braceDepth = 1;
        state.parenDepth = 0;
        state.expectEntryOpen = false;
        state.expectEntryKey = true;
        return "brace";
      }
      if (stream.eat("(")) {
        state.entryDelimiter = "(";
        state.parenDepth = 1;
        state.braceDepth = 0;
        state.expectEntryOpen = false;
        state.expectEntryKey = true;
        return "paren";
      }
      state.expectEntryOpen = false;
    }

    if (state.expectEntryKey) {
      if (stream.match(/^[^,\s})]+/)) {
        state.expectEntryKey = false;
        return "atom";
      }
      state.expectEntryKey = false;
    }

    if (stream.eat('"')) {
      state.inString = true;
      return "string";
    }

    if (stream.eat("{")) {
      state.braceDepth++;
      return "brace";
    }
    if (stream.eat("}")) {
      if (state.braceDepth > 0) state.braceDepth--;
      if (state.entryDelimiter === "{" && state.braceDepth === 0) {
        state.entryDelimiter = null;
      }
      return "brace";
    }

    if (state.entryDelimiter === "(" && state.braceDepth === 0) {
      if (stream.eat("(")) {
        state.parenDepth++;
        return "paren";
      }
      if (stream.eat(")")) {
        if (state.parenDepth > 0) state.parenDepth--;
        if (state.parenDepth === 0) {
          state.entryDelimiter = null;
        }
        return "paren";
      }
    }

    if (stream.eat("=") || stream.eat("#")) {
      return "operator";
    }

    const atEntryFieldLevel =
      (state.entryDelimiter === "{" && state.braceDepth === 1) ||
      (state.entryDelimiter === "(" && state.parenDepth === 1 && state.braceDepth === 0);

    // Field name at entry top level (e.g. title = {...})
    if (atEntryFieldLevel && stream.match(/^[a-zA-Z][a-zA-Z0-9_-]*(?=\s*=)/)) {
      return "propertyName";
    }

    if (stream.match(/^\d+/)) {
      return "number";
    }

    const inBracedValue =
      (state.entryDelimiter === "{" && state.braceDepth >= 2) ||
      (state.entryDelimiter === "(" && state.braceDepth >= 1) ||
      (state.entryDelimiter === null && state.braceDepth >= 2);

    if (inBracedValue && stream.match(/^[^"{}%]+/)) {
      return "string";
    }

    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "%" },
  },
};

export const latexLanguage = StreamLanguage.define(latexStreamParser);
export const bibtexLanguage = StreamLanguage.define(bibtexStreamParser);

export function getLatexLanguageExtension(path: string): Extension | null {
  if (isBibtexFile(path)) return bibtexLanguage;
  if (isLatexDocumentFile(path)) return latexLanguage;
  return null;
}
