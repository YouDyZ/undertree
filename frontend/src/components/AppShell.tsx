import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type AutoPushResponse,
  type CommentThread,
  type CompileResult,
  type GitStatus,
  type PresenceUser,
  type Project,
  type Repo,
  type RootFile,
  type ServerEvent,
  type Tree,
  type User,
  type ZoteroLink,
  deleteFile,
  errorText,
  fileApiUrl,
  getFileText,
  getGitStatus,
  getTree,
  listComments,
  listProjectRoots,
  listZoteroLinks,
  logout,
  putFile,
  triggerAutoPush,
  triggerCompile,
  updateProject,
} from "../api";
import {
  clearPeerJumpTargetForPath,
  consumePeerJumpTarget,
} from "../editor/awarenessJump";
import { syncBibCache } from "../editor/bibCache";
import { DocSession } from "../editor/docSession";
import { isBibtexFile } from "../editor/latexLanguage";
import { PdfPopoutHostBridge } from "../lib/pdfPopout";
import { ancestorDirs, usersByFile } from "../lib/presence";
import { type ChatSubscribe, useChat } from "../lib/useChat";
import {
  MEMBER_ROLE_DESCRIPTIONS,
  canCommentInProject,
  canManageProject,
  isReadOnlyRole,
} from "../lib/roles";
import {
  formatCompileError,
  loadSavedProjectRoot,
  pickProjectRoot,
  saveProjectRoot,
  viewRootToStore,
  withMainFileFirst,
} from "../lib/roots";
import { buildPdfPopoutUrl, linkClick } from "../lib/route";
import { mapMovedPath } from "../lib/move";
import { isImageFile, isTexFile } from "../lib/tree";
import {
  clearCommentJumpTargetForPath,
  consumeCommentJumpTarget,
  countOpenCommentsByFile,
  formatCommentError,
  mergeFileThreadsIntoProject,
  shouldApplyCommentsLoad,
} from "../lib/comments";
import {
  DEFAULT_REMINDER_AFTER_MS,
  hasPendingGitWork,
  reminderSummary,
  shouldRemindCommit,
} from "../lib/gitReminder";
import { shouldApplyProjectScopedResult } from "../lib/zotero";
import {
  applyTourAction,
  hasCompletedTour,
  shouldStartTourFromUrl,
} from "../tour/storage";
import type { EventsConnectionState } from "../ws/events";
import { Avatars } from "./Avatars";
import {
  CodeEditor,
  type CommentJumpTarget,
  type CommentSelectionDraft,
  type JumpTarget,
  type PeerJumpTarget,
} from "./CodeEditor";
import { ChatPanel } from "./ChatPanel";
import { CommentsPanel } from "./CommentsPanel";
import { EditorTabs, type OpenTab } from "./EditorTabs";
import { FileTree, type NotifyOptions } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { GuidedTour } from "./GuidedTour";
import {
  AlertIcon,
  GitBranchIcon,
  HelpCircleIcon,
  LogOutIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  PanelRightIcon,
  TreeLogoIcon,
} from "./Icons";
import { PdfPanel, type SyncTarget } from "./PdfPanel";
import { UserName } from "./ProfileModal";
import { ProjectSettings } from "./ProjectSettings";
import { SettingsMenu } from "./SettingsMenu";
import { ToastContainer, type ToastItem } from "./Toast";

interface AppShellProps {
  user: User;
  project: Project;
  onProjectChanged: (project: Project) => void;
  onRefreshProject?: () => void | Promise<void>;
  wsState: EventsConnectionState;
  /** online users of the project (latest `presence` event) */
  presence: PresenceUser[];
  /** reports the file in focus (null = none / window hidden) for everyone's presence */
  onFocusChange: (path: string | null) => void;
  lastEvent: ServerEvent | null;
  /** live chat messages (kept apart from `lastEvent` so none gets lost) */
  subscribeChat: ChatSubscribe;
  /** counter: bumped when chat events were missed (refetch the newest page) */
  chatResync: number;
  onLoggedOut: () => void;
}

const WS_LABELS: Record<EventsConnectionState, string> = {
  connected: "Live",
  connecting: "Verbindet…",
  reconnecting: "Reconnect…",
  disconnected: "Offline",
};

function findRepoForPath(repos: Repo[], path: string): string {
  return (
    repos
      .filter((r) => r.kind === "submodule" && (path === r.path || path.startsWith(`${r.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? ""
  );
}

export function AppShell({
  user,
  project,
  onProjectChanged,
  onRefreshProject,
  wsState,
  presence,
  onFocusChange,
  lastEvent,
  subscribeChat,
  chatResync,
  onLoggedOut,
}: AppShellProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tree, setTree] = useState<Tree | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [projectRoots, setProjectRoots] = useState<RootFile[] | null>(null);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [lastCompileResult, setLastCompileResult] = useState<CompileResult | null>(null);
  const rootsGenRef = useRef(0);
  const rootsRefreshTimerRef = useRef<number | null>(null);
  const [zoteroLinks, setZoteroLinks] = useState<ZoteroLink[]>([]);
  const [projectComments, setProjectComments] = useState<CommentThread[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentsDrawerOpen, setCommentsDrawerOpen] = useState(false);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  /** cursor line of the editor in focus, for "Stelle verlinken" in the chat */
  const cursorRef = useRef<{ path: string; line: number } | null>(null);
  const chat = useChat({
    projectId: project.id,
    username: user.username,
    connected: wsState === "connected",
    subscribe: subscribeChat,
    resync: chatResync,
    open: chatDrawerOpen,
  });
  const [commentsTab, setCommentsTab] = useState<"file" | "overview">("file");
  const [pendingCommentDraft, setPendingCommentDraft] = useState<CommentSelectionDraft | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<number | null>(null);
  const [commentJumpTarget, setCommentJumpTarget] = useState<CommentJumpTarget | null>(null);
  const commentJumpSeqRef = useRef(1);
  const allCommentsGenRef = useRef(0);
  const allCommentsRequestIdRef = useRef(0);
  const fileCommentsGenRef = useRef<Map<string, number>>(new Map());

  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  // presence shows only the file in focus: the active tab while this window is visible
  useEffect(() => {
    const report = () => onFocusChange(document.visibilityState === "visible" ? activePath : null);
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [activePath, onFocusChange]);
  const [compileRoot, setCompileRoot] = useState<string | null>(null);
  const [syncTarget, setSyncTarget] = useState<SyncTarget | null>(null);
  const syncSeqRef = useRef(1);
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null);
  const [peerJumpTarget, setPeerJumpTarget] = useState<PeerJumpTarget | null>(null);
  const jumpSeqRef = useRef(1);
  const peerJumpSeqRef = useRef(1);

  const sessionsRef = useRef<Map<string, DocSession>>(new Map());
  const bibCacheRef = useRef<Map<string, string>>(new Map());
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;
  // for the `moved` event handler, which must not re-run when these change
  const projectRef = useRef({ project, onProjectChanged });
  projectRef.current = { project, onProjectChanged };
  const zoteroLoadGenRef = useRef(0);

  const [gitDrawerOpen, setGitDrawerOpen] = useState(false);
  const [selectedGitRepo, setSelectedGitRepo] = useState<string>("");
  const [rootGitStatus, setRootGitStatus] = useState<GitStatus | null>(null);
  const [dirtySinceMs, setDirtySinceMs] = useState<number | null>(null);
  const [snoozedUntilMs, setSnoozedUntilMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissedAutoPushErr, setDismissedAutoPushErr] = useState<string | null>(null);
  const [autoPushBusy, setAutoPushBusy] = useState(false);
  const gitStatusGenRef = useRef(0);
  const gitRefreshTimerRef = useRef<number | null>(null);

  const [tourCompleted, setTourCompleted] = useState(() => hasCompletedTour());
  const [tourOpen, setTourOpen] = useState(() => shouldStartTourFromUrl(window.location.search));

  const [sidebarWidth, setSidebarWidth] = useState(270);
  const [pdfWidth, setPdfWidth] = useState(420);
  const [pdfPoppedOut, setPdfPoppedOut] = useState(false);

  const popoutBridgeRef = useRef<PdfPopoutHostBridge | null>(null);
  const popoutWindowRef = useRef<Window | null>(null);
  const jumpToLineRef = useRef<(path: string, line: number) => void>(() => {});
  const compileStateRef = useRef<{
    compileRoot: string | null;
    projectRoots: RootFile[] | null;
    activePath: string | null;
    triggering: boolean;
  }>({
    compileRoot: null,
    projectRoots: null,
    activePath: null,
    triggering: false,
  });
  compileStateRef.current.compileRoot = compileRoot;
  compileStateRef.current.projectRoots = projectRoots;
  compileStateRef.current.activePath = activePath;

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(1);

  const pushToast = useCallback(
    (kind: ToastItem["kind"], message: string, options?: NotifyOptions) => {
      const id = toastIdRef.current++;
      setToasts((prev) => [...prev, { id, kind, message, action: options?.action }]);
      const duration = options?.durationMs ?? (options?.action ? 8000 : 4500);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Ctrl/Cmd+S anywhere: no browser "save page" dialog; edits are already live, the server
  // flushes them to disk on compile. Panels (PDF) listen for `undertree:save` to recompile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("undertree:save"));
        pushToast("success", "Gespeichert");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushToast]);

  // Cleanup all Yjs WebSocket sessions and timers on unmount / logout
  useEffect(() => {
    const map = sessionsRef.current;
    return () => {
      if (rootsRefreshTimerRef.current !== null) {
        window.clearTimeout(rootsRefreshTimerRef.current);
        rootsRefreshTimerRef.current = null;
      }
      if (gitRefreshTimerRef.current !== null) {
        window.clearTimeout(gitRefreshTimerRef.current);
        gitRefreshTimerRef.current = null;
      }
      for (const session of map.values()) {
        session.destroy();
      }
      map.clear();
    };
  }, []);

  const loadRoots = useCallback(async () => {
    const gen = ++rootsGenRef.current;
    setRootsLoading(true);
    setRootsError(null);
    try {
      const nextRoots = await listProjectRoots();
      if (gen !== rootsGenRef.current) return;
      setProjectRoots(nextRoots);
      setRootsError(null);
    } catch (err: unknown) {
      if (gen !== rootsGenRef.current) return;
      setRootsError(errorText(err, "LaTeX-Roots konnten nicht geladen werden."));
    } finally {
      if (gen === rootsGenRef.current) {
        setRootsLoading(false);
      }
    }
  }, []);

  const scheduleRootsRefresh = useCallback(() => {
    if (rootsRefreshTimerRef.current !== null) {
      window.clearTimeout(rootsRefreshTimerRef.current);
    }
    // Wait slightly longer than the server's 1000ms CRDT disk-flush debounce (#49)
    rootsRefreshTimerRef.current = window.setTimeout(() => {
      rootsRefreshTimerRef.current = null;
      void loadRoots();
      popoutBridgeRef.current?.notifyRootsChanged();
    }, 1400);
  }, [loadRoots]);

  const onRefreshProjectRef = useRef(onRefreshProject);
  onRefreshProjectRef.current = onRefreshProject;

  const scheduleGitStatusRef = useRef<() => void>(() => {});

  const ensureDocSession = useCallback(
    (path: string, repo: string): DocSession => {
      const existing = sessionsRef.current.get(path);
      if (existing) return existing;
      const session = new DocSession({
        path,
        repo,
        user,
        onUnauthorized: onLoggedOut,
        onRoleChanged: () => {
          void onRefreshProjectRef.current?.();
        },
      });
      session.ydoc.on("update", () => {
        if (session.provider.synced) {
          if (isTexFile(path)) scheduleRootsRefresh();
          scheduleGitStatusRef.current();
        }
      });
      sessionsRef.current.set(path, session);
      return session;
    },
    [user, onLoggedOut, scheduleRootsRefresh]
  );

  const openFile = useCallback(
    (path: string, repo?: string) => {
      const resolvedRepo = repo ?? findRepoForPath(tree?.repos ?? [], path);
      const kind: OpenTab["kind"] = isImageFile(path) ? "image" : "doc";
      if (kind === "doc") {
        ensureDocSession(path, resolvedRepo);
      }
      setOpenTabs((prev) => {
        if (prev.some((t) => t.path === path)) return prev;
        return [...prev, { path, repo: resolvedRepo, kind }];
      });
      setActivePath(path);
    },
    [tree, ensureDocSession]
  );

  const closeTab = useCallback((path: string) => {
    setPeerJumpTarget((prev) => clearPeerJumpTargetForPath(prev, path));
    setCommentJumpTarget((prev) => clearCommentJumpTargetForPath(prev, path));
    const session = sessionsRef.current.get(path);
    if (session) {
      session.destroy();
      sessionsRef.current.delete(path);
    }
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.path !== path);
      setActivePath((current) => {
        if (current !== path) return current;
        if (next.length === 0) return null;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback ? fallback.path : null;
      });
      return next;
    });
  }, []);

  // Ready for Issue #10 (Diagnostics click -> open file + jump to 1-based line)
  const jumpToLine = useCallback(
    (path: string, line: number) => {
      openFile(path);
      setJumpTarget({ path, line, seq: jumpSeqRef.current++ });
    },
    [openFile]
  );
  jumpToLineRef.current = jumpToLine;

  // SyncTeX source -> PDF (#52): docked panel reacts to `syncTarget`, a popout via the bridge
  const handleSyncToPdf = useCallback(
    (file: string, line: number, column: number, explicit: boolean) => {
      if (pdfPoppedOut) {
        popoutBridgeRef.current?.notifySyncToPdf(file, line, column, explicit);
      } else {
        setSyncTarget({ file, line, column, explicit, seq: syncSeqRef.current++ });
      }
    },
    [pdfPoppedOut]
  );

  const handleSelectPresenceUser = useCallback(
    (target: PresenceUser) => {
      if (!target.file) return;
      openFile(target.file);
      if (target.username !== user.username) {
        setPeerJumpTarget({
          path: target.file,
          username: target.username,
          seq: peerJumpSeqRef.current++,
        });
      }
    },
    [openFile, user.username]
  );

  const handlePeerJumpConsumed = useCallback((seq: number) => {
    setPeerJumpTarget((prev) => consumePeerJumpTarget(prev, seq));
  }, []);

  const handleCommentJumpConsumed = useCallback((seq: number) => {
    setCommentJumpTarget((prev) => consumeCommentJumpTarget(prev, seq));
  }, []);

  // Coordinate detached PDF preview window per project via BroadcastChannel (#47)
  useEffect(() => {
    const bridge = new PdfPopoutHostBridge(project.id, {
      onPoppedOutChange: (poppedOut) => {
        setPdfPoppedOut(poppedOut);
        if (!poppedOut) {
          popoutWindowRef.current = null;
        }
      },
      onRootChange: (root) => {
        setCompileRoot(root);
      },
      onJumpToLine: (file, line) => {
        jumpToLineRef.current(file, line);
        window.focus();
      },
    });
    popoutBridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      popoutBridgeRef.current = null;
    };
  }, [project.id]);

  // Fallback check in case the popout window closes without firing beforeunload,
  // and compile via Ctrl/Cmd+S while the inline PdfPanel is unmounted (#47).
  useEffect(() => {
    if (!pdfPoppedOut) return;

    const timer = window.setInterval(() => {
      if (popoutWindowRef.current?.closed) {
        popoutWindowRef.current = null;
        popoutBridgeRef.current?.forceCloseTrackedPopouts();
      }
    }, 1000);

    const onSave = () => {
      const state = compileStateRef.current;
      const targetRoot =
        state.activePath && isTexFile(state.activePath)
          ? state.activePath
          : state.compileRoot ??
            pickProjectRoot(
              state.projectRoots ?? [],
              loadSavedProjectRoot(project.id),
              null,
              project.main_files
            );
      if (!targetRoot || state.triggering) return;
      state.triggering = true;
      void triggerCompile(targetRoot)
        .then((res) => {
          setCompileRoot(res.root);
          saveProjectRoot(project.id, viewRootToStore(res.root, project.main_files));
          void loadRoots();
          popoutBridgeRef.current?.notifyRootsChanged();
        })
        .catch((err: unknown) => {
          pushToast("error", formatCompileError(err));
        })
        .finally(() => {
          compileStateRef.current.triggering = false;
        });
    };
    window.addEventListener("undertree:save", onSave);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("undertree:save", onSave);
    };
  }, [pdfPoppedOut, project.id, project.main_files, pushToast]);

  const readOnly = isReadOnlyRole(project.my_role);
  const canComment = canCommentInProject(project.my_role);
  const roleTooltip = MEMBER_ROLE_DESCRIPTIONS[project.my_role];

  const loadRootGitStatus = useCallback(async () => {
    if (readOnly) {
      setRootGitStatus(null);
      setDirtySinceMs(null);
      return;
    }
    const targetPid = project.id;
    const gen = ++gitStatusGenRef.current;
    try {
      const next = await getGitStatus("");
      if (gen !== gitStatusGenRef.current || projectIdRef.current !== targetPid) return;
      setRootGitStatus(next);
      setDirtySinceMs((prev) => (hasPendingGitWork(next) ? (prev ?? Date.now()) : null));
    } catch {
      // ignore transient background status errors
    }
  }, [project.id, readOnly]);

  const scheduleGitStatusRefresh = useCallback(() => {
    if (readOnly) return;
    if (gitRefreshTimerRef.current !== null) {
      window.clearTimeout(gitRefreshTimerRef.current);
    }
    gitRefreshTimerRef.current = window.setTimeout(() => {
      gitRefreshTimerRef.current = null;
      void loadRootGitStatus();
    }, 1500);
  }, [loadRootGitStatus, readOnly]);
  scheduleGitStatusRef.current = scheduleGitStatusRefresh;

  useEffect(() => {
    setDirtySinceMs(null);
    setSnoozedUntilMs(null);
    setDismissedAutoPushErr(null);
    void loadRootGitStatus();
  }, [project.id, loadRootGitStatus]);

  useEffect(() => {
    if (readOnly) return;
    const tickId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    const pollId = window.setInterval(() => void loadRootGitStatus(), 60_000);
    return () => {
      window.clearInterval(tickId);
      window.clearInterval(pollId);
    };
  }, [loadRootGitStatus, readOnly]);

  useEffect(() => {
    if (!canComment) {
      setPendingCommentDraft(null);
    }
  }, [canComment]);

  // same permission as the settings dialog (the server answers 403 otherwise)
  const canSetMainFile = canManageProject(project.my_role);
  const setMainFile = useCallback(
    async (root: string) => {
      onProjectChanged(
        await updateProject(project.id, {
          main_files: withMainFileFirst(project.main_files, root),
        })
      );
    },
    [project.id, project.main_files, onProjectChanged]
  );

  const handlePopoutPdf = useCallback(() => {
    const url = buildPdfPopoutUrl(project.id, compileRoot);
    const win = window.open(url, `undertree-pdf-${project.id}`, "popup=yes,width=960,height=1040");
    if (!win || win.closed) {
      pushToast(
        "error",
        "Popout-Fenster wurde vom Browser blockiert — bitte Pop-ups für diese Seite erlauben."
      );
      return;
    }
    popoutWindowRef.current = win;
    win.focus();
  }, [project.id, compileRoot, pushToast]);

  const handleDockPdf = useCallback(() => {
    popoutBridgeRef.current?.requestDock();
    try {
      popoutWindowRef.current?.close();
    } catch {
      // Ignore cross-window close errors
    }
    popoutWindowRef.current = null;
  }, []);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const nextTree = await getTree();
      setTree(nextTree);
    } catch (err: unknown) {
      setTreeError(err instanceof Error ? err.message : "Dateibaum konnte nicht geladen werden.");
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadZoteroLinks = useCallback(async () => {
    const targetProjectId = project.id;
    const gen = ++zoteroLoadGenRef.current;
    try {
      const links = await listZoteroLinks(targetProjectId);
      if (
        !shouldApplyProjectScopedResult(
          targetProjectId,
          projectIdRef.current,
          gen,
          zoteroLoadGenRef.current
        )
      ) {
        return;
      }
      setZoteroLinks(links);
    } catch {
      // Non-blocking: tree still renders without Zotero link badges
    }
  }, [project.id]);

  const loadAllComments = useCallback(async () => {
    const targetProjectId = project.id;
    const gen = ++allCommentsGenRef.current;
    const reqId = ++allCommentsRequestIdRef.current;
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      const list = await listComments(undefined, targetProjectId);
      if (
        !shouldApplyCommentsLoad(
          targetProjectId,
          projectIdRef.current,
          gen,
          allCommentsGenRef.current
        )
      ) {
        return;
      }
      setProjectComments(list);
      setCommentsError(null);
    } catch (err: unknown) {
      if (
        !shouldApplyCommentsLoad(
          targetProjectId,
          projectIdRef.current,
          gen,
          allCommentsGenRef.current
        )
      ) {
        return;
      }
      setCommentsError(formatCommentError(err, "Kommentare konnten nicht geladen werden."));
    } finally {
      if (
        shouldApplyCommentsLoad(
          targetProjectId,
          projectIdRef.current,
          reqId,
          allCommentsRequestIdRef.current
        )
      ) {
        setCommentsLoading(false);
      }
    }
  }, [project.id]);

  const loadFileComments = useCallback(
    async (path: string) => {
      const targetProjectId = project.id;
      // Invalidate any earlier full-project fetch so it cannot overwrite newer per-file threads
      allCommentsGenRef.current += 1;
      const fileGen = (fileCommentsGenRef.current.get(path) ?? 0) + 1;
      fileCommentsGenRef.current.set(path, fileGen);
      try {
        const list = await listComments(path, targetProjectId);
        if (
          !shouldApplyCommentsLoad(
            targetProjectId,
            projectIdRef.current,
            fileGen,
            fileCommentsGenRef.current.get(path) ?? 0
          )
        ) {
          return;
        }
        setProjectComments((prev) => mergeFileThreadsIntoProject(prev, path, list));
      } catch (err: unknown) {
        if (
          !shouldApplyCommentsLoad(
            targetProjectId,
            projectIdRef.current,
            fileGen,
            fileCommentsGenRef.current.get(path) ?? 0
          )
        ) {
          return;
        }
        setCommentsError(formatCommentError(err, "Kommentare konnten nicht aktualisiert werden."));
      }
    },
    [project.id]
  );

  useEffect(() => {
    setZoteroLinks([]);
    setProjectComments([]);
    setCommentsError(null);
    setPendingCommentDraft(null);
    setActiveCommentId(null);
    setCommentJumpTarget(null);
    allCommentsRequestIdRef.current += 1;
    setCommentsLoading(false);
    fileCommentsGenRef.current.clear();
    void loadTree();
    void loadRoots();
    void loadZoteroLinks();
    void loadAllComments();
    return () => {
      zoteroLoadGenRef.current += 1;
      allCommentsGenRef.current += 1;
    };
  }, [loadTree, loadRoots, loadZoteroLinks, loadAllComments, project.id]);

  // Background-cache all .bib files from the workspace tree for \cite{} autocompletion
  useEffect(() => {
    if (!tree) return;
    let cancelled = false;
    void syncBibCache(tree.entries, bibCacheRef.current, getFileText, {
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [tree]);

  const getContextTexts = useCallback((): string[] => {
    const texts: string[] = [];
    for (const session of sessionsRef.current.values()) {
      texts.push(session.ytext.toString());
    }
    return texts;
  }, []);

  const getBibTexts = useCallback((): string[] => {
    const merged = new Map<string, string>(bibCacheRef.current);
    for (const [path, session] of sessionsRef.current.entries()) {
      if (isBibtexFile(path)) {
        merged.set(path, session.ytext.toString());
      }
    }
    return Array.from(merged.values());
  }, []);

  // React to server events from /ws/events
  useEffect(() => {
    if (!lastEvent) return;
    switch (lastEvent.type) {
      case "tree_changed":
        void loadTree();
        void loadRoots();
        void loadZoteroLinks();
        void loadAllComments();
        void loadRootGitStatus();
        break;
      case "git_changed":
        void loadRootGitStatus();
        void onRefreshProjectRef.current?.();
        break;
      case "doc_reloaded":
        pushToast("info", `Extern aktualisiert: ${lastEvent.path}`);
        void loadRootGitStatus();
        if (isBibtexFile(lastEvent.path)) {
          void getFileText(lastEvent.path)
            .then((text) => {
              bibCacheRef.current.set(lastEvent.path, text);
            })
            .catch(() => {});
        }
        if (isTexFile(lastEvent.path)) {
          void loadRoots();
        }
        break;
      case "compile":
        if ("result" in lastEvent) {
          setLastCompileResult(lastEvent.result);
          void loadRoots();
        }
        break;
      case "comments":
        void loadFileComments(lastEvent.path);
        break;
      case "doc_deleted":
        pushToast("info", `Datei gelöscht: ${lastEvent.path}`);
        bibCacheRef.current.delete(lastEvent.path);
        setPendingCommentDraft((prev) => (prev?.path === lastEvent.path ? null : prev));
        closeTab(lastEvent.path);
        void loadZoteroLinks();
        void loadAllComments();
        break;
      case "moved": {
        // open tabs follow a rename/move: drop the old doc sessions, the editor opens the new path
        // (from === to: the move failed after the server closed the docs, reconnect in place)
        const { from, to } = lastEvent;
        const affected = (p: string) => p === from || p.startsWith(`${from}/`);
        for (const path of Array.from(sessionsRef.current.keys())) {
          if (!affected(path)) continue;
          sessionsRef.current.get(path)?.destroy();
          sessionsRef.current.delete(path);
        }
        for (const path of Array.from(bibCacheRef.current.keys())) {
          if (affected(path)) bibCacheRef.current.delete(path);
        }
        setOpenTabs((prev) => prev.map((t) => ({ ...t, path: mapMovedPath(t.path, from, to) })));
        setActivePath((cur) => (cur === null ? cur : mapMovedPath(cur, from, to)));
        setCompileRoot((cur) => (cur === null ? cur : mapMovedPath(cur, from, to)));
        {
          const { project: proj, onProjectChanged: changed } = projectRef.current;
          const mains = proj.main_files.map((m) => mapMovedPath(m, from, to));
          if (mains.some((m, i) => m !== proj.main_files[i])) {
            changed({ ...proj, main_files: mains });
          }
          const saved = loadSavedProjectRoot(proj.id);
          const mapped = saved === null ? null : mapMovedPath(saved, from, to);
          if (saved !== null && mapped !== saved) saveProjectRoot(proj.id, mapped);
        }
        void loadZoteroLinks();
        break;
      }
      default:
        break;
    }
  }, [
    lastEvent,
    loadTree,
    loadRoots,
    loadZoteroLinks,
    loadAllComments,
    loadFileComments,
    loadRootGitStatus,
    pushToast,
    closeTab,
  ]);

  const activeTab = useMemo(
    () => openTabs.find((t) => t.path === activePath) ?? null,
    [openTabs, activePath]
  );

  const activeSession = useMemo(() => {
    if (!activeTab || activeTab.kind !== "doc") return null;
    return ensureDocSession(activeTab.path, activeTab.repo);
  }, [activeTab, ensureDocSession]);

  // the tree doesn't show yourself next to the file you're looking at
  const presenceByFile = useMemo(
    () => usersByFile(presence, { username: user.username, path: activePath }),
    [presence, user.username, activePath]
  );
  const presenceDirs = useMemo(() => ancestorDirs(presenceByFile.keys()), [presenceByFile]);

  const activeRepoObj: Repo | undefined = useMemo(() => {
    if (!tree) return undefined;
    const repoPath = activeTab?.repo ?? "";
    return tree.repos.find((r) => r.path === repoPath);
  }, [tree, activeTab]);

  const rootPaths = useMemo(
    () => new Set((projectRoots ?? []).map((r) => r.path)),
    [projectRoots]
  );

  const openCommentsByFile = useMemo(
    () => countOpenCommentsByFile(projectComments),
    [projectComments]
  );

  const openCommentsTotal = useMemo(() => {
    let total = 0;
    for (const count of openCommentsByFile.values()) {
      total += count;
    }
    return total;
  }, [openCommentsByFile]);

  const activeFileComments = useMemo(
    () => (activePath ? projectComments.filter((t) => t.path === activePath) : []),
    [projectComments, activePath]
  );

  const refreshWorkspace = useCallback(async () => {
    await Promise.all([loadTree(), loadRoots()]);
  }, [loadTree, loadRoots]);

  const handleCreateFile = async (path: string) => {
    if (readOnly) return;
    await putFile(path, "");
    await refreshWorkspace();
    openFile(path);
    pushToast("success", `Datei erstellt: ${path}`);
  };

  const handleDeleteFile = async (path: string) => {
    if (readOnly) return;
    try {
      await deleteFile(path);
      closeTab(path);
      await refreshWorkspace();
      pushToast("info", `Datei gelöscht: ${path}`);
    } catch (err: unknown) {
      pushToast(
        "error",
        err instanceof Error ? err.message : `Löschen fehlgeschlagen: ${path}`
      );
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err: unknown) {
      if (!(err instanceof ApiError && err.status === 401)) {
        const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
        pushToast("error", `Abmelden fehlgeschlagen (${msg}) — Sitzung ist weiterhin aktiv.`);
        return;
      }
    }
    for (const session of sessionsRef.current.values()) {
      session.destroy();
    }
    sessionsRef.current.clear();
    onLoggedOut();
  };

  const handleOpenGitForRepo = (repoPath: string) => {
    setSelectedGitRepo(repoPath);
    setCommentsDrawerOpen(false);
    setChatDrawerOpen(false);
    setGitDrawerOpen(true);
  };

  const handleToggleCommentsDrawer = () => {
    setCommentsDrawerOpen((open) => {
      const next = !open;
      if (next) {
        setGitDrawerOpen(false);
        setChatDrawerOpen(false);
        setCommentsTab(activePath ? "file" : "overview");
      }
      return next;
    });
  };

  const handleToggleChatDrawer = () => {
    setChatDrawerOpen((open) => {
      if (!open) {
        setGitDrawerOpen(false);
        setCommentsDrawerOpen(false);
      }
      return !open;
    });
  };

  const handleCursorLine = useCallback((path: string, line: number) => {
    cursorRef.current = { path, line };
  }, []);

  const getChatLocation = useCallback(() => {
    if (!activePath) return null;
    const cur = cursorRef.current;
    return { file: activePath, line: cur?.path === activePath ? cur.line : 1 };
  }, [activePath]);

  const handleStartComment = useCallback((draft: CommentSelectionDraft) => {
    setPendingCommentDraft(draft);
    setActiveCommentId(null);
    setGitDrawerOpen(false);
    setChatDrawerOpen(false);
    setCommentsTab("file");
    setCommentsDrawerOpen(true);
  }, []);

  const handleSelectCommentFromEditor = useCallback((threadId: number) => {
    setPendingCommentDraft(null);
    setActiveCommentId(threadId);
    setGitDrawerOpen(false);
    setChatDrawerOpen(false);
    setCommentsTab("file");
    setCommentsDrawerOpen(true);
  }, []);

  const handleJumpToComment = useCallback(
    (thread: CommentThread) => {
      openFile(thread.path);
      setActiveCommentId(thread.id);
      if (!thread.detached) {
        setCommentJumpTarget({
          path: thread.path,
          threadId: thread.id,
          start: thread.start,
          end: thread.end,
          seq: commentJumpSeqRef.current++,
        });
      }
    },
    [openFile]
  );

  const handleCommentThreadCreated = useCallback((thread: CommentThread) => {
    setProjectComments((prev) => mergeFileThreadsIntoProject(prev, thread.path, [
      ...prev.filter((t) => t.path === thread.path && t.id !== thread.id),
      thread,
    ]));
  }, []);

  const handleCommentThreadUpdated = useCallback((thread: CommentThread) => {
    setProjectComments((prev) => mergeFileThreadsIntoProject(prev, thread.path, [
      ...prev.filter((t) => t.path === thread.path && t.id !== thread.id),
      thread,
    ]));
  }, []);

  const handleCommentThreadDeleted = useCallback((threadId: number, path: string) => {
    setProjectComments((prev) =>
      prev.filter((t) => !(t.id === threadId && t.path === path))
    );
    setActiveCommentId((prev) => (prev === threadId ? null : prev));
  }, []);

  const startResize = (side: "left" | "right", startEvent: MouseEvent) => {
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const initial = side === "left" ? sidebarWidth : pdfWidth;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      if (side === "left") {
        setSidebarWidth(Math.max(200, Math.min(480, initial + delta)));
      } else {
        setPdfWidth(Math.max(260, Math.min(760, initial - delta)));
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const finishTour = useCallback(() => {
    const next = applyTourAction({ open: true, completed: tourCompleted }, "finish");
    setTourCompleted(next.completed);
    setTourOpen(next.open);
  }, [tourCompleted]);

  const dismissTour = useCallback(() => {
    const next = applyTourAction({ open: true, completed: tourCompleted }, "dismiss");
    setTourCompleted(next.completed);
    setTourOpen(next.open);
  }, [tourCompleted]);

  const applyAutoPushResult = useCallback(
    (res: AutoPushResponse) => {
      const cur = projectRef.current;
      cur.onProjectChanged({
        ...cur.project,
        auto_push_last_at: res.auto_push_last_at,
        auto_push_last_error: res.auto_push_last_error,
      });
      setDismissedAutoPushErr(null);
      if (res.pushed) {
        setDirtySinceMs(null);
      }
      void loadRootGitStatus();
    },
    [loadRootGitStatus]
  );

  const handleBannerAutoPush = useCallback(async () => {
    if (autoPushBusy || readOnly) return;
    setAutoPushBusy(true);
    try {
      const res = await triggerAutoPush(project.id);
      applyAutoPushResult(res);
      pushToast(
        "success",
        res.pushed ? "Auto-Push erfolgreich." : "Keine Änderungen zum Pushen."
      );
    } catch (err: unknown) {
      pushToast("error", errorText(err, "Auto-Push fehlgeschlagen."));
      void onRefreshProjectRef.current?.();
      void loadRootGitStatus();
    } finally {
      setAutoPushBusy(false);
    }
  }, [autoPushBusy, readOnly, project.id, applyAutoPushResult, pushToast, loadRootGitStatus]);

  const hasAutoPushError = Boolean(project.auto_push_last_error);
  const showAutoPushErrorBanner =
    !readOnly && hasAutoPushError && dismissedAutoPushErr !== project.auto_push_last_error;
  const showCommitReminderBanner =
    !readOnly &&
    !showAutoPushErrorBanner &&
    shouldRemindCommit(dirtySinceMs, nowMs, snoozedUntilMs, project.auto_push_interval_secs);
  const pendingGit = !readOnly && (hasAutoPushError || hasPendingGitWork(rootGitStatus));

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-left">
          <a href="/" class="brand-mark brand-link" title="Zur Projektliste" onClick={linkClick}>
            <TreeLogoIcon size={18} />
            <span class="brand-name">undertree</span>
          </a>
          <nav class="topbar-project" aria-label="Projekt">
            <a href="/" onClick={linkClick}>
              Projekte
            </a>
            <span class="muted-text">/</span>
            <strong title={project.remote_url}>{project.name}</strong>
          </nav>
          {activeTab && (
            <div class="topbar-crumb">
              <span
                class={`badge ${
                  activeRepoObj?.kind === "submodule" ? "badge-submodule" : "badge-parent"
                }`}
              >
                {activeRepoObj?.kind === "submodule" ? activeRepoObj.name : "ROOT"}
              </span>
              <span class="crumb-path">{activeTab.path}</span>
            </div>
          )}
        </div>

        <div class="topbar-right">
          {presence.length > 0 && (
            <div class="topbar-presence" role="group" aria-label="Online im Projekt">
              <Avatars
                users={presence}
                self={user.username}
                max={5}
                onSelectUser={handleSelectPresenceUser}
              />
            </div>
          )}

          <span
            class={`ws-pill ws-${wsState}`}
            data-tour="live-status"
            title={`Event-Stream: ${wsState}`}
          >
            <span class="ws-dot" />
            <span>{WS_LABELS[wsState]}</span>
          </span>

          {pdfPoppedOut && (
            <button
              type="button"
              class="btn-ghost btn-sm"
              title="Abgedockte PDF-Vorschau wieder einbetten"
              onClick={handleDockPdf}
            >
              <PanelRightIcon size={14} />
              <span>PDF andocken</span>
            </button>
          )}

          <button
            type="button"
            class={`btn-ghost btn-sm ${commentsDrawerOpen ? "is-active" : ""}`}
            onClick={handleToggleCommentsDrawer}
            title={
              canComment
                ? "Kommentare & Projekt-Übersicht anzeigen (Strg+Alt+M bei Auswahl)"
                : "Kommentare & Projekt-Übersicht anzeigen"
            }
          >
            <MessageSquareIcon size={14} />
            <span>Kommentare</span>
            {openCommentsTotal > 0 && <span class="badge badge-comments">{openCommentsTotal}</span>}
          </button>

          <button
            type="button"
            class={`btn-ghost btn-sm ${chatDrawerOpen ? "is-active" : ""}`}
            onClick={handleToggleChatDrawer}
            title="Projekt-Chat"
          >
            <MessageCircleIcon size={14} />
            <span>Chat</span>
            {chat.unread.count > 0 && (
              <span
                class={`badge badge-chat ${chat.unread.mentioned ? "is-mention" : ""}`}
                title={chat.unread.mentioned ? "Du wurdest erwähnt" : undefined}
              >
                {chat.unread.mentioned ? "@" : ""}
                {chat.unread.count}
              </span>
            )}
          </button>

          <button
            type="button"
            class={`btn-ghost btn-sm ${gitDrawerOpen ? "is-active" : ""}`}
            data-tour="git-button"
            onClick={() => {
              setGitDrawerOpen((v) => {
                const next = !v;
                if (next) {
                  setCommentsDrawerOpen(false);
                  setChatDrawerOpen(false);
                }
                return next;
              });
            }}
          >
            <GitBranchIcon size={14} />
            <span>Git</span>
            {pendingGit && (
              <span
                class={`git-status-dot${hasAutoPushError ? " is-error" : ""}`}
                aria-hidden="true"
              />
            )}
          </button>

          <button
            type="button"
            class={`btn-ghost btn-sm tour-trigger-btn ${tourOpen ? "is-active" : ""}`}
            title="Interaktive Einführungstour starten"
            onClick={() => setTourOpen(true)}
          >
            <HelpCircleIcon size={14} />
            <span>Tour</span>
            {!tourCompleted && <span class="tour-unseen-dot" aria-hidden="true" />}
          </button>

          <button
            type="button"
            class={`btn-ghost btn-sm ${settingsOpen ? "is-active" : ""}`}
            onClick={() => setSettingsOpen(true)}
          >
            Projekt-Einstellungen
          </button>

          <div class="user-chip" title={user.email ?? user.username}>
            <UserName user={user} />
            {user.is_admin && (
              <a href="/admin" class="badge badge-admin" title="Benutzerverwaltung" onClick={linkClick}>
                Admin
              </a>
            )}
          </div>

          <SettingsMenu />

          <button
            type="button"
            class="icon-btn"
            title="Abmelden"
            aria-label="Abmelden"
            onClick={() => void handleLogout()}
          >
            <LogOutIcon size={15} />
          </button>
        </div>
      </header>

      {(showAutoPushErrorBanner || showCommitReminderBanner) && (
        <div
          class={`git-reminder-banner${showAutoPushErrorBanner ? " is-error" : ""}`}
          role={showAutoPushErrorBanner ? "alert" : "status"}
        >
          <span class="git-reminder-text">
            <AlertIcon size={15} />
            <span>
              {showAutoPushErrorBanner
                ? `Auto-Push-Fehler: ${project.auto_push_last_error}`
                : `${reminderSummary(rootGitStatus) || "Ungespeicherte Git-Änderungen"} — noch nicht gepusht.`}
            </span>
          </span>
          <div class="git-reminder-actions">
            <button
              type="button"
              class="btn-primary btn-xs"
              disabled={autoPushBusy}
              onClick={() => void handleBannerAutoPush()}
            >
              {autoPushBusy ? "Pushe…" : "Auto-Push jetzt"}
            </button>
            <button
              type="button"
              class="btn-ghost btn-xs"
              onClick={() => {
                setSelectedGitRepo("");
                setGitDrawerOpen(true);
              }}
            >
              Git öffnen
            </button>
            <button
              type="button"
              class="btn-ghost btn-xs"
              onClick={() => {
                if (showAutoPushErrorBanner) {
                  setDismissedAutoPushErr(project.auto_push_last_error);
                } else {
                  setSnoozedUntilMs(Date.now() + DEFAULT_REMINDER_AFTER_MS);
                }
              }}
            >
              {showAutoPushErrorBanner ? "Ausblenden" : "Später (15 Min)"}
            </button>
          </div>
        </div>
      )}

      <div class="workspace-body">
        <div class="pane-sidebar" data-tour="file-tree" style={{ width: `${sidebarWidth}px` }}>
          <FileTree
            tree={tree}
            loading={treeLoading}
            error={treeError}
            selectedPath={activePath}
            self={user.username}
            presenceByFile={presenceByFile}
            presenceDirs={presenceDirs}
            rootPaths={rootPaths}
            compileRoot={compileRoot}
            zoteroLinks={zoteroLinks}
            readOnly={readOnly}
            openCommentsByFile={openCommentsByFile}
            onSelectFile={(path, repo) => openFile(path, repo)}
            onRefresh={refreshWorkspace}
            onZoteroChanged={loadZoteroLinks}
            onCreateFile={handleCreateFile}
            onDeleteFile={handleDeleteFile}
            onOpenGitForRepo={handleOpenGitForRepo}
            onNotify={pushToast}
          />
        </div>

        <div
          class="split-handle"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(e) => startResize("left", e)}
        />

        <main class="pane-editor" data-tour="editor-pane">
          <EditorTabs
            tabs={openTabs}
            activePath={activePath}
            onSelect={setActivePath}
            onClose={closeTab}
          />

          {!activeTab ? (
            <div class="placeholder-card">
              <h2>Kollaborativer LaTeX-Editor</h2>
              <p>
                Wähle links eine Datei aus dem Parent-Repo oder einem Submodul aus, um gemeinsam in
                Echtzeit zu editieren.
              </p>
            </div>
          ) : activeTab.kind === "image" ? (
            <div class="image-preview">
              <div class="pane-toolbar">
                <span class="mono">{activeTab.path}</span>
                <span class="badge badge-muted">Bildvorschau</span>
              </div>
              <div class="image-stage">
                <img src={fileApiUrl(activeTab.path)} alt={activeTab.path} />
              </div>
            </div>
          ) : activeSession ? (
            <CodeEditor
              key={activeSession.path}
              session={activeSession}
              jumpTarget={jumpTarget}
              peerJumpTarget={peerJumpTarget}
              onPeerJumpConsumed={handlePeerJumpConsumed}
              readOnly={readOnly}
              roleTooltip={roleTooltip}
              comments={activeFileComments}
              activeCommentId={activeCommentId}
              commentJumpTarget={commentJumpTarget}
              onCommentJumpConsumed={handleCommentJumpConsumed}
              onStartComment={canComment ? handleStartComment : undefined}
              onSelectComment={handleSelectCommentFromEditor}
              getContextTexts={getContextTexts}
              getBibTexts={getBibTexts}
              onSyncToPdf={handleSyncToPdf}
              onCursorLine={handleCursorLine}
            />
          ) : null}
        </main>

        {!pdfPoppedOut && (
          <>
            <div
              class="split-handle"
              role="separator"
              aria-orientation="vertical"
              onMouseDown={(e) => startResize("right", e)}
            />

            <section class="pane-pdf" data-tour="pdf-pane" style={{ width: `${pdfWidth}px` }}>
              <PdfPanel
                projectId={project.id}
                tree={tree}
                projectRoots={projectRoots}
                rootsLoading={rootsLoading}
                rootsError={rootsError}
                onRetryRoots={loadRoots}
                onAfterCompileQueued={() => {
                  void loadRoots();
                  popoutBridgeRef.current?.notifyRootsChanged();
                }}
                compilerMode={project.compiler}
                mainFiles={project.main_files}
                onSetMainFile={canSetMainFile ? setMainFile : undefined}
                activePath={activePath}
                lastEvent={lastEvent}
                onJumpToLine={jumpToLine}
                syncTarget={syncTarget}
                onNotify={pushToast}
                onSelectedRootChange={setCompileRoot}
                onPopout={handlePopoutPdf}
              />
            </section>
          </>
        )}

        {commentsDrawerOpen && (
          <CommentsPanel
            projectId={project.id}
            user={user}
            canComment={canComment}
            isProjectOwner={canSetMainFile}
            activePath={activePath}
            activeSession={activeSession}
            threads={projectComments}
            loading={commentsLoading}
            error={commentsError}
            pendingDraft={canComment ? pendingCommentDraft : null}
            activeThreadId={activeCommentId}
            tab={commentsTab}
            onTabChange={setCommentsTab}
            onCancelDraft={() => setPendingCommentDraft(null)}
            onSelectThread={setActiveCommentId}
            onJumpToThread={handleJumpToComment}
            onThreadCreated={handleCommentThreadCreated}
            onThreadUpdated={handleCommentThreadUpdated}
            onThreadDeleted={handleCommentThreadDeleted}
            onReload={loadAllComments}
            onNotify={pushToast}
            onClose={() => setCommentsDrawerOpen(false)}
          />
        )}

        {chatDrawerOpen && (
          <ChatPanel
            projectId={project.id}
            user={user}
            canWrite={canComment}
            messages={chat.messages}
            hasMore={chat.hasMore}
            loading={chat.loading}
            error={chat.error}
            onLoadOlder={() => void chat.loadOlder()}
            onUpsert={chat.upsert}
            getLocation={getChatLocation}
            onJumpToLine={jumpToLine}
            onNotify={pushToast}
            onClose={() => setChatDrawerOpen(false)}
          />
        )}

        {gitDrawerOpen && (
          <GitPanel
            repos={tree?.repos ?? []}
            selectedRepo={selectedGitRepo}
            readOnly={readOnly}
            autoPushIntervalSecs={project.auto_push_interval_secs}
            autoPushLastAt={project.auto_push_last_at}
            autoPushLastError={project.auto_push_last_error}
            onSelectRepo={setSelectedGitRepo}
            lastEvent={lastEvent}
            onClose={() => setGitDrawerOpen(false)}
            onNotify={pushToast}
            onTreeRefresh={() => {
              void refreshWorkspace();
              void loadRootGitStatus();
            }}
            onAutoPushResult={applyAutoPushResult}
          />
        )}
      </div>

      <GuidedTour open={tourOpen} onFinish={finishTour} onDismiss={dismissTour} />
      {settingsOpen && (
        <ProjectSettings
          project={project}
          user={user}
          roots={projectRoots ?? undefined}
          selectedRoot={compileRoot}
          lastCompileResult={lastCompileResult}
          onClose={() => setSettingsOpen(false)}
          onProjectChanged={onProjectChanged}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
