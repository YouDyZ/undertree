import * as Y from "yjs";
import type { DocSession } from "./docSession";
import { getUserColor } from "./userColor";

export interface PeerCursorPosition {
  anchor: number;
  head: number;
  color: string;
  name?: string;
}

export interface PeerJumpTarget {
  path: string;
  username: string;
  seq: number;
}

export interface RunPeerJumpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onApply: (pos: PeerCursorPosition) => void;
  onConsumed: (seq: number) => void;
}

export function consumePeerJumpTarget(
  current: PeerJumpTarget | null,
  seq: number
): PeerJumpTarget | null {
  if (!current || current.seq !== seq) return current;
  return null;
}

export function clearPeerJumpTargetForPath(
  current: PeerJumpTarget | null,
  path: string
): PeerJumpTarget | null {
  if (!current || current.path !== path) return current;
  return null;
}

/**
 * Resolves a one-shot peer cursor jump for `target`, invokes `onApply` only if
 * still active when resolved, and notifies `onConsumed(target.seq)` once across
 * resolution, timeout, null result, or abort.
 */
export async function runPeerJump(
  session: DocSession,
  target: PeerJumpTarget,
  options: RunPeerJumpOptions
): Promise<void> {
  if (target.path !== session.path) return;

  const { signal, timeoutMs, onApply, onConsumed } = options;
  let consumed = false;
  const consumeOnce = () => {
    if (consumed) return;
    consumed = true;
    onConsumed(target.seq);
  };

  if (signal?.aborted) {
    consumeOnce();
    return;
  }

  signal?.addEventListener("abort", consumeOnce, { once: true });
  try {
    const pos = await waitForPeerCursorOffset(session, target.username, {
      timeoutMs,
      signal,
    });
    if (!signal?.aborted && pos) {
      onApply(pos);
    }
  } finally {
    signal?.removeEventListener("abort", consumeOnce);
    consumeOnce();
  }
}

function resolveRelativeOffset(raw: unknown, ydoc: Y.Doc, ytext: Y.Text): number | null {
  if (!raw || typeof raw !== "object") return null;
  try {
    const rel =
      raw instanceof Y.RelativePosition ? raw : Y.createRelativePositionFromJSON(raw);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc);
    if (!abs || abs.type !== ytext) return null;
    return Math.max(0, Math.min(abs.index, ytext.length));
  } catch {
    return null;
  }
}

/**
 * Resolves a remote collaborator's current cursor offset inside `ydoc.getText("content")`
 * from Yjs awareness states (matching by `state.user.username`).
 */
export function findPeerCursorOffset(
  states: Map<number, Record<string, unknown>>,
  localClientId: number,
  username: string,
  ydoc: Y.Doc
): PeerCursorPosition | null {
  if (!username) return null;
  const ytext = ydoc.getText("content");

  for (const [clientId, state] of states.entries()) {
    if (clientId === localClientId) continue;
    const rawUser = state?.user;
    if (!rawUser || typeof rawUser !== "object") continue;
    const user = rawUser as Partial<{ username: unknown; name: unknown; color: unknown }>;
    if (user.username !== username) continue;

    const rawCursor = state?.cursor;
    if (!rawCursor || typeof rawCursor !== "object") continue;
    const cursor = rawCursor as Partial<{ anchor: unknown; head: unknown }>;
    if (cursor.head == null) continue;

    const head = resolveRelativeOffset(cursor.head, ydoc, ytext);
    if (head === null) continue;

    const resolvedAnchor =
      cursor.anchor != null ? resolveRelativeOffset(cursor.anchor, ydoc, ytext) : null;
    const anchor = resolvedAnchor ?? head;
    const color =
      typeof user.color === "string" && user.color.trim()
        ? user.color
        : getUserColor(username).color;

    const pos: PeerCursorPosition = { anchor, head, color };
    if (typeof user.name === "string" && user.name.trim()) {
      pos.name = user.name;
    }
    return pos;
  }

  return null;
}

/**
 * Returns the peer's cursor offset immediately if present in awareness, or waits
 * for incoming awareness updates until found, aborted, or timed out.
 */
export function waitForPeerCursorOffset(
  session: DocSession,
  username: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<PeerCursorPosition | null> {
  const timeoutMs = options?.timeoutMs ?? 3000;
  const signal = options?.signal;
  if (signal?.aborted) {
    return Promise.resolve(null);
  }

  const readCurrent = () =>
    findPeerCursorOffset(
      session.provider.awareness.getStates() as Map<number, Record<string, unknown>>,
      session.ydoc.clientID,
      username,
      session.ydoc
    );

  const immediate = readCurrent();
  if (immediate !== null) {
    return Promise.resolve(immediate);
  }

  return new Promise((resolve) => {
    let settled = false;

    const onAwarenessChange = () => {
      const next = readCurrent();
      if (next !== null) {
        finish(next);
      }
    };

    const onAbort = () => {
      finish(null);
    };

    const finish = (value: PeerCursorPosition | null) => {
      if (settled) return;
      settled = true;
      session.provider.awareness.off("change", onAwarenessChange);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    session.provider.awareness.on("change", onAwarenessChange);
    signal?.addEventListener("abort", onAbort, { once: true });

    const lateCheck = readCurrent();
    if (lateCheck !== null) {
      finish(lateCheck);
    }
  });
}
