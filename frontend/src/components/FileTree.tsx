import { useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type MoveReference,
  type PresenceUser,
  type Repo,
  type Tree,
  type ZoteroImportResult,
  type ZoteroLink,
  deleteZoteroLink,
  moveFile,
  previewMove,
  putFile,
  refreshZoteroLink,
  setZoteroAutoSync,
} from "../api";
import {
  dropTargetPath,
  formatRefQuestion,
  validateMoveTarget,
} from "../lib/move";
import {
  type TreeNode,
  buildTreeNodes,
  filterTreeNodes,
  isImageFile,
  isTexFile,
} from "../lib/tree";
import {
  type ResolvedUpload,
  type UploadCandidate,
  type UploadProgress,
  buildUploadTargetPath,
  candidatesFromFileList,
  findCollisions,
  formatIncludeGraphicsSnippet,
  formatUploadError,
  isIncludeGraphicsAsset,
  isInsideUninitializedSubmodule,
  processDroppedTransfer,
  resolveEffectiveCompileRoot,
} from "../lib/upload";
import {
  formatZoteroError,
  isZoteroRowControlDisabled,
  zoteroLinkTitle,
} from "../lib/zotero";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ImageIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SubmoduleIcon,
  TrashIcon,
  UnlinkIcon,
  UploadIcon,
} from "./Icons";
import { Avatars } from "./Avatars";
import { Modal } from "./Modal";
import type { ToastAction, ToastItem } from "./Toast";
import { ZoteroImportModal } from "./ZoteroImportModal";

export interface NotifyOptions {
  action?: ToastAction;
  durationMs?: number;
}

interface PendingCollision {
  resolved: ResolvedUpload[];
  collisions: string[];
  targetDir: string;
  invalidNames: string[];
}

/** Drag type of tree rows being moved (file uploads use the browser's "Files"). */
const MOVE_MIME = "application/x-undertree-path";

/** Rename/move in progress: typing the target ("input"), or asking about references ("refs"). */
interface MoveState {
  from: string;
  to: string;
  stage: "input" | "refs" | "confirm";
  refs: MoveReference[];
  busy: boolean;
  error: string | null;
}

interface FileTreeProps {
  tree: Tree | null;
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  /** username of the logged-in user */
  self: string;
  /** online users per open file */
  presenceByFile: Map<string, PresenceUser[]>;
  /** directories containing a file from `presenceByFile` */
  presenceDirs: Set<string>;
  rootPaths?: ReadonlySet<string>;
  compileRoot?: string | null;
  zoteroLinks?: ZoteroLink[];
  readOnly?: boolean;
  openCommentsByFile?: ReadonlyMap<string, number>;
  onSelectFile: (path: string, repo: string) => void;
  onRefresh: () => void | Promise<void>;
  onZoteroChanged?: () => void | Promise<void>;
  onCreateFile: (path: string) => Promise<void>;
  onDeleteFile: (path: string) => Promise<void>;
  onOpenGitForRepo: (repoPath: string) => void;
  onNotify: (
    kind: ToastItem["kind"],
    message: string,
    options?: NotifyOptions,
  ) => void;
}

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

function isMoveDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(MOVE_MIME);
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to execCommand below
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function FileTree({
  tree,
  loading,
  error,
  selectedPath,
  self,
  presenceByFile,
  presenceDirs,
  rootPaths,
  compileRoot,
  zoteroLinks = [],
  readOnly = false,
  openCommentsByFile,
  onSelectFile,
  onRefresh,
  onZoteroChanged,
  onCreateFile,
  onDeleteFile,
  onOpenGitForRepo,
  onNotify,
}: FileTreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [isSidebarDragOver, setIsSidebarDragOver] = useState(false);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const [dropTargetBlocked, setDropTargetBlocked] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  const [pendingCollision, setPendingCollision] =
    useState<PendingCollision | null>(null);
  const [zoteroModalOpen, setZoteroModalOpen] = useState(false);
  const [refreshingZoteroPath, setRefreshingZoteroPath] = useState<
    string | null
  >(null);
  const [unlinkingZoteroPath, setUnlinkingZoteroPath] = useState<string | null>(
    null,
  );
  const [move, setMove] = useState<MoveState | null>(null);
  const [moveDropDir, setMoveDropDir] = useState<string | null>(null);
  /** path of the tree row being dragged (shows the root drop zone) */
  const [draggingPath, setDraggingPath] = useState<string | null>(null);

  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetDirRef = useRef<string>("");

  const parentRepo: Repo | undefined = useMemo(
    () => tree?.repos.find((r) => r.kind === "parent"),
    [tree],
  );

  const submodules: Repo[] = useMemo(
    () => tree?.repos.filter((r) => r.kind === "submodule") ?? [],
    [tree],
  );

  const existingFilePaths = useMemo(() => {
    const set = new Set<string>();
    for (const entry of tree?.entries ?? []) {
      if (entry.kind === "file") {
        set.add(entry.path);
      }
    }
    return set;
  }, [tree]);

  const zoteroByPath = useMemo(() => {
    const map = new Map<string, ZoteroLink>();
    for (const link of zoteroLinks) {
      map.set(link.path, link);
    }
    return map;
  }, [zoteroLinks]);

  const allNodes = useMemo(() => (tree ? buildTreeNodes(tree) : []), [tree]);
  const visibleNodes = useMemo(
    () => filterTreeNodes(allNodes, query),
    [allNodes, query],
  );

  const isExpanded = (path: string, depth: number): boolean => {
    if (query.trim().length > 0) return true;
    const val = expanded[path];
    if (val !== undefined) return val;
    return depth < 2;
  };

  const toggleDir = (path: string, depth: number) => {
    setExpanded((prev) => ({
      ...prev,
      [path]: !isExpanded(path, depth),
    }));
  };

  const resetDragState = () => {
    dragDepthRef.current = 0;
    setIsSidebarDragOver(false);
    setDropTargetDir(null);
    setDropTargetBlocked(false);
  };

  const startCreateIn = (prefix: string) => {
    if (readOnly) return;
    setCreating(true);
    setCreateError(null);
    setNewPath(prefix ? `${prefix}/` : "");
  };

  const openFilePicker = (targetDir: string) => {
    if (readOnly) return;
    if (uploadProgress) {
      onNotify("info", "Ein Upload läuft bereits — bitte kurz warten.");
      return;
    }
    const blocked = isInsideUninitializedSubmodule(
      targetDir,
      tree?.repos ?? [],
    );
    if (blocked) {
      onNotify(
        "error",
        `Upload in das nicht initialisierte Submodul „${blocked.path}“ ist nicht möglich. Bitte zuerst im Git-Panel initialisieren.`,
      );
      return;
    }
    uploadTargetDirRef.current = targetDir;
    const input = fileInputRef.current;
    if (input) {
      input.value = "";
      input.click();
    }
  };

  const executeUpload = async (
    items: ResolvedUpload[],
    targetDir: string,
    invalidNames: string[],
  ) => {
    if (items.length === 0) {
      if (invalidNames.length > 0) {
        onNotify(
          "error",
          `${invalidNames.length} ungültige Datei(en) übersprungen (z. B. ${invalidNames[0]}).`,
        );
      }
      return;
    }

    const succeeded: ResolvedUpload[] = [];
    const errors: string[] = [];

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        setUploadProgress({
          current: i + 1,
          total: items.length,
          fileName: item.file.name,
        });
        try {
          await putFile(item.targetPath, item.file);
          succeeded.push(item);
        } catch (err: unknown) {
          errors.push(formatUploadError(err, item.file.name));
        }
      }
    } finally {
      setUploadProgress(null);
    }

    if (succeeded.length > 0) {
      if (targetDir) {
        setExpanded((prev) => ({ ...prev, [targetDir]: true }));
      }
      await onRefresh();
    }

    if (invalidNames.length > 0) {
      onNotify(
        "error",
        `${invalidNames.length} ungültige Datei(en) übersprungen (z. B. ${invalidNames[0]}).`,
      );
    }

    if (errors.length === 1) {
      onNotify("error", errors[0]!);
    } else if (errors.length > 1) {
      onNotify(
        "error",
        `${errors.length} Dateien fehlgeschlagen — ${errors[0]}`,
      );
    }

    if (succeeded.length > 0) {
      const uploadedGraphics = succeeded.filter((item) =>
        isIncludeGraphicsAsset(item.targetPath),
      );
      const summary =
        succeeded.length === 1
          ? `Hochgeladen: ${succeeded[0]!.targetPath}`
          : `${succeeded.length} Dateien hochgeladen`;

      if (uploadedGraphics.length > 0) {
        const fallbackRoot =
          selectedPath && (!rootPaths || rootPaths.has(selectedPath))
            ? selectedPath
            : null;
        const activeCompileRoot = resolveEffectiveCompileRoot(
          compileRoot,
          fallbackRoot,
        );
        const snippets = uploadedGraphics
          .map((item) =>
            formatIncludeGraphicsSnippet(
              item.targetPath,
              activeCompileRoot,
              tree?.repos,
            ),
          )
          .filter((s): s is string => s !== null);

        if (snippets.length > 0) {
          const snippet = snippets.join("\n");
          const skippedCount = uploadedGraphics.length - snippets.length;
          const summaryWithNote =
            skippedCount > 0 && activeCompileRoot
              ? `${summary} (${skippedCount} außerhalb des Compile-Verzeichnisses)`
              : summary;
          const label =
            snippets.length === 1
              ? "\\includegraphics kopieren"
              : `\\includegraphics kopieren (${snippets.length})`;

          onNotify("success", summaryWithNote, {
            durationMs: 8000,
            action: {
              label,
              onClick: () => {
                void copyTextToClipboard(snippet).then((ok) => {
                  if (ok) {
                    onNotify("info", "LaTeX-Snippet in Zwischenablage kopiert");
                  } else {
                    onNotify(
                      "error",
                      "Kopieren in die Zwischenablage fehlgeschlagen.",
                    );
                  }
                });
              },
            },
          });
        } else if (activeCompileRoot) {
          onNotify(
            "success",
            `${summary} — liegt außerhalb des Compile-Verzeichnisses von ${activeCompileRoot} (kein \\includegraphics-Snippet)`,
            { durationMs: 6000 },
          );
        } else {
          onNotify("success", summary);
        }
      } else {
        onNotify("success", summary);
      }
    }
  };

  const handleUploadCandidates = async (
    candidates: UploadCandidate[],
    targetDir: string,
  ) => {
    if (candidates.length === 0) return;
    if (uploadProgress) {
      onNotify("info", "Ein Upload läuft bereits — bitte kurz warten.");
      return;
    }

    const repos = tree?.repos ?? [];
    const targetBlocked = isInsideUninitializedSubmodule(targetDir, repos);
    if (targetBlocked) {
      onNotify(
        "error",
        `Upload in das nicht initialisierte Submodul „${targetBlocked.path}“ ist nicht möglich. Bitte zuerst im Git-Panel initialisieren.`,
      );
      return;
    }

    const resolvedMap = new Map<string, ResolvedUpload>();
    const invalidNames: string[] = [];
    const blockedSubmodulePaths = new Set<string>();

    for (const candidate of candidates) {
      const targetPath = buildUploadTargetPath(
        targetDir,
        candidate.relativePath,
      );
      if (!targetPath) {
        invalidNames.push(candidate.relativePath);
        continue;
      }
      const blocked = isInsideUninitializedSubmodule(targetPath, repos);
      if (blocked) {
        blockedSubmodulePaths.add(blocked.path);
        continue;
      }
      resolvedMap.set(targetPath, {
        file: candidate.file,
        relativePath: candidate.relativePath,
        targetPath,
      });
    }

    if (blockedSubmodulePaths.size > 0) {
      const names = Array.from(blockedSubmodulePaths).join(", ");
      onNotify(
        "error",
        `Upload in nicht initialisierte(s) Submodul(e) abgelehnt: ${names}. Bitte zuerst im Git-Panel initialisieren.`,
      );
    }

    const resolved = Array.from(resolvedMap.values());
    if (resolved.length === 0) {
      if (invalidNames.length > 0) {
        onNotify(
          "error",
          `Ungültiger Dateipfad: ${invalidNames[0]}${invalidNames.length > 1 ? ` (+${invalidNames.length - 1} weitere)` : ""}`,
        );
      }
      return;
    }

    const collisions = findCollisions(resolved, existingFilePaths);
    if (collisions.length > 0) {
      setPendingCollision({ resolved, collisions, targetDir, invalidNames });
      return;
    }

    await executeUpload(resolved, targetDir, invalidNames);
  };

  const handleFileInputChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const candidates = candidatesFromFileList(input.files);
    const targetDir = uploadTargetDirRef.current;
    input.value = "";
    void handleUploadCandidates(candidates, targetDir);
  };

  const handleSidebarDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (readOnly) return;
    dragDepthRef.current += 1;
    setIsSidebarDragOver(true);
  };

  const handleSidebarDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (readOnly) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      return;
    }
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    if (dropTargetDir !== null) {
      setDropTargetDir(null);
      setDropTargetBlocked(false);
    }
  };

  const handleSidebarDragLeave = (e: DragEvent) => {
    if (readOnly || !isFileDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsSidebarDragOver(false);
      setDropTargetDir(null);
      setDropTargetBlocked(false);
    }
  };

  const handleSidebarDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (readOnly) return;
    resetDragState();
    const dt = e.dataTransfer;
    if (!dt) return;
    void processDroppedTransfer(
      dt,
      (candidates) => handleUploadCandidates(candidates, ""),
      (msg) => onNotify("error", msg),
    );
  };

  const handleDirDragOver = (
    e: DragEvent,
    dirPath: string,
    isUninitialized: boolean,
  ) => {
    if (readOnly) {
      if (isFileDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      }
      return;
    }
    if (isMoveDrag(e)) {
      if (isUninitialized) return;
      e.preventDefault();
      e.stopPropagation();
      if (moveDropDir !== dirPath) setMoveDropDir(dirPath);
      return;
    }
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = isUninitialized ? "none" : "copy";
    }
    if (dropTargetDir !== dirPath || dropTargetBlocked !== isUninitialized) {
      setDropTargetDir(dirPath);
      setDropTargetBlocked(isUninitialized);
    }
  };

  const handleDirDragLeave = (e: DragEvent, dirPath: string) => {
    if (readOnly) return;
    if (isMoveDrag(e) && moveDropDir === dirPath) setMoveDropDir(null);
    const currentTarget = e.currentTarget as HTMLElement | null;
    const related = e.relatedTarget as Node | null;
    if (currentTarget && related && currentTarget.contains(related)) return;
    if (dropTargetDir === dirPath) {
      setDropTargetDir(null);
      setDropTargetBlocked(false);
    }
  };

  const handleDirDrop = (
    e: DragEvent,
    dirPath: string,
    isUninitialized: boolean,
  ) => {
    if (readOnly) {
      if (isFileDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (isMoveDrag(e)) {
      if (!isUninitialized) handleMoveDrop(e, dirPath);
      return;
    }
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    resetDragState();
    if (isUninitialized) {
      onNotify(
        "error",
        `Upload in das nicht initialisierte Submodul „${dirPath}“ ist nicht möglich. Bitte zuerst im Git-Panel initialisieren.`,
      );
      return;
    }
    const dt = e.dataTransfer;
    if (!dt) return;
    void processDroppedTransfer(
      dt,
      (candidates) => handleUploadCandidates(candidates, dirPath),
      (msg) => onNotify("error", msg),
    );
  };

  const handleCreateSubmit = async (e: Event) => {
    e.preventDefault();
    const trimmed = newPath.trim().replace(/^\/+/, "");
    if (!trimmed) {
      setCreateError("Pfad darf nicht leer sein.");
      return;
    }
    setSubmitting(true);
    setCreateError(null);
    try {
      await onCreateFile(trimmed);
      setCreating(false);
      setNewPath("");
    } catch (err: unknown) {
      setCreateError(
        err instanceof Error
          ? err.message
          : "Datei konnte nicht erstellt werden.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleMoveDrop = (e: DragEvent, dirPath: string) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setMoveDropDir(null);
    setDraggingPath(null);
    const from = e.dataTransfer?.getData(MOVE_MIME);
    const to = from ? dropTargetPath(from, dirPath) : null;
    // a drop is easy to do by accident: always ask first
    if (from && to)
      setMove({
        from,
        to,
        stage: "confirm",
        refs: [],
        busy: false,
        error: null,
      });
  };

  /**
   * Moves `from` to `to`. Looks for references first: if there are any, the user is asked whether
   * to update them. `interactive` = the rename dialog is open (errors show there, else as toast).
   */
  const requestMove = async (
    from: string,
    to: string,
    interactive: boolean,
  ) => {
    if (interactive) {
      const stage = move?.stage === "confirm" ? "confirm" : "input";
      setMove({ from, to, stage, refs: [], busy: true, error: null });
    }
    try {
      const refs = await previewMove(from, to);
      if (refs.length === 0) {
        await runMove(from, to, false, interactive);
      } else {
        setMove({ from, to, stage: "refs", refs, busy: false, error: null });
      }
    } catch (err: unknown) {
      failMove(err, from, interactive);
    }
  };

  const runMove = async (
    from: string,
    to: string,
    updateRefs: boolean,
    inDialog: boolean,
  ) => {
    setMove((m) => (m ? { ...m, busy: true, error: null } : m));
    try {
      const result = await moveFile(from, to, updateRefs);
      setMove(null);
      await onRefresh();
      const refCount = result.updated_refs.reduce((n, r) => n + r.count, 0);
      onNotify(
        "success",
        `${from} → ${to}${refCount > 0 ? ` (${refCount} Verweise angepasst)` : ""}`,
      );
    } catch (err: unknown) {
      failMove(err, from, inDialog);
    }
  };

  const failMove = (err: unknown, from: string, inDialog: boolean) => {
    const msg =
      err instanceof Error
        ? err.message
        : `Verschieben von ${from} fehlgeschlagen.`;
    if (inDialog) {
      setMove((m) =>
        m ? { ...m, stage: "input", busy: false, error: msg } : m,
      );
    } else {
      onNotify("error", msg);
    }
  };

  const handleMoveSubmit = (e: Event) => {
    e.preventDefault();
    if (!move || move.busy) return;
    const to = move.to.trim();
    const problem = validateMoveTarget(move.from, to);
    if (problem) {
      setMove({ ...move, error: problem });
      return;
    }
    void requestMove(move.from, to, true);
  };

  const startRowDrag = (e: DragEvent, path: string) => {
    if (readOnly || !e.dataTransfer) return;
    e.dataTransfer.setData(MOVE_MIME, path);
    e.dataTransfer.effectAllowed = "move";
    setDraggingPath(path);
  };

  const endRowDrag = () => {
    setMoveDropDir(null);
    setDraggingPath(null);
  };

  const startMoveDialog = (path: string) => {
    if (readOnly) return;
    setMove({
      from: path,
      to: path,
      stage: "input",
      refs: [],
      busy: false,
      error: null,
    });
  };

  const handleDelete = async (e: MouseEvent, path: string) => {
    e.stopPropagation();
    if (readOnly) return;
    const ok = window.confirm(`Datei "${path}" wirklich löschen?`);
    if (!ok) return;
    await onDeleteFile(path);
  };

  const handleZoteroImported = async (result: ZoteroImportResult) => {
    const parts = result.path.split("/");
    if (parts.length > 1) {
      setExpanded((prev) => {
        const next = { ...prev };
        let prefix = "";
        for (let i = 0; i < parts.length - 1; i++) {
          prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
          next[prefix] = true;
        }
        return next;
      });
    }
    await onRefresh();
    await onZoteroChanged?.();
    onNotify(
      "success",
      `${result.entries} Einträge nach ${result.path} importiert`,
    );
  };

  const handleRefreshZotero = async (path: string) => {
    if (refreshingZoteroPath || unlinkingZoteroPath) return;
    setRefreshingZoteroPath(path);
    try {
      const result = await refreshZoteroLink(path);
      await onRefresh();
      await onZoteroChanged?.();
      onNotify(
        "success",
        `${result.entries} Einträge nach ${result.path} importiert`,
      );
    } catch (err: unknown) {
      if (
        err instanceof ApiError &&
        (err.status === 409 || err.status === 404)
      ) {
        await onZoteroChanged?.();
      }
      onNotify(
        "error",
        formatZoteroError(err, `Aktualisierung von ${path} fehlgeschlagen.`),
      );
    } finally {
      setRefreshingZoteroPath(null);
    }
  };

  const handleZoteroAutoSync = async (path: string, on: boolean) => {
    if (refreshingZoteroPath || unlinkingZoteroPath) return;
    try {
      await setZoteroAutoSync(path, on);
    } catch (err) {
      onNotify(
        "error",
        formatZoteroError(
          err,
          `Automatische Synchronisierung von ${path} nicht änderbar.`,
        ),
      );
    }
    await onZoteroChanged?.();
  };

  const handleUnlinkZotero = async (path: string) => {
    if (refreshingZoteroPath || unlinkingZoteroPath) return;
    setUnlinkingZoteroPath(path);
    try {
      await deleteZoteroLink(path);
      await onZoteroChanged?.();
      onNotify("info", `Zotero-Verknüpfung für ${path} gelöst`);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        await onZoteroChanged?.();
      }
      onNotify(
        "error",
        formatZoteroError(
          err,
          `Verknüpfung für ${path} konnte nicht gelöst werden.`,
        ),
      );
    } finally {
      setUnlinkingZoteroPath(null);
    }
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const paddingLeft = 10 + depth * 14;

    if (node.kind === "dir") {
      const sub = node.submodule;
      const isSubmodule = Boolean(sub);
      const isUninitialized = Boolean(sub && !sub.initialized);
      const open = !isUninitialized && isExpanded(node.path, depth);
      const isDropTarget = isSidebarDragOver && dropTargetDir === node.path;

      return (
        <div key={node.path}>
          <div
            class={`tree-row tree-dir ${isSubmodule ? "tree-submodule" : ""} ${
              isUninitialized ? "is-uninitialized" : ""
            } ${
              isDropTarget
                ? isUninitialized
                  ? "is-drop-blocked"
                  : "is-drop-target"
                : ""
            } ${moveDropDir === node.path ? "is-drop-target" : ""}`}
            style={{ paddingLeft: `${paddingLeft}px` }}
            draggable={!readOnly && !isSubmodule}
            onDragStart={(e) => startRowDrag(e, node.path)}
            onDragEnd={endRowDrag}
            role="treeitem"
            aria-expanded={isUninitialized ? undefined : open}
            title={
              isUninitialized
                ? `${node.path} — nicht initialisiertes Git-Submodul (im Git-Panel aktualisieren)`
                : sub
                  ? `Submodul ${sub.path} (${sub.branch ?? "detached"} @ ${sub.head ?? "—"})`
                  : node.path
            }
            onClick={() => {
              if (isUninitialized) {
                onOpenGitForRepo("");
              } else {
                toggleDir(node.path, depth);
              }
            }}
            onDragOver={(e) => handleDirDragOver(e, node.path, isUninitialized)}
            onDragLeave={(e) => handleDirDragLeave(e, node.path)}
            onDrop={(e) => handleDirDrop(e, node.path, isUninitialized)}
          >
            <span class="tree-chevron">
              {isUninitialized ? null : open ? (
                <ChevronDownIcon size={13} />
              ) : (
                <ChevronRightIcon size={13} />
              )}
            </span>

            <span
              class={`tree-icon ${isSubmodule ? "icon-submodule" : "icon-folder"}`}
            >
              {isSubmodule ? (
                <SubmoduleIcon size={14} />
              ) : open ? (
                <FolderOpenIcon size={14} />
              ) : (
                <FolderIcon size={14} />
              )}
            </span>

            <span class="tree-label">{node.name}</span>

            {presenceDirs.has(node.path) && (
              <span
                class="presence-dot"
                role="img"
                title="Hier arbeitet gerade jemand"
                aria-label="Hier arbeitet gerade jemand"
              />
            )}

            {isSubmodule && sub && (
              <span class="tree-badges">
                {sub.initialized ? (
                  <>
                    <span class="badge badge-submodule">SUB</span>
                    {sub.branch && (
                      <span class="badge badge-branch">{sub.branch}</span>
                    )}
                    {!sub.branch && sub.head && (
                      <span class="badge badge-detached">{sub.head}</span>
                    )}
                  </>
                ) : (
                  <span class="badge badge-uninit">nicht init.</span>
                )}
              </span>
            )}

            {!isUninitialized && (isSubmodule || !readOnly) && (
              <span class="tree-row-actions">
                {isSubmodule && sub && (
                  <button
                    type="button"
                    class="icon-btn"
                    title={`Git-Panel für Submodul ${sub.name} öffnen`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenGitForRepo(sub.path);
                    }}
                  >
                    <GitBranchIcon size={12} />
                  </button>
                )}
                {!readOnly && (
                  <>
                    {!isSubmodule && (
                      <button
                        type="button"
                        class="icon-btn"
                        title={`${node.name} umbenennen / verschieben`}
                        aria-label={`${node.name} umbenennen oder verschieben`}
                        onClick={(e) => {
                          e.stopPropagation();
                          startMoveDialog(node.path);
                        }}
                      >
                        <EditIcon size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      class="icon-btn"
                      title={`Dateien in ${node.path} hochladen`}
                      aria-label={`Dateien in ${node.path} hochladen`}
                      disabled={Boolean(uploadProgress)}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFilePicker(node.path);
                      }}
                    >
                      <UploadIcon size={12} />
                    </button>
                    <button
                      type="button"
                      class="icon-btn"
                      title={`Neue Datei in ${node.path}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        startCreateIn(node.path);
                      }}
                    >
                      <PlusIcon size={12} />
                    </button>
                  </>
                )}
              </span>
            )}
          </div>

          {open && node.children.length > 0 && (
            <div role="group">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const active = selectedPath === node.path;
    const tex = isTexFile(node.path);
    const img = isImageFile(node.path);
    const bib = node.path.toLowerCase().endsWith(".bib");
    const here = presenceByFile.get(node.path);
    const openCommentCount = openCommentsByFile?.get(node.path) ?? 0;
    const zoteroLink = zoteroByPath.get(node.path);
    const isRefreshingZotero = refreshingZoteroPath === node.path;
    const isUnlinkingZotero = unlinkingZoteroPath === node.path;
    const zoteroDisconnected = zoteroLink?.account_id === null;
    const zoteroBusy = isZoteroRowControlDisabled({
      refreshingPath: refreshingZoteroPath,
      unlinkingPath: unlinkingZoteroPath,
    });
    const refreshDisabled = isZoteroRowControlDisabled({
      refreshingPath: refreshingZoteroPath,
      unlinkingPath: unlinkingZoteroPath,
      disconnected: zoteroDisconnected,
    });

    return (
      <div
        key={node.path}
        class={`tree-row tree-file ${active ? "is-selected" : ""}`}
        style={{ paddingLeft: `${paddingLeft + 16}px` }}
        role="treeitem"
        aria-selected={active}
        title={node.path}
        draggable={!readOnly}
        onDragStart={(e) => startRowDrag(e, node.path)}
        onDragEnd={endRowDrag}
        onClick={() => onSelectFile(node.path, node.repo)}
      >
        <span
          class={`tree-icon ${
            tex ? "icon-tex" : bib ? "icon-bib" : img ? "icon-img" : "icon-file"
          }`}
        >
          {img ? <ImageIcon size={14} /> : <FileIcon size={14} />}
        </span>
        <span class="tree-label">{node.name}</span>
        {zoteroLink && (
          <span
            class={`badge badge-zotero ${zoteroDisconnected || zoteroLink.last_error ? "is-disconnected" : ""}`}
            title={
              zoteroDisconnected
                ? "Zotero-Konto wurde getrennt — bitte über Import neu verknüpfen"
                : zoteroLinkTitle(zoteroLink)
            }
          >
            Zotero
          </span>
        )}
        {openCommentCount > 0 && (
          <span
            class="badge badge-comments"
            title={`${openCommentCount} offene${openCommentCount === 1 ? "r Kommentar" : " Kommentare"}`}
            aria-label={`${openCommentCount} offene Kommentare`}
          >
            <MessageSquareIcon size={10} />
            <span>{openCommentCount}</span>
          </span>
        )}
        {here && <Avatars users={here} self={self} max={3} small />}
        {!readOnly && (
          <span
            class={`tree-row-actions ${isRefreshingZotero ? "is-busy" : ""}`}
          >
            {zoteroLink && (
              <>
                <input
                  type="checkbox"
                  checked={zoteroLink.auto_sync}
                  disabled={zoteroBusy || zoteroDisconnected}
                  title="Automatisch synchronisieren (überschreibt lokale Änderungen der Datei bei der nächsten Änderung in Zotero)"
                  aria-label={`${node.name} automatisch mit Zotero synchronisieren`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    void handleZoteroAutoSync(
                      node.path,
                      e.currentTarget.checked,
                    );
                  }}
                />
                <button
                  type="button"
                  class="icon-btn"
                  disabled={refreshDisabled}
                  title={
                    zoteroDisconnected
                      ? "Zotero-Konto wurde getrennt — bitte über Import neu verknüpfen"
                      : zoteroBusy && !isRefreshingZotero
                        ? "Zotero-Aktion läuft bereits"
                        : "Aus Zotero aktualisieren"
                  }
                  aria-label={
                    zoteroDisconnected
                      ? "Zotero-Konto wurde getrennt — bitte über Import neu verknüpfen"
                      : `${node.name} aus Zotero aktualisieren`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleRefreshZotero(node.path);
                  }}
                >
                  <RefreshIcon
                    size={12}
                    class={isRefreshingZotero ? "spin" : ""}
                  />
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  disabled={zoteroBusy}
                  title={
                    zoteroBusy && !isUnlinkingZotero
                      ? "Zotero-Aktion läuft bereits"
                      : "Zotero-Verknüpfung lösen"
                  }
                  aria-label={`Zotero-Verknüpfung für ${node.name} lösen`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleUnlinkZotero(node.path);
                  }}
                >
                  <UnlinkIcon size={12} />
                </button>
              </>
            )}
            <button
              type="button"
              class="icon-btn"
              title={`${node.name} umbenennen / verschieben`}
              aria-label={`${node.name} umbenennen oder verschieben`}
              onClick={(e) => {
                e.stopPropagation();
                startMoveDialog(node.path);
              }}
            >
              <EditIcon size={12} />
            </button>
            <button
              type="button"
              class="icon-btn icon-btn-danger"
              title={`${node.name} löschen`}
              onClick={(e) => void handleDelete(e, node.path)}
            >
              <TrashIcon size={12} />
            </button>
          </span>
        )}
      </div>
    );
  };

  const collisionNonOverlapCount = pendingCollision
    ? pendingCollision.resolved.length - pendingCollision.collisions.length
    : 0;

  return (
    <aside
      class={`sidebar ${isSidebarDragOver ? "is-drag-over" : ""}`}
      onDragEnter={handleSidebarDragEnter}
      onDragOver={handleSidebarDragOver}
      onDragLeave={handleSidebarDragLeave}
      onDrop={handleSidebarDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        class="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileInputChange}
      />

      <div class="sidebar-header">
        <div class="repo-header-info">
          <span class="badge badge-parent">ROOT</span>
          <span class="repo-name" title={parentRepo?.name ?? "Workspace"}>
            {parentRepo?.name ?? "Workspace"}
          </span>
          {parentRepo?.branch && (
            <button
              type="button"
              class="repo-branch-pill"
              title="Git-Panel für Parent-Repo öffnen"
              onClick={() => onOpenGitForRepo("")}
            >
              <GitBranchIcon size={11} />
              <span>{parentRepo.branch}</span>
              {parentRepo.head && (
                <span class="mono-dim">{parentRepo.head}</span>
              )}
            </button>
          )}
        </div>
        <div class="sidebar-actions">
          {!readOnly && (
            <>
              <button
                type="button"
                class="icon-btn"
                title="Aus Zotero importieren"
                aria-label="Aus Zotero importieren"
                onClick={() => setZoteroModalOpen(true)}
              >
                <BookOpenIcon size={14} />
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Dateien hochladen (Root)"
                aria-label="Dateien hochladen"
                disabled={Boolean(uploadProgress)}
                onClick={() => openFilePicker("")}
              >
                <UploadIcon size={14} />
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Neue Datei anlegen"
                onClick={() => startCreateIn("")}
              >
                <PlusIcon size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            class="icon-btn"
            title="Dateibaum neu laden"
            onClick={() => void onRefresh()}
            disabled={loading}
          >
            <RefreshIcon size={14} class={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {submodules.length > 0 && (
        <div class="submodule-summary">
          <span>
            {submodules.filter((s) => s.initialized).length}/{submodules.length}{" "}
            Submodule aktiv
          </span>
        </div>
      )}

      <div class="sidebar-search">
        <SearchIcon size={13} class="search-icon" />
        <input
          type="search"
          class="search-input"
          placeholder="Dateien filtern…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      {!readOnly && creating && (
        <form
          class="create-file-form"
          onSubmit={(e) => void handleCreateSubmit(e)}
        >
          <input
            type="text"
            class="text-input"
            placeholder="z. B. papers/icml/intro.tex"
            value={newPath}
            autoFocus
            disabled={submitting}
            onInput={(e) => setNewPath((e.target as HTMLInputElement).value)}
          />
          {createError && <div class="form-error">{createError}</div>}
          <div class="create-file-actions">
            <button
              type="submit"
              class="btn-primary btn-xs"
              disabled={submitting}
            >
              Erstellen
            </button>
            <button
              type="button"
              class="btn-ghost btn-xs"
              disabled={submitting}
              onClick={() => setCreating(false)}
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}

      {uploadProgress && (
        <div class="upload-progress" role="status" aria-live="polite">
          <div class="upload-progress-text">
            Lade hoch {uploadProgress.current}/{uploadProgress.total}:{" "}
            {uploadProgress.fileName}…
          </div>
          <div class="upload-progress-track">
            <div
              class="upload-progress-bar"
              style={{
                width: `${Math.round((uploadProgress.current / uploadProgress.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      <div class="tree-scroll" role="tree" aria-label="Workspace-Dateibaum">
        {error && <div class="tree-empty tree-error">{error}</div>}
        {!error && loading && !tree && (
          <div class="tree-empty">Lade Dateibaum…</div>
        )}
        {!error && tree && visibleNodes.length === 0 && (
          <div class="tree-empty">
            {query ? "Keine passenden Dateien." : "Workspace ist leer."}
          </div>
        )}
        {visibleNodes.map((node) => renderNode(node, 0))}
      </div>

      {!readOnly &&
        draggingPath !== null &&
        dropTargetPath(draggingPath, "") !== null && (
          <div
            class={`tree-root-drop ${moveDropDir === "" ? "is-drop-target" : ""}`}
            onDragOver={(e) => {
              if (!isMoveDrag(e)) return;
              e.preventDefault();
              if (moveDropDir !== "") setMoveDropDir("");
            }}
            onDragLeave={() => setMoveDropDir((d) => (d === "" ? null : d))}
            onDrop={(e) => isMoveDrag(e) && handleMoveDrop(e, "")}
          >
            In den Workspace-Root verschieben
          </div>
        )}

      {isSidebarDragOver && (
        <div
          class={`sidebar-drop-banner ${dropTargetBlocked ? "is-blocked" : ""}`}
          aria-live="polite"
        >
          <UploadIcon size={14} />
          <span>
            {dropTargetBlocked && dropTargetDir
              ? `Submodul „${dropTargetDir}“ nicht initialisiert`
              : dropTargetDir
                ? `In „${dropTargetDir}“ ablegen…`
                : "Dateien hier ablegen…"}
          </span>
        </div>
      )}

      {pendingCollision && (
        <Modal
          title={
            pendingCollision.collisions.length === 1
              ? "Vorhandene Datei überschreiben?"
              : "Vorhandene Dateien überschreiben?"
          }
          onClose={() => setPendingCollision(null)}
        >
          <div class="form-stack">
            <p class="muted-text" style={{ margin: 0 }}>
              {pendingCollision.collisions.length === 1
                ? "Diese Datei existiert bereits im Workspace:"
                : `${pendingCollision.collisions.length} Dateien existieren bereits im Workspace:`}
            </p>
            <ul class="upload-collision-list">
              {pendingCollision.collisions.map((path) => (
                <li key={path}>
                  <code class="mono">{path}</code>
                </li>
              ))}
            </ul>
            <div class="form-actions">
              <button
                type="button"
                class="btn-ghost btn-sm"
                onClick={() => setPendingCollision(null)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                class="btn-ghost btn-sm"
                disabled={collisionNonOverlapCount === 0}
                title={
                  collisionNonOverlapCount === 0
                    ? "Alle ausgewählten Dateien existieren bereits"
                    : `${collisionNonOverlapCount} neue Datei(en) hochladen`
                }
                onClick={() => {
                  const current = pendingCollision;
                  const collisionSet = new Set(current.collisions);
                  const remaining = current.resolved.filter(
                    (item) => !collisionSet.has(item.targetPath),
                  );
                  setPendingCollision(null);
                  void executeUpload(
                    remaining,
                    current.targetDir,
                    current.invalidNames,
                  );
                }}
              >
                Überspringen
              </button>
              <button
                type="button"
                class="btn-danger btn-sm"
                onClick={() => {
                  const current = pendingCollision;
                  setPendingCollision(null);
                  void executeUpload(
                    current.resolved,
                    current.targetDir,
                    current.invalidNames,
                  );
                }}
              >
                Überschreiben
              </button>
            </div>
          </div>
        </Modal>
      )}

      {!readOnly && move && (
        <Modal
          title={
            move.stage === "refs"
              ? "Verweise mitändern?"
              : move.stage === "confirm"
                ? "Verschieben"
                : "Umbenennen / Verschieben"
          }
          busy={move.busy}
          onClose={() => setMove(null)}
        >
          {move.stage === "confirm" ? (
            <div class="form-stack">
              <p style={{ margin: 0 }}>
                <code class="mono">{move.from}</code> nach{" "}
                <code class="mono">{move.to}</code> verschieben?
              </p>
              <div class="form-actions">
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  disabled={move.busy}
                  onClick={() => setMove(null)}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  class="btn-primary btn-sm"
                  disabled={move.busy}
                  onClick={() => void requestMove(move.from, move.to, true)}
                >
                  Verschieben
                </button>
              </div>
            </div>
          ) : move.stage === "input" ? (
            <form class="form-stack" onSubmit={handleMoveSubmit}>
              <label class="form-label">
                Neuer Pfad für <code class="mono">{move.from}</code>
                <input
                  type="text"
                  class="text-input"
                  value={move.to}
                  autoFocus
                  disabled={move.busy}
                  onInput={(e) =>
                    setMove({
                      ...move,
                      to: (e.target as HTMLInputElement).value,
                      error: null,
                    })
                  }
                />
              </label>
              <p class="muted-text" style={{ margin: 0 }}>
                Anderer Ordner im Pfad = verschieben (innerhalb desselben
                Repos).
              </p>
              {move.error && <div class="form-error">{move.error}</div>}
              <div class="form-actions">
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  disabled={move.busy}
                  onClick={() => setMove(null)}
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  class="btn-primary btn-sm"
                  disabled={move.busy}
                >
                  Verschieben
                </button>
              </div>
            </form>
          ) : (
            <div class="form-stack">
              <p style={{ margin: 0 }}>
                <strong>{formatRefQuestion(move.refs)}</strong>
              </p>
              <ul class="upload-collision-list">
                {move.refs.slice(0, 8).map((r) => (
                  <li key={`${r.path}:${r.line}:${r.old}`}>
                    <code class="mono">
                      {r.path}:{r.line}
                    </code>{" "}
                    <code class="mono">{r.old}</code> →{" "}
                    <code class="mono">{r.new}</code>
                  </li>
                ))}
                {move.refs.length > 8 && (
                  <li>… und {move.refs.length - 8} weitere</li>
                )}
              </ul>
              {move.error && <div class="form-error">{move.error}</div>}
              <div class="form-actions">
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  disabled={move.busy}
                  onClick={() => setMove(null)}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  disabled={move.busy}
                  onClick={() => void runMove(move.from, move.to, false, true)}
                >
                  Nein
                </button>
                <button
                  type="button"
                  class="btn-primary btn-sm"
                  disabled={move.busy}
                  onClick={() => void runMove(move.from, move.to, true, true)}
                >
                  Ja
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {!readOnly && zoteroModalOpen && (
        <ZoteroImportModal
          existingPaths={existingFilePaths}
          defaultPath={
            selectedPath && selectedPath.toLowerCase().endsWith(".bib")
              ? selectedPath
              : "references.bib"
          }
          onImported={handleZoteroImported}
          onClose={() => setZoteroModalOpen(false)}
        />
      )}
    </aside>
  );
}
