import { ApiError, type Repo } from "../api";
import { isTexFile } from "./tree";

export interface UploadCandidate {
  file: File;
  /** Relative path within the dropped/selected batch (e.g. "plot.png" or "figs/plot.png"). */
  relativePath: string;
}

export interface ResolvedUpload {
  file: File;
  relativePath: string;
  targetPath: string;
}

export interface UploadProgress {
  current: number;
  total: number;
  fileName: string;
}

const INCLUDEGRAPHICS_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".pdf",
  ".eps",
]);

interface FileSystemEntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  readonly isFile: true;
  file: (success: (file: File) => void, error?: (err: unknown) => void) => void;
}

interface FileSystemDirectoryReaderLike {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    error?: (err: unknown) => void
  ) => void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  readonly isDirectory: true;
  createReader: () => FileSystemDirectoryReaderLike;
}

interface WebkitDataTransferItem extends Omit<DataTransferItem, "webkitGetAsEntry"> {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
}

/**
 * Validates and normalizes a single path segment for uploads.
 * Rejects empty segments, `.`, `..`, `.git`, slashes, backslashes, and NUL bytes.
 */
export function sanitizeUploadSegment(name: string): string | null {
  if (name.includes("\0") || name.includes("\\") || name.includes("/")) {
    return null;
  }
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed === "." || trimmed === ".." || trimmed.toLowerCase() === ".git") {
    return null;
  }
  return trimmed;
}

/**
 * Combines a workspace target directory and a relative upload path into a safe
 * workspace-relative path. Strips leading/duplicate slashes and rejects traversal,
 * `.git`, backslashes, and NUL bytes.
 */
export function buildUploadTargetPath(
  targetDir: string,
  relativeFilePath: string
): string | null {
  if (
    targetDir.includes("\\") ||
    targetDir.includes("\0") ||
    relativeFilePath.includes("\\") ||
    relativeFilePath.includes("\0")
  ) {
    return null;
  }

  const dirSegments: string[] = [];
  for (const raw of targetDir.split("/")) {
    if (!raw) continue;
    const clean = sanitizeUploadSegment(raw);
    if (!clean) return null;
    dirSegments.push(clean);
  }

  const normalizedRel = relativeFilePath.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!normalizedRel || normalizedRel.endsWith("/")) {
    return null;
  }

  const relSegments: string[] = [];
  for (const raw of normalizedRel.split("/")) {
    const clean = sanitizeUploadSegment(raw);
    if (!clean) return null;
    relSegments.push(clean);
  }

  if (relSegments.length === 0) return null;
  return [...dirSegments, ...relSegments].join("/");
}

/**
 * Returns the uninitialized submodule containing `targetPath` (or matching it),
 * or `null` if `targetPath` is in the parent repo or an initialized submodule.
 */
export function isInsideUninitializedSubmodule(
  targetPath: string,
  repos: Repo[]
): Repo | null {
  const normalized = targetPath.replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;

  let matched: Repo | null = null;
  for (const repo of repos) {
    if (repo.kind !== "submodule" || repo.initialized || !repo.path) continue;
    const repoPath = repo.path.replace(/^\/+|\/+$/g, "");
    if (!repoPath) continue;
    if (normalized === repoPath || normalized.startsWith(`${repoPath}/`)) {
      if (!matched || repoPath.length > matched.path.length) {
        matched = repo;
      }
    }
  }
  return matched;
}

/**
 * Checks whether a path has an extension suitable for LaTeX `\includegraphics`.
 */
export function isIncludeGraphicsAsset(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return INCLUDEGRAPHICS_EXTENSIONS.has(base.slice(dot));
}

function findContainingRepoPath(path: string, repos?: Repo[]): string {
  if (!repos || repos.length === 0) return "";
  const normalized = path.replace(/^\/+|\/+$/g, "");
  let best = "";
  for (const repo of repos) {
    if (repo.kind !== "submodule" || !repo.path) continue;
    const repoPath = repo.path.replace(/^\/+|\/+$/g, "");
    if (normalized === repoPath || normalized.startsWith(`${repoPath}/`)) {
      if (repoPath.length > best.length) {
        best = repoPath;
      }
    }
  }
  return best;
}

/**
 * Picks the effective TeX root whose working directory and compile snapshot are
 * used for `\includegraphics` snippets. Prefers `compileRoot` (`PdfPanel`'s
 * `selectedRoot` passed to `triggerCompile`), falling back to `selectedPath` if
 * it is itself a `.tex` file.
 */
export function resolveEffectiveCompileRoot(
  compileRoot?: string | null,
  selectedPath?: string | null
): string | null {
  if (compileRoot) return compileRoot;
  if (selectedPath && isTexFile(selectedPath)) return selectedPath;
  return null;
}

/**
 * Resolves the `\includegraphics` path for `filePath` constrained to the backend
 * compile snapshot (`dirname(compileRootPath)` in `src/compile.rs`) and relative to
 * the compile root working directory (not a nested `\input` editor file). Returns
 * `null` if `filePath` lies outside that compile snapshot and therefore cannot be
 * read by the sandboxed `latexmk` run.
 *
 * When `compileRootPath` is not set, resolves relative to `filePath`'s containing
 * submodule root (or workspace root).
 */
export function resolveIncludeGraphicsPath(
  filePath: string,
  compileRootPath?: string | null,
  repos?: Repo[]
): string | null {
  const cleanFile = filePath.replace(/^\/+/, "");
  const cleanRoot = compileRootPath?.replace(/^\/+/, "") ?? "";
  if (!cleanFile) return null;

  if (!cleanRoot) {
    const baseDir = findContainingRepoPath(cleanFile, repos);
    if (!baseDir) return cleanFile;
    return cleanFile.startsWith(`${baseDir}/`) ? cleanFile.slice(baseDir.length + 1) : null;
  }

  const lastSlash = cleanRoot.lastIndexOf("/");
  const snapshotDir = lastSlash >= 0 ? cleanRoot.slice(0, lastSlash) : "";
  if (!snapshotDir) return cleanFile;

  return cleanFile.startsWith(`${snapshotDir}/`)
    ? cleanFile.slice(snapshotDir.length + 1)
    : null;
}

/**
 * Formats a LaTeX `\includegraphics[width=\linewidth]{...}` snippet for `filePath`,
 * or returns `null` if the asset lies outside `compileRootPath`'s compile snapshot.
 */
export function formatIncludeGraphicsSnippet(
  filePath: string,
  compileRootPath?: string | null,
  repos?: Repo[]
): string | null {
  const rel = resolveIncludeGraphicsPath(filePath, compileRootPath, repos);
  return rel ? `\\includegraphics[width=\\linewidth]{${rel}}` : null;
}

/**
 * Formats upload errors into clear German user-facing messages.
 */
export function formatUploadError(err: unknown, fileName: string): string {
  if (err instanceof ApiError) {
    if (err.status === 413) {
      return `„${fileName}“ ist zu groß für den Upload (Dateigrößenlimit überschritten).`;
    }
    if (err.status === 400 || err.code === "invalid_path") {
      return `Ungültiger Dateipfad für „${fileName}“.`;
    }
    if (err.status === 401) {
      return `Sitzung abgelaufen — bitte erneut anmelden („${fileName}“).`;
    }
    if (err.status === 403) {
      return `Keine Berechtigung zum Hochladen von „${fileName}“.`;
    }
    if (err.status === 404) {
      return `Ziel für „${fileName}“ wurde nicht gefunden.`;
    }
    if (err.status === 409) {
      return `Konflikt beim Hochladen von „${fileName}“: ${err.message}`;
    }
    if (err.status >= 500) {
      return `Serverfehler (${err.status}) beim Hochladen von „${fileName}“.`;
    }
    return `Upload von „${fileName}“ fehlgeschlagen: ${err.message}`;
  }

  if (err instanceof TypeError) {
    return `Netzwerkfehler beim Hochladen von „${fileName}“ — bitte Verbindung prüfen.`;
  }

  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    if (
      lower.includes("failed to fetch") ||
      lower.includes("networkerror") ||
      lower.includes("load failed") ||
      lower.includes("network")
    ) {
      return `Netzwerkfehler beim Hochladen von „${fileName}“ — bitte Verbindung prüfen.`;
    }
    if (err.message) {
      return `Upload von „${fileName}“ fehlgeschlagen: ${err.message}`;
    }
  }

  return `Upload von „${fileName}“ fehlgeschlagen.`;
}

/**
 * Returns the list of candidate target paths that already exist in `existingPaths`.
 */
export function findCollisions(
  candidates: { targetPath: string }[],
  existingPaths: Set<string>
): string[] {
  const seen = new Set<string>();
  const collisions: string[] = [];
  for (const candidate of candidates) {
    if (existingPaths.has(candidate.targetPath) && !seen.has(candidate.targetPath)) {
      seen.add(candidate.targetPath);
      collisions.push(candidate.targetPath);
    }
  }
  return collisions;
}

/**
 * Converts a FileList or array of Files (e.g. from `<input type="file" multiple>`)
 * into `UploadCandidate` items.
 */
export function candidatesFromFileList(files: ArrayLike<File>): UploadCandidate[] {
  const list: UploadCandidate[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    const rel =
      "webkitRelativePath" in file && typeof file.webkitRelativePath === "string" && file.webkitRelativePath
        ? file.webkitRelativePath
        : file.name;
    list.push({ file, relativePath: rel });
  }
  return list;
}

function readEntryFile(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readAllDirectoryEntries(
  reader: FileSystemDirectoryReaderLike
): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntryLike[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
        } else {
          all.push(...batch);
          readBatch();
        }
      }, reject);
    };
    readBatch();
  });
}

async function traverseEntry(
  entry: FileSystemEntryLike,
  prefix: string
): Promise<UploadCandidate[]> {
  const nextPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntryLike);
    return [{ file, relativePath: nextPath }];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntryLike).createReader();
    const children = await readAllDirectoryEntries(reader);
    const nested: UploadCandidate[] = [];
    for (const child of children) {
      const childResults = await traverseEntry(child, nextPath);
      nested.push(...childResults);
    }
    return nested;
  }
  return [];
}

/**
 * Extracts dropped files (and recursively dropped folders via `webkitGetAsEntry`
 * when available) from a `DataTransfer`. Collects items synchronously before any
 * async filesystem reads because browsers clear `DataTransferItemList` after drop.
 */
export async function extractDroppedFiles(
  dataTransfer: DataTransfer
): Promise<UploadCandidate[]> {
  const entries: FileSystemEntryLike[] = [];
  const directFiles: UploadCandidate[] = [];

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i] as WebkitDataTransferItem | undefined;
      if (!item || item.kind !== "file") continue;

      if (typeof item.webkitGetAsEntry === "function") {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          entries.push(entry);
          continue;
        }
      }

      if (typeof item.getAsFile === "function") {
        const file = item.getAsFile();
        if (file) {
          directFiles.push({
            file,
            relativePath: file.webkitRelativePath || file.name,
          });
        }
      }
    }
  }

  if (entries.length > 0) {
    const results: UploadCandidate[] = [...directFiles];
    for (const entry of entries) {
      const traversed = await traverseEntry(entry, "");
      results.push(...traversed);
    }
    return results;
  }

  if (directFiles.length > 0) {
    return directFiles;
  }

  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return candidatesFromFileList(dataTransfer.files);
  }

  return [];
}

/**
 * Formats an error thrown while reading dropped files or directories.
 */
export function formatDropReadError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return `Abgelegte Dateien konnten nicht gelesen werden: ${err.message}`;
  }
  return "Abgelegte Dateien konnten nicht gelesen werden.";
}

/**
 * Extracts dropped files/folders from a `DataTransfer` and passes them to
 * `onCandidates`, surfacing any extraction or callback errors via `onError`
 * instead of leaving an unhandled promise rejection.
 */
export async function processDroppedTransfer(
  dataTransfer: DataTransfer,
  onCandidates: (candidates: UploadCandidate[]) => Promise<void> | void,
  onError: (message: string) => void
): Promise<void> {
  try {
    const candidates = await extractDroppedFiles(dataTransfer);
    await onCandidates(candidates);
  } catch (err: unknown) {
    onError(formatDropReadError(err));
  }
}
