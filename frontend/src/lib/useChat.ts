import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { type ChatMessage, errorText, listChat } from "../api";
import { loadLastRead, mergeMessages, saveLastRead, unreadStats } from "./chat";

export const CHAT_PAGE = 50;

export type ChatSubscribe = (listener: (message: ChatMessage) => void) => () => void;

interface UseChatOptions {
  projectId: number;
  username: string;
  /** events socket is up: (re)load the newest page, which closes gaps after a reconnect */
  connected: boolean;
  subscribe: ChatSubscribe;
  /** changes whenever events were missed: refetch the newest page */
  resync: number;
  /** drawer visible: everything loaded counts as read */
  open: boolean;
}

/** Chat history of a project, live updates from the events socket and the unread counter. */
export function useChat({ projectId, username, connected, subscribe, resync, open }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRead, setLastRead] = useState<number | null>(() => loadLastRead(projectId));
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const busyRef = useRef(false);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    setError(null);
    setLastRead(loadLastRead(projectId));
  }, [projectId]);

  const upsert = useCallback((m: ChatMessage) => setMessages((prev) => mergeMessages(prev, [m])), []);

  useEffect(() => subscribe(upsert), [subscribe, upsert]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    listChat({ limit: CHAT_PAGE }, projectId)
      .then((page) => {
        if (cancelled) return;
        setError(null);
        const prev = messagesRef.current;
        const newest = prev[prev.length - 1];
        // more than a page missed while offline: drop the stale history, load it again on scroll
        const contiguous =
          newest === undefined || page.length < CHAT_PAGE || (page[0]?.id ?? 0) <= newest.id;
        if (!contiguous) setMessages(page);
        else setMessages((cur) => mergeMessages(cur, page));
        if (!contiguous || prev.length === 0) setHasMore(page.length >= CHAT_PAGE);
        // first visit in this browser: the existing history is not "unread"
        setLastRead((prev) => prev ?? page[page.length - 1]?.id ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, "Chat konnte nicht geladen werden."));
      });
    return () => {
      cancelled = true;
    };
  }, [connected, projectId, resync]);

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (busyRef.current || !first) return;
    busyRef.current = true;
    setLoading(true);
    const pid = projectRef.current;
    try {
      const page = await listChat({ before: first.id, limit: CHAT_PAGE }, pid);
      if (pid !== projectRef.current) return;
      setMessages((prev) => mergeMessages(prev, page));
      setHasMore(page.length >= CHAT_PAGE);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Ältere Nachrichten konnten nicht geladen werden."));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, []);

  const newestId = messages[messages.length - 1]?.id ?? 0;
  useEffect(() => {
    if (open && lastRead !== null && newestId > lastRead) {
      setLastRead(newestId);
      saveLastRead(projectId, newestId);
    }
  }, [open, newestId, lastRead, projectId]);

  const unread =
    open || lastRead === null
      ? { count: 0, mentioned: false }
      : unreadStats(messages, lastRead, username);

  return { messages, hasMore, loading, error, unread, loadOlder, upsert };
}
