/**
 * German compounds ("Wörterbuch", "Literaturverzeichnis"): nspell does not implement Hunspell's
 * COMPOUND rules, so the dictionary alone flags most of them. A word counts as correct if it splits
 * into 2-3 known parts of at least 3 letters, with an optional linking element (Fugen-s, -n, -en, -e, -er).
 * ponytail: also accepts a typo that happens to split into known parts; real COMPOUNDRULE support
 * would need a different engine.
 */
const MIN_PART = 3;
const MAX_PARTS = 3;
const LINKS = ["", "s", "es", "n", "en", "e", "er"];

const cap = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);

/** Longer words are neither split nor given suggestions: the search is polynomial in the length. */
export const MAX_WORD_LENGTH = 40;

export function isCompound(word: string, correct: (w: string) => boolean, parts = MAX_PARTS): boolean {
  if (parts < 2 || word.length >= MAX_WORD_LENGTH) return false;
  for (let k = MIN_PART; k <= word.length - MIN_PART; k++) {
    const head = word.slice(0, k);
    const tail = word.slice(k);
    const tailOk = correct(tail) || correct(cap(tail)) || isCompound(tail, correct, parts - 1);
    if (!tailOk) continue;
    for (const link of LINKS) {
      if (link && !head.endsWith(link)) continue;
      const base = head.slice(0, head.length - link.length);
      // inside a compound the head is lower case: "werk" for "Werk"
      if (base.length >= MIN_PART && (correct(base) || (parts < MAX_PARTS && correct(cap(base))))) return true;
    }
  }
  return false;
}
