/**
 * Typed REST API client matching docs/API.md (v1).
 * All wire JSON fields use snake_case verbatim.
 */

export type ErrorCode =
  | "invalid_request"
  | "invalid_path"
  | "no_root"
  | "invalid_zip"
  | "no_main_file"
  | "unsafe_path"
  | "preview_pending"
  | "preview_failed"
  | "zotero_forbidden"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "internal"
  | "git_failed"
  | "remote_failed"
  | "insufficient_role"
  | "last_owner"
  | "invite_role_too_low"
  | "spellcheck_disabled"
  | "spellcheck_unavailable"
  | "rate_limited"
  | string;

export interface ApiErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface HealthResponse {
  status: string;
  version: string;
}

export type OAuthProvider = "github" | "google";

export interface AuthProviders {
  oauth: OAuthProvider[];
  dev_login?: boolean;
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  is_admin: boolean;
  commit_email: string | null;
}

export interface Repo {
  path: string; // "" = parent repo, else submodule path e.g. "papers/icml"
  name: string;
  kind: "parent" | "submodule";
  initialized: boolean;
  branch: string | null;
  head: string | null;
}

export interface Entry {
  path: string;
  kind: "file" | "dir";
  repo: string;
}

export interface Tree {
  repos: Repo[];
  entries: Entry[];
}

export type DiagnosticSeverity = "error" | "warning" | "badbox";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  file: string | null;
  line: number | null;
  message: string;
}

export type FixedTexCompiler = "pdflatex" | "xelatex" | "lualatex";

export interface RootFile {
  path: string;
  repo: string;
  engine: FixedTexCompiler;
  reason: string;
  /** spell-check language (LanguageTool code such as "de-DE", or "auto") */
  language?: string;
}

export interface CompileResult {
  root: string;
  state: "success" | "failed";
  started_at: string;
  duration_ms: number;
  pdf_url: string | null;
  diagnostics: Diagnostic[];
  engine?: FixedTexCompiler;
  engine_reason?: string;
}

export interface CompileQueuedResponse {
  root: string;
  state: "queued";
}

export type ServerEvent =
  | { type: "tree_changed" }
  | { type: "doc_reloaded"; path: string }
  | { type: "doc_deleted"; path: string }
  | { type: "moved"; from: string; to: string }
  | { type: "compile"; root: string; state: "queued" | "running" }
  | { type: "compile"; root: string; state: "success" | "failed"; result: CompileResult }
  | { type: "git_changed"; repo: string }
  | { type: "comments"; path: string }
  | { type: "chat"; message: ChatMessage }
  | { type: "chat_resync" }
  | { type: "presence"; users: PresenceUser[] };

/** One online user of the project; `file` = the file they have in focus (null = none). */
export interface PresenceUser {
  username: string;
  display_name: string;
  file: string | null;
}

export interface GitStatusFile {
  path: string;
  index: string;
  worktree: string;
}

export interface GitStatus {
  repo: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
}

export interface GitLogEntry {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitCommitResponse {
  sha: string;
  short: string;
}

export interface GitCommandOutput {
  stdout: string;
  stderr: string;
}

export interface AutoPushResponse {
  pushed: boolean;
  sha: string | null;
  auto_push_last_at: string | null;
  auto_push_last_error: string | null;
}

/**
 * Encodes a workspace-relative path for URL path segments (`/api/projects/{pid}/files/{*path}`).
 * Preserves `/` separators and percent-encodes each path segment.
 */
export function encodeWorkspacePath(path: string): string {
  const cleaned = path.replace(/^\/+/, "");
  if (!cleaned) {
    throw new ApiError(400, "invalid_path", "Path must not be empty");
  }
  const segments = cleaned.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw new ApiError(400, "invalid_path", `Invalid path segment in "${path}"`);
    }
  }
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/**
 * Validates that a post-login redirect path is a safe same-origin path.
 */
export function sanitizeNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/";
  }
  if (next.startsWith("/login")) {
    return "/";
  }
  return next;
}

export function oauthStartUrl(provider: OAuthProvider, next?: string | null): string {
  const safeNext = sanitizeNextPath(next);
  const base = `/api/auth/oauth/${provider}/start`;
  if (safeNext && safeNext !== "/") {
    return `${base}?next=${encodeURIComponent(safeNext)}`;
  }
  return base;
}

export function wsBaseUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

// ponytail: one module-level "open project" instead of threading `pid` through every call,
// so workspace helpers keep their signatures. Pass `pid` explicitly if two projects ever share a tab.
let activeProjectId: number | null = null;

export function setActiveProject(pid: number | null): void {
  activeProjectId = pid;
}

function requireProject(pid: number | null): number {
  if (pid === null) throw new ApiError(400, "invalid_request", "Kein Projekt geöffnet");
  return pid;
}

/** `/api/projects/{pid}` — the single place building the REST project prefix. */
export function projectApiBase(pid: number | null = activeProjectId): string {
  return `/api/projects/${requireProject(pid)}`;
}

/** `/ws/projects/{pid}` — the single place building the WebSocket project prefix. */
export function projectWsPath(pid: number | null = activeProjectId): string {
  return `/ws/projects/${requireProject(pid)}`;
}

export function fileApiUrl(path: string): string {
  return `${projectApiBase()}/files/${encodeWorkspacePath(path)}`;
}

export function pdfApiUrl(root: string, version?: string | number): string {
  const base = `${projectApiBase()}/pdf/${encodeWorkspacePath(root)}`;
  return version !== undefined ? `${base}?v=${encodeURIComponent(String(version))}` : base;
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
  try {
    const data = (await res.json()) as Partial<ApiErrorEnvelope>;
    if (data.error && typeof data.error.code === "string" && typeof data.error.message === "string") {
      return new ApiError(res.status, data.error.code, data.error.message);
    }
  } catch {
    // non-JSON error body
  }
  return new ApiError(res.status, "internal", res.statusText || `HTTP ${res.status}`);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return (await res.json()) as T;
}

async function requestText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return await res.text();
}

async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
}

// --- Health ---

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health");
}

// --- Auth (OAuth-only: Google / GitHub) ---

export function getAuthProviders(): Promise<AuthProviders> {
  return requestJson<AuthProviders>("/api/auth/providers");
}

export function devLogin(username: string): Promise<User> {
  return requestJson<User>("/api/auth/dev-login", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export function getMe(): Promise<User> {
  return requestJson<User>("/api/auth/me");
}

export function updateMe(body: { commit_email: string | null }): Promise<User> {
  return requestJson<User>("/api/auth/me", { method: "PATCH", body: JSON.stringify(body) });
}

export function logout(): Promise<void> {
  return requestVoid("/api/auth/logout", { method: "POST" });
}

// --- Workspace ---

export function getTree(): Promise<Tree> {
  return requestJson<Tree>(`${projectApiBase()}/tree`);
}

export function getFileText(path: string): Promise<string> {
  return requestText(fileApiUrl(path));
}

export async function getFileBlob(path: string): Promise<Blob> {
  const res = await fetch(fileApiUrl(path), { credentials: "same-origin" });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return await res.blob();
}

export function putFile(path: string, content: BodyInit): Promise<void> {
  return requestVoid(fileApiUrl(path), {
    method: "PUT",
    body: content,
  });
}

export function deleteFile(path: string): Promise<void> {
  return requestVoid(fileApiUrl(path), {
    method: "DELETE",
  });
}

/** A reference `update_refs` would rewrite (`path` = file before the move). */
export interface MoveReference {
  path: string;
  line: number;
  old: string;
  new: string;
}

export interface MoveResult {
  moved: { from: string; to: string }[];
  updated_refs: { file: string; count: number }[];
}

export async function previewMove(from: string, to: string): Promise<MoveReference[]> {
  const q = new URLSearchParams({ from, to });
  const res = await requestJson<{ references: MoveReference[] }>(
    `${projectApiBase()}/files/move/preview?${q}`
  );
  return res.references;
}

export function moveFile(from: string, to: string, updateRefs: boolean): Promise<MoveResult> {
  return requestJson<MoveResult>(`${projectApiBase()}/files/move`, {
    method: "POST",
    body: JSON.stringify({ from, to, update_refs: updateRefs }),
  });
}

// --- LaTeX Compile ---

export function listProjectRoots(pid?: number): Promise<RootFile[]> {
  return requestJson<RootFile[]>(`${projectApiBase(pid)}/roots`);
}

/** `clean: true` = "Recompile from scratch": the root's build output is deleted before the run. */
export function triggerCompile(root: string, clean = false): Promise<CompileQueuedResponse> {
  return requestJson<CompileQueuedResponse>(`${projectApiBase()}/compile`, {
    method: "POST",
    body: JSON.stringify({ root, clean }),
  });
}

export interface WordCount {
  words: number;
  headers: number;
  captions: number;
  math_inline: number;
  math_display: number;
  per_file: { path: string; words: number }[];
}

export function wordcount(root: string): Promise<WordCount> {
  return requestJson<WordCount>(`${projectApiBase()}/wordcount?root=${encodeURIComponent(root)}`);
}

/** PDF points, origin top left, pages from 1 (docs/API.md → SyncTeX). */
export interface SyncBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SyncSource {
  file: string;
  line: number;
  column: number;
}

/** Source -> PDF; `[]` if nothing in the PDF comes from that line. */
export function synctexForward(
  root: string,
  file: string,
  line: number,
  column = 0
): Promise<SyncBox[]> {
  const q = new URLSearchParams({ root, file, line: String(line), column: String(column) });
  return requestJson<SyncBox[]>(`${projectApiBase()}/synctex/forward?${q}`);
}

/** PDF -> source (`404 no_synctex` / `404 no_match`). */
export function synctexInverse(
  root: string,
  page: number,
  x: number,
  y: number
): Promise<SyncSource> {
  const q = new URLSearchParams({ root, page: String(page), x: String(x), y: String(y) });
  return requestJson<SyncSource>(`${projectApiBase()}/synctex/inverse?${q}`);
}

export function getCompileResult(root: string): Promise<CompileResult> {
  return requestJson<CompileResult>(`${projectApiBase()}/compile?root=${encodeURIComponent(root)}`);
}

export function getCompileLog(root: string): Promise<string> {
  return requestText(`${projectApiBase()}/compile/log?root=${encodeURIComponent(root)}`);
}

// --- Git ---

export function getGitStatus(repo: string): Promise<GitStatus> {
  return requestJson<GitStatus>(`${projectApiBase()}/git/status?repo=${encodeURIComponent(repo)}`);
}

export function getGitDiff(repo: string, path?: string, staged = false): Promise<string> {
  const params = new URLSearchParams({ repo, staged: String(staged) });
  if (path) params.set("path", path);
  return requestText(`${projectApiBase()}/git/diff?${params.toString()}`);
}

export function getGitLog(repo: string, limit = 20): Promise<GitLogEntry[]> {
  const params = new URLSearchParams({ repo, limit: String(limit) });
  return requestJson<GitLogEntry[]>(`${projectApiBase()}/git/log?${params.toString()}`);
}

export interface CoAuthor {
  username: string;
  display_name: string;
}

export function getCoAuthors(repo: string, paths?: string[]): Promise<CoAuthor[]> {
  const params = new URLSearchParams({ repo });
  for (const p of paths ?? []) params.append("paths", p);
  return requestJson<CoAuthor[]>(`${projectApiBase()}/git/coauthors?${params.toString()}`);
}

export interface CommitIdentity {
  commit_name: string | null;
  commit_email: string | null;
}

export interface UpdateCommitIdentityRequest {
  commit_name?: string | null;
  commit_email?: string | null;
}

export function updateProjectCommitIdentity(
  pid: number,
  body: UpdateCommitIdentityRequest
): Promise<CommitIdentity> {
  return requestJson<CommitIdentity>(`${projectApiBase(pid)}/git/identity`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function gitCommit(
  repo: string,
  message: string,
  paths?: string[],
  coAuthors?: string[]
): Promise<GitCommitResponse> {
  const body: { repo: string; message: string; paths?: string[]; co_authors?: string[] } = {
    repo,
    message,
  };
  if (paths && paths.length > 0) {
    body.paths = paths;
  }
  if (coAuthors) {
    body.co_authors = coAuthors;
  }
  return requestJson<GitCommitResponse>(`${projectApiBase()}/git/commit`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function gitPull(repo: string): Promise<GitCommandOutput> {
  return requestJson<GitCommandOutput>(`${projectApiBase()}/git/pull`, {
    method: "POST",
    body: JSON.stringify({ repo }),
  });
}

export function gitPush(repo: string): Promise<GitCommandOutput> {
  return requestJson<GitCommandOutput>(`${projectApiBase()}/git/push`, {
    method: "POST",
    body: JSON.stringify({ repo }),
  });
}

export function triggerAutoPush(pid?: number): Promise<AutoPushResponse> {
  return requestJson<AutoPushResponse>(`${projectApiBase(pid)}/git/auto-push`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function gitSubmoduleUpdate(path?: string, remote = true): Promise<GitCommandOutput> {
  const body: { path?: string; remote: boolean } = { remote };
  if (path) body.path = path;
  return requestJson<GitCommandOutput>(`${projectApiBase()}/git/submodule-update`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Spell check ---

export interface SpellIssue {
  /** UTF-16 offsets in the file */
  start: number;
  end: number;
  message: string;
  short: string;
  rule: string;
  /** LanguageTool category id; "TYPOS" = spelling */
  category: string;
  replacements: string[];
}

export interface SpellDictionary {
  words: string[];
  disabled_rules: string[];
}

/** `text` omitted: the whole file; `start` = UTF-16 offset of `text` in the file. */
export function spellcheck(body: {
  path: string;
  text?: string;
  start?: number;
  language?: string;
}): Promise<SpellIssue[]> {
  return requestJson<SpellIssue[]>(`${projectApiBase()}/spellcheck`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getDictionary(pid?: number): Promise<SpellDictionary> {
  return requestJson<SpellDictionary>(`${projectApiBase(pid)}/dictionary`);
}

export function addDictionaryWord(word: string, pid?: number): Promise<void> {
  return requestVoid(`${projectApiBase(pid)}/dictionary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word }),
  });
}

export function deleteDictionaryWord(word: string, pid?: number): Promise<void> {
  return requestVoid(`${projectApiBase(pid)}/dictionary/${encodeURIComponent(word)}`, {
    method: "DELETE",
  });
}

export function setDisabledRules(rules: string[], pid?: number): Promise<{ disabled_rules: string[] }> {
  return requestJson<{ disabled_rules: string[] }>(`${projectApiBase(pid)}/spellcheck/rules`, {
    method: "PUT",
    body: JSON.stringify({ disabled_rules: rules }),
  });
}

// --- Projects ---

/** Legacy coarse role, see `MemberRole` / `Project.my_role` for permissions. */
export type ProjectRole = "owner" | "member" | "admin";

/** docs/API.md → Projects → Roles; each role may everything the lower ones may. */
export type MemberRole = "owner" | "editor" | "commenter" | "viewer";

export type TexCompiler = "auto" | FixedTexCompiler;

export const TEX_COMPILERS: { value: TexCompiler; label: string }[] = [
  { value: "auto", label: "Automatisch" },
  { value: "pdflatex", label: "pdfLaTeX" },
  { value: "xelatex", label: "XeLaTeX" },
  { value: "lualatex", label: "LuaLaTeX" },
];

export interface Project {
  id: number;
  name: string;
  remote_url: string;
  branch: string;
  owner: string;
  role: ProjectRole;
  /** caller's effective role (site admins: "owner") */
  my_role: MemberRole;
  has_token: boolean;
  compiler: TexCompiler;
  /** roots compiled by default, first = default; empty = automatic */
  main_files: string[];
  /** account the remote repo was created with (`create_remote`); enables invite-remote */
  account_id: number | null;
  /** caller's per-project commit author name override */
  commit_name: string | null;
  /** caller's per-project commit author e-mail override */
  commit_email: string | null;
  /** 0 = disabled, or seconds in 60..=86400 */
  auto_push_interval_secs: number;
  auto_push_message: string;
  auto_push_last_at: string | null;
  auto_push_last_error: string | null;
  created_at: string;
}

export interface CreateRemote {
  account_id: number;
  repo_name: string;
  private?: boolean;
  /** GitLab group path */
  namespace?: string;
  template_id?: string;
}

/** Either `remote_url` (existing repo) or `create_remote` (new repo with CI). */
export interface CreateProjectRequest {
  name: string;
  remote_url?: string;
  branch?: string;
  username?: string;
  token?: string;
  template_id?: string;
  create_remote?: CreateRemote;
  compiler?: TexCompiler;
}

export interface ScanProjectRequest {
  remote_url: string;
  branch?: string;
  username?: string;
  token?: string;
}

export interface MatchedAccountInfo {
  id: number;
  provider: "github" | "gitlab";
  base_url: string;
  login: string;
}

export interface ScanProjectResult {
  branch: string;
  is_empty: boolean;
  file_count: number;
  has_tex_files: boolean;
  tex_files: string[];
  roots: string[];
  detected_compiler: FixedTexCompiler | null;
  matched_account: MatchedAccountInfo | null;
}

export interface UpdateProjectRequest {
  name?: string;
  username?: string;
  token?: string | null;
  compiler?: TexCompiler;
  main_files?: string[];
  auto_push_interval_secs?: number;
  auto_push_message?: string;
}

export interface ProjectMember {
  username: string;
  display_name: string;
  role: MemberRole;
}

export function listProjects(): Promise<Project[]> {
  return requestJson<Project[]>("/api/projects");
}

export function createProject(body: CreateProjectRequest): Promise<Project> {
  return requestJson<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) });
}

export function scanProject(body: ScanProjectRequest): Promise<ScanProjectResult> {
  return requestJson<ScanProjectResult>("/api/projects/scan", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getProject(pid: number): Promise<Project> {
  return requestJson<Project>(projectApiBase(pid));
}

export function updateProject(pid: number, body: UpdateProjectRequest): Promise<Project> {
  return requestJson<Project>(projectApiBase(pid), { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteProject(pid: number): Promise<void> {
  return requestVoid(projectApiBase(pid), { method: "DELETE" });
}

export function listMembers(pid: number): Promise<ProjectMember[]> {
  return requestJson<ProjectMember[]>(`${projectApiBase(pid)}/members`);
}

export function addMember(pid: number, username: string, role?: MemberRole): Promise<void> {
  return requestVoid(`${projectApiBase(pid)}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(role ? { username, role } : { username }),
  });
}

export function updateMemberRole(pid: number, username: string, role: MemberRole): Promise<void> {
  return requestVoid(`${projectApiBase(pid)}/members/${encodeURIComponent(username)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export function removeMember(pid: number, username: string): Promise<void> {
  return requestVoid(`${projectApiBase(pid)}/members/${encodeURIComponent(username)}`, {
    method: "DELETE",
  });
}

export function inviteRemote(pid: number, username: string): Promise<void> {
  return requestVoid(
    `${projectApiBase(pid)}/members/${encodeURIComponent(username)}/invite-remote`,
    { method: "POST" }
  );
}

// --- Connected accounts (GitHub / GitLab / Zotero) ---

export type AccountProvider = "github" | "gitlab" | "zotero";
export type GitProvider = AccountProvider;

export interface GitAccount {
  id: number;
  provider: AccountProvider;
  base_url: string;
  login: string;
  /** self-hosted GitLab: SSH host key trusted on first use, null until the first repo */
  ssh_host_key_fingerprint: string | null;
}

export type Account = GitAccount;

/** OAuth redirect (plain link) granting `repo workflow`; returns to `/?connected=github`. */
export const GITHUB_CONNECT_URL = "/api/auth/connect/github";

export function listAccounts(): Promise<GitAccount[]> {
  return requestJson<GitAccount[]>("/api/accounts");
}

export function addGitlabAccount(base_url: string, token: string): Promise<GitAccount> {
  return requestJson<GitAccount>("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ provider: "gitlab", base_url, token }),
  });
}

export function addZoteroAccount(token: string): Promise<GitAccount> {
  return requestJson<GitAccount>("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ provider: "zotero", token }),
  });
}

export function deleteAccount(id: number): Promise<void> {
  return requestVoid(`/api/accounts/${id}`, { method: "DELETE" });
}

// --- Templates ---

export type TemplateCompiler = "pdflatex" | "xelatex" | "lualatex";

export type TemplatePreviewState = "pending" | "ready" | "failed";

export interface Template {
  id: string;
  name: string;
  description: string;
  compiler: TemplateCompiler;
  main_file: string;
  builtin: boolean;
  owner: string | null;
  preview: TemplatePreviewState;
  public: boolean;
}

export interface TemplateFile {
  path: string;
  size: number;
}

export interface UpdateTemplateRequest {
  public?: boolean;
  name?: string;
  description?: string;
}

export function listTemplates(): Promise<Template[]> {
  return requestJson<Template[]>("/api/templates");
}

export function uploadTemplate(formData: FormData): Promise<Template> {
  return requestJson<Template>("/api/templates", {
    method: "POST",
    body: formData,
  });
}

export function updateTemplate(id: string, body: UpdateTemplateRequest): Promise<Template> {
  return requestJson<Template>(`/api/templates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteTemplate(id: string): Promise<void> {
  return requestVoid(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function templatePreviewUrl(id: string, version?: string | number): string {
  const base = `/api/templates/${encodeURIComponent(id)}/preview.pdf`;
  return version !== undefined ? `${base}?v=${encodeURIComponent(String(version))}` : base;
}

export function listTemplateFiles(id: string): Promise<TemplateFile[]> {
  return requestJson<TemplateFile[]>(`/api/templates/${encodeURIComponent(id)}/files`);
}

// --- Zotero ---

export interface ZoteroLibrary {
  library: string;
  name: string;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parent: string | null;
}

export type ZoteroFormat = "biblatex" | "bibtex";

export interface ZoteroLink {
  path: string;
  account_id: number | null;
  library: string;
  collection: string | null;
  format: ZoteroFormat;
  updated_at: string;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
}

export interface ZoteroImportRequest {
  account_id: number;
  library: string;
  collection: string | null;
  path: string;
  format?: ZoteroFormat;
}

export interface ZoteroImportResult {
  path: string;
  entries: number;
}

export function listZoteroLibraries(accountId: number): Promise<ZoteroLibrary[]> {
  return requestJson<ZoteroLibrary[]>(`/api/accounts/${accountId}/zotero/libraries`);
}

export function listZoteroCollections(accountId: number, library: string): Promise<ZoteroCollection[]> {
  return requestJson<ZoteroCollection[]>(
    `/api/accounts/${accountId}/zotero/collections?library=${encodeURIComponent(library)}`
  );
}

export function importZoteroBib(body: ZoteroImportRequest): Promise<ZoteroImportResult> {
  return requestJson<ZoteroImportResult>(`${projectApiBase()}/zotero/import`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listZoteroLinks(pid?: number): Promise<ZoteroLink[]> {
  const base = pid !== undefined ? `/api/projects/${pid}` : projectApiBase();
  return requestJson<ZoteroLink[]>(`${base}/zotero/links`);
}

export function refreshZoteroLink(path: string): Promise<ZoteroImportResult> {
  return requestJson<ZoteroImportResult>(`${projectApiBase()}/zotero/refresh`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export function setZoteroAutoSync(path: string, autoSync: boolean): Promise<void> {
  return requestVoid(`${projectApiBase()}/zotero/links`, {
    method: "PATCH",
    body: JSON.stringify({ path, auto_sync: autoSync }),
  });
}

export function deleteZoteroLink(path: string): Promise<void> {
  return requestVoid(`${projectApiBase()}/zotero/links?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
}

// --- Comments ---

export interface CommentMessage {
  id: number;
  author: string | null;
  display_name: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}

export interface CommentThread {
  id: number;
  path: string;
  start: number;
  end: number;
  quote: string;
  detached: boolean;
  resolved: boolean;
  resolved_by: string | null;
  created_by: string | null;
  created_at: string;
  messages: CommentMessage[];
}

export interface CreateCommentRequest {
  path: string;
  start: number;
  end: number;
  body: string;
}

function commentsApiBase(pid?: number): string {
  const base = pid !== undefined ? `/api/projects/${pid}` : projectApiBase();
  return `${base}/comments`;
}

export function listComments(path?: string, pid?: number): Promise<CommentThread[]> {
  const query = path !== undefined ? `?path=${encodeURIComponent(path)}` : "";
  return requestJson<CommentThread[]>(`${commentsApiBase(pid)}${query}`);
}

export function createComment(body: CreateCommentRequest, pid?: number): Promise<CommentThread> {
  return requestJson<CommentThread>(commentsApiBase(pid), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function replyToComment(
  threadId: number,
  body: string,
  pid?: number
): Promise<CommentMessage> {
  return requestJson<CommentMessage>(`${commentsApiBase(pid)}/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export function setCommentResolved(
  threadId: number,
  resolved: boolean,
  pid?: number
): Promise<CommentThread> {
  return requestJson<CommentThread>(`${commentsApiBase(pid)}/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify({ resolved }),
  });
}

export function deleteCommentThread(threadId: number, pid?: number): Promise<void> {
  return requestVoid(`${commentsApiBase(pid)}/${threadId}`, { method: "DELETE" });
}

export function editCommentMessage(
  threadId: number,
  messageId: number,
  body: string,
  pid?: number
): Promise<CommentMessage> {
  return requestJson<CommentMessage>(`${commentsApiBase(pid)}/${threadId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export function deleteCommentMessage(
  threadId: number,
  messageId: number,
  pid?: number
): Promise<void> {
  return requestVoid(`${commentsApiBase(pid)}/${threadId}/messages/${messageId}`, {
    method: "DELETE",
  });
}

// --- Admin ---

export interface AdminUser {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  github: string | null;
  is_admin: boolean;
  commit_email: string | null;
  created_at: string;
}

export interface CreateUserRequest {
  username: string;
  display_name?: string;
  email?: string;
  github?: string;
  is_admin?: boolean;
}

export type UpdateUserRequest = Partial<{
  display_name: string;
  email: string | null;
  github: string | null;
  is_admin: boolean;
}>;

export function listUsers(): Promise<AdminUser[]> {
  return requestJson<AdminUser[]>("/api/admin/users");
}

export function createUser(body: CreateUserRequest): Promise<AdminUser> {
  return requestJson<AdminUser>("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
}

export function updateUser(id: number, body: UpdateUserRequest): Promise<AdminUser> {
  return requestJson<AdminUser>(`/api/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteUser(id: number): Promise<void> {
  return requestVoid(`/api/admin/users/${id}`, { method: "DELETE" });
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// --- Chat ---

export interface ChatMessage {
  id: number;
  author: string | null;
  display_name: string | null;
  /** "" once deleted */
  body: string;
  file: string | null;
  /** 1-based, only with `file` */
  line: number | null;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  /** usernames of project members named as `@username` in `body` */
  mentions: string[];
}

export interface SendChatRequest {
  body: string;
  file?: string;
  line?: number;
}

function chatApiBase(pid?: number): string {
  return `${pid !== undefined ? `/api/projects/${pid}` : projectApiBase()}/chat`;
}

/** Up to `limit` messages older than `before`, oldest first. */
export function listChat(
  opts: { before?: number; limit?: number } = {},
  pid?: number
): Promise<ChatMessage[]> {
  const q = new URLSearchParams();
  if (opts.before !== undefined) q.set("before", String(opts.before));
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  const query = q.size > 0 ? `?${q}` : "";
  return requestJson<ChatMessage[]>(`${chatApiBase(pid)}${query}`);
}

export function sendChat(body: SendChatRequest, pid?: number): Promise<ChatMessage> {
  return requestJson<ChatMessage>(chatApiBase(pid), { method: "POST", body: JSON.stringify(body) });
}

export function editChat(id: number, body: string, pid?: number): Promise<ChatMessage> {
  return requestJson<ChatMessage>(`${chatApiBase(pid)}/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export function deleteChat(id: number, pid?: number): Promise<void> {
  return requestVoid(`${chatApiBase(pid)}/${id}`, { method: "DELETE" });
}
