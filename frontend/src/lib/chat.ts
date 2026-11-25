import type { ChatMessage, ProjectMember } from "../api";
import { countUnicodeChars } from "./comments";

export const MAX_CHAT_BODY_CHARS = 4000;
/** consecutive messages of one author closer than this share a header */
export const GROUP_GAP_MS = 5 * 60_000;

export function validateChatBody(
  raw: string
): { ok: true; body: string } | { ok: false; error: string } {
  const body = raw.trim();
  if (!body) return { ok: false, error: "Bitte eine Nachricht eingeben." };
  if (countUnicodeChars(body) > MAX_CHAT_BODY_CHARS) {
    return {
      ok: false,
      error: `Nachricht ist zu lang (maximal ${MAX_CHAT_BODY_CHARS.toLocaleString("de-DE")} Zeichen).`,
    };
  }
  return { ok: true, body };
}

export interface BodySegment {
  text: string;
  /** canonical username when this segment is a `@mention` of a project member */
  mention?: string;
}

const isNameChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/**
 * Splits `body` into plain and `@mention` segments, using the server's rules: only names in
 * `mentions` count, longest wins, case-insensitive, not inside a word.
 */
export function splitMentions(body: string, mentions: string[]): BodySegment[] {
  const names = [...mentions].sort((a, b) => b.length - a.length);
  const out: BodySegment[] = [];
  let plain = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "@" && !isNameChar(body[i - 1])) {
      const rest = body.slice(i + 1);
      const hit = names.find(
        (n) => rest.slice(0, n.length).toLowerCase() === n.toLowerCase() && !isNameChar(rest[n.length])
      );
      if (hit) {
        if (plain) out.push({ text: plain });
        plain = "";
        out.push({ text: body.slice(i, i + 1 + hit.length), mention: hit });
        i += 1 + hit.length;
        continue;
      }
    }
    plain += body[i];
    i += 1;
  }
  if (plain) out.push({ text: plain });
  return out;
}

export function mentionsUser(m: ChatMessage, username: string): boolean {
  return !m.deleted && m.mentions.includes(username);
}

/** Of two versions of one message: a deletion beats a live one, a later edit beats an earlier one. */
function newerVersion(old: ChatMessage, next: ChatMessage): ChatMessage {
  if (old.deleted !== next.deleted) return old.deleted ? old : next;
  return (old.edited_at ?? "") > (next.edited_at ?? "") ? old : next;
}

/**
 * Inserts or replaces messages by id (edits, deletions, duplicates of own sends); sorted by id.
 * A stale snapshot (e.g. a refetch answered after a live event) never undoes a newer version.
 */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) {
    const old = byId.get(m.id);
    byId.set(m.id, old ? newerVersion(old, m) : m);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export interface MessageGroup {
  key: number;
  author: string | null;
  display_name: string | null;
  messages: ChatMessage[];
}

/** Consecutive messages of the same author within `GROUP_GAP_MS` form one group. */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    const prev = last?.messages[last.messages.length - 1];
    if (
      last &&
      prev &&
      last.author === m.author &&
      Date.parse(m.created_at) - Date.parse(prev.created_at) <= GROUP_GAP_MS
    ) {
      last.messages.push(m);
    } else {
      groups.push({ key: m.id, author: m.author, display_name: m.display_name, messages: [m] });
    }
  }
  return groups;
}

export interface UnreadStats {
  count: number;
  /** one of the unread messages mentions the user */
  mentioned: boolean;
}

/** Messages of others newer than `lastReadId`. */
export function unreadStats(
  messages: ChatMessage[],
  lastReadId: number,
  username: string
): UnreadStats {
  const unread = messages.filter((m) => m.id > lastReadId && !m.deleted && m.author !== username);
  return { count: unread.length, mentioned: unread.some((m) => mentionsUser(m, username)) };
}

/** `main.tex:42` */
export function locationLabel(file: string, line: number | null): string {
  return line === null ? file : `${file}:${line}`;
}

export interface MentionQuery {
  /** index of the `@` */
  start: number;
  query: string;
}

/** The `@partial` word directly before `caret`, if any. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const m = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]*)$/u.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** Members whose username or display name starts with `query` (case-insensitive), then those containing it. */
export function suggestMembers(
  members: ProjectMember[],
  query: string,
  limit = 6
): ProjectMember[] {
  const q = query.toLowerCase();
  const rank = (m: ProjectMember): number => {
    const names = [m.username.toLowerCase(), m.display_name.toLowerCase()];
    if (names.some((n) => n.startsWith(q))) return 0;
    return names.some((n) => n.includes(q)) ? 1 : 2;
  };
  return members
    .filter((m) => rank(m) < 2)
    .sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username))
    .slice(0, limit);
}

/** Replaces the `@query` at `q` by `@username ` and returns the new text and caret. */
export function applyMention(
  text: string,
  caret: number,
  q: MentionQuery,
  username: string
): { text: string; caret: number } {
  const insert = `@${username} `;
  return {
    text: text.slice(0, q.start) + insert + text.slice(caret),
    caret: q.start + insert.length,
  };
}

const readKey = (pid: number) => `undertree.chat.read.${pid}`;

/** Last chat message id the user has seen in this project, in this browser. */
export function loadLastRead(pid: number): number | null {
  try {
    const v = Number(localStorage.getItem(readKey(pid)));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function saveLastRead(pid: number, id: number): void {
  try {
    localStorage.setItem(readKey(pid), String(id));
  } catch {
    // private mode / blocked storage: the badge just resets on reload
  }
}
