/** Web Worker of the Hunspell check (#62): nspell plus the dictionary of a language, loaded on first use. */
import nspell from "nspell";
// the packages only export index.js, so the data files are addressed by path; Vite emits them as
// separate hashed assets (fetched here on demand), not into any JS chunk
import deAff from "../../node_modules/dictionary-de/index.aff?url";
import deDic from "../../node_modules/dictionary-de/index.dic?url";
import enAff from "../../node_modules/dictionary-en/index.aff?url";
import enDic from "../../node_modules/dictionary-en/index.dic?url";
import { MAX_WORD_LENGTH, isCompound } from "./compound";
import type { HunspellRequest, HunspellResponse } from "./hunspellClient";

const URLS = { de: [deAff, deDic], en: [enAff, enDic] } as const;
const MAX_SUGGESTED = 5;
/** Suggesting is slow on the German dictionary: per request only this many unknown words get any. */
const MAX_SUGGEST_WORDS = 25;

type Spell = ReturnType<typeof nspell>;
interface Loaded {
  spell: Spell;
  /** project dictionary words currently added */
  added: Set<string>;
  suggestions: Map<string, string[]>;
}

const loaded = new Map<string, Promise<Loaded>>();

function load(lang: "de" | "en"): Promise<Loaded> {
  let p = loaded.get(lang);
  if (!p) {
    const [aff, dic] = URLS[lang];
    p = Promise.all([fetch(aff), fetch(dic)])
      .then(([a, d]) => {
        if (!a.ok || !d.ok) throw new Error(`Wörterbuch ${lang} nicht ladbar`);
        return Promise.all([a.text(), d.text()]);
      })
      .then(([a, d]) => ({ spell: nspell(a, d), added: new Set<string>(), suggestions: new Map() }));
    // a failed load is retried by the next request
    p.catch(() => loaded.delete(lang));
    loaded.set(lang, p);
  }
  return p;
}

self.addEventListener("message", (e: MessageEvent<HunspellRequest>) => {
  const { id, lang, words, extra } = e.data;
  load(lang)
    .then((l) => {
      const want = new Set(extra);
      let changed = false;
      for (const w of want)
        if (!l.added.has(w)) {
          l.spell.add(w);
          l.added.add(w);
          changed = true;
        }
      for (const w of l.added)
        if (!want.has(w)) {
          l.spell.remove(w);
          l.added.delete(w);
          changed = true;
        }
      if (changed) l.suggestions.clear();
      const bad: Record<string, string[]> = {};
      let suggested = 0;
      for (const w of words) {
        if (l.spell.correct(w) || (lang === "de" && isCompound(w, (x) => l.spell.correct(x)))) continue;
        let s = l.suggestions.get(w);
        if (!s && suggested < MAX_SUGGEST_WORDS && w.length < MAX_WORD_LENGTH) {
          suggested++;
          s = l.spell.suggest(w).slice(0, MAX_SUGGESTED);
          l.suggestions.set(w, s);
        }
        bad[w] = s ?? [];
      }
      const res: HunspellResponse = { id, bad };
      self.postMessage(res);
    })
    .catch((err: unknown) => {
      const res: HunspellResponse = { id, error: err instanceof Error ? err.message : String(err) };
      self.postMessage(res);
    });
});
