import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ApiError,
  type CompileResult,
  type Diagnostic,
  type DiagnosticSeverity,
  type RootFile,
  type ServerEvent,
  type SyncBox,
  type TexCompiler,
  type Tree,
  type WordCount,
  getCompileLog,
  getCompileResult,
  synctexForward,
  synctexInverse,
  triggerCompile,
  wordcount,
} from "../api";
import {
  ZOOM_STEP,
  clampZoom,
  compareCompileTimestamp,
  listTexRoots,
  pdfDownloadName,
  recordCompileBaseline,
  shouldAcceptFallbackPollResult,
  summarizeDiagnostics,
} from "../lib/compileUi";
import {
  formatAutoCompilerStatus,
  formatCompileError,
  formatDetectedEngineBadge,
  formatEngineLabel,
  loadSavedProjectRoot,
  pickProjectRoot,
  resolveRootSelectorState,
  saveProjectRoot,
  shouldApplyInitialCompileFetch,
  viewRootToStore,
} from "../lib/roots";
import {
  NO_PDF_SYNC_HINT,
  displayToPagePoint,
  pageBoxToCssRect,
  planSyncRequest,
  syncErrorHint,
} from "../lib/synctex";
import { isTexFile } from "../lib/tree";
import { formatWordCount, formatWordCountError, groupThousands } from "../lib/wordcount";
import {
  AlertIcon,
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MinusIcon,
  PanelRightIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  TerminalIcon,
} from "./Icons";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** SyncTeX source -> PDF request; `seq` makes repeated requests for the same line distinct. */
export interface SyncTarget {
  file: string;
  line: number;
  column: number;
  /** button / shortcut: show hints (e.g. "erst kompilieren"); double-click stays silent */
  explicit: boolean;
  seq: number;
}

export interface PdfPanelProps {
  projectId: number;
  tree: Tree | null;
  projectRoots?: RootFile[] | null;
  rootsLoading?: boolean;
  rootsError?: string | null;
  onRetryRoots?: () => void | Promise<void>;
  onAfterCompileQueued?: () => void;
  compilerMode?: TexCompiler;
  /** `Project.main_files`: the first one is the default selection */
  mainFiles?: readonly string[];
  /** set the root as the project's first main file; only given to users who may change it */
  onSetMainFile?: (root: string) => Promise<void>;
  activePath: string | null;
  lastEvent: ServerEvent | null;
  onJumpToLine: (file: string, line: number) => void;
  syncTarget?: SyncTarget | null;
  onNotify: (kind: "info" | "success" | "error", msg: string) => void;
  onSelectedRootChange?: (root: string | null) => void;
  initialRoot?: string | null;
  isPopout?: boolean;
  onPopout?: () => void;
  onDock?: () => void;
}

const NO_MAIN_FILES: readonly string[] = [];

type CompileStatus = "idle" | "queued" | "running" | "success" | "failed";
type ZoomMode = "fit" | "manual";
type DrawerTab = "diagnostics" | "log";

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: "ERROR",
  warning: "WARN",
  badbox: "BOX",
};

function isCancellationError(err: unknown): boolean {
  if (err instanceof pdfjsLib.RenderingCancelledException) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (
    err instanceof Error &&
    (err.name === "RenderingCancelledException" ||
      err.name === "AbortError" ||
      err.message === "Worker was destroyed")
  ) {
    return true;
  }
  return false;
}

function formatDiagLocation(diag: Diagnostic): string {
  if (diag.file && diag.line !== null) {
    return `${diag.file}:${diag.line}`;
  }
  if (diag.file) {
    return diag.file;
  }
  if (diag.line !== null) {
    return `Zeile ${diag.line}`;
  }
  return "LaTeX";
}

export function PdfPanel({
  projectId,
  tree,
  projectRoots,
  rootsLoading,
  rootsError,
  onRetryRoots,
  onAfterCompileQueued,
  compilerMode,
  mainFiles = NO_MAIN_FILES,
  onSetMainFile,
  activePath,
  lastEvent,
  onJumpToLine,
  syncTarget = null,
  onNotify,
  onSelectedRootChange,
  initialRoot = null,
  isPopout = false,
  onPopout,
  onDock,
}: PdfPanelProps) {
  const roots = useMemo<RootFile[]>(() => {
    if (projectRoots !== undefined) {
      return projectRoots ?? [];
    }
    return listTexRoots(tree).map((path) => ({
      path,
      repo: "",
      engine: "pdflatex",
      reason: "default",
    }));
  }, [projectRoots, tree]);

  const [selectedRoot, setSelectedRoot] = useState<string | null>(
    () => initialRoot ?? loadSavedProjectRoot(projectId) ?? mainFiles[0] ?? null
  );
  const mainFilesRef = useRef(mainFiles);
  mainFilesRef.current = mainFiles;
  const initialRootRef = useRef<string | null>(initialRoot ?? null);
  const activePathRef = useRef<string | null>(activePath);
  activePathRef.current = activePath;
  const pendingQueuedRootRef = useRef<string | null>(null);

  const [compileStatus, setCompileStatus] = useState<CompileStatus>("idle");
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);

  // Keeps the last valid PDF URL visible across queued/running/failed compiles
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfRevision, setPdfRevision] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [hasRenderedPdf, setHasRenderedPdf] = useState(false);

  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [zoomScale, setZoomScale] = useState<number>(1.0);
  const [displayZoomPct, setDisplayZoomPct] = useState<number>(100);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  const [pageCount, setPageCount] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);

  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("diagnostics");
  const [rawLog, setRawLog] = useState<string | null>(null);
  const [rawLogLoading, setRawLogLoading] = useState<boolean>(false);
  const [rawLogError, setRawLogError] = useState<string | null>(null);

  const [wc, setWc] = useState<WordCount | null>(null);
  const [wcOpen, setWcOpen] = useState(false);
  const [wcLoading, setWcLoading] = useState(false);
  const [wcError, setWcError] = useState<string | null>(null);
  const wcGenRef = useRef(0);
  const [compileMenuOpen, setCompileMenuOpen] = useState(false);
  const wcAnchorRef = useRef<HTMLDivElement | null>(null);
  const compileSplitRef = useRef<HTMLDivElement | null>(null);
  const lastSyncSeqRef = useRef(syncTarget?.seq ?? 0);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pagesHostRef = useRef<HTMLDivElement | null>(null);

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const activeRenderTasksRef = useRef<Set<RenderTask>>(new Set());
  const renderSeqRef = useRef<number>(0);
  const lastRenderedScaleRef = useRef<number | null>(null);
  const lastHandledEventRef = useRef<ServerEvent | null>(null);
  const compileGenRef = useRef<number>(0);
  const rawLogGenRef = useRef<number>(0);
  const selectedRootRef = useRef<string | null>(selectedRoot);
  selectedRootRef.current = selectedRoot;
  const lastCompletedStartedAtRef = useRef<string | null>(null);
  const activeCompileQueuedAtMsRef = useRef<number | null>(null);
  const drawerStateRef = useRef<{ open: boolean; tab: DrawerTab }>({
    open: drawerOpen,
    tab: drawerTab,
  });
  drawerStateRef.current = { open: drawerOpen, tab: drawerTab };

  const summary = useMemo(
    () => summarizeDiagnostics(compileResult?.diagnostics ?? []),
    [compileResult]
  );

  // Keep selectedRoot synchronized with detected project roots and localStorage
  useEffect(() => {
    if (projectRoots === null && (rootsLoading ?? !rootsError)) return;
    if (roots.length === 0) {
      setSelectedRoot(null);
      return;
    }
    setSelectedRoot((prev) => {
      const preferred = prev ?? initialRootRef.current;
      const saved = loadSavedProjectRoot(projectId);
      const next = pickProjectRoot(roots, saved, preferred, mainFilesRef.current);
      initialRootRef.current = null;
      return next;
    });
  }, [projectId, projectRoots, roots, rootsLoading, rootsError]);

  useEffect(() => {
    if (projectRoots === null) return;
    saveProjectRoot(projectId, viewRootToStore(selectedRoot, mainFiles));
  }, [projectId, projectRoots, selectedRoot, mainFiles]);

  useEffect(() => {
    onSelectedRootChange?.(selectedRoot);
  }, [selectedRoot, onSelectedRootChange]);

  const cancelActiveRenders = useCallback(() => {
    renderSeqRef.current += 1;
    for (const task of activeRenderTasksRef.current) {
      try {
        task.cancel();
      } catch {
        // Ignore already completed/cancelled tasks
      }
    }
    activeRenderTasksRef.current.clear();
  }, []);

  const destroyCurrentDoc = useCallback(() => {
    cancelActiveRenders();
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      fetchAbortRef.current = null;
    }
    if (loadingTaskRef.current) {
      const task = loadingTaskRef.current;
      loadingTaskRef.current = null;
      void task.destroy().catch(() => {});
    }
    if (pdfDocRef.current) {
      const doc = pdfDocRef.current;
      pdfDocRef.current = null;
      void doc.destroy().catch(() => {});
    }
    setPdfDoc(null);
  }, [cancelActiveRenders]);

  // Cleanup all PDF.js resources on unmount
  useEffect(() => {
    return () => {
      destroyCurrentDoc();
    };
  }, [destroyCurrentDoc]);

  // Track visible page on scroll
  const updateCurrentPage = useCallback(() => {
    const scroller = scrollerRef.current;
    const host = pagesHostRef.current;
    if (!scroller || !host) return;

    const children = host.children;
    if (children.length === 0) return;

    const targetY = scroller.scrollTop + Math.min(scroller.clientHeight * 0.3, 180);
    let bestPage = 1;
    for (let i = 0; i < children.length; i += 1) {
      const el = children[i] as HTMLElement | undefined;
      if (!el) continue;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (targetY >= top && targetY <= bottom) {
        bestPage = i + 1;
        break;
      }
      if (top <= targetY) {
        bestPage = i + 1;
      }
    }
    setCurrentPage(bestPage);
  }, []);

  // Word count (#63): on popover open and after each successful compile, never per keystroke
  const loadWordCount = useCallback(async (root: string) => {
    const gen = ++wcGenRef.current;
    setWcLoading(true);
    setWcError(null);
    try {
      const res = await wordcount(root);
      if (gen !== wcGenRef.current || selectedRootRef.current !== root) return;
      setWc(res);
    } catch (err: unknown) {
      if (gen !== wcGenRef.current || selectedRootRef.current !== root) return;
      setWcError(formatWordCountError(err));
    } finally {
      if (gen === wcGenRef.current) setWcLoading(false);
    }
  }, []);

  useEffect(() => {
    wcGenRef.current += 1;
    setWc(null);
    setWcError(null);
    setWcLoading(false);
    setWcOpen(false);
  }, [selectedRoot]);

  useEffect(() => {
    if (compileResult?.state === "success" && compileResult.root === selectedRoot) {
      void loadWordCount(compileResult.root);
    }
  }, [compileResult, selectedRoot, loadWordCount]);

  // Close the word count popover / compile menu on outside click or Escape
  useEffect(() => {
    if (!wcOpen && !compileMenuOpen) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (wcOpen && !wcAnchorRef.current?.contains(t)) setWcOpen(false);
      if (compileMenuOpen && !compileSplitRef.current?.contains(t)) setCompileMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      setWcOpen(false);
      setCompileMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [wcOpen, compileMenuOpen]);

  const toggleWordCount = () => {
    const next = !wcOpen;
    setWcOpen(next);
    if (next && selectedRoot) void loadWordCount(selectedRoot);
  };

  // Load raw compile log on demand (guarded against stale responses after root switch)
  const loadRawLog = useCallback(async (root: string) => {
    const gen = ++rawLogGenRef.current;
    setRawLogLoading(true);
    setRawLogError(null);
    try {
      const text = await getCompileLog(root);
      if (gen !== rawLogGenRef.current || selectedRootRef.current !== root) return;
      setRawLog(text);
    } catch (err: unknown) {
      if (gen !== rawLogGenRef.current || selectedRootRef.current !== root) return;
      if (err instanceof ApiError && err.status === 404) {
        setRawLog(null);
        setRawLogError("Noch kein Compile-Log vorhanden.");
      } else {
        setRawLogError(
          err instanceof Error ? err.message : "Compile-Log konnte nicht geladen werden."
        );
      }
    } finally {
      if (gen === rawLogGenRef.current && selectedRootRef.current === root) {
        setRawLogLoading(false);
      }
    }
  }, []);

  // When selectedRoot changes: clear rendered PDF & fetch latest compile result (ignoring 404)
  useEffect(() => {
    compileGenRef.current += 1;
    rawLogGenRef.current += 1;
    lastCompletedStartedAtRef.current = null;
    activeCompileQueuedAtMsRef.current = null;
    destroyCurrentDoc();
    if (pagesHostRef.current) {
      pagesHostRef.current.replaceChildren();
    }
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = 0;
      scrollerRef.current.scrollLeft = 0;
    }
    lastRenderedScaleRef.current = null;
    const isPendingQueued = Boolean(selectedRoot && pendingQueuedRootRef.current === selectedRoot);
    if (isPendingQueued) {
      pendingQueuedRootRef.current = null;
      compileGenRef.current += 1;
      activeCompileQueuedAtMsRef.current = Date.now();
      setCompileStatus("queued");
    } else {
      pendingQueuedRootRef.current = null;
      setCompileStatus("idle");
    }
    setCompileResult(null);
    setPdfUrl(null);
    setPdfError(null);
    setHasRenderedPdf(false);
    setPageCount(0);
    setCurrentPage(1);
    setRawLog(null);
    setRawLogError(null);
    setRawLogLoading(false);

    if (!selectedRoot) return;
    const root = selectedRoot;
    const fetchGen = compileGenRef.current;

    let cancelled = false;
    void (async () => {
      try {
        const res = await getCompileResult(root);
        if (cancelled || selectedRootRef.current !== root) return;
        const queuedAtMs = activeCompileQueuedAtMsRef.current;
        const parsedStartedMs = Date.parse(res.started_at);
        const isOlderThanPendingQueue =
          queuedAtMs === null || (!Number.isNaN(parsedStartedMs) && parsedStartedMs < queuedAtMs);
        // Seed the prior-result baseline when no newer pending run could already have completed,
        // so a fallback poll after a queued compile never treats an older terminal result as new (#30, #49).
        if (!isPendingQueued || isOlderThanPendingQueue) {
          lastCompletedStartedAtRef.current = recordCompileBaseline(
            lastCompletedStartedAtRef.current,
            res.started_at
          );
        }
        if (
          !shouldApplyInitialCompileFetch({
            isPendingQueued,
            activeCompileQueuedAtMs: activeCompileQueuedAtMsRef.current,
            fetchGen,
            currentGen: compileGenRef.current,
          })
        ) {
          return;
        }
        setCompileResult(res);
        setCompileStatus(res.state);
        if (res.pdf_url) {
          setPdfUrl(res.pdf_url);
          setPdfRevision((r) => r + 1);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // Never compiled yet — keep idle/queued state
          return;
        }
        if (
          !shouldApplyInitialCompileFetch({
            isPendingQueued,
            activeCompileQueuedAtMs: activeCompileQueuedAtMsRef.current,
            fetchGen,
            currentGen: compileGenRef.current,
          })
        ) {
          return;
        }
        onNotify(
          "error",
          err instanceof Error ? err.message : "Compile-Status konnte nicht geladen werden."
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRoot, destroyCurrentDoc, onNotify]);

  // React to server compile events via /ws/events (each event object handled once)
  useEffect(() => {
    if (!lastEvent || lastEvent === lastHandledEventRef.current) return;
    if (lastEvent.type !== "compile" || !selectedRoot) return;
    if (lastEvent.root !== selectedRoot) return;

    lastHandledEventRef.current = lastEvent;

    if (lastEvent.state === "queued" || lastEvent.state === "running") {
      compileGenRef.current += 1;
      if (activeCompileQueuedAtMsRef.current === null) {
        activeCompileQueuedAtMsRef.current = Date.now();
      }
      setCompileStatus(lastEvent.state);
      return;
    }

    if (!("result" in lastEvent)) return;

    // Guard against overwriting a newer terminal event
    if (
      lastCompletedStartedAtRef.current !== null &&
      compareCompileTimestamp(lastEvent.result.started_at, lastCompletedStartedAtRef.current) < 0
    ) {
      return;
    }

    compileGenRef.current += 1;
    lastCompletedStartedAtRef.current = recordCompileBaseline(
      lastCompletedStartedAtRef.current,
      lastEvent.result.started_at
    );
    activeCompileQueuedAtMsRef.current = null;
    setCompileStatus(lastEvent.state);
    setCompileResult(lastEvent.result);

    if (lastEvent.result.pdf_url) {
      setPdfUrl(lastEvent.result.pdf_url);
      setPdfRevision((r) => r + 1);
    }

    if (lastEvent.state === "failed") {
      setDrawerOpen(true);
      setDrawerTab("diagnostics");
    } else if (drawerStateRef.current.open && drawerStateRef.current.tab === "log") {
      void loadRawLog(selectedRoot);
    }
  }, [lastEvent, selectedRoot, loadRawLog]);

  // Fallback reconciliation poll while queued/running in case /ws/events drops mid-compile
  useEffect(() => {
    if (!selectedRoot || (compileStatus !== "queued" && compileStatus !== "running")) {
      return;
    }
    const root = selectedRoot;
    const genAtStart = compileGenRef.current;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await getCompileResult(root);
          if (selectedRootRef.current !== root || compileGenRef.current !== genAtStart) return;
          if (
            !shouldAcceptFallbackPollResult(
              lastCompletedStartedAtRef.current,
              activeCompileQueuedAtMsRef.current,
              res.started_at
            )
          ) {
            return;
          }
          compileGenRef.current += 1;
          lastCompletedStartedAtRef.current = recordCompileBaseline(
            lastCompletedStartedAtRef.current,
            res.started_at
          );
          activeCompileQueuedAtMsRef.current = null;
          setCompileStatus(res.state);
          setCompileResult(res);
          if (res.pdf_url) {
            setPdfUrl(res.pdf_url);
            setPdfRevision((r) => r + 1);
          }
          if (res.state === "failed") {
            setDrawerOpen(true);
            setDrawerTab("diagnostics");
          } else if (drawerStateRef.current.open && drawerStateRef.current.tab === "log") {
            void loadRawLog(root);
          }
        } catch {
          // 404 (not compiled yet) or transient error — keep waiting
        }
      })();
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [selectedRoot, compileStatus, loadRawLog]);

  // Fetch raw log whenever log tab becomes active
  useEffect(() => {
    if (drawerOpen && drawerTab === "log" && selectedRoot) {
      void loadRawLog(selectedRoot);
    }
  }, [drawerOpen, drawerTab, selectedRoot, loadRawLog]);

  // Observe scroll container width for Fit-to-width mode (debounced)
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;

    let timer: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? scroller.clientWidth;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setContainerWidth((prev) => (Math.abs(prev - width) > 2 ? Math.round(width) : prev));
      }, 100);
    });

    observer.observe(scroller);
    setContainerWidth(Math.round(scroller.clientWidth));

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  // Load PDFDocumentProxy whenever pdfUrl or pdfRevision changes (keeping old canvases on screen!)
  useEffect(() => {
    if (!pdfUrl) return;

    let cancelled = false;
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    if (loadingTaskRef.current) {
      const oldTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      void oldTask.destroy().catch(() => {});
    }

    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setPdfLoading(true);
    setPdfError(null);

    void (async () => {
      try {
        const res = await fetch(pdfUrl, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`PDF konnte nicht geladen werden (HTTP ${res.status})`);
        }
        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        loadingTaskRef.current = loadingTask;
        const nextDoc = await loadingTask.promise;

        if (cancelled) {
          void nextDoc.destroy().catch(() => {});
          return;
        }

        if (loadingTaskRef.current === loadingTask) {
          loadingTaskRef.current = null;
        }

        // Cancel any in-flight renders on the old document and release it;
        // the already-painted DOM canvases stay visible until the new pages finish rendering!
        cancelActiveRenders();
        const prevDoc = pdfDocRef.current;
        pdfDocRef.current = nextDoc;
        if (prevDoc && prevDoc !== nextDoc) {
          void prevDoc.destroy().catch(() => {});
        }

        setPageCount(nextDoc.numPages);
        setPdfDoc(nextDoc);
      } catch (err: unknown) {
        if (cancelled || isCancellationError(err)) return;
        setPdfError(err instanceof Error ? err.message : "PDF konnte nicht gerendert werden.");
      } finally {
        if (!cancelled) {
          setPdfLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (loadingTaskRef.current) {
        const task = loadingTaskRef.current;
        loadingTaskRef.current = null;
        void task.destroy().catch(() => {});
      }
    };
  }, [pdfUrl, pdfRevision, cancelActiveRenders]);

  const fitWidth = zoomMode === "fit" ? containerWidth : 0;

  // Render all pages offscreen, then atomically swap into DOM while preserving exact scroll position!
  useEffect(() => {
    if (!pdfDoc) return;

    cancelActiveRenders();
    const seq = renderSeqRef.current;
    const scroller = scrollerRef.current;
    const host = pagesHostRef.current;
    if (!scroller || !host) return;

    // Remember scroll state before starting offscreen render
    const initialScrollTop = scroller.scrollTop;
    const initialScrollLeft = scroller.scrollLeft;
    const initialMaxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const initialRatio = initialMaxScroll > 0 ? initialScrollTop / initialMaxScroll : 0;

    void (async () => {
      try {
        const firstPage = await pdfDoc.getPage(1);
        if (seq !== renderSeqRef.current) return;

        const baseViewport = firstPage.getViewport({ scale: 1 });
        let effectiveScale = zoomScale;
        if (zoomMode === "fit") {
          const measuredWidth = (fitWidth || scroller.clientWidth || 380) - 32;
          const usableWidth = Math.max(180, measuredWidth);
          effectiveScale = clampZoom(usableWidth / Math.max(1, baseViewport.width));
        }
        setDisplayZoomPct(Math.round(effectiveScale * 100));

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const newWrappers: HTMLDivElement[] = [];

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum += 1) {
          if (seq !== renderSeqRef.current) return;

          const page = pageNum === 1 ? firstPage : await pdfDoc.getPage(pageNum);
          if (seq !== renderSeqRef.current) return;

          const viewport = page.getViewport({ scale: effectiveScale });
          const wrapper = document.createElement("div");
          wrapper.className = "pdf-page-wrapper";
          wrapper.dataset.page = String(pageNum);
          wrapper.dataset.scale = String(effectiveScale);
          wrapper.dataset.rotation = String(viewport.rotation);
          wrapper.dataset.pw = String(viewport.width / effectiveScale);
          wrapper.dataset.ph = String(viewport.height / effectiveScale);
          wrapper.style.width = `${Math.floor(viewport.width)}px`;
          wrapper.style.height = `${Math.floor(viewport.height)}px`;

          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page-canvas";
          canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
          canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          wrapper.appendChild(canvas);

          const renderTask = page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          });
          activeRenderTasksRef.current.add(renderTask);

          try {
            await renderTask.promise;
          } finally {
            activeRenderTasksRef.current.delete(renderTask);
            page.cleanup();
          }

          if (seq !== renderSeqRef.current) return;
          newWrappers.push(wrapper);
        }

        if (seq !== renderSeqRef.current) return;

        // Read the latest scroll coordinates immediately before atomic DOM swap
        // (captures any user scrolling that happened while rendering offscreen)
        const currentTop = scroller.scrollTop;
        const currentLeft = scroller.scrollLeft;
        const currentMaxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const currentMaxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const scrollRatioY = currentMaxY > 0 ? currentTop / currentMaxY : initialRatio;
        const scrollRatioX = currentMaxX > 0 ? currentLeft / currentMaxX : 0;

        const prevScale = lastRenderedScaleRef.current;
        const isSameScaleReload =
          prevScale !== null && Math.abs(prevScale - effectiveScale) < 0.005;

        // Atomic swap: replace old pages with freshly rendered canvases in one synchronous step
        host.replaceChildren(...newWrappers);
        lastRenderedScaleRef.current = effectiveScale;
        setHasRenderedPdf(true);
        setPdfError(null);

        // Restore scroll position without any page jump
        const newMaxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const newMaxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);

        if (isSameScaleReload) {
          const targetTop = currentTop !== initialScrollTop ? currentTop : initialScrollTop;
          const targetLeft = currentLeft !== initialScrollLeft ? currentLeft : initialScrollLeft;
          scroller.scrollTop = Math.min(targetTop, newMaxY);
          scroller.scrollLeft = Math.min(targetLeft, newMaxX);
        } else if (prevScale !== null) {
          scroller.scrollTop = Math.min(Math.round(scrollRatioY * newMaxY), newMaxY);
          scroller.scrollLeft = Math.min(Math.round(scrollRatioX * newMaxX), newMaxX);
        }

        updateCurrentPage();
      } catch (err: unknown) {
        if (seq !== renderSeqRef.current || isCancellationError(err)) return;
        setPdfError(err instanceof Error ? err.message : "PDF-Rendering fehlgeschlagen.");
      }
    })();

    return () => {
      cancelActiveRenders();
    };
  }, [pdfDoc, zoomMode, zoomScale, fitWidth, cancelActiveRenders, updateCurrentPage]);

  const handleRootChange = (ev: JSX.TargetedEvent<HTMLSelectElement, Event>) => {
    const next = ev.currentTarget.value;
    setSelectedRoot(next || null);
  };

  const handleSetMainFile = async () => {
    if (!selectedRoot || !onSetMainFile) return;
    try {
      await onSetMainFile(selectedRoot);
      onNotify("success", `${selectedRoot} ist jetzt die Hauptdatei.`);
    } catch (err: unknown) {
      onNotify("error", formatCompileError(err));
    }
  };

  const triggerTargetCompile = useCallback(
    async (target: string | null, clean = false) => {
      if (!target || isTriggering) return;
      setIsTriggering(true);
      try {
        const queued = await triggerCompile(target, clean);
        const resolvedRoot = queued.root;
        if (resolvedRoot !== selectedRootRef.current) {
          pendingQueuedRootRef.current = resolvedRoot;
          selectedRootRef.current = resolvedRoot;
          saveProjectRoot(projectId, viewRootToStore(resolvedRoot, mainFilesRef.current));
          setSelectedRoot(resolvedRoot);
        } else {
          compileGenRef.current += 1;
          activeCompileQueuedAtMsRef.current = Date.now();
          setCompileStatus("queued");
        }
        onAfterCompileQueued?.();
      } catch (err: unknown) {
        onNotify("error", formatCompileError(err));
      } finally {
        setIsTriggering(false);
      }
    },
    [isTriggering, onAfterCompileQueued, onNotify, projectId]
  );

  const handleCompile = useCallback(
    (clean = false) => triggerTargetCompile(selectedRootRef.current, clean),
    [triggerTargetCompile]
  );

  // SyncTeX PDF -> source (#52): double-click on a page
  const handlePagesDblClick = useCallback(
    (ev: JSX.TargetedMouseEvent<HTMLDivElement>) => {
      const root = selectedRootRef.current;
      const wrapper = (ev.target as Element).closest<HTMLElement>(".pdf-page-wrapper");
      if (!root || !wrapper) return;
      const d = wrapper.dataset;
      const rect = wrapper.getBoundingClientRect();
      const { x, y } = displayToPagePoint(ev.clientX - rect.left, ev.clientY - rect.top, {
        scale: Number(d.scale),
        rotation: Number(d.rotation),
        width: Number(d.pw),
        height: Number(d.ph),
      });
      void synctexInverse(root, Number(d.page), x, y)
        .then((src) => {
          if (selectedRootRef.current === root) onJumpToLine(src.file, src.line);
        })
        .catch((err: unknown) => {
          const hint = syncErrorHint(err, true);
          if (hint) onNotify("info", hint);
        });
    },
    [onJumpToLine, onNotify]
  );

  // SyncTeX source -> PDF (#52): scroll to the first box and flash all boxes
  useEffect(() => {
    const root = selectedRootRef.current;
    if (!syncTarget) return;
    // every request is consumed exactly once, never held until a later render
    const action = planSyncRequest(syncTarget.seq, lastSyncSeqRef.current, Boolean(root && hasRenderedPdf));
    if (action === "ignore") return;
    lastSyncSeqRef.current = syncTarget.seq;
    const { file, line, column, explicit } = syncTarget;
    if (action === "no_pdf" || !root) {
      if (explicit) onNotify("info", NO_PDF_SYNC_HINT);
      return;
    }
    void synctexForward(root, file, line, column)
      .then((boxes: SyncBox[]) => {
        if (selectedRootRef.current !== root) return;
        if (!showSyncBoxes(boxes) && explicit) {
          onNotify("info", "Zu dieser Zeile gibt es keine Stelle im PDF.");
        }
      })
      .catch((err: unknown) => {
        const hint = syncErrorHint(err, explicit);
        if (hint) onNotify("info", hint);
      });
  }, [syncTarget, hasRenderedPdf, onNotify]);

  const showSyncBoxes = (boxes: SyncBox[]): boolean => {
    const scroller = scrollerRef.current;
    const host = pagesHostRef.current;
    if (!scroller || !host || boxes.length === 0) return false;
    let first: HTMLElement | null = null;
    for (const box of boxes) {
      const wrapper = host.querySelector<HTMLElement>(`.pdf-page-wrapper[data-page="${box.page}"]`);
      if (!wrapper) continue;
      const d = wrapper.dataset;
      const r = pageBoxToCssRect(box, {
        scale: Number(d.scale),
        rotation: Number(d.rotation),
        width: Number(d.pw),
        height: Number(d.ph),
      });
      const el = document.createElement("div");
      el.className = "pdf-sync-box";
      el.style.cssText = `left:${r.left}px;top:${r.top}px;width:${Math.max(r.width, 6)}px;height:${Math.max(r.height, 6)}px`;
      wrapper.appendChild(el);
      window.setTimeout(() => el.remove(), 2200);
      first ??= el;
    }
    if (!first) return false;
    const elRect = first.getBoundingClientRect();
    const scRect = scroller.getBoundingClientRect();
    scroller.scrollTo({
      top: scroller.scrollTop + elRect.top - scRect.top - scroller.clientHeight / 3,
      behavior: "smooth",
    });
    return true;
  };

  // Trigger compile on Ctrl+S (`undertree:save` window event from editor, #26).
  // When editing an included `.tex` file, send it directly so the server resolves its root (#49).
  const triggerTargetCompileRef = useRef(triggerTargetCompile);
  triggerTargetCompileRef.current = triggerTargetCompile;
  useEffect(() => {
    const onSave = () => {
      const currentActive = activePathRef.current;
      const target =
        currentActive && isTexFile(currentActive) ? currentActive : selectedRootRef.current;
      void triggerTargetCompileRef.current(target);
    };
    window.addEventListener("undertree:save", onSave);
    return () => {
      window.removeEventListener("undertree:save", onSave);
    };
  }, []);

  const handleZoomOut = () => {
    const base = zoomMode === "fit" ? displayZoomPct / 100 : zoomScale;
    setZoomMode("manual");
    setZoomScale(clampZoom(base - ZOOM_STEP));
  };

  const handleZoomIn = () => {
    const base = zoomMode === "fit" ? displayZoomPct / 100 : zoomScale;
    setZoomMode("manual");
    setZoomScale(clampZoom(base + ZOOM_STEP));
  };

  const handleZoomReset = () => {
    setZoomMode("manual");
    setZoomScale(1.0);
  };

  const handleZoomFit = () => {
    setZoomMode("fit");
  };

  const isCompiling = compileStatus === "queued" || compileStatus === "running";

  const activeRootInfo = useMemo(
    () => roots.find((r) => r.path === selectedRoot) ?? null,
    [roots, selectedRoot]
  );

  const engineBadge = useMemo(() => {
    if (compilerMode !== "auto") return null;
    if (compileResult?.engine && compileResult.engine_reason !== "fixed") {
      return {
        label: formatEngineLabel(compileResult.engine),
        tooltip: formatDetectedEngineBadge(compileResult.engine, compileResult.engine_reason),
        status: formatAutoCompilerStatus(
          compileResult.engine,
          compileResult.engine_reason ?? "default"
        ),
      };
    }
    if (activeRootInfo) {
      return {
        label: formatEngineLabel(activeRootInfo.engine),
        tooltip: formatDetectedEngineBadge(activeRootInfo.engine, activeRootInfo.reason),
        status: formatAutoCompilerStatus(activeRootInfo.engine, activeRootInfo.reason),
      };
    }
    return null;
  }, [compilerMode, compileResult, activeRootInfo]);

  const statusPill = useMemo(() => {
    switch (compileStatus) {
      case "queued":
        return { cls: "status-pill-warn", label: "Queued" };
      case "running":
        return { cls: "status-pill-info", label: "Kompiliert…" };
      case "success":
        return {
          cls: "status-pill-ok",
          label: compileResult ? `OK (${compileResult.duration_ms} ms)` : "OK",
        };
      case "failed":
        return {
          cls: "status-pill-error",
          label: summary.errors > 0 ? `Fehler (${summary.errors})` : "Fehler",
        };
      default:
        return { cls: "status-pill-idle", label: "Bereit" };
    }
  }, [compileStatus, compileResult, summary.errors]);

  const rootSelectorState = resolveRootSelectorState({
    rootsCount: roots.length,
    loading: rootsLoading ?? (projectRoots === null && !rootsError),
    error: rootsError ?? null,
  });

  return (
    <div class="pdf-panel">
      <div class="pdf-toolbar">
        <div class="pdf-toolbar-row">
          {rootSelectorState === "select" ? (
            <select
              class="pdf-root-select"
              aria-label="LaTeX Root-Datei"
              value={selectedRoot ?? ""}
              onChange={handleRootChange}
              title={selectedRoot ?? "LaTeX Root-Datei"}
            >
              {roots.map((root) => (
                <option key={root.path} value={root.path}>
                  {root.path}
                </option>
              ))}
            </select>
          ) : rootSelectorState === "single" ? (
            <span
              class="pdf-root-pill mono"
              title={`LaTeX Root-Datei: ${roots[0]!.path}`}
              aria-label={`LaTeX Root-Datei: ${roots[0]!.path}`}
            >
              {roots[0]!.path}
            </span>
          ) : rootSelectorState === "error" ? (
            <span class="pdf-root-pill pdf-root-error" title={rootsError ?? undefined}>
              <span class="pdf-root-error-text">Roots nicht geladen</span>
              {onRetryRoots && (
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="Roots erneut laden"
                  title={rootsError ?? "Roots erneut laden"}
                  onClick={() => void onRetryRoots()}
                >
                  <RefreshIcon size={11} />
                </button>
              )}
            </span>
          ) : (
            <span class="pdf-root-pill pdf-root-empty">
              {rootSelectorState === "loading" ? "Lade Roots…" : "Keine LaTeX-Root gefunden"}
            </span>
          )}

          {onSetMainFile && selectedRoot && selectedRoot !== mainFiles[0] && (
            <button
              type="button"
              class="btn-ghost btn-xs pdf-set-main-btn"
              onClick={() => void handleSetMainFile()}
              title="Diese Root als erste Hauptdatei des Projekts speichern (gilt für alle Mitglieder)"
            >
              Als Hauptdatei festlegen
            </button>
          )}

          <div
            class="pdf-split-btn"
            ref={compileSplitRef}
            onFocusOut={(ev) => {
              const next = ev.relatedTarget as Node | null;
              if (next && !ev.currentTarget.contains(next)) setCompileMenuOpen(false);
            }}
          >
            <button
              type="button"
              class="btn-primary btn-xs pdf-compile-btn"
              disabled={!selectedRoot || isTriggering}
              onClick={() => void handleCompile()}
              title={selectedRoot ? `${selectedRoot} kompilieren` : "Keine LaTeX-Root gefunden"}
            >
              {isCompiling ? (
                <RefreshIcon size={13} class="spin" />
              ) : (
                <PlayIcon size={12} />
              )}
              <span>Compile</span>
            </button>
            <button
              type="button"
              class="btn-primary btn-xs pdf-compile-caret"
              disabled={!selectedRoot || isTriggering}
              aria-expanded={compileMenuOpen}
              aria-label="Weitere Compile-Optionen"
              title="Weitere Compile-Optionen"
              onClick={() => setCompileMenuOpen((v) => !v)}
            >
              <ChevronDownIcon size={12} />
            </button>
            {compileMenuOpen && (
              <div class="pdf-compile-menu">
                <button
                  type="button"
                  class="pdf-compile-menu-item"
                  title="Löscht aux/bbl/fdb und das letzte PDF dieser Root vor dem Lauf"
                  onClick={() => {
                    setCompileMenuOpen(false);
                    void handleCompile(true);
                  }}
                >
                  Von Grund auf neu kompilieren
                </button>
              </div>
            )}
          </div>

          {engineBadge && (
            <span class="pdf-engine-pill" title={engineBadge.tooltip}>
              {engineBadge.label}
            </span>
          )}

          <span
            class={`pdf-status-pill ${statusPill.cls}`}
            title={
              engineBadge
                ? `Compile-Status: ${statusPill.label} · ${engineBadge.status}`
                : `Compile-Status: ${statusPill.label}`
            }
          >
            {statusPill.label}
          </span>
        </div>

        <div class="pdf-toolbar-row pdf-toolbar-controls">
          <div class="pdf-zoom-group" role="group" aria-label="Zoom-Steuerung">
            <button
              type="button"
              class="icon-btn"
              title="Verkleinern"
              aria-label="Verkleinern"
              disabled={!hasRenderedPdf}
              onClick={handleZoomOut}
            >
              <MinusIcon size={13} />
            </button>
            <button
              type="button"
              class="pdf-zoom-readout"
              title="Auf 100 % zurücksetzen"
              disabled={!hasRenderedPdf}
              onClick={handleZoomReset}
            >
              {displayZoomPct}%
            </button>
            <button
              type="button"
              class="icon-btn"
              title="Vergrößern"
              aria-label="Vergrößern"
              disabled={!hasRenderedPdf}
              onClick={handleZoomIn}
            >
              <PlusIcon size={13} />
            </button>
            <button
              type="button"
              class={`btn-ghost btn-xs pdf-fit-btn ${zoomMode === "fit" ? "is-active" : ""}`}
              title="An Breite anpassen"
              onClick={handleZoomFit}
            >
              Fit
            </button>
          </div>

          <span class="pdf-page-indicator mono-dim" aria-live="polite">
            {pageCount > 0 ? `Seite ${currentPage} / ${pageCount}` : "Seite – / –"}
          </span>

          <div class="pdf-wc-anchor" ref={wcAnchorRef}>
            <button
              type="button"
              class={`btn-ghost btn-xs pdf-wc-badge ${wcOpen ? "is-active" : ""}`}
              disabled={!selectedRoot}
              aria-haspopup="dialog"
              aria-expanded={wcOpen}
              title="Wortzähler (texcount)"
              onClick={toggleWordCount}
            >
              {wc ? formatWordCount(wc.words) : "Wörter"}
            </button>
            {wcOpen && (
              <div class="pdf-wc-popover" role="dialog" aria-label="Wortzähler">
                {wcLoading && !wc && <div class="pdf-wc-note">Zähle Wörter…</div>}
                {wcError && <div class="pdf-wc-note pdf-wc-error">{wcError}</div>}
                {wc && (
                  <>
                    <dl class="pdf-wc-totals">
                      <dt>Wörter (Text)</dt>
                      <dd>{groupThousands(wc.words)}</dd>
                      <dt>Wörter in Überschriften</dt>
                      <dd>{groupThousands(wc.headers)}</dd>
                      <dt>Wörter in Captions u. Ä.</dt>
                      <dd>{groupThousands(wc.captions)}</dd>
                      <dt>Formeln inline</dt>
                      <dd>{groupThousands(wc.math_inline)}</dd>
                      <dt>Formeln abgesetzt</dt>
                      <dd>{groupThousands(wc.math_display)}</dd>
                    </dl>
                    {wc.per_file.length > 0 && (
                      <ul class="pdf-wc-files">
                        {wc.per_file.map((f) => (
                          <li key={f.path} title={f.path}>
                            <span class="mono pdf-wc-path">{f.path}</span>
                            <span>{groupThousands(f.words)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                <button
                  type="button"
                  class="btn-ghost btn-xs"
                  disabled={wcLoading || !selectedRoot}
                  onClick={() => selectedRoot && void loadWordCount(selectedRoot)}
                >
                  <RefreshIcon size={11} class={wcLoading ? "spin" : undefined} />
                  <span>Neu zählen</span>
                </button>
              </div>
            )}
          </div>

          <div class="pdf-toolbar-right">
            {pdfUrl && selectedRoot ? (
              <a
                class="icon-btn"
                href={pdfUrl}
                download={pdfDownloadName(selectedRoot)}
                title="PDF herunterladen"
                aria-label="PDF herunterladen"
              >
                <DownloadIcon size={14} />
              </a>
            ) : (
              <button
                type="button"
                class="icon-btn"
                disabled
                title="Noch kein PDF verfügbar"
                aria-label="PDF herunterladen"
              >
                <DownloadIcon size={14} />
              </button>
            )}

            <button
              type="button"
              class={`btn-ghost btn-xs pdf-diag-toggle ${drawerOpen ? "is-active" : ""}`}
              onClick={() => setDrawerOpen((v) => !v)}
              title="Diagnostics & Log ein-/ausblenden"
              aria-expanded={drawerOpen}
            >
              <TerminalIcon size={13} />
              <span>Log</span>
              {summary.errors > 0 && (
                <span class="diag-count diag-count-error" title={`${summary.errors} Fehler`}>
                  {summary.errors}
                </span>
              )}
              {summary.warnings > 0 && (
                <span class="diag-count diag-count-warn" title={`${summary.warnings} Warnungen`}>
                  {summary.warnings}
                </span>
              )}
            </button>

            {!isPopout && onPopout && (
              <button
                type="button"
                class="icon-btn"
                title="In eigenem Fenster öffnen"
                aria-label="In eigenem Fenster öffnen"
                onClick={onPopout}
              >
                <ExternalLinkIcon size={14} />
              </button>
            )}

            {isPopout && onDock && (
              <button
                type="button"
                class="icon-btn"
                title="Im Hauptfenster andocken"
                aria-label="Im Hauptfenster andocken"
                onClick={onDock}
              >
                <PanelRightIcon size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {pdfError && hasRenderedPdf && (
        <div class="pdf-inline-error" role="alert">
          <AlertIcon size={14} />
          <span>{pdfError}</span>
        </div>
      )}

      <div
        ref={scrollerRef}
        class="pdf-viewport"
        onScroll={updateCurrentPage}
      >
        <div
          ref={pagesHostRef}
          class="pdf-pages"
          onDblClick={handlePagesDblClick}
        />

        {!hasRenderedPdf && (
          <div class="pdf-empty-state">
            {pdfLoading ? (
              <>
                <div class="boot-spinner" />
                <p>PDF wird geladen…</p>
              </>
            ) : pdfError ? (
              <>
                <AlertIcon size={22} />
                <h3>PDF-Vorschau fehlgeschlagen</h3>
                <p>{pdfError}</p>
              </>
            ) : roots.length === 0 ? (
              projectRoots === null ? (
                <>
                  <div class="boot-spinner" />
                  <p>LaTeX-Roots werden gesucht…</p>
                </>
              ) : (
                <>
                  <h3>Keine LaTeX-Root gefunden</h3>
                  <p>
                    Lege links eine <code>.tex</code>-Datei mit{" "}
                    <code>\begin&#123;document&#125;</code> an, um ein PDF zu kompilieren.
                  </p>
                </>
              )
            ) : (
              <>
                <h3>Noch nicht kompiliert</h3>
                <p>
                  Klicke auf <strong>Compile</strong>, um <code class="mono">{selectedRoot}</code>{" "}
                  zu übersetzen. Nach dem ersten Build aktualisiert sich das PDF automatisch.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {drawerOpen && (
        <div class="pdf-drawer" aria-label="Diagnostics und Compile-Log">
          <div class="pdf-drawer-header">
            <div class="pdf-drawer-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "diagnostics"}
                class={`pdf-drawer-tab ${drawerTab === "diagnostics" ? "is-active" : ""}`}
                onClick={() => setDrawerTab("diagnostics")}
              >
                <span>Diagnostics</span>
                <span class="badge badge-muted">{summary.total}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "log"}
                class={`pdf-drawer-tab ${drawerTab === "log" ? "is-active" : ""}`}
                onClick={() => setDrawerTab("log")}
              >
                <span>Raw Log</span>
              </button>
            </div>

            <div class="pdf-drawer-actions">
              {drawerTab === "log" && selectedRoot && (
                <button
                  type="button"
                  class="icon-btn"
                  title="Log aktualisieren"
                  aria-label="Log aktualisieren"
                  disabled={rawLogLoading}
                  onClick={() => void loadRawLog(selectedRoot)}
                >
                  <RefreshIcon size={13} class={rawLogLoading ? "spin" : undefined} />
                </button>
              )}
              <button
                type="button"
                class="icon-btn"
                title="Bereich einklappen"
                aria-label="Bereich einklappen"
                onClick={() => setDrawerOpen(false)}
              >
                <ChevronDownIcon size={14} />
              </button>
            </div>
          </div>

          <div class="pdf-drawer-body">
            {drawerTab === "diagnostics" ? (
              summary.sorted.length === 0 ? (
                <div class="pdf-drawer-empty">
                  {compileResult
                    ? "Keine Fehler, Warnungen oder Badboxes im letzten Build."
                    : "Noch kein Build-Ergebnis vorhanden."}
                </div>
              ) : (
                <div class="diag-list" role="list">
                  {summary.sorted.map((diag, idx) => {
                    const location = formatDiagLocation(diag);
                    const badgeCls = `diag-badge diag-badge-${diag.severity}`;
                    const content = (
                      <>
                        <span class={badgeCls}>{SEVERITY_LABEL[diag.severity]}</span>
                        <span class="diag-loc mono">{location}</span>
                        <span class="diag-msg">{diag.message}</span>
                      </>
                    );

                    if (diag.file) {
                      const targetFile = diag.file;
                      const targetLine = diag.line ?? 1;
                      return (
                        <button
                          key={`${diag.severity}-${targetFile}-${targetLine}-${idx}`}
                          type="button"
                          role="listitem"
                          class="diag-row is-clickable"
                          onClick={() => onJumpToLine(targetFile, targetLine)}
                          title={`Zu ${targetFile}:${targetLine} springen`}
                        >
                          {content}
                        </button>
                      );
                    }

                    return (
                      <div
                        key={`${diag.severity}-none-${idx}`}
                        role="listitem"
                        class="diag-row"
                      >
                        {content}
                      </div>
                    );
                  })}
                </div>
              )
            ) : rawLogLoading ? (
              <div class="pdf-drawer-empty">Log wird geladen…</div>
            ) : rawLogError ? (
              <div class="pdf-drawer-empty">{rawLogError}</div>
            ) : rawLog !== null ? (
              <pre class="pdf-raw-log">{rawLog}</pre>
            ) : (
              <div class="pdf-drawer-empty">Noch kein Compile-Log vorhanden.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
