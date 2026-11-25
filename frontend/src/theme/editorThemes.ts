import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { EditorThemeId } from "./themeStore";

export interface EditorThemeSwatch {
  bg: string;
  fg: string;
  accent: string;
  keyword: string;
}

export interface EditorThemeMeta {
  id: EditorThemeId;
  label: string;
  group: "dark" | "light";
  swatch: EditorThemeSwatch;
}

interface EditorPalette {
  dark: boolean;
  bg: string;
  fg: string;
  gutterBg: string;
  gutterFg: string;
  gutterBorder: string;
  activeLineBg: string;
  activeLineGutterBg: string;
  activeLineGutterFg: string;
  caret: string;
  selection: string;
  searchMatchBg: string;
  searchMatchOutline: string;
  searchMatchSelectedBg: string;
  selectionMatchBg: string;
  matchingBracketBg: string;
  panelBg: string;
  panelBorder: string;
  tooltipBg: string;
  tooltipBorder: string;
  // Syntax tokens (optimized for LaTeX stex + general files)
  keyword: string;
  command: string; // tags.tagName (\section, \begin, \end, \usepackage, \foo)
  type: string; // tags.typeName, tags.className
  atom: string; // tags.atom (env names, \label/\ref/\cite args)
  string: string; // tags.string
  variable: string; // tags.variableName
  mathVar: string; // tags.special(tags.variableName) (math identifiers)
  number: string; // tags.number
  operator: string; // tags.operator
  bracket: string; // tags.bracket, tags.squareBracket, tags.brace
  meta: string; // tags.meta, tags.labelName
  comment: string; // tags.comment
  invalid: string; // tags.invalid
}

function buildEditorTheme(p: EditorPalette): Extension {
  const editorChrome = EditorView.theme(
    {
      "&": {
        color: p.fg,
        backgroundColor: p.bg,
      },
      ".cm-content": {
        caretColor: p.caret,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: p.caret,
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: p.selection,
        },
      ".cm-panels": {
        backgroundColor: p.panelBg,
        color: p.fg,
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: `1px solid ${p.panelBorder}`,
      },
      ".cm-panels.cm-panels-bottom": {
        borderTop: `1px solid ${p.panelBorder}`,
      },
      ".cm-searchMatch": {
        backgroundColor: p.searchMatchBg,
        outline: `1px solid ${p.searchMatchOutline}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: p.searchMatchSelectedBg,
      },
      ".cm-activeLine": {
        backgroundColor: p.activeLineBg,
      },
      ".cm-selectionMatch": {
        backgroundColor: p.selectionMatchBg,
      },
      "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: p.matchingBracketBg,
      },
      ".cm-gutters": {
        backgroundColor: p.gutterBg,
        color: p.gutterFg,
        borderRight: `1px solid ${p.gutterBorder}`,
      },
      ".cm-activeLineGutter": {
        backgroundColor: p.activeLineGutterBg,
        color: p.activeLineGutterFg,
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: `1px solid ${p.gutterBorder}`,
        color: p.gutterFg,
      },
      ".cm-tooltip": {
        border: `1px solid ${p.tooltipBorder}`,
        backgroundColor: p.tooltipBg,
        color: p.fg,
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: "transparent",
        borderBottomColor: "transparent",
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: p.tooltipBg,
        borderBottomColor: p.tooltipBg,
      },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
          backgroundColor: p.selection,
          color: p.fg,
        },
      },
    },
    { dark: p.dark }
  );

  const highlight = HighlightStyle.define([
    // Keywords & math delimiters ($...$, \[...\])
    { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: p.keyword, fontWeight: "500" },
    // LaTeX commands (\section, \begin, \end, \usepackage) emitted as "tag" by stex
    { tag: [tags.tagName, tags.macroName, tags.processingInstruction], color: p.command },
    // Environment & type names
    { tag: [tags.typeName, tags.className, tags.namespace, tags.annotation], color: p.type },
    // LaTeX arguments ({document}, {amsmath}, \ref{...}, \cite{...}, \label{...})
    { tag: [tags.atom, tags.bool], color: p.atom },
    // Strings & text arguments
    { tag: [tags.string, tags.special(tags.string), tags.inserted], color: p.string },
    // Variables, macros, properties
    { tag: [tags.variableName, tags.propertyName, tags.definition(tags.variableName)], color: p.variable },
    // Math-mode identifiers (variableName.special in stex) & builtins
    { tag: [tags.special(tags.variableName), tags.standard(tags.variableName)], color: p.mathVar },
    // Numbers
    { tag: [tags.number, tags.integer, tags.float], color: p.number },
    // Operators & escapes
    { tag: [tags.operator, tags.operatorKeyword, tags.escape, tags.regexp], color: p.operator },
    // Brackets, braces, parens
    {
      tag: [tags.bracket, tags.squareBracket, tags.brace, tags.paren, tags.angleBracket],
      color: p.bracket,
    },
    // Meta, labels, references
    { tag: [tags.meta, tags.labelName, tags.attributeName], color: p.meta },
    // Comments (% ...)
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: p.comment, fontStyle: "italic" },
    // Headings & prose formatting
    { tag: tags.heading, color: p.command, fontWeight: "bold" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: p.meta, textDecoration: "underline" },
    // Errors & unmatched brackets
    { tag: [tags.invalid, tags.deleted], color: p.invalid, textDecoration: "underline wavy" },
  ]);

  return [editorChrome, syntaxHighlighting(highlight)];
}

const PALETTES: Record<EditorThemeId, EditorPalette> = {
  "one-dark": {
    dark: true,
    bg: "#282c34",
    fg: "#abb2bf",
    gutterBg: "#21252b",
    gutterFg: "#636d83",
    gutterBorder: "#323844",
    activeLineBg: "rgba(97, 175, 239, 0.08)",
    activeLineGutterBg: "#2c313a",
    activeLineGutterFg: "#e6ebf5",
    caret: "#528bff",
    selection: "#3e4451",
    searchMatchBg: "rgba(114, 161, 255, 0.32)",
    searchMatchOutline: "#528bff",
    searchMatchSelectedBg: "rgba(97, 175, 239, 0.45)",
    selectionMatchBg: "rgba(152, 195, 121, 0.16)",
    matchingBracketBg: "rgba(186, 208, 248, 0.25)",
    panelBg: "#21252b",
    panelBorder: "#181a1f",
    tooltipBg: "#2c313a",
    tooltipBorder: "#3e4451",
    keyword: "#c678dd",
    command: "#61afef",
    type: "#e5c07b",
    atom: "#e06c75",
    string: "#98c379",
    variable: "#e06c75",
    mathVar: "#d19a66",
    number: "#d19a66",
    operator: "#56b6c2",
    bracket: "#8b95a7",
    meta: "#56b6c2",
    comment: "#7d8799",
    invalid: "#f44747",
  },
  dracula: {
    dark: true,
    bg: "#282a36",
    fg: "#f8f8f2",
    gutterBg: "#21222c",
    gutterFg: "#6272a4",
    gutterBorder: "#383a59",
    activeLineBg: "rgba(68, 71, 90, 0.52)",
    activeLineGutterBg: "#343746",
    activeLineGutterFg: "#f8f8f2",
    caret: "#f8f8f2",
    selection: "#44475a",
    searchMatchBg: "rgba(255, 184, 108, 0.28)",
    searchMatchOutline: "#ffb86c",
    searchMatchSelectedBg: "rgba(255, 121, 198, 0.35)",
    selectionMatchBg: "rgba(80, 250, 123, 0.16)",
    matchingBracketBg: "rgba(139, 233, 253, 0.25)",
    panelBg: "#21222c",
    panelBorder: "#191a21",
    tooltipBg: "#343746",
    tooltipBorder: "#44475a",
    keyword: "#ff79c6",
    command: "#8be9fd",
    type: "#50fa7b",
    atom: "#bd93f9",
    string: "#f1fa8c",
    variable: "#50fa7b",
    mathVar: "#ffb86c",
    number: "#bd93f9",
    operator: "#ff79c6",
    bracket: "#a4b0d6",
    meta: "#ffb86c",
    comment: "#7a88b8",
    invalid: "#ff5555",
  },
  monokai: {
    dark: true,
    bg: "#272822",
    fg: "#f8f8f2",
    gutterBg: "#20211c",
    gutterFg: "#75715e",
    gutterBorder: "#3b3a32",
    activeLineBg: "rgba(255, 255, 255, 0.05)",
    activeLineGutterBg: "#34352d",
    activeLineGutterFg: "#f8f8f2",
    caret: "#f8f8f0",
    selection: "#49483e",
    searchMatchBg: "rgba(230, 219, 116, 0.28)",
    searchMatchOutline: "#e6db74",
    searchMatchSelectedBg: "rgba(249, 38, 114, 0.35)",
    selectionMatchBg: "rgba(166, 226, 46, 0.16)",
    matchingBracketBg: "rgba(102, 217, 239, 0.24)",
    panelBg: "#20211c",
    panelBorder: "#171814",
    tooltipBg: "#34352d",
    tooltipBorder: "#49483e",
    keyword: "#f92672",
    command: "#66d9ef",
    type: "#a6e22e",
    atom: "#ae81ff",
    string: "#e6db74",
    variable: "#a6e22e",
    mathVar: "#fd971f",
    number: "#ae81ff",
    operator: "#f92672",
    bracket: "#a6a596",
    meta: "#fd971f",
    comment: "#8f8b76",
    invalid: "#ff4a6e",
  },
  nord: {
    dark: true,
    bg: "#2e3440",
    fg: "#d8dee9",
    gutterBg: "#272c36",
    gutterFg: "#616e88",
    gutterBorder: "#3b4252",
    activeLineBg: "rgba(67, 76, 94, 0.42)",
    activeLineGutterBg: "#3b4252",
    activeLineGutterFg: "#eceff4",
    caret: "#d8dee9",
    selection: "#434c5e",
    searchMatchBg: "rgba(136, 192, 208, 0.26)",
    searchMatchOutline: "#88c0d0",
    searchMatchSelectedBg: "rgba(235, 203, 139, 0.34)",
    selectionMatchBg: "rgba(163, 190, 140, 0.18)",
    matchingBracketBg: "rgba(136, 192, 208, 0.28)",
    panelBg: "#272c36",
    panelBorder: "#20242d",
    tooltipBg: "#3b4252",
    tooltipBorder: "#4c566a",
    keyword: "#81a1c1",
    command: "#88c0d0",
    type: "#8fbcbb",
    atom: "#b48ead",
    string: "#a3be8c",
    variable: "#8fbcbb",
    mathVar: "#ebcb8b",
    number: "#b48ead",
    operator: "#81a1c1",
    bracket: "#8b98b0",
    meta: "#d08770",
    comment: "#7b88a1",
    invalid: "#bf616a",
  },
  "overleaf-light": {
    dark: false,
    bg: "#ffffff",
    fg: "#222933",
    gutterBg: "#f5f7f9",
    gutterFg: "#7b8794",
    gutterBorder: "#e2e7ee",
    activeLineBg: "#f2f7fc",
    activeLineGutterBg: "#e8eff7",
    activeLineGutterFg: "#1f2937",
    caret: "#138a07",
    selection: "#cfe5ff",
    searchMatchBg: "rgba(250, 204, 21, 0.38)",
    searchMatchOutline: "#ca8a04",
    searchMatchSelectedBg: "rgba(19, 138, 7, 0.22)",
    selectionMatchBg: "rgba(19, 138, 7, 0.12)",
    matchingBracketBg: "rgba(11, 110, 79, 0.18)",
    panelBg: "#f5f7f9",
    panelBorder: "#d8e0e8",
    tooltipBg: "#ffffff",
    tooltipBorder: "#cbd5e1",
    keyword: "#9a2a8c",
    command: "#0b6e4f",
    type: "#1d4ed8",
    atom: "#1d4ed8",
    string: "#b45309",
    variable: "#0f766e",
    mathVar: "#7c3aed",
    number: "#c2410c",
    operator: "#0369a1",
    bracket: "#64748b",
    meta: "#0284c7",
    comment: "#6b7280",
    invalid: "#dc2626",
  },
  "github-light": {
    dark: false,
    bg: "#ffffff",
    fg: "#1f2328",
    gutterBg: "#f6f8fa",
    gutterFg: "#6e7781",
    gutterBorder: "#d8dee4",
    activeLineBg: "#f6f8fa",
    activeLineGutterBg: "#eaeef2",
    activeLineGutterFg: "#1f2328",
    caret: "#0969da",
    selection: "#cce5ff",
    searchMatchBg: "rgba(255, 211, 61, 0.45)",
    searchMatchOutline: "#bf8700",
    searchMatchSelectedBg: "rgba(9, 105, 218, 0.22)",
    selectionMatchBg: "rgba(26, 127, 55, 0.14)",
    matchingBracketBg: "rgba(9, 105, 218, 0.18)",
    panelBg: "#f6f8fa",
    panelBorder: "#d0d7de",
    tooltipBg: "#ffffff",
    tooltipBorder: "#d0d7de",
    keyword: "#cf222e",
    command: "#0550ae",
    type: "#953800",
    atom: "#8250df",
    string: "#116329",
    variable: "#953800",
    mathVar: "#8250df",
    number: "#0550ae",
    operator: "#cf222e",
    bracket: "#57606a",
    meta: "#0969da",
    comment: "#6e7781",
    invalid: "#a40e26",
  },
  "solarized-light": {
    dark: false,
    bg: "#fdf6e3",
    fg: "#586e75",
    gutterBg: "#eee8d5",
    gutterFg: "#839496",
    gutterBorder: "#dfd8c3",
    activeLineBg: "#f5efdc",
    activeLineGutterBg: "#e6dfc9",
    activeLineGutterFg: "#073642",
    caret: "#268bd2",
    selection: "#e2dcc7",
    searchMatchBg: "rgba(181, 137, 0, 0.28)",
    searchMatchOutline: "#b58900",
    searchMatchSelectedBg: "rgba(38, 139, 210, 0.28)",
    selectionMatchBg: "rgba(133, 153, 0, 0.18)",
    matchingBracketBg: "rgba(42, 161, 152, 0.25)",
    panelBg: "#eee8d5",
    panelBorder: "#dcd4bc",
    tooltipBg: "#fdf6e3",
    tooltipBorder: "#d5ccb4",
    keyword: "#859900",
    command: "#268bd2",
    type: "#b58900",
    atom: "#d33682",
    string: "#2aa198",
    variable: "#cb4b16",
    mathVar: "#6c71c4",
    number: "#d33682",
    operator: "#859900",
    bracket: "#7c8b8d",
    meta: "#cb4b16",
    comment: "#7c8b8d",
    invalid: "#dc322f",
  },
  "one-light": {
    dark: false,
    bg: "#fafafa",
    fg: "#383a42",
    gutterBg: "#f0f0f1",
    gutterFg: "#8c8e96",
    gutterBorder: "#e2e2e5",
    activeLineBg: "#f2f2f4",
    activeLineGutterBg: "#e5e5e8",
    activeLineGutterFg: "#383a42",
    caret: "#526fff",
    selection: "#d7dae0",
    searchMatchBg: "rgba(193, 132, 1, 0.26)",
    searchMatchOutline: "#c18401",
    searchMatchSelectedBg: "rgba(64, 120, 242, 0.24)",
    selectionMatchBg: "rgba(80, 161, 79, 0.16)",
    matchingBracketBg: "rgba(64, 120, 242, 0.2)",
    panelBg: "#f0f0f1",
    panelBorder: "#dbdbdf",
    tooltipBg: "#ffffff",
    tooltipBorder: "#d4d4d8",
    keyword: "#a626a4",
    command: "#4078f2",
    type: "#c18401",
    atom: "#e45649",
    string: "#50a14f",
    variable: "#e45649",
    mathVar: "#986801",
    number: "#986801",
    operator: "#0184bc",
    bracket: "#696c77",
    meta: "#0184bc",
    comment: "#7f848e",
    invalid: "#ca1243",
  },
};

export const EDITOR_THEMES: readonly EditorThemeMeta[] = [
  {
    id: "one-dark",
    label: "One Dark",
    group: "dark",
    swatch: { bg: "#282c34", fg: "#abb2bf", accent: "#61afef", keyword: "#c678dd" },
  },
  {
    id: "dracula",
    label: "Dracula",
    group: "dark",
    swatch: { bg: "#282a36", fg: "#f8f8f2", accent: "#8be9fd", keyword: "#ff79c6" },
  },
  {
    id: "monokai",
    label: "Monokai",
    group: "dark",
    swatch: { bg: "#272822", fg: "#f8f8f2", accent: "#66d9ef", keyword: "#f92672" },
  },
  {
    id: "nord",
    label: "Nord",
    group: "dark",
    swatch: { bg: "#2e3440", fg: "#d8dee9", accent: "#88c0d0", keyword: "#81a1c1" },
  },
  {
    id: "overleaf-light",
    label: "Overleaf Light",
    group: "light",
    swatch: { bg: "#ffffff", fg: "#222933", accent: "#0b6e4f", keyword: "#9a2a8c" },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    group: "light",
    swatch: { bg: "#ffffff", fg: "#1f2328", accent: "#0550ae", keyword: "#cf222e" },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    group: "light",
    swatch: { bg: "#fdf6e3", fg: "#586e75", accent: "#268bd2", keyword: "#859900" },
  },
  {
    id: "one-light",
    label: "One Light",
    group: "light",
    swatch: { bg: "#fafafa", fg: "#383a42", accent: "#4078f2", keyword: "#a626a4" },
  },
];

const extensionCache = new Map<EditorThemeId, Extension>();

export function getEditorThemeExtension(id: EditorThemeId): Extension {
  const cached = extensionCache.get(id);
  if (cached) return cached;
  const palette = PALETTES[id] ?? PALETTES["one-dark"];
  const ext = buildEditorTheme(palette);
  extensionCache.set(id, ext);
  return ext;
}
