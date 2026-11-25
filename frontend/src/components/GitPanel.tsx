import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type GitLogEntry,
  type GitStatus,
  type Repo,
  type ServerEvent,
  getCoAuthors,
  getGitDiff,
  getGitLog,
  getGitStatus,
  gitCommit,
  gitPull,
  gitPush,
  gitSubmoduleUpdate,
} from "../api";
import {
  coAuthorsForCommit,
  coAuthorsOfRepo,
  statusOfRepo,
  type RepoCoAuthors,
  describeGitStatus,
  formatCommitDate,
  formatRelativeRepoPath,
  parseUnifiedDiff,
} from "../lib/gitUi";
import { AlertIcon, GitBranchIcon, RefreshIcon, SubmoduleIcon, XIcon } from "./Icons";

export interface GitPanelProps {
  repos: Repo[];
  selectedRepo: string;
  readOnly?: boolean;
  onSelectRepo: (repo: string) => void;
  lastEvent: ServerEvent | null;
  onClose: () => void;
  onNotify: (kind: "info" | "success" | "error", msg: string) => void;
  onTreeRefresh: () => void;
}

type GitTab = "changes" | "log";
type BusyAction = "pull" | "push" | "submodule" | "commit" | null;

interface GitErrorBanner {
  title: string;
  code: string;
  status: number | null;
  detail: string;
}

function formatApiError(err: unknown, fallbackAction: string): GitErrorBanner {
  if (err instanceof ApiError) {
    if (err.status === 409 || err.code === "conflict") {
      return {
        title: `Konflikt bei ${fallbackAction} (409 conflict)`,
        code: err.code,
        status: err.status,
        detail: err.message,
      };
    }
    if (err.status === 502 || err.code === "git_failed") {
      return {
        title: `Git-Fehler bei ${fallbackAction} (502 git_failed)`,
        code: err.code,
        status: err.status,
        detail: err.message || "git wurde mit einem Fehlercode beendet.",
      };
    }
    return {
      title: `Fehler bei ${fallbackAction} (${err.status} ${err.code})`,
      code: err.code,
      status: err.status,
      detail: err.message,
    };
  }
  return {
    title: `Fehler bei ${fallbackAction}`,
    code: "unknown",
    status: null,
    detail: err instanceof Error ? err.message : String(err),
  };
}

function ArrowDownIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function GitPanel({
  repos,
  selectedRepo,
  readOnly = false,
  onSelectRepo,
  lastEvent,
  onClose,
  onNotify,
  onTreeRefresh,
}: GitPanelProps) {
  const activeRepo = useMemo<Repo | undefined>(() => {
    return repos.find((r) => r.path === selectedRepo) ?? repos[0];
  }, [repos, selectedRepo]);

  const activeRepoPath = activeRepo?.path ?? "";
  const isInitialized = activeRepo ? activeRepo.initialized : true;

  const [activeTab, setActiveTab] = useState<GitTab>("changes");
  const [loadedStatus, setStatus] = useState<GitStatus | null>(null);
  // a status still loading for the previous repo must never drive selection, co-authors or commit
  const status = statusOfRepo(loadedStatus, activeRepoPath);
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [errorBanner, setErrorBanner] = useState<GitErrorBanner | null>(null);

  // Selected files for commit (all checked by default; track manually unchecked paths)
  const [uncheckedPaths, setUncheckedPaths] = useState<Set<string>>(() => new Set());
  // Scope commit message drafts per repo so switching repos never bleeds or wipes another repo's draft
  const [commitMessagesByRepo, setCommitMessagesByRepo] = useState<Record<string, string>>({});
  const commitMessage = commitMessagesByRepo[activeRepoPath] ?? "";
  const setCommitMessage = useCallback(
    (value: string) => {
      setCommitMessagesByRepo((prev) => ({ ...prev, [activeRepoPath]: value }));
    },
    [activeRepoPath]
  );

  // Diff viewer state: undefined = closed, null = whole repo diff, string = specific file path
  const [diffTarget, setDiffTarget] = useState<string | null | undefined>(undefined);
  const [diffStaged, setDiffStaged] = useState(false);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);

  const loadSeqRef = useRef(0);
  const diffSeqRef = useRef(0);
  const activeRepoRef = useRef(activeRepoPath);
  activeRepoRef.current = activeRepoPath;

  // Co-authors detected for the next commit (all checked by default; track unchecked usernames)
  // tagged with their repo: after a repo switch the previous list must never reach a commit
  const [detectedCoAuthors, setDetectedCoAuthors] = useState<RepoCoAuthors>({ repo: "", list: [] });
  const coAuthors = coAuthorsOfRepo(detectedCoAuthors, activeRepoPath);
  const [uncheckedCoAuthors, setUncheckedCoAuthors] = useState<Set<string>>(() => new Set());

  // Reset per-repo transient UI when switching repos
  useEffect(() => {
    setUncheckedPaths(new Set());
    setUncheckedCoAuthors(new Set());
    setDiffTarget(undefined);
    setDiffStaged(false);
    setDiffText("");
    setErrorBanner(null);
  }, [activeRepoPath]);

  const loadRepoData = useCallback(
    async (repoPath: string, initialized: boolean) => {
      const seq = ++loadSeqRef.current;
      if (!initialized) {
        setStatus(null);
        setLogEntries([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const [nextStatus, nextLog] = await Promise.all([
          getGitStatus(repoPath),
          getGitLog(repoPath, 20),
        ]);
        if (seq !== loadSeqRef.current) return;
        setStatus(nextStatus);
        setLogEntries(nextLog);
        // Drop unchecked entries that are no longer in status.files
        const present = new Set(nextStatus.files.map((f) => f.path));
        setUncheckedPaths((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set<string>();
          for (const p of prev) {
            if (present.has(p)) next.add(p);
          }
          return next;
        });
      } catch (err: unknown) {
        if (seq !== loadSeqRef.current) return;
        setErrorBanner(formatApiError(err, "Status/Verlauf laden"));
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    void loadRepoData(activeRepoPath, isInitialized);
  }, [activeRepoPath, isInitialized, loadRepoData]);

  const loadDiff = useCallback(
    async (repoPath: string, target: string | null | undefined, staged: boolean) => {
      if (target === undefined || !isInitialized) return;
      const seq = ++diffSeqRef.current;
      setDiffLoading(true);
      try {
        const raw = await getGitDiff(repoPath, target ?? undefined, staged);
        if (seq !== diffSeqRef.current) return;
        setDiffText(raw);
      } catch (err: unknown) {
        if (seq !== diffSeqRef.current) return;
        setErrorBanner(formatApiError(err, "Diff laden"));
        setDiffText("");
      } finally {
        if (seq === diffSeqRef.current) {
          setDiffLoading(false);
        }
      }
    },
    [isInitialized]
  );

  useEffect(() => {
    void loadDiff(activeRepoPath, diffTarget, diffStaged);
  }, [activeRepoPath, diffTarget, diffStaged, loadDiff]);

  // React automatically to server git_changed events
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== "git_changed") return;
    if (lastEvent.repo === activeRepoPath || activeRepoPath === "") {
      void loadRepoData(activeRepoPath, isInitialized);
      if (diffTarget !== undefined) {
        void loadDiff(activeRepoPath, diffTarget, diffStaged);
      }
    }
  }, [lastEvent, activeRepoPath, isInitialized, diffTarget, diffStaged, loadRepoData, loadDiff]);

  const statusFiles = useMemo(() => status?.files ?? [], [status]);

  const selectedPaths = useMemo(
    () => statusFiles.map((f) => f.path).filter((p) => !uncheckedPaths.has(p)),
    [statusFiles, uncheckedPaths]
  );

  const allSelected = statusFiles.length > 0 && selectedPaths.length === statusFiles.length;

  // Reload detected co-authors whenever status or the file selection changes
  const coAuthorSeqRef = useRef(0);
  const selectionKey = allSelected ? "" : selectedPaths.join("\0");
  useEffect(() => {
    const seq = ++coAuthorSeqRef.current;
    if (!isInitialized || !status || selectedPaths.length === 0) {
      setDetectedCoAuthors({ repo: activeRepoPath, list: [] });
      return;
    }
    const repo = activeRepoPath;
    getCoAuthors(activeRepoPath, allSelected ? undefined : selectedPaths)
      .then((list) => {
        if (seq === coAuthorSeqRef.current) setDetectedCoAuthors({ repo, list });
      })
      .catch(() => {
        if (seq === coAuthorSeqRef.current) setDetectedCoAuthors({ repo, list: [] });
      });
    // selectedPaths/allSelected are covered by selectionKey
  },[activeRepoPath, isInitialized, status, selectionKey]);

  const toggleCoAuthor = (username: string) => {
    setUncheckedCoAuthors((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const parsedDiffLines = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  const toggleFileSelection = (path: string) => {
    setUncheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setUncheckedPaths(new Set(statusFiles.map((f) => f.path)));
    } else {
      setUncheckedPaths(new Set());
    }
  };

  const handleRefresh = () => {
    setErrorBanner(null);
    void loadRepoData(activeRepoPath, isInitialized);
    if (diffTarget !== undefined) {
      void loadDiff(activeRepoPath, diffTarget, diffStaged);
    }
  };

  const handlePull = async () => {
    if (busyAction || !isInitialized) return;
    setBusyAction("pull");
    setErrorBanner(null);
    try {
      const out = await gitPull(activeRepoPath);
      const summary = out.stdout.trim().split("\n")[0];
      onNotify("success", summary ? `Pull erfolgreich: ${summary}` : "Pull erfolgreich.");
      onTreeRefresh();
      await loadRepoData(activeRepoPath, true);
      if (diffTarget !== undefined) {
        await loadDiff(activeRepoPath, diffTarget, diffStaged);
      }
    } catch (err: unknown) {
      setErrorBanner(formatApiError(err, "Pull"));
    } finally {
      setBusyAction(null);
    }
  };

  const handlePush = async () => {
    if (busyAction || !isInitialized) return;
    setBusyAction("push");
    setErrorBanner(null);
    try {
      await gitPush(activeRepoPath);
      onNotify("success", "Push erfolgreich.");
      await loadRepoData(activeRepoPath, true);
    } catch (err: unknown) {
      setErrorBanner(formatApiError(err, "Push"));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSubmoduleUpdate = async (targetSubmodulePath?: string) => {
    if (busyAction) return;
    setBusyAction("submodule");
    setErrorBanner(null);
    try {
      await gitSubmoduleUpdate(targetSubmodulePath, true);
      onNotify(
        "success",
        targetSubmodulePath
          ? `Submodul aktualisiert: ${targetSubmodulePath}`
          : "Submodule aktualisiert."
      );
      onTreeRefresh();
      await loadRepoData(activeRepoPath, true);
      if (diffTarget !== undefined) {
        await loadDiff(activeRepoPath, diffTarget, diffStaged);
      }
    } catch (err: unknown) {
      setErrorBanner(
        formatApiError(
          err,
          targetSubmodulePath ? `Submodul-Update (${targetSubmodulePath})` : "Submodule-Update"
        )
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCommit = async (ev?: Event) => {
    ev?.preventDefault();
    const targetRepo = activeRepoPath;
    const trimmed = commitMessage.trim();
    if (busyAction || !isInitialized || !trimmed || selectedPaths.length === 0) return;

    setBusyAction("commit");
    setErrorBanner(null);
    try {
      const res = await gitCommit(
        targetRepo,
        trimmed,
        selectedPaths,
        coAuthorsForCommit(coAuthors, uncheckedCoAuthors)
      );
      setCommitMessagesByRepo((prev) => ({ ...prev, [targetRepo]: "" }));
      onNotify("success", `Commit erstellt: ${res.short}`);
      onTreeRefresh();
      if (activeRepoRef.current === targetRepo) {
        setUncheckedPaths(new Set());
        setUncheckedCoAuthors(new Set());
        await loadRepoData(targetRepo, true);
        if (diffTarget !== undefined) {
          await loadDiff(targetRepo, diffTarget, diffStaged);
        }
      }
    } catch (err: unknown) {
      if (activeRepoRef.current === targetRepo) {
        setErrorBanner(formatApiError(err, "Commit"));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyError = async () => {
    if (!errorBanner) return;
    const text = `${errorBanner.title}\n${errorBanner.detail}`.trim();
    try {
      await navigator.clipboard.writeText(text);
      onNotify("info", "Fehlermeldung in die Zwischenablage kopiert.");
    } catch {
      onNotify("error", "Kopieren in die Zwischenablage fehlgeschlagen.");
    }
  };

  const branchLabel = status
    ? status.branch ?? "detached HEAD"
    : activeRepo?.branch ?? "detached HEAD";
  const isDetached = status ? status.branch === null : activeRepo?.branch === null;
  const submoduleTarget = activeRepo?.kind === "submodule" ? activeRepo.path : undefined;

  return (
    <aside class="git-drawer" aria-label="Git-Panel">
      <div class="pane-toolbar">
        <span class="drawer-title">
          <GitBranchIcon size={14} />
          <span>Git &amp; Submodule</span>
        </span>
        <div class="git-toolbar-right">
          {readOnly && (
            <span
              class="badge badge-readonly"
              title="Nur Lesen — Git-Schreibaktionen sind deaktiviert"
            >
              Nur Lesen
            </span>
          )}
          <button
            type="button"
            class="icon-btn"
            title="Git-Status neu laden"
            aria-label="Git-Status neu laden"
            disabled={loading || busyAction !== null}
            onClick={handleRefresh}
          >
            <RefreshIcon size={14} class={loading ? "spin" : undefined} />
          </button>
          <button type="button" class="icon-btn" aria-label="Schließen" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <div class="git-panel-body">
        {/* Repo Selector: Parent (ROOT) + Submodules */}
        <section class="git-repo-selector" aria-label="Repository-Auswahl">
          {repos.map((repo) => {
            const isSelected = repo.path === activeRepoPath;
            return (
              <button
                key={repo.path || "__parent__"}
                type="button"
                class={`git-repo-chip ${isSelected ? "is-selected" : ""} ${
                  !repo.initialized ? "is-uninit" : ""
                }`}
                disabled={busyAction !== null}
                onClick={() => onSelectRepo(repo.path)}
                title={repo.path || repo.name}
              >
                <span class="git-repo-chip-left">
                  {repo.kind === "submodule" ? (
                    <SubmoduleIcon size={13} class="icon-submodule" />
                  ) : (
                    <GitBranchIcon size={13} />
                  )}
                  <span class="git-repo-chip-name">{repo.path || repo.name}</span>
                </span>
                <span class="git-repo-chip-badges">
                  <span
                    class={`badge ${
                      repo.kind === "submodule" ? "badge-submodule" : "badge-parent"
                    }`}
                  >
                    {repo.kind === "submodule" ? "SUB" : "ROOT"}
                  </span>
                  {!repo.initialized && <span class="badge badge-uninit">nicht init.</span>}
                </span>
              </button>
            );
          })}
        </section>

        {/* Error & Stderr Box */}
        {errorBanner && (
          <div class="git-error-box" role="alert">
            <div class="git-error-header">
              <span class="git-error-title">
                <AlertIcon size={14} />
                <span>{errorBanner.title}</span>
              </span>
              <div class="git-error-actions">
                <button
                  type="button"
                  class="icon-btn"
                  title="Fehlertext kopieren"
                  aria-label="Fehlertext kopieren"
                  onClick={() => void handleCopyError()}
                >
                  <CopyIcon />
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  title="Fehlermeldung schließen"
                  aria-label="Fehlermeldung schließen"
                  onClick={() => setErrorBanner(null)}
                >
                  <XIcon size={13} />
                </button>
              </div>
            </div>
            {errorBanner.detail && <pre class="git-error-pre">{errorBanner.detail}</pre>}
          </div>
        )}

        {/* Uninitialized Submodule Callout */}
        {activeRepo && !activeRepo.initialized ? (
          <div class="git-uninit-card">
            <SubmoduleIcon size={22} class="icon-submodule" />
            <h4>Submodul nicht initialisiert</h4>
            <p class="muted-text">
              Das Submodul <span class="mono">{activeRepo.path}</span> wurde noch nicht
              ausgecheckt. Initialisiere es, um Dateien zu bearbeiten und Git-Aktionen auszuführen.
            </p>
            {readOnly ? (
              <span class="muted-text">
                Nur Bearbeiter oder Eigentümer können Submodule initialisieren.
              </span>
            ) : (
              <button
                type="button"
                class="btn-primary btn-sm"
                disabled={busyAction !== null}
                onClick={() => void handleSubmoduleUpdate(activeRepo.path)}
              >
                {busyAction === "submodule" ? "Initialisiere…" : "Submodul initialisieren"}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Branch / Upstream / Ahead-Behind Header */}
            <section class="git-status-header">
              <div class="git-branch-row">
                <span class={`badge ${isDetached ? "badge-detached" : "badge-branch"}`}>
                  <GitBranchIcon size={11} />
                  <span>{branchLabel}</span>
                </span>
                {activeRepo?.head && isDetached && (
                  <span class="mono-dim">{activeRepo.head}</span>
                )}
                <div class="git-sync-pills">
                  {(status?.ahead ?? 0) > 0 && (
                    <span class="git-ab-pill git-ahead" title={`${status?.ahead} Commits voraus`}>
                      ↑ {status?.ahead}
                    </span>
                  )}
                  {(status?.behind ?? 0) > 0 && (
                    <span
                      class="git-ab-pill git-behind"
                      title={`${status?.behind} Commits zurück`}
                    >
                      ↓ {status?.behind}
                    </span>
                  )}
                </div>
              </div>
              <div class="git-upstream-row">
                <span class="mono-dim">
                  {status?.upstream ? `Upstream: ${status.upstream}` : "Kein Upstream konfiguriert"}
                </span>
              </div>
            </section>

            {/* Actions Toolbar: Pull / Push / Submodule Update */}
            {!readOnly && (
              <section class="git-actions-bar" aria-label="Git-Aktionen">
                <button
                  type="button"
                  class="btn-ghost btn-xs"
                  disabled={busyAction !== null}
                  onClick={() => void handlePull()}
                  title="git pull --ff-only"
                >
                  <ArrowDownIcon />
                  <span>{busyAction === "pull" ? "Pull…" : "Pull"}</span>
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-xs"
                  disabled={busyAction !== null}
                  onClick={() => void handlePush()}
                  title="git push"
                >
                  <ArrowUpIcon />
                  <span>{busyAction === "push" ? "Push…" : "Push"}</span>
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-xs git-action-sub"
                  disabled={busyAction !== null}
                  onClick={() => void handleSubmoduleUpdate(submoduleTarget)}
                  title={
                    submoduleTarget
                      ? `git submodule update --init --remote -- ${submoduleTarget}`
                      : "git submodule update --init --remote (alle Submodule)"
                  }
                >
                  <SubmoduleIcon size={13} />
                  <span>
                    {busyAction === "submodule"
                      ? "Aktualisiere…"
                      : submoduleTarget
                        ? "Submodul aktualisieren"
                        : "Submodule aktualisieren"}
                  </span>
                </button>
              </section>
            )}

            {/* Tabs: Änderungen (N) | Verlauf */}
            <div class="git-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "changes"}
                class={`git-tab ${activeTab === "changes" ? "is-active" : ""}`}
                onClick={() => setActiveTab("changes")}
              >
                Änderungen ({statusFiles.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "log"}
                class={`git-tab ${activeTab === "log" ? "is-active" : ""}`}
                onClick={() => setActiveTab("log")}
              >
                Verlauf ({logEntries.length})
              </button>
            </div>

            {activeTab === "changes" ? (
              <div class="git-tab-content">
                {readOnly ? (
                  <div class="git-commit-actions">
                    <button
                      type="button"
                      class={`btn-ghost btn-xs ${diffTarget === null ? "is-active" : ""}`}
                      onClick={() =>
                        setDiffTarget((prev) => (prev === null ? undefined : null))
                      }
                    >
                      Gesamt-Diff
                    </button>
                  </div>
                ) : (
                  <form class="git-commit-form" onSubmit={(e) => void handleCommit(e)}>
                    <textarea
                      class="git-commit-input"
                      rows={2}
                      placeholder="Commit-Nachricht eingeben…"
                      value={commitMessage}
                      disabled={busyAction !== null}
                      onInput={(e) => setCommitMessage((e.target as HTMLTextAreaElement).value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                          void handleCommit();
                        }
                      }}
                    />
                    {coAuthors.length > 0 && (
                      <fieldset class="git-coauthors" disabled={busyAction !== null}>
                        <span title="Werden als Co-authored-by im Commit genannt">Mitautoren:</span>
                        {coAuthors.map((c) => (
                          <label key={c.username} class="git-select-all" title={c.username}>
                            <input
                              type="checkbox"
                              checked={!uncheckedCoAuthors.has(c.username)}
                              onChange={() => toggleCoAuthor(c.username)}
                            />
                            <span>{c.display_name}</span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <div class="git-commit-actions">
                      <button
                        type="submit"
                        class="btn-primary btn-xs git-commit-btn"
                        disabled={
                          busyAction !== null ||
                          commitMessage.trim().length === 0 ||
                          selectedPaths.length === 0
                        }
                      >
                        {busyAction === "commit"
                          ? "Commite…"
                          : selectedPaths.length > 0
                            ? `Commit (${selectedPaths.length} ${
                                selectedPaths.length === 1 ? "Datei" : "Dateien"
                              })`
                            : "Commit"}
                      </button>
                      <button
                        type="button"
                        class={`btn-ghost btn-xs ${diffTarget === null ? "is-active" : ""}`}
                        onClick={() =>
                          setDiffTarget((prev) => (prev === null ? undefined : null))
                        }
                      >
                        Gesamt-Diff
                      </button>
                    </div>
                  </form>
                )}

                {/* Changed Files List */}
                <div class="git-files-section">
                  {!readOnly && statusFiles.length > 0 && (
                    <div class="git-files-toolbar">
                      <label class="git-select-all">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                        />
                        <span>
                          {selectedPaths.length}/{statusFiles.length} ausgewählt
                        </span>
                      </label>
                    </div>
                  )}

                  {loading && !status ? (
                    <div class="git-empty">Lade Git-Status…</div>
                  ) : statusFiles.length === 0 ? (
                    <div class="git-empty">Arbeitsverzeichnis ist sauber.</div>
                  ) : (
                    <ul class="git-file-list">
                      {statusFiles.map((file) => {
                        const info = describeGitStatus(file.index, file.worktree);
                        const checked = !uncheckedPaths.has(file.path);
                        const isDiffOpen = diffTarget === file.path;
                        const displayPath = formatRelativeRepoPath(file.path, activeRepoPath);
                        return (
                          <li
                            key={file.path}
                            class={`git-file-row ${isDiffOpen ? "is-selected" : ""}`}
                          >
                            {!readOnly && (
                              <input
                                type="checkbox"
                                class="git-file-checkbox"
                                checked={checked}
                                aria-label={`${displayPath} für Commit auswählen`}
                                onChange={() => toggleFileSelection(file.path)}
                              />
                            )}
                            <button
                              type="button"
                              class="git-file-btn"
                              title={`${file.path} — ${info.label} (${file.index}${file.worktree})`}
                              onClick={() =>
                                setDiffTarget((prev) =>
                                  prev === file.path ? undefined : file.path
                                )
                              }
                            >
                              <span
                                class={`git-xy-badge ${info.cssClass}`}
                                title={info.label}
                              >
                                {info.code}
                              </span>
                              <span class="git-file-path mono">{displayPath}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* Inline Unified Diff Viewer */}
                {diffTarget !== undefined && (
                  <section class="git-diff-box" aria-label="Diff-Ansicht">
                    <div class="git-diff-header">
                      <span
                        class="git-diff-title mono"
                        title={diffTarget ?? "Gesamtes Repository"}
                      >
                        {diffTarget
                          ? formatRelativeRepoPath(diffTarget, activeRepoPath)
                          : "Gesamt-Diff"}
                      </span>
                      <div class="git-diff-controls">
                        <div class="git-diff-mode" role="group" aria-label="Diff-Modus">
                          <button
                            type="button"
                            class={`git-mode-btn ${!diffStaged ? "is-active" : ""}`}
                            onClick={() => setDiffStaged(false)}
                          >
                            Arbeitsverzeichnis
                          </button>
                          <button
                            type="button"
                            class={`git-mode-btn ${diffStaged ? "is-active" : ""}`}
                            onClick={() => setDiffStaged(true)}
                          >
                            Staged
                          </button>
                        </div>
                        <button
                          type="button"
                          class="icon-btn"
                          aria-label="Diff schließen"
                          onClick={() => setDiffTarget(undefined)}
                        >
                          <XIcon size={13} />
                        </button>
                      </div>
                    </div>

                    <div class="git-diff-content">
                      {diffLoading ? (
                        <div class="git-empty">Lade Diff…</div>
                      ) : parsedDiffLines.length === 0 ? (
                        <div class="git-empty">
                          Kein Diff im Modus „{diffStaged ? "Staged" : "Arbeitsverzeichnis"}“
                          verfügbar.
                        </div>
                      ) : (
                        <div class="git-diff-lines" role="region" aria-label="Unified Diff">
                          {parsedDiffLines.map((line, idx) => (
                            <div key={idx} class={`diff-line diff-${line.kind}`}>
                              <span class="diff-ln">{line.oldLine ?? ""}</span>
                              <span class="diff-ln">{line.newLine ?? ""}</span>
                              <span class="diff-text">{line.text || " "}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </div>
            ) : (
              <div class="git-tab-content">
                {loading && logEntries.length === 0 ? (
                  <div class="git-empty">Lade Verlauf…</div>
                ) : logEntries.length === 0 ? (
                  <div class="git-empty">Noch keine Commits vorhanden.</div>
                ) : (
                  <ul class="git-log-list">
                    {logEntries.map((entry) => (
                      <li key={entry.sha} class="git-log-item">
                        <div class="git-log-top">
                          <span class="git-log-sha mono" title={entry.sha}>
                            {entry.short}
                          </span>
                          <span class="git-log-date mono-dim" title={entry.date}>
                            {formatCommitDate(entry.date)}
                          </span>
                        </div>
                        <div class="git-log-subject">{entry.subject}</div>
                        <div class="git-log-author">{entry.author}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
