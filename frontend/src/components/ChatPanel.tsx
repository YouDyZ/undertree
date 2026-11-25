import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type ChatMessage,
  type ProjectMember,
  type User,
  deleteChat,
  editChat,
  errorText,
  listMembers,
  sendChat,
} from "../api";
import { formatCommentTime } from "../lib/comments";
import {
  applyMention,
  groupMessages,
  locationLabel,
  mentionQuery,
  mentionsUser,
  splitMentions,
  suggestMembers,
  validateChatBody,
} from "../lib/chat";
import { AlertIcon, EditIcon, ExternalLinkIcon, MessageSquareIcon, TrashIcon, XIcon } from "./Icons";

export interface ChatLocation {
  file: string;
  line: number;
}

export interface ChatPanelProps {
  projectId: number;
  user: User;
  /** commenter or higher */
  canWrite: boolean;
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadOlder: () => void;
  onUpsert: (message: ChatMessage) => void;
  /** file and cursor line of the editor in focus, if any */
  getLocation: () => ChatLocation | null;
  onJumpToLine: (file: string, line: number) => void;
  onNotify: (kind: "info" | "success" | "error", msg: string) => void;
  onClose: () => void;
}

function Body({ message, me }: { message: ChatMessage; me: string }) {
  // text nodes only: bodies are user input and never reach innerHTML
  return (
    <p class="chat-body">
      {splitMentions(message.body, message.mentions).map((seg, i) =>
        seg.mention ? (
          <span key={i} class={`chat-mention ${seg.mention === me ? "is-me" : ""}`}>
            {seg.text}
          </span>
        ) : (
          seg.text
        )
      )}
    </p>
  );
}

export function ChatPanel({
  projectId,
  user,
  canWrite,
  messages,
  hasMore,
  loading,
  error,
  onLoadOlder,
  onUpsert,
  getLocation,
  onJumpToLine,
  onNotify,
  onClose,
}: ChatPanelProps) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [attached, setAttached] = useState<ChatLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const atBottomRef = useRef(true);
  const seenRef = useRef<{ first?: number; last?: number; height: number }>({ height: 0 });

  useEffect(() => {
    let cancelled = false;
    listMembers(projectId)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch(() => {
        // autocomplete is a convenience
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // scroll: stay at the bottom for new messages, keep the view when older ones are prepended
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const first = messages[0]?.id;
    const last = messages[messages.length - 1]?.id;
    const seen = seenRef.current;
    if (seen.first === undefined) {
      el.scrollTop = el.scrollHeight;
    } else if (first !== undefined && first < seen.first) {
      el.scrollTop += el.scrollHeight - seen.height;
    } else if (last !== seen.last && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    seenRef.current = { first, last, height: el.scrollHeight };
  }, [messages]);

  const groups = useMemo(() => groupMessages(messages), [messages]);

  const mq = canWrite && !suggestDismissed ? mentionQuery(text, caret) : null;
  const suggestions = mq ? suggestMembers(members, mq.query) : [];
  const picked = Math.min(pick, Math.max(0, suggestions.length - 1));

  const syncCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? el.value.length);
  };

  const chooseMention = (username: string) => {
    if (!mq) return;
    const next = applyMention(text, caret, mq, username);
    setText(next.text);
    setCaret(next.caret);
    setPick(0);
    window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  const send = async () => {
    if (busy) return;
    const v = validateChatBody(text);
    if (!v.ok) {
      setComposeError(v.error);
      return;
    }
    setBusy(true);
    setComposeError(null);
    try {
      const m = await sendChat(
        { body: v.body, ...(attached ? { file: attached.file, line: attached.line } : {}) },
        projectId
      );
      atBottomRef.current = true;
      onUpsert(m);
      setText("");
      setCaret(0);
      setAttached(null);
    } catch (err) {
      setComposeError(errorText(err, "Nachricht konnte nicht gesendet werden."));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : suggestions.length - 1;
        setPick((picked + step) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const m = suggestions[picked];
        if (m) chooseMention(m.username);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const v = validateChatBody(editing.body);
    if (!v.ok) {
      onNotify("error", v.error);
      return;
    }
    try {
      onUpsert(await editChat(editing.id, v.body, projectId));
      setEditing(null);
    } catch (err) {
      onNotify("error", errorText(err, "Nachricht konnte nicht geändert werden."));
    }
  };

  const remove = async (m: ChatMessage) => {
    if (!window.confirm("Nachricht wirklich löschen?")) return;
    try {
      await deleteChat(m.id, projectId);
      // the `chat` event delivers the tombstone to everybody; show it right away for the author
      onUpsert({ ...m, deleted: true, body: "", file: null, line: null, mentions: [] });
    } catch (err) {
      onNotify("error", errorText(err, "Nachricht konnte nicht gelöscht werden."));
    }
  };

  const attach = () => {
    if (attached) {
      setAttached(null);
      return;
    }
    const loc = getLocation();
    if (!loc) {
      onNotify("info", "Öffne zuerst eine Datei, auf die du verweisen möchtest.");
      return;
    }
    setAttached(loc);
    inputRef.current?.focus();
  };

  return (
    <aside class="git-drawer chat-drawer" aria-label="Chat">
      <div class="pane-toolbar">
        <span class="drawer-title">
          <MessageSquareIcon size={14} />
          <strong>Chat</strong>
        </span>
        <div class="git-toolbar-right">
          <button
            type="button"
            class="icon-btn"
            onClick={onClose}
            aria-label="Chat schließen"
            title="Schließen"
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <div
        class="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (el.scrollTop < 60 && hasMore && !loading) onLoadOlder();
        }}
      >
        {error && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={15} />
            <span>{error}</span>
          </div>
        )}
        {hasMore && (
          <button type="button" class="btn-ghost btn-sm" disabled={loading} onClick={onLoadOlder}>
            {loading ? "Lade…" : "Ältere Nachrichten laden"}
          </button>
        )}
        {messages.length === 0 && !error && (
          <p class="chat-empty muted-text">Noch keine Nachrichten. Schreib die erste.</p>
        )}
        {groups.map((g) => (
          <section key={g.key} class="chat-group">
            <header class="chat-group-head">
              <span class={`chat-author ${g.author === user.username ? "is-me" : ""}`}>
                {g.display_name ?? g.author ?? "Gelöschter Nutzer"}
              </span>
              <time class="mono-dim" dateTime={g.messages[0]?.created_at}>
                {formatCommentTime(g.messages[0]?.created_at ?? "")}
              </time>
            </header>
            {g.messages.map((m) => {
              const own = canWrite && !m.deleted && m.author === user.username;
              return (
                <article
                  key={m.id}
                  class={`chat-msg ${mentionsUser(m, user.username) ? "is-mention-me" : ""} ${m.deleted ? "is-deleted" : ""}`}
                >
                  {m.deleted ? (
                    <p class="chat-body muted-text">Nachricht gelöscht</p>
                  ) : editing?.id === m.id ? (
                    <div class="chat-edit">
                      <textarea
                        class="comment-textarea"
                        value={editing.body}
                        onInput={(e) =>
                          setEditing({ id: m.id, body: (e.target as HTMLTextAreaElement).value })
                        }
                        onKeyDown={(e) => {
                          if (e.isComposing) return;
                          if (e.key === "Escape") setEditing(null);
                          else if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void saveEdit();
                          }
                        }}
                        autoFocus
                      />
                      <div class="comment-composer-actions">
                        <button type="button" class="btn-ghost btn-sm" onClick={() => setEditing(null)}>
                          Abbrechen
                        </button>
                        <button type="button" class="btn-primary btn-sm" onClick={() => void saveEdit()}>
                          Speichern
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <Body message={m} me={user.username} />
                      {m.file && (
                        <button
                          type="button"
                          class="chat-link"
                          title="Stelle im Editor öffnen"
                          onClick={() => onJumpToLine(m.file as string, m.line ?? 1)}
                        >
                          <ExternalLinkIcon size={12} />
                          <span>{locationLabel(m.file, m.line)}</span>
                        </button>
                      )}
                      {m.edited_at && <span class="chat-edited mono-dim">bearbeitet</span>}
                    </>
                  )}
                  {own && editing?.id !== m.id && (
                    <span class="chat-msg-actions">
                      <button
                        type="button"
                        class="icon-btn"
                        title="Bearbeiten"
                        aria-label="Nachricht bearbeiten"
                        onClick={() => setEditing({ id: m.id, body: m.body })}
                      >
                        <EditIcon size={12} />
                      </button>
                      <button
                        type="button"
                        class="icon-btn"
                        title="Löschen"
                        aria-label="Nachricht löschen"
                        onClick={() => void remove(m)}
                      >
                        <TrashIcon size={12} />
                      </button>
                    </span>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>

      {canWrite ? (
        <div class="chat-composer">
          {suggestions.length > 0 && (
            <ul class="chat-suggest" role="listbox" aria-label="Mitglieder erwähnen">
              {suggestions.map((m, i) => (
                <li
                  key={m.username}
                  role="option"
                  aria-selected={i === picked}
                  class={i === picked ? "is-active" : ""}
                  // mousedown: keep the focus in the textarea
                  onMouseDown={(e) => {
                    e.preventDefault();
                    chooseMention(m.username);
                  }}
                >
                  <strong>{m.display_name}</strong> <span class="mono-dim">@{m.username}</span>
                </li>
              ))}
            </ul>
          )}
          {attached && (
            <div class="chat-attached">
              <ExternalLinkIcon size={12} />
              <span>{locationLabel(attached.file, attached.line)}</span>
              <button
                type="button"
                class="icon-btn"
                aria-label="Verknüpfung entfernen"
                title="Verknüpfung entfernen"
                onClick={() => setAttached(null)}
              >
                <XIcon size={12} />
              </button>
            </div>
          )}
          {composeError && (
            <div class="alert alert-error" role="alert">
              <AlertIcon size={15} />
              <span>{composeError}</span>
            </div>
          )}
          <textarea
            ref={inputRef}
            class="comment-textarea chat-input"
            rows={2}
            placeholder="Nachricht… (Enter sendet, Shift+Enter neue Zeile, @ erwähnt)"
            value={text}
            disabled={busy}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement;
              setText(el.value);
              syncCaret(el);
              setSuggestDismissed(false);
              setPick(0);
              setComposeError(null);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(e) => syncCaret(e.target as HTMLTextAreaElement)}
            onClick={(e) => syncCaret(e.target as HTMLTextAreaElement)}
          />
          <div class="chat-composer-actions">
            <button
              type="button"
              class={`btn-ghost btn-sm ${attached ? "is-active" : ""}`}
              onClick={attach}
              title="Aktuelle Datei und Zeile an die Nachricht hängen"
            >
              <ExternalLinkIcon size={13} />
              <span>Stelle verlinken</span>
            </button>
            <button
              type="button"
              class="btn-primary btn-sm"
              disabled={busy || !text.trim()}
              onClick={() => void send()}
            >
              Senden
            </button>
          </div>
        </div>
      ) : (
        <p class="chat-readonly muted-text">Du hast nur Leserechte und kannst hier nicht schreiben.</p>
      )}
    </aside>
  );
}
