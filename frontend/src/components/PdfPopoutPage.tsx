import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type Project,
  type RootFile,
  type ServerEvent,
  type Tree,
  errorText,
  getProject,
  getTree,
  listProjectRoots,
  setActiveProject,
} from "../api";
import { PdfPopoutWindowBridge } from "../lib/pdfPopout";
import { buildPdfPopoutUrl, parsePdfRootParam } from "../lib/route";
import { EventsClient, type EventsConnectionState } from "../ws/events";
import { AlertIcon, PanelRightIcon, TreeLogoIcon } from "./Icons";
import { PdfPanel, type SyncTarget } from "./PdfPanel";
import { SettingsMenu } from "./SettingsMenu";
import { ToastContainer, type ToastItem } from "./Toast";

interface PdfPopoutPageProps {
  pid: number;
  onLoggedOut: () => void;
}

const WS_LABELS: Record<EventsConnectionState, string> = {
  connected: "Live",
  connecting: "Verbindet…",
  reconnecting: "Reconnect…",
  disconnected: "Offline",
};

/**
 * Standalone PDF preview window (`/p/{pid}/pdf?root=...`) for dual-monitor setups.
 * Connects its own Events WebSocket (with `reportFocus: false` so project presence is
 * untouched) and coordinates collapse/docking, root switches, and jump-to-line with
 * the main workspace tab via `BroadcastChannel`.
 */
export function PdfPopoutPage({ pid, onLoggedOut }: PdfPopoutPageProps) {
  const [initialRoot] = useState<string | null>(() => parsePdfRootParam(window.location.search));
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [projectRoots, setProjectRoots] = useState<RootFile[] | null>(null);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [wsState, setWsState] = useState<EventsConnectionState>("disconnected");
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [syncTarget, setSyncTarget] = useState<SyncTarget | null>(null);
  const syncSeqRef = useRef(1);

  const toastIdRef = useRef(1);
  const bridgeRef = useRef<PdfPopoutWindowBridge | null>(null);
  const treeLoadedRef = useRef(false);
  const rootsLoadedRef = useRef(false);
  const rootsGenRef = useRef(0);

  const pushToast = useCallback((kind: ToastItem["kind"], message: string) => {
    const id = toastIdRef.current++;
    setToasts((prev) => [...prev, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const next = await getTree();
      treeLoadedRef.current = true;
      setTree(next);
    } catch {
      // Non-fatal; PdfPanel shows empty/error states if no tree loads
    }
  }, []);

  const loadRoots = useCallback(async () => {
    const gen = ++rootsGenRef.current;
    setRootsLoading(true);
    setRootsError(null);
    try {
      const next = await listProjectRoots();
      if (gen !== rootsGenRef.current) return;
      rootsLoadedRef.current = true;
      setProjectRoots(next);
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

  useEffect(() => {
    let active = true;
    getProject(pid)
      .then((p) => {
        if (!active) return;
        setActiveProject(p.id);
        setProject(p);
        document.title = `PDF — ${p.name} · undertree`;
        void loadTree();
        void loadRoots();
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          onLoggedOut();
          return;
        }
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? "Projekt nicht gefunden oder kein Zugriff."
            : errorText(err, "Projekt konnte nicht geladen werden.")
        );
      });
    return () => {
      active = false;
      setActiveProject(null);
    };
  }, [pid, onLoggedOut, loadTree, loadRoots]);

  const loaded = project !== null;
  useEffect(() => {
    if (!loaded) return;
    // Never emit focus frames from the detached PDF window (#47)
    const client = new EventsClient({
      reportFocus: false,
      onUnauthorized: onLoggedOut,
      onProjectGone: () => setLoadError("Projekt wurde gelöscht oder dein Zugriff entzogen."),
    });
    const unsubState = client.onStateChange(setWsState);
    const unsubEvents = client.subscribe((ev) => {
      setLastEvent(ev);
      if (ev.type === "tree_changed") {
        void loadTree();
        void loadRoots();
      } else if (ev.type === "doc_reloaded" || (ev.type === "compile" && "result" in ev)) {
        void loadRoots();
      }
    });
    client.connect();

    const bridge = new PdfPopoutWindowBridge(pid, initialRoot, {
      onDockRequest: () => {
        bridge.close();
        window.close();
      },
      onRootsChanged: () => {
        void loadRoots();
      },
      onSyncToPdf: (file, line, column, explicit) => {
        setSyncTarget({ file, line, column, explicit, seq: syncSeqRef.current++ });
      },
    });
    bridgeRef.current = bridge;

    const onUnload = () => bridge.close();
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);

    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
      bridge.close();
      bridgeRef.current = null;
      unsubState();
      unsubEvents();
      client.dispose();
    };
  }, [loaded, pid, initialRoot, onLoggedOut, loadTree, loadRoots]);

  const handleSelectedRootChange = useCallback(
    (root: string | null) => {
      if (!treeLoadedRef.current && !rootsLoadedRef.current) return;
      const nextUrl = buildPdfPopoutUrl(pid, root);
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (currentUrl !== nextUrl) {
        window.history.replaceState(null, "", nextUrl);
      }
      bridgeRef.current?.notifyRootChanged(root);
    },
    [pid]
  );

  const handleDock = useCallback(() => {
    bridgeRef.current?.close();
    window.close();
  }, []);

  const handleJumpToLine = useCallback((file: string, line: number) => {
    bridgeRef.current?.notifyJumpToLine(file, line);
  }, []);

  if (loadError) {
    return (
      <div class="boot-screen">
        <AlertIcon size={20} />
        <span>{loadError}</span>
        <button type="button" class="btn-ghost btn-sm" onClick={() => window.close()}>
          Fenster schließen
        </button>
      </div>
    );
  }

  if (!project) {
    return (
      <div class="boot-screen">
        <div class="boot-spinner" />
        <span>Lade PDF-Vorschau…</span>
      </div>
    );
  }

  return (
    <div class="pdf-popout-page">
      <header class="topbar pdf-popout-header">
        <div class="pdf-popout-header-left">
          <span class="brand-mark">
            <TreeLogoIcon size={17} />
            <span class="brand-name">undertree</span>
          </span>
          <span class="muted-text">/</span>
          <strong title={project.remote_url}>{project.name}</strong>
          <span class="badge badge-muted">PDF-Popout</span>
        </div>

        <div class="pdf-popout-header-right">
          <span class={`ws-pill ws-${wsState}`} title={`Event-Stream: ${wsState}`}>
            <span class="ws-dot" />
            <span>{WS_LABELS[wsState]}</span>
          </span>

          <button
            type="button"
            class="btn-ghost btn-xs"
            onClick={handleDock}
            title="Im Hauptfenster andocken"
          >
            <PanelRightIcon size={13} />
            <span>Andocken</span>
          </button>

          <SettingsMenu />
        </div>
      </header>

      <main class="pdf-popout-body">
        <PdfPanel
          projectId={project.id}
          tree={tree}
          projectRoots={projectRoots}
          rootsLoading={rootsLoading}
          rootsError={rootsError}
          onRetryRoots={loadRoots}
          syncTarget={syncTarget}
          onAfterCompileQueued={() => void loadRoots()}
          compilerMode={project.compiler}
          mainFiles={project.main_files}
          activePath={null}
          lastEvent={lastEvent}
          onJumpToLine={handleJumpToLine}
          onNotify={pushToast}
          onSelectedRootChange={handleSelectedRootChange}
          initialRoot={initialRoot}
          isPopout
          onDock={handleDock}
        />
      </main>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
