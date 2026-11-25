import { useEffect, useRef, useState } from "preact/hooks";
import {
  Compartment,
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { type CommentThread, fileApiUrl } from "../api";
import { isImageFile } from "../lib/tree";
import {
  type CommentAnchor,
  type CommentJumpTarget,
  clampValidSelectionRange,
  findCommentAtPosition,
  resolveCommentAnchorRange,
  syncCommentAnchors,
} from "../lib/comments";
import {
  type YjsCommentHighlightBinding,
  attachYjsCommentHighlights,
  commentHighlightField,
} from "../editor/commentHighlights";
import {
  type PeerJumpTarget,
  runPeerJump,
} from "../editor/awarenessJump";
import {
  type DocSession,
  type DocSessionSnapshot,
  type DocSyncStatus,
} from "../editor/docSession";
import { cursorSyncPosition, flashLine, synctexExtension } from "../editor/synctex";
import { latexAutocompletion } from "../editor/latexCompletion";
import { createLatexEmmetKeymap } from "../editor/latexEmmet";
import {
  getLatexLanguageExtension,
  isBibtexFile,
  isLatexDocumentFile,
  isLatexSyntaxFile,
} from "../editor/latexLanguage";
import { getReadOnlyExtension } from "../editor/readOnly";
import { spellcheckExtension } from "../editor/spellcheck";
import { browserSpellcheckExtension } from "../editor/browserSpellcheck";
import { getEditorThemeExtension } from "../theme/editorThemes";
import { type EditorThemeId, useThemeSettings } from "../theme/themeStore";
import { AlertIcon, MessageSquareIcon, RefreshIcon } from "./Icons";

export interface JumpTarget {
  path: string;
  line: number;
  seq: number;
}

export type { PeerJumpTarget, CommentJumpTarget };

export interface CommentSelectionDraft {
  path: string;
  start: number;
  end: number;
  quote: string;
}

interface CodeEditorProps {
  session: DocSession;
  jumpTarget: JumpTarget | null;
  peerJumpTarget?: PeerJumpTarget | null;
  onPeerJumpConsumed?: (seq: number) => void;
  readOnly?: boolean;
  roleTooltip?: string;
  comments?: CommentThread[];
  activeCommentId?: number | null;
  commentJumpTarget?: CommentJumpTarget | null;
  onCommentJumpConsumed?: (seq: number) => void;
  onStartComment?: (draft: CommentSelectionDraft) => void;
  onSelectComment?: (threadId: number) => void;
  getContextTexts?: () => string[];
  getBibTexts?: () => string[];
  /** SyncTeX source -> PDF (#52): double-click, Ctrl+Alt+J (`explicit`) or the toolbar button */
  /** cursor moved to this 1-based line (also reported once on mount) */
  onCursorLine?: (path: string, line: number) => void;
  onSyncToPdf?: (file: string, line: number, column: number, explicit: boolean) => void;
}

interface PeerJumpHighlight {
  anchor: number;
  head: number;
  color: string;
}

class PeerJumpCaretWidget extends WidgetType {
  constructor(readonly color: string) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-peer-jump-caret";
    el.style.setProperty("--peer-jump-color", this.color);
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  eq(other: PeerJumpCaretWidget): boolean {
    return other.color === this.color;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const setPeerJumpHighlight = StateEffect.define<PeerJumpHighlight | null>();

const peerJumpHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setPeerJumpHighlight)) continue;
      if (!effect.value) {
        next = Decoration.none;
        continue;
      }
      const docLen = tr.state.doc.length;
      const anchor = Math.max(0, Math.min(effect.value.anchor, docLen));
      const head = Math.max(0, Math.min(effect.value.head, docLen));
      const from = Math.min(anchor, head);
      const to = Math.max(anchor, head);
      const color = effect.value.color;
      const line = tr.state.doc.lineAt(head);
      const decos: Array<Range<Decoration>> = [
        Decoration.line({
          class: "cm-peer-jump-highlight",
          attributes: { style: `--peer-jump-color: ${color}` },
        }).range(line.from),
      ];
      if (from < to) {
        decos.push(
          Decoration.mark({
            class: "cm-peer-jump-selection",
            attributes: { style: `--peer-jump-color: ${color}` },
          }).range(from, to)
        );
      }
      decos.push(
        Decoration.widget({
          widget: new PeerJumpCaretWidget(color),
          side: head - anchor > 0 ? -1 : 1,
        }).range(head)
      );
      next = Decoration.set(decos, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const SYNC_LABELS: Record<DocSyncStatus, string> = {
  connecting: "Verbindet…",
  connected: "Synchronisiere…",
  synced: "Synchronisiert",
  disconnected: "Reconnect…",
  error: "Fehler",
};

const undertreeBaseEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13.5px",
    fontFamily: "var(--font-mono)",
  },
  ".cm-scroller": {
    overflow: "auto",
    lineHeight: "1.6",
    fontFamily: "var(--font-mono)",
  },
  ".cm-ySelectionInfo": {
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    fontWeight: "600",
    padding: "1px 5px",
    borderRadius: "3px 3px 3px 0",
    opacity: "0.95",
  },
});

export function CodeEditor({
  session,
  jumpTarget,
  peerJumpTarget,
  onPeerJumpConsumed,
  readOnly = false,
  roleTooltip,
  comments = [],
  activeCommentId = null,
  commentJumpTarget = null,
  onCommentJumpConsumed,
  onStartComment,
  onSelectComment,
  getContextTexts,
  getBibTexts,
  onSyncToPdf,
  onCursorLine,
}: CodeEditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const onPeerJumpConsumedRef = useRef(onPeerJumpConsumed);
  onPeerJumpConsumedRef.current = onPeerJumpConsumed;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onCommentJumpConsumedRef = useRef(onCommentJumpConsumed);
  onCommentJumpConsumedRef.current = onCommentJumpConsumed;
  const onStartCommentRef = useRef(onStartComment);
  onStartCommentRef.current = onStartComment;
  const onSelectCommentRef = useRef(onSelectComment);
  onSelectCommentRef.current = onSelectComment;
  const anchorsRef = useRef<CommentAnchor[]>([]);
  const anchorsSessionRef = useRef<DocSession | null>(null);
  const highlightSyncRef = useRef<YjsCommentHighlightBinding | null>(null);
  const resolvedHighlightsRef = useRef<Array<{ threadId: number; from: number; to: number }>>([]);
  const activeCommentIdRef = useRef<number | null>(activeCommentId);
  activeCommentIdRef.current = activeCommentId;
  const onSyncToPdfRef = useRef(onSyncToPdf);
  onSyncToPdfRef.current = onSyncToPdf;
  const onCursorLineRef = useRef(onCursorLine);
  onCursorLineRef.current = onCursorLine;
  const contextTextsRef = useRef(getContextTexts);
  const bibTextsRef = useRef(getBibTexts);
  contextTextsRef.current = getContextTexts;
  bibTextsRef.current = getBibTexts;

  const [commentFab, setCommentFab] = useState<{
    top: number;
    left: number;
    start: number;
    end: number;
    quote: string;
  } | null>(null);

  const themeCompartmentRef = useRef<Compartment | null>(null);
  if (!themeCompartmentRef.current) {
    themeCompartmentRef.current = new Compartment();
  }
  const readOnlyCompartmentRef = useRef<Compartment | null>(null);
  if (!readOnlyCompartmentRef.current) {
    readOnlyCompartmentRef.current = new Compartment();
  }

  const { editorTheme } = useThemeSettings();
  const editorThemeRef = useRef<EditorThemeId>(editorTheme);
  editorThemeRef.current = editorTheme;

  const [snapshot, setSnapshot] = useState<DocSessionSnapshot>(() => session.getSnapshot());
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [wordWrap, setWordWrap] = useState(true);

  useEffect(() => {
    setSnapshot(session.getSnapshot());
    return session.subscribe(setSnapshot);
  }, [session]);

  useEffect(() => {
    const container = mountRef.current;
    const themeCompartment = themeCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    if (!container || !themeCompartment || !readOnlyCompartment) return;
    if (snapshot.errorCode === 4415 || snapshot.errorCode === 4404) {
      return;
    }

    const triggerCommentFromView = (activeView: EditorView): boolean => {
      if (!onStartCommentRef.current) return false;
      const sel = activeView.state.selection.main;
      if (sel.empty) return false;
      const clamped = clampValidSelectionRange(
        activeView.state.doc.toString(),
        sel.from,
        sel.to
      );
      if (!clamped) return false;
      onStartCommentRef.current({
        path: session.path,
        start: clamped.start,
        end: clamped.end,
        quote: clamped.quote,
      });
      return true;
    };

    const updateCommentFabFromView = (activeView: EditorView) => {
      if (!onStartCommentRef.current) {
        setCommentFab(null);
        return;
      }
      const sel = activeView.state.selection.main;
      if (sel.empty) {
        setCommentFab(null);
        return;
      }
      const clamped = clampValidSelectionRange(
        activeView.state.doc.toString(),
        sel.from,
        sel.to
      );
      if (!clamped) {
        setCommentFab(null);
        return;
      }
      const hostRect = container.getBoundingClientRect();
      const coords =
        activeView.coordsAtPos(clamped.end) ?? activeView.coordsAtPos(clamped.start);
      if (!coords || hostRect.width <= 0 || hostRect.height <= 0) {
        setCommentFab(null);
        return;
      }
      if (coords.bottom < hostRect.top || coords.top > hostRect.bottom) {
        setCommentFab(null);
        return;
      }
      const top = Math.max(8, Math.min(hostRect.height - 38, coords.bottom - hostRect.top + 6));
      const left = Math.max(8, Math.min(hostRect.width - 148, coords.left - hostRect.left));
      setCommentFab({
        top,
        left,
        start: clamped.start,
        end: clamped.end,
        quote: clamped.quote,
      });
    };

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      themeCompartment.of(getEditorThemeExtension(editorThemeRef.current)),
      readOnlyCompartment.of(getReadOnlyExtension(readOnlyRef.current)),
      undertreeBaseEditorTheme,
      peerJumpHighlightField,
      commentHighlightField,
      keymap.of([
        {
          key: "Ctrl-Alt-m",
          mac: "Cmd-Alt-m",
          run: triggerCommentFromView,
        },
        ...yUndoManagerKeymap,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      yCollab(session.ytext, session.provider.awareness, {
        undoManager: session.undoManager,
      }),
      EditorView.domEventHandlers({
        click: (ev, activeView) => {
          if (!onSelectCommentRef.current || !activeView.state.selection.main.empty) return false;
          const pos = activeView.posAtCoords({ x: ev.clientX, y: ev.clientY });
          if (pos === null) return false;
          const hitId = findCommentAtPosition(resolvedHighlightsRef.current, pos);
          if (hitId !== null) {
            onSelectCommentRef.current(hitId);
          }
          return false;
        },
        scroll: (_ev, activeView) => {
          updateCommentFabFromView(activeView);
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          setCursorPos({ line: line.number, col: head - line.from + 1 });
          onCursorLineRef.current?.(session.path, line.number);
          updateCommentFabFromView(update.view);
        }
      }),
    ];

    if (wordWrap) {
      extensions.push(EditorView.lineWrapping);
    }

    const langExtension = getLatexLanguageExtension(session.path);
    if (langExtension) {
      extensions.push(langExtension);
    }

    if (isLatexDocumentFile(session.path)) {
      extensions.push(
        latexAutocompletion({
          getContextTexts: () => contextTextsRef.current?.() ?? [],
          getBibTexts: () => bibTextsRef.current?.() ?? [],
        }),
        createLatexEmmetKeymap(),
        synctexExtension((line, column, explicit) =>
          onSyncToPdfRef.current?.(session.path, line, column, explicit)
        ),
        spellcheckExtension(session.path),
        browserSpellcheckExtension()
      );
    }

    const state = EditorState.create({
      doc: session.ytext.toString(),
      extensions,
    });

    const view = new EditorView({
      state,
      parent: container,
    });
    viewRef.current = view;
    onCursorLineRef.current?.(session.path, 1);

    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      setCommentFab(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [session, wordWrap, snapshot.errorCode]);

  // Live theme switch without remounting the editor or interrupting Yjs/cursor
  useEffect(() => {
    const view = viewRef.current;
    const themeCompartment = themeCompartmentRef.current;
    if (!view || !themeCompartment) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(getEditorThemeExtension(editorTheme)),
    });
  }, [editorTheme]);

  // Live read-only switch without remounting or dropping awareness/presence (#65)
  useEffect(() => {
    const view = viewRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    if (!view || !readOnlyCompartment) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(getReadOnlyExtension(readOnly)),
    });
  }, [readOnly]);

  // Support jumping to a 1-based line number (e.g., from LaTeX Diagnostics in #10)
  useEffect(() => {
    if (!jumpTarget || jumpTarget.path !== session.path) return;
    const view = viewRef.current;
    if (!view) return;
    const clampedLine = Math.max(1, Math.min(jumpTarget.line, view.state.doc.lines));
    const lineInfo = view.state.doc.line(clampedLine);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
    flashLine(view, lineInfo.from);
    view.focus();
  }, [jumpTarget, session.path]);

  // Support jumping to a remote peer's cursor position via topbar avatar click (#43)
  useEffect(() => {
    if (!peerJumpTarget || peerJumpTarget.path !== session.path) return;
    if (!viewRef.current) {
      if (snapshot.errorCode !== null) {
        onPeerJumpConsumedRef.current?.(peerJumpTarget.seq);
      }
      return;
    }

    const controller = new AbortController();
    void runPeerJump(session, peerJumpTarget, {
      signal: controller.signal,
      onApply: (pos) => {
        const activeView = viewRef.current;
        if (!activeView) return;

        const docLen = activeView.state.doc.length;
        const anchor = Math.max(0, Math.min(pos.anchor, docLen));
        const head = Math.max(0, Math.min(pos.head, docLen));

        activeView.dispatch({
          effects: [
            setPeerJumpHighlight.of({ anchor, head, color: pos.color }),
            EditorView.scrollIntoView(head, { y: "center" }),
          ],
        });

        if (highlightTimerRef.current !== null) {
          window.clearTimeout(highlightTimerRef.current);
        }
        highlightTimerRef.current = window.setTimeout(() => {
          highlightTimerRef.current = null;
          const currentView = viewRef.current;
          if (!currentView) return;
          currentView.dispatch({
            effects: setPeerJumpHighlight.of(null),
          });
        }, 1800);
      },
      onConsumed: (seq) => {
        onPeerJumpConsumedRef.current?.(seq);
      },
    });

    return () => {
      controller.abort();
    };
  }, [peerJumpTarget, session, snapshot.errorCode]);

  // Keep persistent Y.RelativePosition anchors per thread/session so local/remote edits are preserved (#54)
  useEffect(() => {
    if (anchorsSessionRef.current !== session) {
      anchorsRef.current = [];
      anchorsSessionRef.current = session;
    }
    const forFile = comments.filter((t) => t.path === session.path && !t.detached);
    anchorsRef.current = syncCommentAnchors(anchorsRef.current, forFile, session.ydoc);
    highlightSyncRef.current?.schedule();
  }, [comments, session, snapshot.status]);

  // Attach async Yjs highlight dispatch (via microtask) so CM6 updates never run inside yCollab's update (#54)
  useEffect(() => {
    const binding = attachYjsCommentHighlights(
      session.ydoc,
      () => anchorsRef.current,
      () => activeCommentIdRef.current,
      () => viewRef.current,
      (resolved) => {
        resolvedHighlightsRef.current = resolved;
      }
    );
    highlightSyncRef.current = binding;
    binding.schedule();
    return () => {
      binding.dispose();
      if (highlightSyncRef.current === binding) {
        highlightSyncRef.current = null;
      }
    };
  }, [session, wordWrap, snapshot.errorCode]);

  // Update active highlight styling without rebuilding Y.RelativePosition anchors (#54)
  useEffect(() => {
    activeCommentIdRef.current = activeCommentId;
    highlightSyncRef.current?.schedule();
  }, [activeCommentId]);

  // One-shot jump to a comment thread's anchored range (#54)
  useEffect(() => {
    if (!commentJumpTarget || commentJumpTarget.path !== session.path) return;
    const view = viewRef.current;
    if (!view) {
      if (snapshot.errorCode !== null) {
        onCommentJumpConsumedRef.current?.(commentJumpTarget.seq);
      }
      return;
    }

    const docLen = view.state.doc.length;
    const anchor = anchorsRef.current.find((a) => a.threadId === commentJumpTarget.threadId);
    const resolved = anchor ? resolveCommentAnchorRange(anchor, session.ydoc) : null;
    const from = resolved
      ? Math.max(0, Math.min(resolved.from, docLen))
      : Math.max(0, Math.min(commentJumpTarget.start, docLen));

    view.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
    onCommentJumpConsumedRef.current?.(commentJumpTarget.seq);
  }, [commentJumpTarget, session, snapshot.errorCode]);

  if (snapshot.errorCode === 4415) {
    if (isImageFile(session.path)) {
      return (
        <div class="image-preview">
          <div class="pane-toolbar">
            <span class="mono">{session.path}</span>
            <span class="badge badge-muted">Bildvorschau</span>
          </div>
          <div class="image-stage">
            <img src={fileApiUrl(session.path)} alt={session.path} />
          </div>
        </div>
      );
    }
    return (
      <div class="editor-error-view">
        <AlertIcon size={22} />
        <h3>Binärdatei nicht editierbar</h3>
        <p>{snapshot.errorMessage}</p>
        <a class="btn-ghost btn-sm" href={fileApiUrl(session.path)} download>
          Datei herunterladen
        </a>
      </div>
    );
  }

  if (snapshot.errorCode !== null) {
    return (
      <div class="editor-error-view">
        <AlertIcon size={22} />
        <h3>Dokument konnte nicht geöffnet werden</h3>
        <p>{snapshot.errorMessage}</p>
        {snapshot.errorCode !== 4401 && (
          <button type="button" class="btn-ghost btn-sm" onClick={() => session.retry()}>
            <RefreshIcon size={13} />
            <span>Erneut verbinden</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div class="code-editor-shell">
      <div class="editor-toolbar">
        <div class="editor-toolbar-left">
          <span class={`sync-pill sync-${snapshot.status}`}>
            <span class="ws-dot" />
            <span>{SYNC_LABELS[snapshot.status]}</span>
          </span>
          {isLatexSyntaxFile(session.path) && (
            <span class="badge badge-muted">{isBibtexFile(session.path) ? "BibTeX" : "LaTeX"}</span>
          )}
          {readOnly && (
            <span
              class="badge badge-readonly"
              role="status"
              title={roleTooltip ?? "Nur Lesen"}
            >
              Nur Lesen
            </span>
          )}
        </div>

        <div class="editor-toolbar-right">
          {snapshot.peers.length > 0 && (
            <div class="peer-list" title="Aktive Mitbearbeiter in dieser Datei">
              {snapshot.peers.map((peer) => (
                <span
                  key={peer.clientId}
                  class="peer-chip"
                  style={{
                    borderColor: peer.color,
                    backgroundColor: peer.colorLight,
                  }}
                >
                  <span class="peer-dot" style={{ backgroundColor: peer.color }} />
                  <span>{peer.name}</span>
                </span>
              ))}
            </div>
          )}

          {onSyncToPdf && isLatexDocumentFile(session.path) && (
            <button
              type="button"
              class="btn-ghost btn-xs"
              title="Cursorposition im PDF zeigen (Strg+Alt+J)"
              onClick={() => {
                const view = viewRef.current;
                if (!view) return;
                const { line, column } = cursorSyncPosition(view);
                onSyncToPdf(session.path, line, column, true);
              }}
            >
              Im PDF zeigen
            </button>
          )}

          <button
            type="button"
            class={`btn-ghost btn-xs ${wordWrap ? "is-active" : ""}`}
            onClick={() => setWordWrap((w) => !w)}
            title="Zeilenumbruch umschalten"
          >
            Wrap
          </button>
        </div>
      </div>

      <div class="cm-editor-stage">
        <div class="cm-host" ref={mountRef} />
        {commentFab && onStartComment && (
          <button
            type="button"
            class="editor-comment-fab"
            style={{ top: `${commentFab.top}px`, left: `${commentFab.left}px` }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onStartComment({
                path: session.path,
                start: commentFab.start,
                end: commentFab.end,
                quote: commentFab.quote,
              });
              setCommentFab(null);
            }}
            title="Ausgewählten Text kommentieren (Strg+Alt+M)"
          >
            <MessageSquareIcon size={13} />
            <span>Kommentieren</span>
          </button>
        )}
      </div>

      <div class="editor-statusbar">
        <span class="mono-dim">{session.path}</span>
        <div class="editor-statusbar-right">
          {!readOnly && isLatexDocumentFile(session.path) && (
            <span class="editor-statusbar-hint">Tab: Emmet · Strg+Space: Vorschläge</span>
          )}
          <span class="mono-dim">
            Ln {cursorPos.line}, Col {cursorPos.col}
          </span>
        </div>
      </div>
    </div>
  );
}
