import * as Y from "yjs";
import {
  ApiError,
  type CommentMessage,
  type CommentThread,
  type User,
  errorText,
} from "../api";

export const MAX_COMMENT_BODY_CHARS = 10_000;

export interface CommentAnchor {
  threadId: number;
  resolved: boolean;
  sourceStart: number;
  sourceEnd: number;
  startRel: Y.RelativePosition;
  endRel: Y.RelativePosition;
  fallbackStart: number;
  fallbackEnd: number;
}

export interface ResolvedCommentRange {
  threadId: number;
  from: number;
  to: number;
}

export interface ClampedSelectionRange {
  start: number;
  end: number;
  quote: string;
}

export interface CommentJumpTarget {
  path: string;
  threadId: number;
  start: number;
  end: number;
  seq: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Clamps UTF-16 selection offsets to valid bounds without splitting a UTF-16 surrogate pair.
 * Returns null if the resulting range is empty (`start >= end`).
 */
export function clampValidSelectionRange(
  text: string,
  rawStart: number,
  rawEnd: number
): ClampedSelectionRange | null {
  const len = text.length;
  let start = Math.max(0, Math.min(rawStart, len));
  let end = Math.max(0, Math.min(rawEnd, len));
  if (end < start) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  if (start >= end) return null;

  // Never start on a trailing low surrogate whose high surrogate precedes it
  if (start > 0 && start < len && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  // Never end right between a high surrogate and its trailing low surrogate
  if (end > 0 && end < len && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end += 1;
  }

  if (start >= end) return null;
  return {
    start,
    end,
    quote: text.slice(start, end),
  };
}

/**
 * Converts server-supplied UTF-16 thread ranges into Yjs relative positions against `ydoc.getText("content")`.
 * Start sticks to the following item (`assoc = 0`) and end sticks to the preceding item (`assoc = -1`),
 * matching the server sticky-index contract so text typed right at either edge stays outside.
 */
export function createCommentAnchors(
  threads: readonly CommentThread[],
  ydoc: Y.Doc
): CommentAnchor[] {
  return syncCommentAnchors([], threads, ydoc);
}

/**
 * Keeps existing live `Y.RelativePosition` anchors whenever a thread's server `(start, end)` did
 * not change, preventing stale server offsets from snapping edited highlights back on unrelated updates.
 * Defers anchoring non-empty ranges while the Yjs doc is still empty (awaiting initial sync).
 */
export function syncCommentAnchors(
  prev: readonly CommentAnchor[],
  threads: readonly CommentThread[],
  ydoc: Y.Doc
): CommentAnchor[] {
  const prevById = new Map<number, CommentAnchor>();
  for (const anchor of prev) {
    prevById.set(anchor.threadId, anchor);
  }

  const ytext = ydoc.getText("content");
  const docLen = ytext.length;
  const anchors: CommentAnchor[] = [];

  for (const thread of threads) {
    if (thread.detached) continue;
    const existing = prevById.get(thread.id);
    if (
      existing &&
      existing.sourceStart === thread.start &&
      existing.sourceEnd === thread.end
    ) {
      anchors.push(
        existing.resolved === thread.resolved
          ? existing
          : { ...existing, resolved: thread.resolved }
      );
      continue;
    }
    if (docLen === 0 && thread.end > 0) continue;
    const start = Math.max(0, Math.min(thread.start, docLen));
    const end = Math.max(start, Math.min(thread.end, docLen));
    anchors.push({
      threadId: thread.id,
      resolved: thread.resolved,
      sourceStart: thread.start,
      sourceEnd: thread.end,
      startRel: Y.createRelativePositionFromTypeIndex(ytext, start, 0),
      endRel: Y.createRelativePositionFromTypeIndex(ytext, end, -1),
      fallbackStart: start,
      fallbackEnd: end,
    });
  }

  return anchors;
}

/**
 * Resolves a single `CommentAnchor` back into live UTF-16 offsets inside `ydoc.getText("content")`.
 */
export function resolveCommentAnchorRange(
  anchor: CommentAnchor,
  ydoc: Y.Doc
): ResolvedCommentRange | null {
  const ytext = ydoc.getText("content");
  const docLen = ytext.length;
  const startAbs = Y.createAbsolutePositionFromRelativePosition(anchor.startRel, ydoc);
  const endAbs = Y.createAbsolutePositionFromRelativePosition(anchor.endRel, ydoc);

  const rawFrom =
    startAbs && startAbs.type === ytext ? startAbs.index : anchor.fallbackStart;
  const rawTo = endAbs && endAbs.type === ytext ? endAbs.index : anchor.fallbackEnd;

  const from = Math.max(0, Math.min(rawFrom, docLen));
  const to = Math.max(0, Math.min(rawTo, docLen));
  if (from >= to) return null;

  return {
    threadId: anchor.threadId,
    from,
    to,
  };
}

/**
 * Resolves live editor highlights for open, non-detached comment threads.
 */
export function resolveCommentHighlights(
  anchors: readonly CommentAnchor[],
  ydoc: Y.Doc
): ResolvedCommentRange[] {
  const highlights: ResolvedCommentRange[] = [];
  for (const anchor of anchors) {
    if (anchor.resolved) continue;
    const resolved = resolveCommentAnchorRange(anchor, ydoc);
    if (resolved) {
      highlights.push(resolved);
    }
  }
  return highlights;
}

/**
 * Picks the narrowest highlighted range containing `pos` (helpful when comments overlap).
 */
export function findCommentAtPosition(
  highlights: readonly ResolvedCommentRange[],
  pos: number
): number | null {
  let bestId: number | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const item of highlights) {
    if (pos >= item.from && pos <= item.to) {
      const span = item.to - item.from;
      if (span < bestSpan) {
        bestSpan = span;
        bestId = item.threadId;
      }
    }
  }
  return bestId;
}

/** Counts open (`!resolved`) comment threads per workspace-relative file path. */
export function countOpenCommentsByFile(threads: readonly CommentThread[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.resolved) continue;
    counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
  }
  return counts;
}

/**
 * Filters and sorts threads for a single file's editor sidebar view.
 * Detached threads are excluded here because they belong solely in the project overview.
 */
export function getFileSidebarThreads(
  threads: readonly CommentThread[],
  filePath: string,
  showResolved: boolean,
  liveStartById?: ReadonlyMap<number, number>
): CommentThread[] {
  const filtered = threads.filter(
    (t) => t.path === filePath && !t.detached && (showResolved || !t.resolved)
  );
  filtered.sort((a, b) => {
    const startA = liveStartById?.get(a.id) ?? a.start;
    const startB = liveStartById?.get(b.id) ?? b.start;
    if (startA !== startB) return startA - startB;
    return a.id - b.id;
  });
  return filtered;
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Filters and sorts project overview threads (`path`, then `start`, then `id`), keeping detached
 * threads visible so collaborators can inspect orphaned discussions.
 */
export function getOverviewThreads(
  threads: readonly CommentThread[],
  showResolved: boolean
): CommentThread[] {
  const filtered = threads.filter((t) => showResolved || !t.resolved);
  filtered.sort(
    (a, b) => compareCodeUnits(a.path, b.path) || a.start - b.start || a.id - b.id
  );
  return filtered;
}

/** Replaces threads for `filePath` inside the project thread list while maintaining canonical order. */
export function mergeFileThreadsIntoProject(
  projectThreads: readonly CommentThread[],
  filePath: string,
  nextForPath: readonly CommentThread[]
): CommentThread[] {
  const merged = projectThreads.filter((t) => t.path !== filePath);
  merged.push(...nextForPath);
  merged.sort(
    (a, b) => compareCodeUnits(a.path, b.path) || a.start - b.start || a.id - b.id
  );
  return merged;
}

/** Guards async comment fetches against switched projects and newer reloads. */
export function shouldApplyCommentsLoad(
  requestProjectId: number,
  currentProjectId: number,
  requestGen: number,
  currentGen: number
): boolean {
  return requestProjectId === currentProjectId && requestGen === currentGen;
}

/** Consumes a one-shot `commentJumpTarget` only when its sequence matches. */
export function consumeCommentJumpTarget(
  current: CommentJumpTarget | null,
  seq: number
): CommentJumpTarget | null {
  if (!current || current.seq !== seq) return current;
  return null;
}

/** Clears a pending `commentJumpTarget` if its tab is closed before landing. */
export function clearCommentJumpTargetForPath(
  current: CommentJumpTarget | null,
  path: string
): CommentJumpTarget | null {
  if (!current || current.path !== path) return current;
  return null;
}

/** True if the signed-in user is the author of `msg`. */
export function canEditOrDeleteMessage(msg: CommentMessage, user: User): boolean {
  return msg.author !== null && msg.author === user.username;
}

/** True if the signed-in user may delete the entire thread (thread creator, project owner or admin). */
export function canDeleteThread(
  thread: CommentThread,
  user: User,
  isProjectOwner = false
): boolean {
  return (
    user.is_admin ||
    isProjectOwner ||
    (thread.created_by !== null && thread.created_by === user.username)
  );
}

/** Counts Unicode scalar values (code points), matching Rust's `str::chars().count()`. */
export function countUnicodeChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch.length > 0) count += 1;
  }
  return count;
}

/** Validates and trims a comment or reply body (`1..10000` Unicode chars). */
export function validateCommentBody(
  raw: string
): { ok: true; body: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Bitte einen Kommentartext eingeben." };
  }
  if (countUnicodeChars(trimmed) > MAX_COMMENT_BODY_CHARS) {
    return {
      ok: false,
      error: `Kommentar ist zu lang (maximal ${MAX_COMMENT_BODY_CHARS.toLocaleString("de-DE")} Zeichen).`,
    };
  }
  return { ok: true, body: trimmed };
}

/** Formats a comment API error into German for UI display. */
export function formatCommentError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403 || err.code === "forbidden" || err.code === "insufficient_role") {
      return "Keine Berechtigung für diese Kommentar-Aktion.";
    }
    if (err.status === 404 || err.code === "not_found") {
      return "Kommentar oder Datei wurde nicht mehr gefunden.";
    }
    if (err.status === 413 || err.code === "too_large") {
      return "Die Datei überschreitet das 8-MiB-Limit für Kommentare.";
    }
    if (err.code === "invalid_path") {
      return "Kommentare in nicht initialisierten Submodulen sind nicht möglich.";
    }
    if (err.code === "invalid_request") {
      return err.message || "Ungültige Textauswahl oder Kommentarlänge.";
    }
  }
  return errorText(err, fallback);
}

/** Formats a timestamp in compact German locale form. */
export function formatCommentTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}
