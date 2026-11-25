/**
 * Pure UI helpers for the Git panel:
 * - Porcelain v1 XY status code interpretation
 * - Unified diff line classification & line-number parsing
 * - Repo-relative path & date formatting
 */

export type GitStatusBadgeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflict"
  | "unknown";

export interface GitStatusInfo {
  /** Compact 1-2 char code shown inside the badge (e.g. "M", "A", "MM", "?", "UU"). */
  code: string;
  /** Human-readable German description for tooltips / screen readers. */
  label: string;
  /** Semantic category for styling and grouping. */
  kind: GitStatusBadgeKind;
  /** CSS class suffix/name for badge coloring. */
  cssClass: string;
  /** Whether the file has staged (index) changes. */
  staged: boolean;
  /** Whether the file has unstaged (worktree) changes. */
  unstaged: boolean;
  isUntracked: boolean;
  isConflict: boolean;
}

function normalizeCodeChar(value: string): string {
  if (!value) return " ";
  const ch = value[0] ?? " ";
  return ch === "." ? " " : ch;
}

function singleCharCategory(ch: string): { kind: GitStatusBadgeKind; label: string } {
  switch (ch) {
    case "M":
    case "T":
      return { kind: "modified", label: "Geändert" };
    case "A":
      return { kind: "added", label: "Hinzugefügt" };
    case "D":
      return { kind: "deleted", label: "Gelöscht" };
    case "R":
      return { kind: "renamed", label: "Umbenannt" };
    case "C":
      return { kind: "copied", label: "Kopiert" };
    case "?":
      return { kind: "untracked", label: "Unversioniert" };
    case "U":
      return { kind: "conflict", label: "Konflikt" };
    default:
      return { kind: "unknown", label: "Geändert" };
  }
}

/**
 * Interprets Git porcelain v1 XY status codes (index = X, worktree = Y)
 * into badge code, German label, semantic kind, and CSS class.
 */
export function describeGitStatus(index: string, worktree: string): GitStatusInfo {
  const x = normalizeCodeChar(index);
  const y = normalizeCodeChar(worktree);

  const isConflict =
    x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");

  if (isConflict) {
    const code = `${x}${y}`.trim() || "U";
    return {
      code,
      label: "Merge-Konflikt",
      kind: "conflict",
      cssClass: "git-badge-conflict",
      staged: x !== " ",
      unstaged: y !== " ",
      isUntracked: false,
      isConflict: true,
    };
  }

  if (x === "?" && y === "?") {
    return {
      code: "?",
      label: "Unversioniert",
      kind: "untracked",
      cssClass: "git-badge-untracked",
      staged: false,
      unstaged: true,
      isUntracked: true,
      isConflict: false,
    };
  }

  if (x === "!" && y === "!") {
    return {
      code: "!",
      label: "Ignoriert",
      kind: "unknown",
      cssClass: "git-badge-unknown",
      staged: false,
      unstaged: false,
      isUntracked: false,
      isConflict: false,
    };
  }

  const staged = x !== " ";
  const unstaged = y !== " ";

  let code: string;
  if (staged && unstaged) {
    code = `${x}${y}`;
  } else if (staged) {
    code = x;
  } else if (unstaged) {
    code = y;
  } else {
    code = "·";
  }

  // Prefer staged category for A/R/C/D, otherwise worktree category if present.
  let primaryChar = " ";
  if (staged && (x === "A" || x === "R" || x === "C" || x === "D")) {
    primaryChar = x;
  } else if (unstaged) {
    primaryChar = y;
  } else if (staged) {
    primaryChar = x;
  }

  const { kind, label: baseLabel } = singleCharCategory(primaryChar);
  let label = baseLabel;
  if (staged && unstaged) {
    label = `${baseLabel} (staged + lokal)`;
  } else if (staged) {
    label = `${baseLabel} (staged)`;
  }

  return {
    code,
    label,
    kind,
    cssClass: `git-badge-${kind}`,
    staged,
    unstaged,
    isUntracked: false,
    isConflict: false,
  };
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const META_PREFIXES = [
  "diff --git ",
  "index ",
  "--- ",
  "+++ ",
  "new file mode ",
  "deleted file mode ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
  "GIT binary patch",
  "\\ No newline at end of file",
];

/**
 * Classifies a single line from a unified diff output.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) {
    return "hunk";
  }
  for (const prefix of META_PREFIXES) {
    if (line.startsWith(prefix)) {
      return "meta";
    }
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "ctx";
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a raw unified diff string into classified lines with old/new line numbers.
 */
export function parseUnifiedDiff(raw: string): DiffLine[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");

  const result: DiffLine[] = [];
  let oldCur: number | null = null;
  let newCur: number | null = null;

  for (const text of lines) {
    const kind = classifyDiffLine(text);

    if (kind === "meta") {
      if (text.startsWith("diff --git ")) {
        oldCur = null;
        newCur = null;
      }
      result.push({ kind, text, oldLine: null, newLine: null });
      continue;
    }

    if (kind === "hunk") {
      const match = HUNK_HEADER_RE.exec(text);
      if (match) {
        oldCur = Number.parseInt(match[1] ?? "0", 10);
        newCur = Number.parseInt(match[2] ?? "0", 10);
      } else {
        oldCur = null;
        newCur = null;
      }
      result.push({ kind, text, oldLine: null, newLine: null });
      continue;
    }

    if (kind === "del") {
      const oldLine = oldCur;
      if (oldCur !== null) oldCur += 1;
      result.push({ kind, text, oldLine, newLine: null });
      continue;
    }

    if (kind === "add") {
      const newLine = newCur;
      if (newCur !== null) newCur += 1;
      result.push({ kind, text, oldLine: null, newLine });
      continue;
    }

    const oldLine = oldCur;
    const newLine = newCur;
    if (oldCur !== null) oldCur += 1;
    if (newCur !== null) newCur += 1;
    result.push({ kind: "ctx", text, oldLine, newLine });
  }

  return result;
}

/**
 * Strips the submodule prefix from a workspace-relative path for compact display.
 */
export function formatRelativeRepoPath(filePath: string, repoPath: string): string {
  if (!repoPath) return filePath;
  const prefix = `${repoPath}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

/**
 * Formats an ISO 8601 git author date concisely for the log list.
 */
export function formatCommitDate(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(parsed.getDate());
  const month = pad(parsed.getMonth() + 1);
  const year = parsed.getFullYear();
  const hours = pad(parsed.getHours());
  const minutes = pad(parsed.getMinutes());
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * `co_authors` for the commit request: `undefined` (the server uses everyone it detects, also
 * edits made after the list was loaded) unless the user unchecked someone.
 */
export function coAuthorsForCommit(
  detected: { username: string }[],
  unchecked: ReadonlySet<string>
): string[] | undefined {
  if (!detected.some((c) => unchecked.has(c.username))) return undefined;
  return detected.map((c) => c.username).filter((u) => !unchecked.has(u));
}

/** Co-authors detected for `repo`; a commit must never send another repo's names. */
export interface RepoCoAuthors {
  repo: string;
  list: { username: string; display_name: string }[];
}

export function coAuthorsOfRepo(detected: RepoCoAuthors, repo: string): RepoCoAuthors["list"] {
  return detected.repo === repo ? detected.list : [];
}

/** `status` only if it was loaded for `repo` (it lags behind a repo switch until refetched). */
export function statusOfRepo<T extends { repo: string }>(status: T | null, repo: string): T | null {
  return status?.repo === repo ? status : null;
}
