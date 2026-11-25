import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type CommentMessage,
  type CommentThread,
  type User,
  createComment,
  deleteCommentMessage,
  deleteCommentThread,
  editCommentMessage,
  replyToComment,
  setCommentResolved,
} from "../api";
import type { DocSession } from "../editor/docSession";
import {
  type CommentAnchor,
  canDeleteThread,
  canEditOrDeleteMessage,
  formatCommentError,
  formatCommentTime,
  getFileSidebarThreads,
  getOverviewThreads,
  resolveCommentAnchorRange,
  syncCommentAnchors,
  validateCommentBody,
} from "../lib/comments";
import {
  AlertIcon,
  CheckIcon,
  EditIcon,
  MessageSquareIcon,
  RefreshIcon,
  RotateCcwIcon,
  TrashIcon,
  XIcon,
} from "./Icons";

export interface CommentDraft {
  path: string;
  start: number;
  end: number;
  quote: string;
}

export interface CommentsPanelProps {
  projectId: number;
  user: User;
  canComment?: boolean;
  isProjectOwner?: boolean;
  activePath: string | null;
  activeSession: DocSession | null;
  threads: CommentThread[];
  loading: boolean;
  error: string | null;
  pendingDraft: CommentDraft | null;
  activeThreadId: number | null;
  tab: "file" | "overview";
  onTabChange: (tab: "file" | "overview") => void;
  onCancelDraft: () => void;
  onSelectThread: (threadId: number | null) => void;
  onJumpToThread: (thread: CommentThread) => void;
  onThreadCreated: (thread: CommentThread) => void;
  onThreadUpdated: (thread: CommentThread) => void;
  onThreadDeleted: (threadId: number, path: string) => void;
  onReload: () => void | Promise<void>;
  onNotify: (kind: "info" | "success" | "error", msg: string) => void;
  onClose: () => void;
}

export function CommentsPanel({
  projectId,
  user,
  canComment = true,
  isProjectOwner = false,
  activePath,
  activeSession,
  threads,
  loading,
  error,
  pendingDraft,
  activeThreadId,
  tab,
  onTabChange,
  onCancelDraft,
  onSelectThread,
  onJumpToThread,
  onThreadCreated,
  onThreadUpdated,
  onThreadDeleted,
  onReload,
  onNotify,
  onClose,
}: CommentsPanelProps) {
  const [showResolved, setShowResolved] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [replyBodies, setReplyBodies] = useState<Record<number, string>>({});
  const [replyBusyId, setReplyBusyId] = useState<number | null>(null);
  const [busyThreadId, setBusyThreadId] = useState<number | null>(null);

  const [editingMsg, setEditingMsg] = useState<{
    threadId: number;
    messageId: number;
    body: string;
  } | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const threadCardRefs = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    if (pendingDraft) {
      setDraftBody("");
      setDraftError(null);
      window.setTimeout(() => {
        draftInputRef.current?.focus();
      }, 0);
    }
  }, [pendingDraft]);

  useEffect(() => {
    if (activeThreadId === null) return;
    const el = threadCardRefs.current.get(activeThreadId);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeThreadId, tab]);

  const anchorsRef = useRef<CommentAnchor[]>([]);
  const anchorsSessionRef = useRef<DocSession | null>(null);
  const [sessionSynced, setSessionSynced] = useState(
    () => activeSession?.getSnapshot().status === "synced"
  );
  useEffect(() => {
    if (!activeSession) {
      setSessionSynced(false);
      return;
    }
    setSessionSynced(activeSession.getSnapshot().status === "synced");
    return activeSession.subscribe((snap) => {
      setSessionSynced(snap.status === "synced");
    });
  }, [activeSession]);

  const [anchorTick, setAnchorTick] = useState(0);
  useEffect(() => {
    if (!activeSession) return;
    let cancelled = false;
    let scheduled = false;
    const onUpdate = () => {
      if (cancelled || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!cancelled) {
          setAnchorTick((n) => n + 1);
        }
      });
    };
    activeSession.ydoc.on("update", onUpdate);
    return () => {
      cancelled = true;
      activeSession.ydoc.off("update", onUpdate);
    };
  }, [activeSession]);

  const fileAnchors = useMemo(() => {
    if (!activePath || !activeSession || activeSession.path !== activePath) {
      return [] as CommentAnchor[];
    }
    if (anchorsSessionRef.current !== activeSession) {
      anchorsRef.current = [];
      anchorsSessionRef.current = activeSession;
    }
    if (!sessionSynced && activeSession.ydoc.getText("content").length === 0) {
      return anchorsRef.current;
    }
    const forFile = threads.filter((t) => t.path === activePath && !t.detached);
    anchorsRef.current = syncCommentAnchors(anchorsRef.current, forFile, activeSession.ydoc);
    return anchorsRef.current;
  }, [threads, activePath, activeSession, sessionSynced]);

  const liveStartById = useMemo(() => {
    const map = new Map<number, number>();
    if (anchorTick < 0 || !activeSession || fileAnchors.length === 0) {
      return map;
    }
    for (const anchor of fileAnchors) {
      const range = resolveCommentAnchorRange(anchor, activeSession.ydoc);
      if (range) {
        map.set(anchor.threadId, range.from);
      }
    }
    return map;
  }, [fileAnchors, activeSession, anchorTick]);

  const visibleThreads = useMemo(() => {
    if (tab === "overview") {
      return getOverviewThreads(threads, showResolved);
    }
    if (!activePath) return [];
    return getFileSidebarThreads(threads, activePath, showResolved, liveStartById);
  }, [tab, threads, activePath, showResolved, liveStartById]);

  const openTotalCount = useMemo(() => threads.filter((t) => !t.resolved).length, [threads]);
  const openFileCount = useMemo(
    () =>
      activePath
        ? threads.filter((t) => t.path === activePath && !t.detached && !t.resolved).length
        : 0,
    [threads, activePath]
  );

  const handleCreateSubmit = async (e?: Event) => {
    e?.preventDefault();
    if (!pendingDraft || draftBusy) return;
    const check = validateCommentBody(draftBody);
    if (!check.ok) {
      setDraftError(check.error);
      return;
    }
    const reqPid = projectIdRef.current;
    setDraftBusy(true);
    setDraftError(null);
    try {
      const created = await createComment(
        {
          path: pendingDraft.path,
          start: pendingDraft.start,
          end: pendingDraft.end,
          body: check.body,
        },
        reqPid
      );
      if (projectIdRef.current !== reqPid) return;
      onThreadCreated(created);
      onSelectThread(created.id);
      onCancelDraft();
      setDraftBody("");
    } catch (err: unknown) {
      if (projectIdRef.current !== reqPid) return;
      setDraftError(formatCommentError(err, "Kommentar konnte nicht erstellt werden."));
    } finally {
      if (projectIdRef.current === reqPid) {
        setDraftBusy(false);
      }
    }
  };

  const handleReplySubmit = async (thread: CommentThread, e?: Event) => {
    e?.preventDefault();
    if (replyBusyId !== null) return;
    const raw = replyBodies[thread.id] ?? "";
    const check = validateCommentBody(raw);
    if (!check.ok) {
      onNotify("error", check.error);
      return;
    }
    const reqPid = projectIdRef.current;
    setReplyBusyId(thread.id);
    try {
      const message = await replyToComment(thread.id, check.body, reqPid);
      if (projectIdRef.current !== reqPid) return;
      onThreadUpdated({
        ...thread,
        messages: [...thread.messages, message],
      });
      setReplyBodies((prev) => ({ ...prev, [thread.id]: "" }));
    } catch (err: unknown) {
      if (projectIdRef.current !== reqPid) return;
      onNotify("error", formatCommentError(err, "Antwort konnte nicht gesendet werden."));
    } finally {
      if (projectIdRef.current === reqPid) {
        setReplyBusyId(null);
      }
    }
  };

  const handleToggleResolved = async (thread: CommentThread) => {
    if (busyThreadId !== null) return;
    const reqPid = projectIdRef.current;
    setBusyThreadId(thread.id);
    try {
      const updated = await setCommentResolved(thread.id, !thread.resolved, reqPid);
      if (projectIdRef.current !== reqPid) return;
      onThreadUpdated(updated);
      onNotify("info", updated.resolved ? "Kommentar erledigt" : "Kommentar wieder geöffnet");
    } catch (err: unknown) {
      if (projectIdRef.current !== reqPid) return;
      onNotify("error", formatCommentError(err, "Status konnte nicht geändert werden."));
    } finally {
      if (projectIdRef.current === reqPid) {
        setBusyThreadId(null);
      }
    }
  };

  const handleDeleteThread = async (thread: CommentThread) => {
    if (busyThreadId !== null) return;
    if (!window.confirm("Kommentar-Thread wirklich löschen?")) return;
    const reqPid = projectIdRef.current;
    setBusyThreadId(thread.id);
    try {
      await deleteCommentThread(thread.id, reqPid);
      if (projectIdRef.current !== reqPid) return;
      onThreadDeleted(thread.id, thread.path);
      onNotify("info", "Kommentar-Thread gelöscht");
    } catch (err: unknown) {
      if (projectIdRef.current !== reqPid) return;
      onNotify("error", formatCommentError(err, "Thread konnte nicht gelöscht werden."));
    } finally {
      if (projectIdRef.current === reqPid) {
        setBusyThreadId(null);
      }
    }
  };

  const handleSaveEditMessage = async (thread: CommentThread, e?: Event) => {
    e?.preventDefault();
    if (!editingMsg || editingMsg.threadId !== thread.id || editBusy) return;
    const check = validateCommentBody(editingMsg.body);
    if (!check.ok) {
      onNotify("error", check.error);
      return;
    }
    const reqPid = projectIdRef.current;
    setEditBusy(true);
    try {
      const updatedMsg = await editCommentMessage(
        thread.id,
        editingMsg.messageId,
        check.body,
        reqPid
      );
      if (projectIdRef.current !== reqPid) return;
      onThreadUpdated({
        ...thread,
        messages: thread.messages.map((m) => (m.id === updatedMsg.id ? updatedMsg : m)),
      });
      setEditingMsg(null);
    } catch (err: unknown) {
      if (projectIdRef.current !== reqPid) return;
      onNotify("error", formatCommentError(err, "Nachricht konnte nicht bearbeitet werden."));
    } finally {
      if (projectIdRef.current === reqPid) {
        setEditBusy(false);
      }
    }
  };

  const handleDeleteMessage = async (thread: CommentThread, msg: CommentMessage) => {
    if (busyThreadId !== null || editBusy) return;
    const isRootMessage = thread.messages[0]?.id === msg.id || thread.messages.length <= 1;
    const confirmText = isRootMessage
      ? "Dies ist die Startnachricht — beim Löschen wird der gesamte Thread entfernt. Fortfahren?"
      : "Nachricht wirklich löschen?";
    if (!window.confirm(confirmText)) return;

    const reqPid = projectIdRef.current;
    setBusyThreadId(thread.id);
    try {
      await deleteCommentMessage(thread.id, msg.id, reqPid);
      if (projectIdRef.current !== reqPid) return;
      if (isRootMessage) {
        onThreadDeleted(thread.id, thread.path);
        onNotify("info", "Kommentar-Thread gelöscht");
      } else {
        onThreadUpdated({
          ...thread,
          messages: thread.messages.filter((m) => m.id !== msg.id),
        });
        if (editingMsg?.messageId === msg.id) {
          setEditingMsg(null);
        }
      }
    } catch (err: unknown) {
      if (projectIdRef.current !== reqPid) return;
      onNotify("error", formatCommentError(err, "Nachricht konnte nicht gelöscht werden."));
    } finally {
      if (projectIdRef.current === reqPid) {
        setBusyThreadId(null);
      }
    }
  };

  return (
    <aside class="git-drawer comments-drawer" aria-label="Kommentare">
      <div class="pane-toolbar">
        <span class="drawer-title">
          <MessageSquareIcon size={14} />
          <strong>Kommentare</strong>
        </span>
        <div class="git-toolbar-right">
          <button
            type="button"
            class="icon-btn"
            onClick={() => void onReload()}
            disabled={loading}
            title="Kommentare aktualisieren"
            aria-label="Kommentare aktualisieren"
          >
            <RefreshIcon size={13} class={loading ? "spin" : ""} />
          </button>
          <button
            type="button"
            class="icon-btn"
            onClick={onClose}
            aria-label="Kommentare schließen"
            title="Schließen"
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <div class="comments-tabs" role="tablist" aria-label="Kommentaransicht">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "file"}
          class={`comments-tab ${tab === "file" ? "is-active" : ""}`}
          onClick={() => onTabChange("file")}
        >
          <span>Diese Datei</span>
          {openFileCount > 0 && <span class="badge badge-muted">{openFileCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "overview"}
          class={`comments-tab ${tab === "overview" ? "is-active" : ""}`}
          onClick={() => onTabChange("overview")}
        >
          <span>Projekt-Übersicht</span>
          {openTotalCount > 0 && <span class="badge badge-muted">{openTotalCount}</span>}
        </button>
      </div>

      <div class="comments-filter-bar">
        <label class="comments-filter-toggle">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved((e.target as HTMLInputElement).checked)}
          />
          <span>Erledigte anzeigen</span>
        </label>
        {canComment && (
          <span class="mono-dim" title="Tastenkürzel bei Textauswahl">
            Strg+Alt+M
          </span>
        )}
      </div>

      <div class="comments-drawer-body">
        {error && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={15} />
            <span>{error}</span>
          </div>
        )}

        {pendingDraft && canComment && (
          <form class="comment-composer-card" onSubmit={(e) => void handleCreateSubmit(e)}>
            <div class="comment-composer-head">
              <strong>Neuer Kommentar</strong>
              <span class="mono-dim">{pendingDraft.path}</span>
            </div>
            <blockquote class="comment-quote" title={pendingDraft.quote}>
              {pendingDraft.quote}
            </blockquote>
            <textarea
              ref={draftInputRef}
              class="text-input comment-textarea"
              rows={3}
              placeholder="Kommentar schreiben… (Strg+Enter zum Senden)"
              value={draftBody}
              disabled={draftBusy}
              onInput={(e) => setDraftBody((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleCreateSubmit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelDraft();
                }
              }}
            />
            {draftError && <div class="form-error">{draftError}</div>}
            <div class="comment-composer-actions">
              <button
                type="button"
                class="btn-ghost btn-xs"
                disabled={draftBusy}
                onClick={onCancelDraft}
              >
                Abbrechen
              </button>
              <button
                type="submit"
                class="btn-primary btn-xs"
                disabled={draftBusy || !draftBody.trim()}
              >
                {draftBusy ? "Speichere…" : "Kommentieren"}
              </button>
            </div>
          </form>
        )}

        {tab === "file" && !activePath && (!pendingDraft || !canComment) && (
          <div class="comments-empty muted-text">
            {canComment ? (
              <>
                Öffne eine Datei im Editor, um ihre Kommentare zu sehen oder Textstellen mit{" "}
                <kbd>Strg+Alt+M</kbd> zu kommentieren.
              </>
            ) : (
              "Öffne eine Datei im Editor, um ihre Kommentare zu sehen."
            )}
          </div>
        )}

        {(tab === "overview" || activePath) &&
          !loading &&
          visibleThreads.length === 0 &&
          (!pendingDraft || !canComment) && (
            <div class="comments-empty muted-text">
              {tab === "file"
                ? showResolved
                  ? "Keine Kommentare in dieser Datei."
                  : canComment
                    ? "Keine offenen Kommentare in dieser Datei. Markiere Text im Editor zum Kommentieren."
                    : "Keine offenen Kommentare in dieser Datei."
                : showResolved
                  ? "Noch keine Kommentare im Projekt."
                  : "Keine offenen Kommentare im Projekt."}
            </div>
          )}

        {loading && threads.length === 0 && (
          <div class="comments-empty muted-text">Lade Kommentare…</div>
        )}

        {visibleThreads.map((thread) => {
          const isActive = activeThreadId === thread.id;
          const isThreadBusy = busyThreadId === thread.id;
          const allowDeleteThread = canComment && canDeleteThread(thread, user, isProjectOwner);
          const rootAuthor =
            thread.messages[0]?.display_name ||
            thread.messages[0]?.author ||
            thread.created_by ||
            "Unbekannt";

          return (
            <article
              key={thread.id}
              ref={(el) => {
                if (el) threadCardRefs.current.set(thread.id, el);
                else threadCardRefs.current.delete(thread.id);
              }}
              class={`comment-thread-card${isActive ? " is-active" : ""}${
                thread.resolved ? " is-resolved" : ""
              }`}
              onClick={() => onSelectThread(thread.id)}
            >
              <div class="comment-thread-head">
                <div class="comment-thread-meta">
                  {tab === "overview" && (
                    <span class="badge badge-muted comment-file-pill" title={thread.path}>
                      {thread.path}
                    </span>
                  )}
                  <span class="comment-author">{rootAuthor}</span>
                  <span class="mono-dim">{formatCommentTime(thread.created_at)}</span>
                  {thread.resolved && <span class="badge badge-parent">Erledigt</span>}
                </div>
                {canComment && (
                  <div class="comment-thread-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      class="icon-btn"
                      disabled={isThreadBusy}
                      title={thread.resolved ? "Wieder öffnen" : "Als erledigt markieren"}
                      aria-label={thread.resolved ? "Wieder öffnen" : "Erledigt"}
                      onClick={() => void handleToggleResolved(thread)}
                    >
                      {thread.resolved ? <RotateCcwIcon size={12} /> : <CheckIcon size={12} />}
                    </button>
                    {allowDeleteThread && (
                      <button
                        type="button"
                        class="icon-btn icon-btn-danger"
                        disabled={isThreadBusy}
                        title="Thread löschen"
                        aria-label="Thread löschen"
                        onClick={() => void handleDeleteThread(thread)}
                      >
                        <TrashIcon size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {thread.detached ? (
                <div class="comment-detached-wrap">
                  <div class="comment-detached-notice" role="status">
                    <AlertIcon size={13} />
                    <span>Textstelle nicht mehr vorhanden</span>
                  </div>
                  {thread.quote && (
                    <blockquote class="comment-quote is-detached" title={thread.quote}>
                      {thread.quote}
                    </blockquote>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  class="comment-quote-btn"
                  title="Im Editor zur Textstelle springen"
                  onClick={(e) => {
                    e.stopPropagation();
                    onJumpToThread(thread);
                  }}
                >
                  <blockquote class="comment-quote">{thread.quote || "(Auswahl)"}</blockquote>
                </button>
              )}

              <div class="comment-messages">
                {thread.messages.map((msg, idx) => {
                  const isOwn = canComment && canEditOrDeleteMessage(msg, user);
                  const isEditingThis =
                    canComment &&
                    editingMsg?.threadId === thread.id &&
                    editingMsg.messageId === msg.id;
                  const authorName = msg.display_name || msg.author || "Gelöschter Nutzer";

                  return (
                    <div key={msg.id} class="comment-message">
                      <div class="comment-message-head">
                        <span class="comment-message-author">
                          {idx === 0 ? "Eröffnet von " : ""}
                          <strong>{authorName}</strong>
                        </span>
                        <span class="comment-message-meta">
                          <span class="mono-dim">{formatCommentTime(msg.created_at)}</span>
                          {msg.edited_at && <span class="mono-dim">(bearbeitet)</span>}
                          {isOwn && !isEditingThis && (
                            <span class="comment-message-actions" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                class="icon-btn"
                                title="Nachricht bearbeiten"
                                aria-label="Nachricht bearbeiten"
                                disabled={isThreadBusy || editBusy}
                                onClick={() =>
                                  setEditingMsg({
                                    threadId: thread.id,
                                    messageId: msg.id,
                                    body: msg.body,
                                  })
                                }
                              >
                                <EditIcon size={11} />
                              </button>
                              <button
                                type="button"
                                class="icon-btn icon-btn-danger"
                                title={
                                  idx === 0
                                    ? "Startnachricht & Thread löschen"
                                    : "Nachricht löschen"
                                }
                                aria-label="Nachricht löschen"
                                disabled={isThreadBusy || editBusy}
                                onClick={() => void handleDeleteMessage(thread, msg)}
                              >
                                <TrashIcon size={11} />
                              </button>
                            </span>
                          )}
                        </span>
                      </div>

                      {isEditingThis ? (
                        <form
                          class="comment-edit-form"
                          onSubmit={(e) => void handleSaveEditMessage(thread, e)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <textarea
                            class="text-input comment-textarea"
                            rows={2}
                            value={editingMsg.body}
                            disabled={editBusy}
                            onInput={(e) =>
                              setEditingMsg((prev) =>
                                prev
                                  ? { ...prev, body: (e.target as HTMLTextAreaElement).value }
                                  : null
                              )
                            }
                            onKeyDown={(e) => {
                              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                                e.preventDefault();
                                void handleSaveEditMessage(thread);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingMsg(null);
                              }
                            }}
                          />
                          <div class="comment-composer-actions">
                            <button
                              type="button"
                              class="btn-ghost btn-xs"
                              disabled={editBusy}
                              onClick={() => setEditingMsg(null)}
                            >
                              Abbrechen
                            </button>
                            <button
                              type="submit"
                              class="btn-primary btn-xs"
                              disabled={editBusy || !editingMsg.body.trim()}
                            >
                              {editBusy ? "Speichere…" : "Speichern"}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <p class="comment-message-body">{msg.body}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {canComment && (
                <form
                  class="comment-reply-form"
                  onSubmit={(e) => void handleReplySubmit(thread, e)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="text"
                    class="text-input comment-reply-input"
                    placeholder="Antworten…"
                    value={replyBodies[thread.id] ?? ""}
                    disabled={replyBusyId === thread.id || isThreadBusy}
                    onInput={(e) => {
                      const value = (e.target as HTMLInputElement).value;
                      setReplyBodies((prev) => ({ ...prev, [thread.id]: value }));
                    }}
                  />
                  <button
                    type="submit"
                    class="btn-ghost btn-xs"
                    disabled={
                      replyBusyId === thread.id ||
                      isThreadBusy ||
                      !(replyBodies[thread.id] ?? "").trim()
                    }
                  >
                    {replyBusyId === thread.id ? "…" : "Senden"}
                  </button>
                </form>
              )}
            </article>
          );
        })}
      </div>
    </aside>
  );
}
