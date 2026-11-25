# undertree API Contract (v1)

Binding contract between backend (Rust/axum) and frontend (TS/Vite).
Changes only via an issue labeled `agent-sync` + update of this file in the same MR.

## Conventions

- Base: same origin as the frontend. REST under `/api`, WebSockets under `/ws`.
- JSON bodies use `snake_case`, `Content-Type: application/json`.
- **Projects**: every workspace route is scoped to a project. `{pid}` = numeric project id.
  REST: `/api/projects/{pid}/…`, WebSockets: `/ws/projects/{pid}/…`. A project the user may not
  access (not a member, not admin) or that does not exist → `404 not_found`. A member whose role
  is too low for a route → `403 insufficient_role` (Projects → Roles).
  In this document "workspace" = the project's cloned repository.
- **Paths** (`path`, `root`, `repo`) are always relative to the workspace root (the project repo),
  `/`-separated, no leading `/`, no `..`. The parent repo itself is `repo = ""`.
  In URL path segments (`{*path}`) they are sent raw (`/api/projects/1/files/paper/main.tex`), each segment
  percent-encoded if needed. Anything resolving outside the workspace → `400 invalid_path`.
- **Auth**: session cookie `undertree_session` (HttpOnly, SameSite=Lax, Secure in production).
  Every `/api/*` and `/ws/*` route needs a valid session, except those marked *public*.
  WebSocket upgrades additionally check `Origin` against `UNDERTREE_PUBLIC_URL` (`403` on mismatch).
  Vite dev server: run the backend with `UNDERTREE_PUBLIC_URL=http://localhost:5173` so the proxied
  `Origin` matches (also makes OAuth callbacks go through the proxy).
- **Errors**: non-2xx responses carry
  ```json
  { "error": { "code": "not_found", "message": "human readable" } }
  ```
  | Status | `code` |
  |---|---|
  | 400 | `invalid_request`, `invalid_path`, `last_owner` (would leave a project without owner), `host_not_allowed` (GitLab server not in a non-empty `UNDERTREE_GITLAB_HOSTS`, or not publicly reachable), `zotero_forbidden` (Zotero key has no access to that library), template upload: `invalid_zip`, `too_large`, `no_main_file`, `unsafe_path` |
  | 401 | `unauthorized` (no/expired session) |
  | 403 | `forbidden` (e.g. OAuth identity not registered, origin mismatch, admin-only route), `insufficient_role` (project role too low) |
  | 404 | `not_found`, `spellcheck_disabled` (no `UNDERTREE_LANGUAGETOOL_URL`) |
  | 409 | `conflict` (git: merge conflict, non-fast-forward, nothing to commit) |
  | 413 | `too_large` (content over the editor's 8 MiB document limit, spell check over 100 KB) |
  | 429 | `rate_limited` (spell check: more than 2 parallel or 60 per minute per user) |
  | 500 | `internal` |
  | 502 | `git_failed` (git exited non-zero; `message` = stderr), `remote_failed` (GitHub/GitLab/Zotero API call failed, unreachable or rate-limited; `message` = provider's message), `wordcount_failed` (texcount failed), `spellcheck_unavailable` (LanguageTool unreachable, timed out after 10 s or failed) |

## Health

### `GET /api/health` *(public)*
`200` → `{ "status": "ok", "version": "0.1.0" }`

## Auth

Login is **OAuth-only** (GitHub, Google). There is no password login.

### `GET /api/auth/providers` *(public)*
Which login methods are enabled (a provider is listed only if its client id/secret is configured).
`200` → `{ "oauth": ["github", "google"], "dev_login": false }`

### `POST /api/auth/dev-login` *(public, dev only)*
For local development and E2E tests without real OAuth apps. Exists only when
`UNDERTREE_DEV_LOGIN=true`; the server refuses to start if that is combined with an `https://`
`UNDERTREE_PUBLIC_URL`. Otherwise `404`.
Body `{ "username": "alice" }` (must exist) → `200` → `User` + sets cookie. Unknown user → `401`.

### `GET /api/auth/oauth/{provider}/start` *(public)*
`provider` ∈ `github | google`. Optional query `?next=/some/path` (same-origin path only).
`303` → provider authorize URL (with `state` + PKCE). Frontend uses a plain link / `location.href`.

### `GET /api/auth/oauth/{provider}/callback` *(public)*
Called by the provider. On success: sets cookie, `303` → `next` or `/`.
On failure: `303` → `/login?error=<code>` with `code` ∈ `oauth_denied | not_registered | oauth_failed`.
Login only succeeds for identities linked to an existing user (admin CLI), matched by
GitHub numeric user id / login, or Google verified e-mail. No self-registration.

### `GET /api/auth/connect/github`
Logged in only; `404` if GitHub OAuth is not configured. `303` → GitHub authorize URL with scopes
`repo workflow` (`workflow` is needed to push `.github/workflows/*`). Uses the same OAuth app and
callback URL as the login; the callback then stores the token as a connected account of the
caller (no login, no session change) and redirects to `/?connected=github`, on failure to
`/?connect_error=<code>`. Reconnecting replaces the stored token. The login itself keeps asking
for no scopes.

### `POST /api/auth/logout`
`204`, clears session.

### `GET /api/auth/me`
`200` → `User`, `401` if not logged in.

```ts
type User = {
  id: number; username: string; display_name: string; email: string | null; is_admin: boolean;
  commit_email: string | null;  // own commit author e-mail (see Git), null = automatic
};
```

### `PATCH /api/auth/me`
`{ "commit_email": string | null }` → `200 User`. `null` or `""` = automatic choice (see Git).
Must look like an e-mail without whitespace, control characters, `<`, `>` or `,` → else `400 invalid_request`.

## Accounts

GitHub/GitLab accounts of the caller, used to create repos (`create_remote`) and invite members
(`invite-remote`), and Zotero accounts (see Zotero). Tokens/keys are stored encrypted and never returned.

```ts
type Account = {
  id: number;
  provider: "github" | "gitlab" | "zotero";
  base_url: string;   // "https://github.com", the GitLab server or "https://api.zotero.org", no trailing "/"
  login: string;      // username on that server
  ssh_host_key_fingerprint: string | null; // self-hosted GitLab: "SHA256:…" of the SSH host key
                      // trusted on first use (see create_remote), null until the first repo
}
```

### `GET /api/accounts` → `Account[]` (own accounts only)

### `POST /api/accounts`
`{ "provider": "gitlab", "base_url": "https://gitlab.com", "token": "glpat-…" }` → `201 Account`.
Personal access token with scope `api`. `base_url` must be `https://host[/path]` without
credentials, query or fragment. Any GitLab server reachable from the internet works; an operator
can restrict this with `UNDERTREE_GITLAB_HOSTS` (non-empty: `host[:port]` must be listed). Every
call to a GitLab API (connect, create, deploy key, invite) is guarded against SSRF:
- `https` only;
- the host is resolved, and if **any** address is not public (loopback, private RFC 1918,
  link-local, CGNAT `100.64/10`, `0/8`, benchmarking `198.18/15`, documentation, multicast,
  broadcast, reserved, unspecified; IPv6 outside global unicast `2000::/3`, ULA `fc00::/7`,
  `fe80::/10`, Teredo, 6to4 or IPv4-mapped forms of rejected IPv4) the call is refused;
- the connection is pinned to the vetted address (no DNS rebinding), without proxy or redirects.

Not listed or not public → `400 host_not_allowed` before any request is made (message e.g. "… is
not publicly reachable …"); DNS failure → `502 remote_failed`. Both checks run again before every
later API call with a stored account (removing a host from the list disables its accounts). Validated with `GET {base_url}/api/v4/user`: rejected token or no
GitLab there → `400 invalid_request`. Same server again → login/token replaced (same `id`).
`provider: "github"` → `400` (GitHub connects via `GET /api/auth/connect/github`).

`{ "provider": "zotero", "token": "<API key>" }` (no `base_url`) → `201 Account` with
`base_url: "https://api.zotero.org"`, `login` = Zotero username. Key from
zotero.org/settings/keys (read access to the library and the groups to import). Validated with
`GET https://api.zotero.org/keys/current` (key sent as `Zotero-API-Key` header); rejected key →
`400 invalid_request`. One Zotero account per user: connecting again replaces the key (same `id`).
Zotero accounts can't be used for `create_remote` (`404`).

### `DELETE /api/accounts/{id}` → `204`
Someone else's or unknown account → `404`. Projects created with it keep working (own deploy
key) but lose `account_id`, so invite-remote is no longer possible. Zotero links made with it
stay (with `account_id: null`) but can't be refreshed until imported again.

## Zotero

Import a Zotero library or collection as `.bib` file and refresh it later. Every call goes to the
fixed `https://api.zotero.org` with `Zotero-API-Version: 3`; `Backoff` / `Retry-After` are
honored (waits up to 30 s, longer → `502 remote_failed`). Zotero errors: key lacks access →
`400 zotero_forbidden`, unknown library/collection → `404`, anything else → `502 remote_failed`.
Accounts must be the caller's own Zotero accounts, else `404`.

```ts
type Library = { library: string; name: string }  // "user:123" (name "My Library") | "group:456"
type Collection = { key: string; name: string; parent: string | null }  // parent = collection key
type ZoteroLink = {
  path: string;               // workspace-relative .bib file
  account_id: number | null;  // account used for refreshes; null = it was disconnected
  library: string;            // "user:<id>" | "group:<id>"
  collection: string | null;  // collection key, null = whole library
  format: "biblatex" | "bibtex";
  updated_at: string;         // ISO 8601 UTC, last import/refresh that fetched data
  auto_sync: boolean;         // kept current by the background sync (default true)
  last_synced_at: string | null;  // ISO 8601 UTC, last successful import, refresh or sync check
  last_error: string | null;  // why the last sync failed (cleared by the next success)
}
```

### `GET /api/accounts/{id}/zotero/libraries` → `Library[]`
Own library first, then the groups of the key's user.

### `GET /api/accounts/{id}/zotero/collections?library=user:123` → `Collection[]`
All collections of that library (flat, nested via `parent`). `library` must be `user:<digits>` or
`group:<digits>`, else `400`.

### `POST /api/projects/{pid}/zotero/import`
`{ "account_id": 3, "library": "user:123", "collection": "ABCD2345" | null, "path": "references.bib", "format": "biblatex" }`
→ `200 { "path": "references.bib", "entries": 152 }`. `format` default `"biblatex"`.
Downloads all top-level items (in pages of 100) in that format and writes the file like
`PUT …/files/{*path}` (creates parent dirs; open editors get the content as replace; counts as
the caller's change for co-authors; `tree_changed` if new), then stores/replaces the link for
`path`. `path` must end in `.bib` (`400 invalid_request`) and be a valid workspace path
(`400 invalid_path`). More than 20 000 entries or 8 MiB (the editor's limit) → `413 too_large`, paging stops and nothing is written. Needs role `editor`.

### `GET /api/projects/{pid}/zotero/links` → `ZoteroLink[]` (sorted by `path`)

### `POST /api/projects/{pid}/zotero/refresh`
`{ "path": "references.bib" }` → `200 { "path", "entries" }`. Imports again with the stored
link, using the account of whoever created it (role `editor`; the write counts as the
caller's change). No link for `path` → `404`; its account was disconnected → `409 conflict`.

### `PATCH /api/projects/{pid}/zotero/links` *(editor)* → `204`
`{ "path": "references.bib", "auto_sync": false }` switches the background sync of that link on
or off. No such link → `404`.

### Automatic sync
Whatever changes in the Zotero desktop client reaches zotero.org and from there the linked files
(undertree can't reach the client itself). A background task checks every
`UNDERTREE_ZOTERO_SYNC_SECS` (default 300, `0` = off) each link with `auto_sync` whose account is
still connected: the first export page is requested with `If-Modified-Since-Version` = the stored
`library_version` (the `Last-Modified-Version` of the last export, also set by import/refresh);
`304` → nothing changes (`last_synced_at` is updated). Otherwise the file is exported as with
`refresh` and written as the account's user (through the CRDT if open), but only if its content
differs, so unchanged exports cause no commits or recompiles. Failures set `last_error` and are
retried next round. `Backoff` / `Retry-After` / `429` pause the whole Zotero account (also across
rounds); a pause longer than 30 s ends the account's round. Accounts are handled one after
another, at most 2 accounts at the same time. Links whose project or file no longer exists are
skipped, as are links whose account owner is no longer `editor`/`owner` of the project (or site
admin). **Auto-sync overwrites manual edits** of the `.bib` (also in an open editor) with the next
change in Zotero. Links that existed before auto-sync was introduced start with `auto_sync: false`;
new links start with `true`.

### `DELETE /api/projects/{pid}/zotero/links?path=references.bib` *(editor)* → `204`
Forgets the link, the file stays. No such link → `404`. Deleting the project removes its links.

## Projects

A project is a git repository connected by URL (+ optional access token), cloned on the server,
or a new repo undertree creates on GitHub/GitLab (`create_remote`).
### Roles

Every member has one role; each role may everything the roles below it may. Site admins
(`is_admin`) act as `owner` on every project, member or not (`my_role: "owner"`). Non-members
get `404`, members below the needed role `403 insufficient_role`. Enforced on the server for
every route; the doc socket is read-only below `editor` (see Documents).

| Role | May |
|---|---|
| `owner` | everything, incl. members, roles, settings, deleting the project |
| `editor` | edit files and docs, Git writes, Zotero, plus everything below |
| `commenter` | write comments, plus everything below |
| `viewer` | read everything (files, tree, PDF, logs, Git status/diff/log, comments), compile |

| Min. role | Routes (`/api/projects/{pid}` = `…`) |
|---|---|
| `viewer` | `GET …`, `GET …/members`, `GET …/tree`, `GET …/files/{*path}`, `GET …/roots`, `POST …/compile` (compiling changes no sources), `GET …/compile`, `GET …/compile/log`, `GET …/pdf/{*root}`, `GET …/synctex/forward`, `GET …/synctex/inverse`, `GET …/git/status`, `GET …/git/diff`, `GET …/git/log`, `GET …/git/coauthors`, `GET …/zotero/links`, `GET …/comments`, `GET …/chat`, `POST …/spellcheck`, `GET …/dictionary`, `WS /ws/projects/{pid}/events` (presence), `WS /ws/projects/{pid}/doc/{*path}` (read-only below `editor`), `DELETE …/members/{me}` (leave) |
| `commenter` | `POST …/comments`, `POST …/comments/{id}/messages`, `PATCH …/comments/{id}` (resolve); `PATCH`/`DELETE …/comments/{id}/messages/{mid}` (author only); `DELETE …/comments/{id}` (thread creator or owner), `POST …/chat`, `PATCH`/`DELETE …/chat/{id}` (author only) |
| `editor` | `PUT`/`DELETE …/files/{*path}`, doc socket updates, `POST …/git/commit`, `POST …/git/auto-push`, `PATCH …/git/identity`, `POST …/git/pull`, `POST …/git/push`, `POST …/git/submodule-update`, `POST …/zotero/import`, `POST …/zotero/refresh`, `PATCH …/zotero/links`, `DELETE …/zotero/links`, `POST …/dictionary`, `DELETE …/dictionary/{word}`, `PUT …/spellcheck/rules` |
| `owner` | `PATCH …`, `DELETE …`, `POST …/members`, `PATCH …/members/{username}`, `DELETE …/members/{username}`, `POST …/members/{username}/invite-remote` |

A project always keeps at least one owner. The creator becomes `owner`; members that existed
before roles were introduced became `editor`.

```ts
type Project = {
  id: number; name: string;
  remote_url: string;            // never contains credentials
  branch: string;                // checked-out branch
  owner: string;                 // username of the creator (not necessarily still an owner)
  role: "owner" | "member" | "admin";  // legacy: "owner" = role owner, "member" = any other
                                 // role, "admin" = admin without membership; use my_role
  my_role: "owner" | "editor" | "commenter" | "viewer";  // caller's effective role (admins: "owner")
  has_token: boolean;            // token itself is never returned
  compiler: "auto" | "pdflatex" | "xelatex" | "lualatex";  // TeX engine; "auto" = detected per root on
                                 // every compile (LaTeX compile → Engine detection), default for new projects
  main_files: string[];          // workspace-relative roots, first = default compile target; [] = automatic
                                 // (LaTeX compile → Main files)
  account_id: number | null;     // account the remote repo was created with (create_remote), else null
  commit_name: string | null;    // caller's per-project commit author name override (null = user display_name)
  commit_email: string | null;   // caller's per-project commit author e-mail override (null = profile default)
  auto_push_interval_secs: number;       // 0 = off, else 60..=86400
  auto_push_message: string;             // commit message template (placeholders: {files}, {count}, {time})
  auto_push_last_at: string | null;      // RFC 3339 timestamp of the last successful auto-push
  auto_push_last_error: string | null;   // error/conflict message of the last failed auto-push, else null
  created_at: string;            // RFC 3339
}
```

### `GET /api/projects`
`200` → `Project[]` — projects the caller is a member of (admins: all), newest first.

### `POST /api/projects/scan`
`{ "remote_url": "https://gitlab.com/me/paper.git", "branch"?: "main", "username"?: "oauth2", "token"?: "glpat-…" }`
- Clones the repository temporarily (with the same credential resolution as `POST /api/projects`, including automatic reuse of a matching connected GitHub/GitLab account token if `token` is omitted) and scans for `.tex` files and LaTeX roots.
- `200` → `{ branch: string, is_empty: bool, file_count: number, has_tex_files: bool, tex_files: string[], roots: string[], detected_compiler: "pdflatex" | "xelatex" | "lualatex" | null, matched_account: { id, provider, base_url, login } | null }`.
  Clone/auth failure → `502 git_failed` (message scrubbed of tokens).

### `POST /api/projects`
`{ "name": "ICML 2027", "remote_url": "https://gitlab.com/me/paper.git", "branch": "main", "username": "oauth2", "token": "glpat-…", "template_id": "builtin:article" }`
- `branch`, `username`, `token`, `template_id`, `compiler` optional (`compiler` omitted → `"auto"`).
  `branch` omitted → remote default branch.
  `username` defaults to `oauth2` (or `x-access-token` for matched GitHub accounts).
- If `token` is omitted on an `https://` URL, undertree automatically reuses a matching connected GitHub/GitLab account token from `user_accounts` (with an anonymous retry if the repo is public and the stored token fails).
- `template_id` (existing repo path): optional template id from `GET /api/templates`. Only allowed when the repository contains no `.tex` files yet (else `400 invalid_request`). Copies template files without overwriting existing files, commits, and pushes. Empty repositories without `template_id` → `400 invalid_request`.
- `remote_url`: `https://…` (token used via HTTP basic auth) or `git@host:path` / `ssh://…`
  (server SSH key, token ignored). URLs with embedded credentials → `400 invalid_request`.
- Clones (with submodules) synchronously. `201` → `Project`.
  Clone/auth failure → `502 git_failed` (message scrubbed of the token), nothing is stored.

**New repo instead of `remote_url`:**
`{ "name": "ICML 2027", "compiler": "xelatex", "create_remote": { "account_id": 3, "repo_name": "icml-2027", "private": true, "namespace": "chair/papers", "template_id": "builtin:thesis" } }`
- `account_id`: one of the caller's accounts (else `404`). `repo_name`: letters, digits, `.`, `_`, `-`
  (not starting with `.`/`-`, max 100). `private` default `true`. `namespace`: GitLab group path,
  optional (default: the account's user namespace); on GitHub → `400`.
- `template_id`: a template id from `GET /api/templates`, optional (default `builtin:article`).
  Unknown id, or a private template of someone else → `400 invalid_request` before anything is
  created. `compiler` omitted → `"auto"`;
  the CI file then builds with the template's (detected) `compiler`.
- The server creates the empty repo via the provider API, generates an ed25519 key for this
  project only (`$DATA/projects/{pid}/ssh/`) and registers it as **deploy key with write access**
  on that repo (title `undertree <repo_name>`). All git network operations of the project use only
  that key, with strict host key checking against the pinned github.com/gitlab.com keys, the
  project's `ssh/known_hosts` and the operator's `~/.ssh/known_hosts` (an unknown or changed host
  key → `502 git_failed`).
- **Self-hosted GitLab: trust on first use.** The SSH host and port come from the new project's
  `ssh_url_to_repo` (`git@host:path` or `ssh://git@host:port/path`, any port). Unless that host is
  github.com/gitlab.com on port 22, the account's stored host key for it is used; the first time,
  the server vets the host like an API call (public addresses only), runs `ssh-keyscan -t ed25519`
  against the vetted address and stores the `known_hosts` line on the account (its fingerprint:
  `Account.ssh_host_key_fingerprint`). The line is copied into the project's `ssh/known_hosts`;
  later key changes are never re-trusted, ssh fails closed. No ed25519 key offered →
  `502 remote_failed`. One SSH host per account: a different host is scanned and replaces it.
  To re-trust a rotated key, disconnect the account and connect it again.
- Initial content: the template's files, `.gitignore` (LaTeX build output + the main file's PDF)
  and CI building the template's `main_file` with the project's engine (GitHub:
  `.github/workflows/latex.yml` with `xu-cheng/latex-action@v3`; GitLab: `.gitlab-ci.yml` with
  `texlive/texlive:latest` + `latexmk -cd`), PDF as artifact. A `.gitignore` or CI file the
  template brings itself is kept as is. First commit by the caller (e-mail
  rule from Git), pushed to `main` over SSH. `remote_url` = the repo's SSH URL, `branch` = `main`.
- Provider errors → `502 remote_failed`. Everything local is prepared in a temp dir; the project
  exists (and is listed) only once all steps including the push succeeded. If anything fails after
  the remote repo was created, nothing local is kept and the remote repo is **not** deleted: the
  error message contains its URL (and any cleanup step that failed).

### `GET /api/projects/{pid}` → `Project`

### `PATCH /api/projects/{pid}` *(owner)*
`{ "name"?: string, "username"?: string, "token"?: string | null, "compiler"?: "auto" | "pdflatex" | "xelatex" | "lualatex", "main_files"?: string[], "auto_push_interval_secs"?: number, "auto_push_message"?: string }` → `200 Project`.
`auto_push_interval_secs`: `0` (off, clears `auto_push_last_error`) or `60..=86400`. `auto_push_message`: 1–200 chars, no control chars (`""` resets to `"Auto-save: {files}"`).
Projects created before `"auto"` existed keep their fixed engine until changed here.
`main_files` replaces the list (order kept, duplicates dropped, `[]` = automatic): at most 20
entries, each an existing `.tex` file in the workspace inside an initialized repo (`400`/`404` as in
`POST …/compile`) that is a root (`\begin{document}` outside comments, judged on the current text
incl. unflushed editor changes), else `400 no_root`. Nothing is stored if one entry is rejected,
except that entries of the currently stored list which went stale (deleted, no longer a root) are
dropped silently, so they cannot block saving the rest.
`token: null` removes the stored token. `username` alone (no `token`) changes the username used
with the stored token. Other roles → `403 insufficient_role`.

### `DELETE /api/projects/{pid}` *(owner)*
Deletes the project, its local clone, CRDT state and build output. The remote is untouched. `204`.
Open sockets of the project are closed (`4404`).

### `GET /api/projects/{pid}/members`
`200` → `[{ "username": "julius", "display_name": "Julius", "role": "owner" | "editor" | "commenter" | "viewer" }]`,
sorted by role (owners first), then username.

### `POST /api/projects/{pid}/members` *(owner)*
`{ "username": "julius", "role"?: "editor" }` → `201` (empty body; refetch the list). `role`
defaults to `editor`. Unknown user → `404`; already a member → `409 conflict`.

### `PATCH /api/projects/{pid}/members/{username}` *(owner)*
`{ "role": "viewer" }` → `204`. Not a member → `404`; demoting the last owner → `400 last_owner`;
unknown role → `422`.

### `POST /api/projects/{pid}/members/{username}/invite-remote` *(owner)*
Adds the member to the remote repo, using the account the repo was created with
(`account_id`): GitHub → collaborator with `push` (by the user's GitHub login, see Admin);
GitLab → Developer (by the user's own connected account on that server, else the same username).
`204`. Project without `account_id`, or no known GitHub login / no such GitLab user →
`400 invalid_request`; member below `editor` (the remote grants push) → `400 invite_role_too_low`;
not a member → `404`; provider error (e.g. already a member) → `502 remote_failed`.

### `DELETE /api/projects/{pid}/members/{username}` *(owner, or the member themselves)*
`204`. Removing (or leaving as) the last owner → `400 last_owner`; anyone else removing
someone → `403 insufficient_role`; not a member → `404`.

## Admin

All routes require `is_admin` (`403 forbidden` otherwise). Mirrors the admin CLI.

```ts
type AdminUser = {
  id: number; username: string; display_name: string;
  email: string | null; github: string | null; is_admin: boolean;
  commit_email: string | null; created_at: string;
}
```

### `GET /api/admin/users` → `AdminUser[]`

### `POST /api/admin/users`
`{ "username": "julius", "display_name"?: "Julius", "email"?: "x@gmail.com", "github"?: "login", "is_admin"?: false }`
At least one of `email` (Google login) / `github` (GitHub login) → else `400 invalid_request`.
Duplicate username/email/github → `409 conflict`. `201` → `AdminUser`.

### `PATCH /api/admin/users/{id}`
Any subset of `{ display_name, email, github, is_admin, commit_email }` (`null` clears
`email`/`github`/`commit_email`; `commit_email` validated like `PATCH /api/auth/me`) → `200 AdminUser`.
An admin cannot remove their own admin flag (`409 conflict`).

### `DELETE /api/admin/users/{id}` → `204`
Deletes the user, their sessions and memberships; in projects where they were the last owner the
deleting admin becomes owner; projects they created get the admin as `owner` (creator). Deleting yourself → `409 conflict`.

## Templates

Initial content for repos created with `create_remote`. Built-ins are part of the server; every
user can add more as ZIP (e.g. an Overleaf export). Uploads are anonymized (it's about the design,
not the text) and get a PDF preview.

```ts
type Template = {
  id: string;                    // "builtin:article" | "builtin:report" | "builtin:thesis" | random hex
  name: string; description: string;
  compiler: "pdflatex" | "xelatex" | "lualatex";
  main_file: string;             // path in the template, e.g. "main.tex" or "Arbeit.tex"
  builtin: boolean;
  owner: string | null;          // uploader's username; null for built-ins (or a deleted user)
  preview: "pending" | "ready" | "failed";   // built-ins: always "ready"
  public: boolean;               // built-ins: true
}
```

**Visibility:** built-ins and public templates for every logged-in user; a private template only
for its owner and admins. Uploads start **private**, so the owner can check the anonymized files
and the preview first. A template the caller can't see is answered like a missing one (`404`, in
`create_remote` → `400`). **Changing/deleting:** the owner or an admin, others `403 forbidden`;
built-ins → `400 invalid_request`.

### `GET /api/templates` → `Template[]` (any logged-in user)
Built-ins first (`Leer (article)`, `Bericht`: report + chapters + biblatex, `Abschlussarbeit`:
KOMA `scrreprt` + title page + `kapitel/` + biblatex/biber + `abbildungen/`, all `pdflatex`),
then the visible uploaded ones by name.

### `POST /api/templates` (any logged-in user)
`multipart/form-data`: `file` (the `.zip`), `name` (required), `description`, `compiler`
(optional; omitted → detected) → `201 Template` (`public: false`, `preview: "pending"`).
Request body max 25 MB.
- Extraction rules: at most 2000 entries and 50 MB uncompressed; an entry > 1 MB compressed more
  than 100:1 → `400 too_large` (body over 25 MB too). Absolute paths, `..`, `.`, empty segments,
  backslashes, control characters, symlinks or other special files → `400 unsafe_path`. Not a ZIP
  (or a path that is both file and folder) → `400 invalid_zip`.
- A single top-level folder around everything is removed. Dropped: `__MACOSX/`, `.DS_Store`, `.git/`,
  build output (`*.aux *.log *.synctex.gz *.fdb_latexmk *.fls *.out *.toc *.bbl *.blg`) and the
  main file's PDF.
- `main_file`: a `.tex` containing `\begin{document}` outside `%` comments (`\%` is text, `\\%`
  starts a comment, `\verb|…|` is skipped; the preamble may live in an `\input` file); the
  shallowest, then `main.tex`, then alphabetically first. None → `400 no_main_file`. Its name may
  not contain `* ? [ ] !`, start with `#` or have leading/trailing spaces (it becomes a pattern
  in `.gitignore` and the CI artifact path) → `400 unsafe_path`.
- Detected `compiler`: the engine of `main_file` by the same rules as projects with
  `compiler: "auto"` (LaTeX compile → Engine detection: magic comment, packages outside engine
  conditionals in the main file and what it includes, else `pdflatex`), on the upload before
  anonymization.

**Anonymization** (before anything is stored). *Design* is the main file's preamble and `.tex`
files included only from a preamble; *content* is everything from `\begin{document}` on, files
included from there and `.tex` files nobody includes.
- All `%` comments are removed (`\%` is text; verbatim bodies untouched; `% !TEX …` magic
  comments stay).
- Content: every word becomes a Lorem Ipsum word of the same length and capitalization
  (deterministic per word); punctuation, numbers below 5 digits and units (`12pt`) stay, longer
  digit runs are replaced. Command and environment names stay, as do `[…]` options (except of
  `\section`-like commands, `\caption`, `\item`: those are text), math (`$…$`, `$$…$$`, `\(…\)`,
  `\[…\]`, `equation`/`align`/… environments) and the arguments of structure, reference and setup
  commands: `label`, `ref`/`eqref`/`autoref`/`cref`/`Cref`/`pageref`/`nameref`, the `cite`
  family, `input`/`include`/`subfile`/`import`/`subimport`, `includegraphics`/`includepdf`/
  `lstinputlisting`/`inputminted`, `begin`/`end`, `usepackage`/`RequirePackage`/`documentclass`,
  `url`, the first of `href`/`textcolor`/`colorbox`, bibliography commands, lengths
  (`setlength`, `vspace`, …), colors, counters, page styles, `geometry`, `captionsetup`, KOMA font
  and option commands, `hypersetup`, `lstset`/`tikzset`/`sisetup`, glossary/acronym references
  and the name of `newenvironment`/`newtheorem`/`newcounter`. Spec arguments of `tabular`-like
  environments and `minipage` stay. Headings become Lorem Ipsum. Label and citation keys stay
  as they are (they may contain words).
- Verbatim environments (`verbatim`, `Verbatim`, `lstlisting`, `minted`, `comment`) become Lorem
  lines with the same line count and indentation, `\verb|…|`/`\lstinline|…|` Lorem of the same
  length; files included via `\lstinputlisting`/`\inputminted` too.
- Design stays unchanged except metadata: the arguments of `\author`, `\title`, `\subtitle`,
  `\date`, `\subject`, `\publishers`, `\dedication`, `\titlehead`, `\thanks`, `\email`, `\orcid`,
  `\affiliation`, `\institution`, `\address`, `\keywords` and the `hypersetup`/`hyperref` keys
  `pdfauthor`, `pdftitle`, `pdfsubject`, `pdfkeywords` become Lorem Ipsum including digits (also
  in the content). So do `\newcommand`/`\renewcommand`/`\providecommand`/`\def` bodies that are
  text only (no parameters, no math, a word or a number of ≥ 4 digits; not `@` macros or
  `\…name` labels such as `\figurename`): matriculation number, supervisor ….
- `.bib`: one dummy entry per original key with its entry type: author `Mustermann, Max`, a Lorem
  title, year 2000 (2001, 2002 … from the 27th entry on, author-year styles run out of labels).
- Images and PDFs (`png jpg jpeg pdf eps ps svg`): kept if referenced only from the design or a
  `titlepage` environment (or in metadata such as `\titlehead`), e.g. a logo; otherwise (used in
  the content or not referenced) replaced by a grey placeholder of the same format.
- Kept unchanged: `.cls .sty .bst .bbx .cbx .dbx .lbx .def .cfg .clo .fd .ldf`, fonts
  (`.ttf .otf .pfb .pfm .afm .tfm .vf .map .enc .woff .woff2`) and empty files (`.gitkeep`).
  Every other file (`.txt`, `.md`, `.csv`, `.json`, `.py` …, unless included as a listing) is
  removed.

**Preview:** after the upload the anonymized template is compiled in the background in the compile
sandbox (`latexmk` with the template's `compiler`, like a project compile: errors don't matter
as long as a PDF comes out), one build at a time; `preview` turns `ready` or `failed` (the log
stays on the server). Built-ins are built on their first `GET …/preview.pdf` and cached. The PDF is
stored next to the template, it is not part of the files copied into new repos.

### `PATCH /api/templates/{id}` *(owner or admin)*
Any subset of `{ "public": true, "name": "…", "description": "…" }` → `200 Template`. Empty
`name` → `400 invalid_request`.

### `DELETE /api/templates/{id}` *(owner or admin)* → `204`
Projects created from it are unaffected.

### `GET /api/templates/{id}/preview.pdf`
`application/pdf` (`Cache-Control: no-cache`). `404 preview_pending` while it is being built,
`404 preview_failed` if it didn't compile (for a built-in, the next request tries again).

### `GET /api/templates/{id}/files` → `{ path: string, size: number }[]`
The template's files after anonymization, sorted by path (`size` in bytes).

## Workspace

### `GET /api/projects/{pid}/tree`
```ts
type Tree = {
  repos: Repo[];       // parent first, then submodules sorted by path
  entries: Entry[];    // all files + dirs, sorted by path; excludes .git, symlinks and build output
};
type Repo = {
  path: string;        // "" = parent repo, else submodule path e.g. "papers/icml"
  name: string;        // last path segment, parent = workspace dir name
  kind: "parent" | "submodule";
  initialized: boolean;  // submodule checked out? (uninitialized ones have no entries)
  branch: string | null; // null = detached HEAD
  head: string | null;   // short commit sha
};
type Entry = {
  path: string;
  kind: "file" | "dir";
  repo: string;        // path of the innermost repo containing this entry
};
```

### `GET /api/projects/{pid}/files/{*path}`
Raw bytes, `Content-Type` guessed from extension (`.tex/.bib/.sty/.cls/.txt/.md` → `text/plain; charset=utf-8`).
For files open in the editor the CRDT is the truth — use the doc WebSocket, not this endpoint.

### `PUT /api/projects/{pid}/files/{*path}`
Body: raw bytes (max 64 MiB). Creates (incl. parent dirs) or overwrites atomically.
Writing below an uninitialized submodule → `400 invalid_path`. Emits `tree_changed` when the file is new. If the file has an active CRDT doc,
the content is applied to the doc as a replace and broadcast; then it must be UTF-8 without NUL (`400 invalid_request`)
and at most 8 MiB (`413 too_large`), like any file the editor opens. `204`.

### `DELETE /api/projects/{pid}/files/{*path}`
Deletes a file or empty directory (`409 conflict` if not empty). `204`. Emits `tree_changed`. Active doc clients receive a `doc_deleted` event. Its comment threads are deleted (`comments` event).

### `POST /api/projects/{pid}/files/move` *(editor)*
Renames or moves a file or directory inside **one repo** (no crossing into/out of a submodule, never a submodule root itself).
```ts
// body
{ from: string; to: string; update_refs?: boolean }   // workspace-relative paths; update_refs default false
// 200
{ moved: { from: string; to: string }[];               // one entry per file (a directory lists its files)
  updated_refs: { file: string; count: number }[] }    // file = path after the move; empty without update_refs
```
- Errors: `404 not_found` (`from` missing), `409 exists` (`to` exists), `400 cross_repo` (other repo/submodule, or `from` is or contains a submodule), `400 invalid_request` (`to` inside `from`), `400 invalid_path`, `403 insufficient_role`. `to`'s parent directories are created.
- Open docs at or below `from` are retired first: their final text is written to disk, later client updates are dropped and the sockets are closed with `4404`; then the file is renamed (atomically, never replacing: `409 exists`) and everybody on the events socket gets `{ type: "moved", from, to }` (plus `tree_changed`). Clients reopen the docs by their new path. If the rename itself fails (the docs were already retired), `{ type: "moved", from, to: from }` is sent so clients reconnect in place; steps after a successful rename (comments, Zotero links, main files, reference rewrites) are best effort and never turn the response into a 500. A moved path is never written again from the old room.
- Comment threads, Zotero links (`zotero_links`) and `main_files` entries below `from` follow (`comments` event for the new path); known compile roots are renamed (a compile still running keeps its old name until it ends).
- `update_refs: true` rewrites references that resolved to a moved file: `\input`, `\include`, `\subfile`, the `\import` family, `\includegraphics` (also without extension, via `\graphicspath`), `\includepdf`, `\bibliography`, `\addbibresource`, `\lstinputlisting`, `\inputminted`, and `\graphicspath` entries. Paths are resolved relative to the directory of the root that includes the file (as for the compile roots); references of a moved root are rebased. `\import` is relative to the root, `\subimport` and files included through an import are relative to the import's directory. Commented-out and verbatim text is left alone. Files open in the editor are changed through their doc (collaborators see it), others on disk. Only the repo of `from` is searched.
- Note: the static route `files/move` shadows a file named exactly `move` in the workspace root for `GET/PUT/DELETE /files/move`.

### `GET /api/projects/{pid}/files/move/preview?from=…&to=…` *(viewer)*
Same validation as the move; changes nothing. `200 { references: { path: string; line: number; old: string; new: string }[] }`: the references `update_refs` would rewrite (`path` = file before the move, `line` 1-based, `old`/`new` = the path text inside the braces).

## Documents (CRDT) — `WS /ws/projects/{pid}/doc/{*path}`

Standard **y-websocket** binary protocol (y-protocols), so the stock client works:
```ts
new WebsocketProvider(`${wsBase}/ws/projects/${pid}/doc`, "papers/icml/main.tex", ydoc)
// → connects to /ws/projects/{pid}/doc/papers/icml/main.tex
```
- One room per file path. Shared type: `ydoc.getText("content")` (UTF-8 text of the file).
- Binary frames, first varUint = message type:
  - `0` sync — `0` SyncStep1(state vector) · `1` SyncStep2(update) · `2` Update(update)
  - `1` awareness — awareness update (relayed to all room peers)
  - `3` query-awareness — server replies with full awareness state
- Server sends SyncStep1 + SyncStep2 on connect; client does the same.
- **Awareness state** (set by frontend, required for live cursors, `y-codemirror.next` format):
  ```ts
  awareness.setLocalStateField("user", { name: me.display_name, color: "#e5484d", colorLight: "#e5484d33" });
  ```
- Only text files up to 8 MiB can be opened (`.tex .bib .sty .cls .txt .md .latexmkrc` etc.); binary or larger → close code `4415`.
- Close codes: `4401` unauthorized, `4404` file not found, `4415` not a text file, `4403` the
  user's project role changed or they were removed: not terminal, reconnecting applies the new role.
- **Read-only below `editor`** (viewer, commenter): the server still sends the doc and all
  updates and relays awareness (cursors, presence), but drops the client's SyncStep2 and Update
  messages unapplied; they never reach the doc, the disk or other clients. The editor should be
  read-only for them (`my_role`).
- Server writes the doc to disk 1000 ms after the last update. External changes (git pull,
  submodule update, other editors) are 3-way merged into the doc (base = last disk state; on a real
  conflict git-style `<<<<<<<` markers are kept) and arrive as normal updates.
- The CRDT state is persisted server-side, so `WebsocketProvider` auto-reconnects (also after a
  server restart) merge without duplicating text — keep the same `Y.Doc` when reconnecting.
- `%2F`-encoded and raw `/` room names are equivalent.

## Events — `WS /ws/projects/{pid}/events`

JSON text frames. One connection per browser tab. Client must tolerate unknown `type`s (ignore
them). The only client → server frame is the focus report (unknown or malformed frames are
ignored):

```ts
{ type: "focus"; path: string | null }   // file in focus; null = no editor focused / tab hidden
```

Send it whenever the focused file changes and again after every reconnect. `path` is
workspace-relative; an invalid one (absolute, `..`, control characters, > 1024 bytes) counts
as `null`.

```ts
type Event =
  | { type: "tree_changed" }                                  // refetch GET /api/projects/{pid}/tree
  | { type: "doc_reloaded"; path: string }                    // external change merged into doc (info/toast)
  | { type: "doc_deleted"; path: string }
  | { type: "moved"; from: string; to: string }               // file/dir renamed; docs below `from` are closed (4404), reopen under `to`
  | { type: "compile"; root: string; state: "queued" | "running" }
  | { type: "compile"; root: string; state: "success" | "failed"; result: CompileResult }
  | { type: "git_changed"; repo: string }                     // refetch git status for repo
  | { type: "comments"; path: string }                        // refetch GET …/comments?path=
  | { type: "chat"; message: ChatMessage }                    // chat message created / edited / deleted, see Chat
  | { type: "chat_resync" }                                   // events were missed (slow client): refetch the newest chat page
  | { type: "presence"; users: PresenceUser[] };              // who is online, see below

interface PresenceUser {
  username: string;
  display_name: string;
  file: string | null;   // file in focus (latest focus report over all the user's tabs); null = none
}
```

`presence` is the full list (replace, don't merge) of every user with an events socket open in
this project, one entry per user over all their connections, sorted by `display_name`. With
several tabs, the one that reported focus last decides `file`.
It is the **first frame** on every new events connection (includes the caller) and is sent
again whenever that list changes — not on reconnects that leave it unchanged.

## Comments

Threaded comments on a text range of a file, like Overleaf. Stored in the server's database,
**never in the Git repo**. Every endpoint is for project members (others get `404`); reading
needs `viewer`, every write `commenter` or higher (`403 insufficient_role`).

```ts
interface Thread {
  id: number;
  path: string;            // workspace-relative file
  start: number;           // UTF-16 offsets, same unit as Y.Text and CodeMirror
  end: number;
  quote: string;           // the commented text when the thread was created (≤ 1000 chars)
  detached: boolean;       // the text is gone: show only in the overview, not in the editor
  resolved: boolean;
  resolved_by: string | null;   // username
  created_by: string | null;    // username; null once that user was deleted
  created_at: string;           // ISO 8601 UTC
  messages: Message[];          // oldest first; the first one opened the thread
}
interface Message {
  id: number;
  author: string | null;        // username
  display_name: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}
```

**Anchors.** While the file is open in the editor, the server keeps each range as a pair of yrs
sticky indices (start sticks to the following, end to the preceding character, so text typed
right at either edge stays outside). Ranges follow every edit, including the diff-replace after
`git pull`. `GET` returns the live offsets; they are stored on every flush. A range whose text
was deleted entirely (`start == end`) becomes `detached`. When a file is opened, its threads are
re-anchored against the text: `quote` still at `start` → unchanged; else the nearest exact
occurrence of `quote` (by distance to the old `start`); none → `detached` (stays detached).
Clients should turn the offsets into `Y.RelativePosition`s on receipt, so highlights move with
edits until the next refetch.

After every change (create, reply, edit, delete, resolve, re-anchoring, detaching, file
deleted) the events socket sends `{ type: "comments", path }`; refetch that file's threads.

### `GET /api/projects/{pid}/comments[?path=papers/icml/main.tex]` → `Thread[]`
With `path`: that file's threads; without: all threads of the project (overview). Sorted by
`path`, then `start`.

### `POST /api/projects/{pid}/comments`
`{ "path": "papers/icml/main.tex", "start": 120, "end": 134, "body": "Cite this?" }` → `201 Thread`.
The server reads `quote` from the open doc, else from the file on disk. `start < end ≤` length
of the text in UTF-16 units, neither inside a surrogate pair, else `400 invalid_request`. No such
file → `404`; not UTF-8 text → `400`; larger than 8 MiB → `413 too_large`; below an uninitialized
submodule → `400 invalid_path`.

`body` (here and below) is trimmed and must then have 1 to 10 000 characters (`400 invalid_request`).

### `POST /api/projects/{pid}/comments/{id}/messages`
`{ "body": "Done." }` → `201 Message` (reply).

### `PATCH /api/projects/{pid}/comments/{id}` *(commenter)*
`{ "resolved": true }` → `200 Thread`. Reopening (`false`) clears `resolved_by`.

### `DELETE /api/projects/{pid}/comments/{id}` *(thread creator, owner or admin)* → `204`
Others → `403 forbidden`.

### `PATCH /api/projects/{pid}/comments/{id}/messages/{mid}` *(author only)*
`{ "body": "…" }` → `200 Message`, sets `edited_at`. Others → `403 forbidden`.

### `DELETE /api/projects/{pid}/comments/{id}/messages/{mid}` *(author only)* → `204`
Deleting the first message deletes the whole thread.

Deleting a file through `DELETE …/files/{*path}` deletes its threads. Deleting a project deletes
all of them. There is no rename endpoint yet; whoever adds one moves the threads along
(`UPDATE comment_threads SET path`).

## Chat

One chat per project for coordination. Stored in the server's database, **never in the Git
repo**. Members only (others get `404`); reading needs `viewer`, every write `commenter` or
higher (`403 insufficient_role`).

```ts
interface ChatMessage {
  id: number;                   // increasing; the order of the history
  author: string | null;        // username; null once that user was deleted
  display_name: string | null;
  body: string;                 // "" when deleted
  file: string | null;          // workspace-relative file the message points at
  line: number | null;          // 1-based, only with `file`
  created_at: string;           // ISO 8601 UTC
  edited_at: string | null;
  deleted: boolean;             // soft delete: the id stays, body/file/line are wiped
  mentions: string[];           // usernames of project members named as `@username` in body
}
```

**Mentions.** `@username` (case-insensitive, longest member name wins, not directly after a
letter, digit or `_`, not directly followed by one) is parsed by the server; `mentions` lists the
canonical usernames of **project members** only, in order of appearance, without duplicates.
Clients render `@name` for names in `mentions` highlighted and highlight messages that mention
the current user.

After every change the events socket sends `{ type: "chat", message }` with the message as it
is now (a deletion arrives with `deleted: true`). Own messages arrive that way too: dedupe by `id`.
When a slow client missed events, the server sends `{ type: "chat_resync" }` together with
`tree_changed`: refetch the newest page and merge by `id` (the newer of two versions wins:
deleted beats live, later `edited_at` beats earlier). Members whose membership ends get the
events socket closed with `4404`; role changes keep it open.

### `GET /api/projects/{pid}/chat[?before=<id>&limit=50]` → `ChatMessage[]`
The newest `limit` (default 50, 1..100) messages with `id < before` (no `before`: the newest
overall), **oldest first**. Fewer than `limit` entries = start of the history; load older ones
with `before = first id`.

### `POST /api/projects/{pid}/chat`
`{ "body": "Looks good @bob", "file": "papers/icml/main.tex", "line": 42 }` → `201 ChatMessage`.
`body` is trimmed and must then have 1 to 4000 characters. `file` is optional and must be a valid
workspace path (`400 invalid_path`; it need not exist); `line` is optional, ≥ 1 and needs `file`
(`400 invalid_request`). At most 30 messages per user and minute: `429 rate_limited`.

### `PATCH /api/projects/{pid}/chat/{id}` *(author only)*
`{ "body": "…" }` → `200 ChatMessage`, sets `edited_at`. File and line stay. Others (also
admins) → `403 forbidden`; a deleted message → `404`.

### `DELETE /api/projects/{pid}/chat/{id}` *(author only)* → `204`
Soft delete. Others → `403 forbidden`.

## Spell check

Spelling and grammar through a LanguageTool server (`UNDERTREE_LANGUAGETOOL_URL`; unset → every
`…/spellcheck` call is `404 spellcheck_disabled`, the dictionary still works). The server turns the
LaTeX into LanguageTool *AnnotatedText*: only prose is checked; commands, `[…]` options, math,
comments, verbatim-like environments (`verbatim`, `lstlisting`, `minted`, `comment`, `tikzpicture` …)
and the arguments of key/path commands (`\label`, `\ref`, `\cite…`, `\includegraphics`, `\url`,
`\input`, `\usepackage` …) are markup, and so is everything before `\begin{document}`. Text arguments
(`\section`, `\emph`, `\caption`, `\footnote` …) are prose. Offsets are UTF-16 into the file.

**Language**, first match wins: the request's `language`; `% !TeX spellcheck = de_DE` in the first
20 lines of the file; for its root (the file itself or the root including it, as for compiling) that
magic comment, else the last babel language (`main=` wins) or polyglossia `\setmainlanguage[variant=…]`
in the root and the files it includes, else a language option of `\documentclass`; else `auto`.
Babel/polyglossia names map to `de-DE`/`de-AT`/`de-CH`, `en-US`/`en-GB`, `fr`, `es`, `it`, `nl`,
`pt-PT`/`pt-BR`, `pl-PL`; other names are skipped (babel) or `auto` (polyglossia).

### `POST /api/projects/{pid}/spellcheck` *(viewer)*
```ts
{ path: string; text?: string; start?: number; language?: string }
```
`text` omitted: the file (live editor state if open, else disk). With `text` (at most 100 KB), `start`
is its UTF-16 offset in the file, so a client can send only changed paragraphs. `200` →
```ts
type SpellIssue = {
  start: number; end: number;  // UTF-16 offsets in the file
  message: string; short: string;
  rule: string;                // LanguageTool rule id, e.g. GERMAN_SPELLER_RULE
  category: string;            // "TYPOS" = spelling, else grammar/style (GRAMMAR, CASING …)
  replacements: string[];      // at most 5
}[];
```
`TYPOS` hits on dictionary words (as written or in lowercase) are dropped; the project's
`disabled_rules` and `WHITESPACE_RULE` (TeX collapses spaces) are not checked. Limits per user: 2
requests at a time and 60 per minute (`429 rate_limited`); LanguageTool timeout 10 s. A `4xx` of LanguageTool (e.g. unknown language) is a generic `400 invalid_request`.

### `GET /api/projects/{pid}/dictionary` *(viewer)* → `{ words: string[]; disabled_rules: string[] }`
Shared by all members, words sorted.

### `POST /api/projects/{pid}/dictionary` *(editor)* `{ word }` → `204`
One word, 1–100 characters, no whitespace or `/`, not only dots (`400 invalid_request`); at most 10 000 per project. Adding it twice is fine.

### `DELETE /api/projects/{pid}/dictionary/{word}` *(editor)* → `204`

### `PUT /api/projects/{pid}/spellcheck/rules` *(editor)* `{ disabled_rules: string[] }` → same, sorted
Replaces the ignored rules ("Regel ignorieren"); ids `[A-Za-z0-9_]`, at most 200.

## LaTeX compile

Roots are `.tex` files with `\begin{document}` outside `%` comments. Once a root was compiled, it is **auto-recompiled**
after every disk flush of any file in the same repo (debounced, one run per root at a time;
changes during a run queue exactly one follow-up run). The project's `main_files` count as known
roots from the start (also after a server restart), so they are recompiled after a flush even if
they were never compiled in this server run. At most 2 runs of a project execute at the same
time, the others stay `queued`.

**Main files** (`Project.main_files`, set via `PATCH /api/projects/{pid}`, same for all members and
devices, like Overleaf's "Main document"): the roots to compile by default, see
`POST …/compile`. Entries that are no longer roots (deleted, `\begin{document}` removed) are
skipped when resolving, but kept in the list. Saving the list again drops stored entries whose file is gone (404) or is no longer a root (`no_root`) but keeps those in a currently uninitialized submodule.
Build output lives outside the repo (`$UNDERTREE_DATA/projects/{pid}/build/...`), never in the working tree.

### `GET /api/projects/{pid}/roots`
`200` → `RootFile[]` sorted by `path`: the roots of the parent repo and all initialized submodules.

```ts
type RootFile = {
  path: string;      // workspace-relative, e.g. "papers/icml/main.tex"
  repo: string;      // repo containing it ("" = parent), as in GET /tree
  engine: "pdflatex" | "xelatex" | "lualatex";  // detected (what compiler "auto" uses), whatever the project's compiler
  reason: string;    // why, see Engine detection
  language: string;  // spell-check language (LanguageTool code such as "de-DE", or "auto"), see Spell check
};
```
Scanned: `.tex` files, skipping hidden files/folders (`.…`), folders named `build`, `out` or
`node_modules`, symlinks and uninitialized submodules; at most 500 files / 20 MB are read (beyond
that the list may be incomplete). Reads the files on disk (live edits reach it after the debounced flush).

**Engine detection** (per root, for `roots` and for every run with `compiler: "auto"`), first match wins:
1. Magic comment in the root's first 20 lines, case-insensitive: `% !TEX program = <x>` or
   `% !TeX TS-program = <x>`, `<x>` one of `pdflatex|xelatex|lualatex` (also `pdftex`, `xetex`,
   `luatex`) → that engine, `reason: "magic_comment"`. Other values are ignored.
2. Packages outside engine conditionals, in the root and every file it includes transitively
   (`\input{}`, `\include{}`, `\subfile{}`, `\import{dir}{file}`, `\subimport{dir}{file}`; resolved
   against the root's directory, or the import's directory; `.tex` is added when missing; missing
   files are ignored): `luacode`, `luaotfload`, the `luacode`/`luacode*` environment or `\directlua`
   → `lualatex`; else `fontspec`, `unicode-math`, `polyglossia`, `xltxtra` → `xelatex`.
   `reason: "package:<name>"`, e.g. `package:fontspec`, `package:luacode`, `package:directlua`.
   Packages come from `\usepackage`/`\RequirePackage` outside `%` comments.
   *Engine conditionals:* everything between `\ifPDFTeX`, `\ifXeTeX`, `\ifLuaTeX`, `\ifpdf`,
   `\ifpdftex`, `\ifxetex`, `\ifluatex` and the matching `\fi` (nested `\if…`/`\fi` counted, `\else`
   branches included; `\newif\if…` and argument-taking macros such as `\ifthenelse`/`\iftoggle`
   open nothing) does **not** count, includes there are not followed: such a document runs with
   every engine.
3. Otherwise `pdflatex`, `reason: "default"`.

### `POST /api/projects/{pid}/compile`
Body `{ "root"?: "papers/icml/main.tex", "clean"?: boolean }` → `202 { "root": "...", "state": "queued" }`.
`root` may be omitted (`{}`): the project's first `main_files` entry that still exists and is a
root is compiled, `400 no_root` if there is none.
`clean: true` = **Recompile from scratch**: the root's build output dir (`.aux`, `.bbl`,
`.fdb_latexmk`, …, also the last PDF) is deleted before the run. If that root is compiling, the
queued follow-up run is the clean one. Default `false`: incremental (`latexmk` reuses earlier output).
`root` may also be a file that is not a root (e.g. `papers/icml/kapitel/01.tex`); the server then
compiles the root it belongs to, within the same repo (nested submodules are separate). A
`main_files` root of that repo wins: the first one that includes the file transitively, else the
first one of that repo. Without one:
1. a root that includes it transitively (rules as in Engine detection, includes inside engine
   conditionals count here); several → the shallowest path, then alphabetically first;
2. else a root in the nearest ancestor directory (alphabetically first there);
3. else the repo's only root;
4. else `400 no_root`.

The response's `root` is the root actually compiled; the `compile` events and
`GET …/compile?root=` use that path.
Result arrives via `compile` event. `400` if `root` is not a `.tex` file or is in an uninitialized
submodule, `404` if it doesn't exist.
A request while that root is compiling never fails: it queues the (single) follow-up run.
Runs `latexmk -g -f -pdf|-xelatex|-lualatex -interaction=nonstopmode -file-line-error -no-shell-escape -norc -synctex=1`
(engine = the project's `compiler`; `auto` → Engine detection on the run's snapshot) in a Landlock sandbox (read-only system, writes only to the build dir,
no access to server data or `/proc`, empty environment)
against a private snapshot of the initialized repo (no `latexmkrc` from the repo is executed);
source trees containing symlinks or special files are rejected. Compilation has a 120 s timeout.
Like Overleaf, TeX keeps going past errors: a `failed` run may still carry a `pdf_url`
(the PDF written by that run); errors are in `diagnostics`. Subdirectories of the source are
mirrored into the build dir, so `\include{chapters/a}` works.

### `GET /api/projects/{pid}/compile?root=papers/icml/main.tex`
`200` → `CompileResult` of the last run, `404` if never compiled.

```ts
type CompileResult = {
  root: string;
  state: "success" | "failed";
  started_at: string;      // RFC 3339
  duration_ms: number;
  pdf_url: string | null;  // "/api/projects/{pid}/pdf/papers/icml/main.tex?v=<unix_ms>" — null if this run produced no PDF (also possible when failed)
  diagnostics: Diagnostic[];
  engine: "pdflatex" | "xelatex" | "lualatex";  // engine this run used
  engine_reason: string;   // "fixed" (project compiler not "auto"), else as RootFile.reason
};
type Diagnostic = {
  severity: "error" | "warning" | "badbox";
  file: string | null;     // workspace-relative path if resolvable
  line: number | null;     // 1-based
  message: string;
};
```

### `GET /api/projects/{pid}/compile/log?root=...`
`200 text/plain` full `latexmk` / `.log` output of the last run.

### `GET /api/projects/{pid}/pdf/{*root}`
`200 application/pdf` of the last successful build (`Cache-Control: no-cache`). `404` if none.
`?v=` is only a cache buster.

### `GET /api/projects/{pid}/wordcount?root=papers/icml/main.tex`
`200` → `WordCount` of the root and every file it includes (`\input`, `\include`; read from disk
after flushing live edits). `root` is validated and resolved like `POST …/compile` (an included file
stands for its root; `400 no_root` if there is none). Runs TeX Live `texcount -inc -utf8 -brief` on
a private snapshot (same rules as compile) in the sandbox (read-only, empty environment, 10 s
timeout). Files outside the snapshot (absolute `\input` paths) are not counted.
`502 wordcount_failed` (short message) if texcount fails, times out or the source is rejected.

```ts
type WordCount = {
  words: number;         // words in text (sum of per_file)
  headers: number;       // words in headers
  captions: number;      // words outside text (captions, etc.)
  math_inline: number;   // number of inline formulas
  math_display: number;  // number of displayed formulas
  per_file: { path: string; words: number }[];  // workspace-relative, texcount's order; words in text
};
```

### SyncTeX
Every run writes `<stem>.synctex.gz` into the root's build dir. The endpoints below run the TeX Live
`synctex` CLI on it (same sandbox, read-only build dir, empty environment, 5 s timeout) and map the
snapshot paths back to workspace paths. Coordinates are **PDF points (1/72 in), origin top left,
y growing downwards**, pages from 1 (the same units as PDF.js at scale 1 with a top-left origin).
`root` is validated and resolved like `POST …/compile` (`400` invalid/uninitialized, `404` missing;
an included file stands for its root, `400 no_root` if there is none). `line` and `page` start at 1
(`0` → `400`). They use the last run's SyncTeX data, which may be newer than the last *successful*
PDF; every run first deletes the previous `<stem>.synctex.gz`, so a run that writes none leaves
`404 no_synctex`, never stale positions.

`404 no_synctex` if `root` has no SyncTeX data yet (never compiled, or last compiled before SyncTeX
existed): compile it first.

#### `GET /api/projects/{pid}/synctex/forward?root=papers/icml/main.tex&file=papers/icml/sections/intro.tex&line=12&column=0`
Source → PDF. `file` is workspace-relative and may be any file the root includes; `line` is 1-based,
`column` (optional, default `0`) is passed through (pdfTeX records no columns).
`200` → `SyncBox[]`, deduplicated, in synctex's order; `[]` if nothing in the PDF comes from that line
(also when `file` is not in the root's directory tree). `400` if `file` is not a valid workspace path.

```ts
type SyncBox = {
  page: number;  // 1-based
  x: number;     // left edge
  y: number;     // top edge (baseline - h)
  w: number;     // width
  h: number;     // height above the baseline
};
```

#### `GET /api/projects/{pid}/synctex/inverse?root=papers/icml/main.tex&page=2&x=200.5&y=131`
PDF → source. `x`, `y` in points as above, each within `0..=100000` (`400` otherwise, also for
`NaN`/`inf`). synctex picks the nearest source position on that page, so a click anywhere on a page
with content matches.
`200` → `{ file: string, line: number, column: number }`: `file` workspace-relative, `line` 1-based,
`column` `0` when unknown (always, with pdfTeX).
`404 no_match` if there is none (e.g. the page doesn't exist) or it lies outside the root's
directory (a TeX Live class, the `.aux`).

## Git

All take `repo` (`""` = parent, else submodule path). Commands run as the native `git` CLI in
that repo's directory. Commits use the logged-in user as author **and** committer
(`name <email>`, no bot identity), with name = per-project `commit_name` (if set) else
`display_name`, and e-mail chosen so GitHub/GitLab attribute it:
1. the user's per-project `commit_email` (`PATCH …/git/identity`), if set;
2. the user's profile `commit_email`, if set;
3. on a `github.com` remote (the repo's `origin`), for users who logged in with GitHub:
   `<github_id>+<github_login>@users.noreply.github.com`;
4. the user's (Google, verified) `email`;
5. the GitHub noreply address, if known;
6. `<username>@users.undertree`.

### `PATCH /api/projects/{pid}/git/identity` *(editor)*
`{ "commit_name"?: string | null, "commit_email"?: string | null }` → `200 { "commit_name": string | null, "commit_email": string | null }`.
Sets or clears (`null` / `""`) the caller's own commit author name and/or e-mail for this project
only (partial update: omitted fields stay unchanged). Validates `commit_name` (trimmed, 1–200 chars,
no control chars or `<>`, not only punctuation) and `commit_email` like `PATCH /api/auth/me`.
Used for commits and `Co-authored-by` trailers in this project (`GET …/git/coauthors` also returns
the effective `display_name`).

**Co-authors:** the server remembers per project which users changed which files since they were
last committed (live document edits that change the text, `PUT`/`DELETE` on the files API; in
memory, lost on restart). A commit appends a `Co-authored-by: display_name <email>` trailer (same
e-mail rule) for every such user whose files are part of the commit, except the author; afterwards
those files' entries are cleared.

Before any git command, pending CRDT disk writes of that repo are flushed; files changed by
pull/submodule update are merged into open docs via the file watcher. One git operation per repo at a time.
A `repo` that is not the parent or an initialized submodule → `400 invalid_request`.

### `GET /api/projects/{pid}/git/status?repo=papers/icml`
```ts
type GitStatus = {
  repo: string;
  branch: string | null;
  upstream: string | null;  // e.g. "origin/main"
  ahead: number;
  behind: number;           // as of last fetch/pull
  files: { path: string; index: string; worktree: string }[]; // porcelain v1 XY codes, path workspace-relative
};
```

### `GET /api/projects/{pid}/git/diff?repo=...&path=...&staged=false`
`200 text/plain` unified diff. `path` optional (whole repo if omitted).

### `GET /api/projects/{pid}/git/log?repo=...&limit=20`
`200` → `{ sha: string; short: string; author: string; date: string; subject: string }[]`

### `POST /api/projects/{pid}/git/commit`
Body `{ "repo": "papers/icml", "message": "Fix intro", "paths": ["papers/icml/intro.tex"], "co_authors": ["julius"] }`
`paths` optional — omitted = stage everything in that repo (`git add -A`).
`co_authors` optional (usernames) — omitted = everyone detected (see `coauthors`); present = exactly
these (`[]` = none; the author is skipped). Each must be the project owner, a member or an admin,
else `400 invalid_request`.
`200` → `{ "sha": "...", "short": "abc1234" }`. `409 conflict` if nothing to commit.

### `POST /api/projects/{pid}/git/auto-push` *(editor)*
Runs the conflict-free auto-commit & push pass immediately across initialized submodules and the
parent repo using the project's `auto_push_message` template (most recent contributor as author,
other concurrent editors as `Co-authored-by`). Before committing, fetches upstream; non-overlapping
or cleanly 3-way-mergeable remote text changes (`diffy::merge` preflight in memory) are merged
into open docs before pushing. Line/binary/diverged conflicts abort cleanly with `409 conflict`
without leaving conflict markers on disk and record `auto_push_last_error`.
`200` → `{ "pushed": boolean, "sha": string | null, "auto_push_last_at": string | null, "auto_push_last_error": string | null }`.

### `GET /api/projects/{pid}/git/coauthors?repo=papers/icml&paths=papers/icml/intro.tex`
`200` → `{ username: string; display_name: string }[]` — co-authors detected for the next commit
with the same `repo`/`paths` (`paths` optional, repeatable), excluding the caller.

### `POST /api/projects/{pid}/git/pull` · `POST /api/projects/{pid}/git/push`
Body `{ "repo": "papers/icml" }` → `200 { "stdout": "...", "stderr": "..." }`.
Pull = `git pull --ff-only` (no merges from the UI; `409 conflict` if not fast-forwardable).
Push rejected (non-ff) → `409 conflict`.

### `POST /api/projects/{pid}/git/submodule-update`
Body `{ "path": "papers/icml", "remote": true }` — `path` optional (all submodules),
`remote` default `true` (`git submodule update --init --remote [-- path]`), run in the parent repo.
`200 { "stdout": "...", "stderr": "..." }`. Emits `tree_changed` + `git_changed` events.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `UNDERTREE_DATA` | `./data` | SQLite DB, project clones (`projects/{pid}/repo`), CRDT state, build output, uploaded templates (`templates/{id}/`) |
| `UNDERTREE_SECRET_KEY` | auto (`$DATA/secret.key`, 0600) | base64 32-byte key encrypting stored git tokens; set it to keep tokens decryptable when `$DATA/secret.key` is lost |
| `UNDERTREE_BIND` | `127.0.0.1:3000` | listen address |
| `UNDERTREE_PUBLIC_URL` | `http://localhost:3000` | external URL (`https://<DEINE-DOMAIN.TLD>`), used for OAuth redirects, Origin check, Secure cookie |
| `UNDERTREE_STATIC_DIR` | `frontend/dist` | built frontend |
| `UNDERTREE_GITHUB_CLIENT_ID` / `_SECRET` | – | enables GitHub OAuth (callback `<PUBLIC_URL>/api/auth/oauth/github/callback`) |
| `UNDERTREE_GOOGLE_CLIENT_ID` / `_SECRET` | – | enables Google OAuth (callback `<PUBLIC_URL>/api/auth/oauth/google/callback`) |
| `UNDERTREE_DEV_LOGIN` | `false` | enables `POST /api/auth/dev-login` (never with https) |
| `UNDERTREE_GITLAB_HOSTS` | empty | comma-separated `host` / `host:port` of GitLab servers users may connect accounts on (the PAT is only ever sent there); empty: any publicly reachable server (private addresses are always refused) |
| `UNDERTREE_LANGUAGETOOL_URL` | – | LanguageTool server (`http://languagetool:8010` with the compose service); unset = spell check off |
| `UNDERTREE_GITHUB_API_URL` | `https://api.github.com` | GitHub REST API base; only for tests (mock server) |
| `UNDERTREE_ZOTERO_SYNC_SECS` | `300` | seconds between the background checks of Zotero-linked `.bib` files; `0` = off |
| `UNDERTREE_AUTO_PUSH_POLL_SECS` | `15` | seconds between background checks for projects with `auto_push_interval_secs > 0`; `0` = off |
| `UNDERTREE_ZOTERO_API_URL` | `https://api.zotero.org` | Zotero Web API base; only for tests (mock server) |

## Admin CLI

```
undertree serve
undertree user add <username> [--display-name N] [--email E] [--github LOGIN] [--admin]   # needs --email (Google) and/or --github
undertree user list
undertree user remove <username>     # active sessions stop working immediately; open doc sockets end at the next reconnect (the admin API closes them at once)
```
