/**
 * Spell and grammar check as a CodeMirror linter (#57).
 *
 * A provider is a function `SpellRequest → SpellIssue[]` (file offsets, UTF-16); LanguageTool runs
 * on the server, later providers (Hunspell in the browser) add one entry to `SOURCES`. The project
 * dictionary and the ignored rules apply to every provider, so they are filtered here as well.
 */
import { type Action, type Diagnostic, forEachDiagnostic, forceLinting, linter } from "@codemirror/lint";
import { type Extension, StateEffect } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import {
  ApiError,
  type SpellIssue,
  addDictionaryWord,
  getDictionary,
  setDisabledRules,
  spellcheck as checkWithLanguageTool,
} from "../api";
import { hunspellCheck } from "./hunspellClient";

export type SpellProvider = "languagetool" | "hunspell" | "off";

export const SPELL_PROVIDERS: readonly { id: SpellProvider; label: string }[] = [
  { id: "languagetool", label: "LanguageTool (Rechtschreibung & Grammatik)" },
  { id: "hunspell", label: "Hunspell (nur Rechtschreibung, lokal)" },
  { id: "off", label: "Aus" },
];

export const SPELL_DELAY_MS = 1500;
/** Smaller documents are checked whole, larger ones only the visible paragraphs. */
export const WHOLE_DOC_LIMIT = 30 * 1024;
const MAX_ACTION_REPLACEMENTS = 5;
const CACHE_SIZE = 20;

const STORAGE_KEY = "undertree.spellcheck.provider";
const LANG_KEY = "undertree.spellcheck.hunspell-language";
const CHANGE_EVENT = "undertree:spellcheck-provider";
const DICT_EVENT = "undertree:spellcheck-dict";
/** Open editors reload the dictionary at the latest this long after it changed elsewhere. */
export const DICT_MAX_AGE_MS = 60_000;

/** The stored choice if valid, else LanguageTool, or Hunspell when the server has no LanguageTool. */
export function resolveProvider(stored: string | null, languageToolOff: boolean): SpellProvider {
  if (stored === "languagetool" || stored === "hunspell" || stored === "off") return stored;
  return languageToolOff ? "hunspell" : "languagetool";
}

/** The user's choice (this browser). */
export function getSpellProvider(): SpellProvider {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage blocked
  }
  return resolveProvider(stored, languageToolDisabled);
}

/** What results depend on besides the text: the provider and, for Hunspell, the chosen language. */
export function cacheTag(provider: SpellProvider): string {
  return provider === "hunspell" ? `${provider}:${getHunspellLang() ?? "auto"}` : provider;
}

/** Hunspell dictionary chosen by the user; `null` = from the root's language. */
export type HunspellLangChoice = "de" | "en" | null;

export function getHunspellLang(): HunspellLangChoice {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "de" || v === "en") return v;
  } catch {
    // storage blocked
  }
  return null;
}

export function setHunspellLang(lang: HunspellLangChoice): void {
  try {
    if (lang) localStorage.setItem(LANG_KEY, lang);
    else localStorage.removeItem(LANG_KEY);
  } catch {
    // storage blocked: applies until reload
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setSpellProvider(provider: SpellProvider): void {
  try {
    localStorage.setItem(STORAGE_KEY, provider);
  } catch {
    // storage blocked: applies until reload
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The dictionary or ignored rules were changed (project settings): open editors reload them. */
export function notifyDictionaryChanged(): void {
  window.dispatchEvent(new Event(DICT_EVENT));
}

export interface SpellRequest {
  path: string;
  text: string;
  /** UTF-16 offset of `text` in the file */
  start: number;
  /** omitted: the server detects it from the TeX sources */
  language?: string;
  /** project dictionary (for providers that run locally) */
  words?: ReadonlySet<string>;
}

export type SpellSource = (req: SpellRequest) => Promise<SpellIssue[]>;

/** The server answered `spellcheck_disabled` once: don't ask again until reload. */
let languageToolDisabled = false;

export function isLanguageToolDisabled(): boolean {
  return languageToolDisabled;
}

export const SOURCES: Record<Exclude<SpellProvider, "off">, SpellSource> = {
  hunspell: (req) => hunspellCheck({ ...req, language: getHunspellLang() ?? undefined }),
  languagetool: async (req) => {
    if (languageToolDisabled) return [];
    try {
      return await checkWithLanguageTool(req);
    } catch (err) {
      if (err instanceof ApiError && err.code === "spellcheck_disabled") {
        languageToolDisabled = true;
        return [];
      }
      throw err;
    }
  },
};

export interface SpellChunk {
  text: string;
  start: number;
}

/**
 * What to send: the whole document if it is small, else the paragraphs (separated by blank lines)
 * overlapping `visible`, from `\begin{document}` on (the preamble is code).
 */
export function spellChunk(
  doc: string,
  visible: readonly { from: number; to: number }[],
  limit = WHOLE_DOC_LIMIT
): SpellChunk | null {
  if (doc.length <= limit) return { text: doc, start: 0 };
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (!first || !last) return null;
  // ponytail: a commented-out \begin{document} counts too; the server's converter knows better
  const begin = doc.indexOf("\\begin{document}");
  const body = begin < 0 ? 0 : begin + "\\begin{document}".length;
  const from = Math.max(body, first.from);
  const to = last.to;
  if (from >= to) return null;
  const blank = /\n[ \t]*\n/g;
  let start = body;
  let end = doc.length;
  for (let m = blank.exec(doc); m; m = blank.exec(doc)) {
    const sep = m.index;
    if (sep + m[0].length <= from) start = Math.max(start, sep + m[0].length);
    else if (sep >= to) {
      end = sep;
      break;
    }
  }
  return { text: doc.slice(start, end), start };
}

export function isKnownWord(word: string, words: ReadonlySet<string>): boolean {
  return words.has(word) || words.has(word.toLowerCase());
}

/** Without ignored rules and spelling hits on dictionary words; offsets must lie in `doc`. */
export function filterIssues(
  issues: readonly SpellIssue[],
  doc: string,
  words: ReadonlySet<string>,
  rules: ReadonlySet<string>
): SpellIssue[] {
  return issues.filter(
    (i) =>
      i.start < i.end &&
      i.end <= doc.length &&
      !rules.has(i.rule) &&
      !(i.category === "TYPOS" && isKnownWord(doc.slice(i.start, i.end), words))
  );
}

/** Red wavy underline for spelling, blue ("hint") for grammar and style. */
export function issueSeverity(issue: SpellIssue): Diagnostic["severity"] {
  return issue.category === "TYPOS" ? "error" : "hint";
}

/** Dictionary, ignored rules and recent results of one editor. */
export class SpellState {
  words = new Set<string>();
  rules = new Set<string>();
  ready: Promise<void> = Promise.resolve();
  private loadedAt = 0;
  private cache = new Map<string, SpellIssue[]>();
  /** bumped by every `clearCache`: answers started before it must not be cached */
  private generation = 0;
  private warned = false;

  constructor() {
    this.reload();
  }

  /** (Re)fetch dictionary and rules; a failure keeps the old ones. */
  reload(): Promise<void> {
    this.loadedAt = Date.now();
    this.ready = getDictionary()
      .then((d) => {
        this.words = new Set(d.words);
        this.rules = new Set(d.disabled_rules);
      })
      .catch(() => undefined);
    return this.ready;
  }

  /** Other members change the dictionary too, without an event: refetch now and then. */
  reloadIfStale(): void {
    if (Date.now() - this.loadedAt > DICT_MAX_AGE_MS) this.reload();
  }

  /** Issues of `chunk`, relative offsets cached by `tag` (provider and language) and text. */
  async check(source: SpellSource, path: string, chunk: SpellChunk, tag = ""): Promise<SpellIssue[]> {
    const key = `${tag}\0${chunk.text}`;
    let rel = this.cache.get(key);
    if (!rel) {
      const generation = this.generation;
      const found = await source({ path, text: chunk.text, start: chunk.start, words: this.words });
      rel = found.map((i) => ({ ...i, start: i.start - chunk.start, end: i.end - chunk.start }));
      // the provider, language or dictionary changed while waiting: the answer may be outdated
      if (generation === this.generation) {
        if (this.cache.size >= CACHE_SIZE) this.cache.clear();
        this.cache.set(key, rel);
      }
    }
    return rel.map((i) => ({ ...i, start: i.start + chunk.start, end: i.end + chunk.start }));
  }

  /** Provider, language or dictionary changed: forget results and ignore answers still on their way. */
  clearCache(): void {
    this.generation++;
    this.cache.clear();
  }

  warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("Rechtschreibprüfung nicht verfügbar:", err);
  }

  async addWord(word: string): Promise<void> {
    await addDictionaryWord(word);
    this.words.add(word);
  }

  async ignoreRule(rule: string): Promise<void> {
    const res = await setDisabledRules([...this.rules, rule]);
    this.rules = new Set(res.disabled_rules);
  }
}

const refreshEffect = StateEffect.define<null>();

/** Lint again now (dictionary, rule or provider changed): `forceLinting` only hurries a pending run. */
function refresh(view: EditorView): void {
  view.dispatch({ effects: refreshEffect.of(null) });
  forceLinting(view);
}

/** Quick-fix replacements and dictionary/rule mutations are only allowed in editable buffers (`editor+`). */
export function canApplySpellActions(readOnly: boolean): boolean {
  return !readOnly;
}

function actions(issue: SpellIssue, state: SpellState, canEdit: boolean): Action[] {
  if (!canEdit) return [];
  const replace = issue.replacements.slice(0, MAX_ACTION_REPLACEMENTS).map(
    (r): Action => ({
      name: r === "" ? "(entfernen)" : r,
      apply: (view, from, to) => view.dispatch({ changes: { from, to, insert: r } }),
    })
  );
  const add: Action[] =
    issue.category === "TYPOS"
      ? [
          {
            name: "Zum Wörterbuch hinzufügen",
            apply: (view, from, to) =>
              void state.addWord(view.state.sliceDoc(from, to)).then(() => refresh(view), (e: unknown) =>
                state.warnOnce(e)
              ),
          },
        ]
      : [];
  const ignore: Action = {
    name: "Regel ignorieren",
    apply: (view) =>
      void state.ignoreRule(issue.rule).then(() => refresh(view), (e: unknown) => state.warnOnce(e)),
  };
  return [...replace, ...add, ignore];
}

/** The spell-check linter for the file at `path` (LaTeX). */
export function spellcheckExtension(path: string): Extension {
  // .sty/.cls/.dtx are code
  if (!/\.(tex|ltx)$/i.test(path)) return [];
  const state = new SpellState();
  const source = async (view: EditorView): Promise<readonly Diagnostic[]> => {
    const provider = getSpellProvider();
    if (provider === "off") return [];
    const doc = view.state.doc.toString();
    const chunk = spellChunk(doc, view.visibleRanges);
    if (!chunk || !chunk.text.trim()) return [];
    state.reloadIfStale();
    await state.ready;
    let issues: SpellIssue[];
    try {
      issues = await state.check(SOURCES[provider], path, chunk, cacheTag(provider));
      // LanguageTool turned out to be off on a default setting: the default is Hunspell now
      if (getSpellProvider() !== provider) {
        state.clearCache();
        return source(view);
      }
    } catch (err) {
      state.warnOnce(err);
      // e.g. 429: keep what is shown (mapped through edits) instead of flickering
      const kept: Diagnostic[] = [];
      forEachDiagnostic(view.state, (d, from, to) => kept.push({ ...d, from, to }));
      return kept;
    }
    const editable = canApplySpellActions(view.state.readOnly);
    return filterIssues(issues, doc, state.words, state.rules).map((i) => ({
      from: i.start,
      to: i.end,
      severity: issueSeverity(i),
      message: i.message,
      source: i.short || undefined,
      actions: actions(i, state, editable),
    }));
  };
  return [
    linter(source, {
      delay: SPELL_DELAY_MS,
      // large documents: only the visible part is checked, so scrolling needs a new run
      needsRefresh: (u) =>
        u.startState.readOnly !== u.state.readOnly ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect))) ||
        (u.viewportChanged && u.state.doc.length > WHOLE_DOC_LIMIT),
    }),
    ViewPlugin.define((view) => {
      const onChange = () => {
        state.clearCache();
        refresh(view);
      };
      // local providers bake the project dictionary into their results: recheck after it changed
      const onDict = () =>
        void state.reload().then(() => {
          state.clearCache();
          refresh(view);
        });
      window.addEventListener(CHANGE_EVENT, onChange);
      window.addEventListener(DICT_EVENT, onDict);
      return {
        destroy: () => {
          window.removeEventListener(CHANGE_EVENT, onChange);
          window.removeEventListener(DICT_EVENT, onDict);
        },
      };
    }),
  ];
}
