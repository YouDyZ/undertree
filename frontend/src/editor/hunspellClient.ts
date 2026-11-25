/** Main-thread side of the Hunspell check (#62): word extraction, worker round trip, issues. */
import { type RootFile, type SpellIssue, listProjectRoots, projectApiBase } from "../api";
import { type HunspellLang, extractWords, hunspellLang } from "./latexWords";

export interface HunspellRequest {
  id: number;
  lang: HunspellLang;
  /** distinct words to check */
  words: string[];
  /** project dictionary */
  extra: string[];
}

export type HunspellResponse = { id: number; bad: Record<string, string[]> } | { id: number; error: string };

interface Pending {
  resolve: (bad: Record<string, string[]>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A request (dictionary download included) taking longer is considered stuck and the worker is replaced. */
export const REQUEST_TIMEOUT_MS = 20_000;

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

/** Stop the worker, fail everything waiting for it; the next request starts a fresh one. */
function resetWorker(err: Error): void {
  worker?.terminate();
  worker = undefined;
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) {
    clearTimeout(p.timer);
    p.reject(err);
  }
}

function askWorker(lang: HunspellLang, words: string[], extra: string[]): Promise<Record<string, string[]>> {
  if (!worker) {
    const w = new Worker(new URL("./hunspellWorker.ts", import.meta.url), { type: "module" });
    worker = w;
    w.addEventListener("message", (e: MessageEvent<HunspellResponse>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      if ("error" in e.data) p.reject(new Error(e.data.error));
      else p.resolve(e.data.bad);
    });
    const crashed = () => {
      if (worker === w) resetWorker(new Error("Hunspell-Worker ausgefallen"));
    };
    w.addEventListener("error", crashed);
    w.addEventListener("messageerror", crashed);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resetWorker(new Error("Hunspell-Worker antwortet nicht")),
      REQUEST_TIMEOUT_MS
    );
    pending.set(id, { resolve, reject, timer });
    worker?.postMessage({ id, lang, words, extra } satisfies HunspellRequest);
  });
}

const ROOTS_TTL_MS = 60_000;
let roots: { key: string; at: number; value: Promise<RootFile[]> } | undefined;

function cachedRoots(): Promise<RootFile[]> {
  const key = projectApiBase();
  if (!roots || roots.key !== key || Date.now() - roots.at > ROOTS_TTL_MS) {
    const value = listProjectRoots().catch(() => [] as RootFile[]);
    roots = { key, at: Date.now(), value };
  }
  return roots.value;
}

/** The file's own language if it is a root, else the first root with a concrete one; unknown → English. */
export function rootLanguage(path: string, all: readonly RootFile[]): string | undefined {
  const concrete = (r: RootFile) => r.language && r.language !== "auto";
  return (all.find((r) => r.path === path && concrete(r)) ?? all.find(concrete))?.language;
}

/** Issues for the unknown words of `text` (offsets shifted by `start`); `language`: LanguageTool code. */
export async function hunspellCheck(req: {
  path: string;
  text: string;
  start: number;
  language?: string;
  words?: ReadonlySet<string>;
}): Promise<SpellIssue[]> {
  const found = extractWords(req.text);
  if (found.length === 0) return [];
  const lang = hunspellLang(req.language ?? rootLanguage(req.path, await cachedRoots()));
  const bad = await askWorker(lang, [...new Set(found.map((w) => w.text))], [...(req.words ?? [])]);
  return found
    .filter((w) => Object.hasOwn(bad, w.text))
    .map((w) => ({
      start: req.start + w.from,
      end: req.start + w.to,
      message: "Unbekanntes Wort",
      short: "",
      rule: "HUNSPELL",
      category: "TYPOS",
      replacements: bad[w.text] ?? [],
    }));
}
