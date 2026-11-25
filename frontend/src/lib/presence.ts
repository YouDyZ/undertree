import type { PresenceUser } from "../api";
import { getUserColor } from "../editor/userColor";

/** Same color as the user's remote cursor (docSession seeds it with the username). */
export function presenceColor(username: string): string {
  return getUserColor(username).color;
}

/** "Ada Lovelace" → "AL", "alice" → "AL", "" → "?". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).map((p) => Array.from(p));
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return "?";
  const chars = parts.length > 1 ? [first[0], last[0]] : first.slice(0, 2);
  return chars.join("").toUpperCase();
}

/** Users per open file. `hide` drops one user from one file (yourself in your focused tab). */
export function usersByFile(
  users: PresenceUser[],
  hide?: { username: string; path: string | null }
): Map<string, PresenceUser[]> {
  const byFile = new Map<string, PresenceUser[]>();
  for (const u of users) {
    const f = u.file;
    if (f === null || (hide && u.username === hide.username && f === hide.path)) continue;
    byFile.set(f, [...(byFile.get(f) ?? []), u]);
  }
  return byFile;
}

/** Every ancestor directory of `paths` ("a/b/c.tex" → "a", "a/b"). */
export function ancestorDirs(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

/** First `max` items, the rest go behind a "+N" chip. */
export function splitOverflow<T>(items: T[], max: number): { shown: T[]; rest: T[] } {
  return { shown: items.slice(0, max), rest: items.slice(max) };
}

/** Tooltip line: "Ada (du): main.tex, intro.tex" or "Bob: im Projekt". */
export function presenceLabel(u: PresenceUser, self: string): string {
  const name = u.username === self ? `${u.display_name} (du)` : u.display_name;
  return `${name}: ${u.file ?? "im Projekt"}`;
}
