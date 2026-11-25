import type { MoveReference } from "../api";

/** `path` after `from` was moved to `to` (`from` itself or below it); unchanged otherwise. */
export function mapMovedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Client-side check of a typed target path; `null` = fine (the server validates the rest). */
export function validateMoveTarget(from: string, rawTo: string): string | null {
  const to = rawTo.trim();
  if (!to) return "Pfad darf nicht leer sein.";
  if (to === from) return "Der Pfad ist unverändert.";
  if (to.startsWith("/") || to.endsWith("/")) return "Pfad darf nicht mit „/“ beginnen oder enden.";
  if (to.split("/").some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")) {
    return "Ungültiger Pfad.";
  }
  if (to.startsWith(`${from}/`)) return "Ein Ordner kann nicht in sich selbst verschoben werden.";
  return null;
}

/** New path when `from` is dropped onto directory `dir` ("" = root); `null` = nothing to do. */
export function dropTargetPath(from: string, dir: string): string | null {
  if (dir === parentDir(from) || dir === from || dir.startsWith(`${from}/`)) return null;
  const name = baseName(from);
  return dir ? `${dir}/${name}` : name;
}

/** "3 Verweise in 2 Dateien mitändern?" */
export function formatRefQuestion(refs: readonly MoveReference[]): string {
  const files = new Set(refs.map((r) => r.path)).size;
  const n = refs.length;
  return `${n} ${n === 1 ? "Verweis" : "Verweise"} in ${files} ${files === 1 ? "Datei" : "Dateien"} mitändern?`;
}
