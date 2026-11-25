import { ApiError } from "../api";

/** `1234` -> `1 234` (non-breaking space), independent of the browser locale. */
export function groupThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatWordCount(words: number): string {
  return `${groupThousands(words)} ${words === 1 ? "Wort" : "Wörter"}`;
}

export function formatWordCountError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "no_root") return "Keine zugehörige LaTeX-Root-Datei gefunden.";
    if (err.code === "wordcount_failed") {
      return `Wortzählung fehlgeschlagen${err.message ? `: ${err.message}` : "."}`;
    }
    return err.message || "Wörter konnten nicht gezählt werden.";
  }
  return err instanceof Error && err.message ? err.message : "Wörter konnten nicht gezählt werden.";
}
