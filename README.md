# undertree

Self-hosted, collaborative LaTeX editor in the spirit of Overleaf. Every project is a Git
repository you connect with a URL and a token. Edits are saved and committed straight into that
repo. Git submodules are supported, so a paper can live inside a larger research repo.

Rust backend (axum, yrs CRDT), Preact + CodeMirror 6 + PDF.js frontend. LaTeX is compiled with
`latexmk` from a full TeX Live. Git operations call the native `git` CLI. Ships as one Docker
container.

> Status: in active development, used by a small team. The UI is in German.

## Features

**Editing**
- Real-time collaborative editing (CRDT) with live cursors of everyone in the file
- `Ctrl+S` saves and recompiles immediately; undo/redo and the usual editor shortcuts
- File tree that tells the parent repo apart from submodules
- Comments on marked text with replies and "resolved", like Overleaf; stored by undertree,
  not in the Git repo, and they move with the text as people edit
- Optional spelling and grammar check (self-hosted LanguageTool): the language comes from the TeX
  (babel, polyglossia, `% !TeX spellcheck`), commands, math, citations and code are skipped, and
  the project has a shared dictionary for technical terms

**LaTeX**
- Overleaf-like compile: you get a PDF even when the document has errors, and errors and
  warnings show up as clickable diagnostics with the raw log next to them
- PDF preview reloads after every compile
- SyncTeX: jump between source and PDF
- Compiler per project: **pdfLaTeX**, **XeLaTeX** or **LuaLaTeX**
- **Full TeX Live**: every CTAN package, `biber`/biblatex and luaotfload are preinstalled
- `\input`/`\include` from subfolders (thesis layouts with `chapters/…`)

**Git**
- Status, diff, commit, push, pull and `git submodule update --remote` from the UI, for the parent
  repo or one submodule
- **Contributions are attributable.** Each commit's author email lets GitHub/GitLab link it to the
  right account. Everyone who edited the committed files since the last commit is added as
  `Co-authored-by` (you can untick people in the commit dialog). Users can set their commit email
  in their profile.
- Remotes over HTTPS (token) or SSH
- **Create a new repo from undertree:** connect your GitHub account or a (self-hosted) GitLab
  server once. A new project then gets a fresh repo with `main.tex`, a CI pipeline that builds
  the PDF (GitHub Actions or GitLab CI, matching the project's compiler) and its own SSH deploy
  key with write access to that one repo only.
- Invite project members into the remote repo (GitHub collaborator / GitLab developer)
- **Templates:** start a new repo from a built-in template or one a user uploaded as `.zip`
  (e.g. an Overleaf export). Uploads are anonymized automatically (text becomes Lorem Ipsum,
  names and metadata are removed, the design stays), get a PDF preview and stay private until
  their owner publishes them.

**Projects and users**
- Multiple projects per user, each connected to its own Git repo (URL, branch, token)
- Project members: the owner invites registered users
- Login only through **GitHub or Google OAuth**: no passwords, no self-registration
- Admin panel and admin CLI to manage who may log in

## Security model

- **Login:** only users an admin registered can sign in (by GitHub login or verified Google
  email). Sessions are cookie-based, and state-changing requests have their `Origin` checked.
- **Git tokens:** stored encrypted (ChaCha20-Poly1305) and handed to `git` through a credential
  helper over the environment. They never appear in remote URLs or logs.
- **Connected accounts:**
  - Users can connect any GitLab server reachable from the internet; operators can restrict
    this to a list (`UNDERTREE_GITLAB_HOSTS`). Every API call is SSRF-guarded: `https` only, the
    host must resolve to public addresses only (no loopback, private, link-local, CGNAT, …), the
    connection is pinned to the vetted address and redirects are not followed.
  - Per-project SSH uses pinned github.com/gitlab.com host keys plus the operator's
    `known_hosts`. For a self-hosted GitLab, the server's ed25519 host key is trusted on first
    use: scanned (after the same address check) when the account creates its first repo, stored
    on the account (fingerprint shown in the API) and never replaced on a mismatch, so a changed
    key fails closed.
- **Compile sandbox:** a TeX document is code; LuaLaTeX can read any file. Every compile
  therefore runs in a [Landlock](https://docs.kernel.org/userspace-api/landlock.html) sandbox:
  - it may read only the system (TeX Live) and write only its own build directory;
  - it cannot reach the database, keys, other projects or the server's environment;
  - its environment is empty, `-no-shell-escape` is set and repo-provided `latexmkrc` files are
    ignored.

  undertree refuses to compile on kernels without Landlock (Linux < 5.13), rather than run
  without the sandbox.
- **Project access:** projects you cannot access return 404, not 403.

## Quick start (Docker)

Requirements: Linux host with Docker (Compose v1 or v2), kernel ≥ 5.13, about 10 GB of disk for
the TeX Live image, a domain with HTTPS through a reverse proxy, and a GitHub and/or Google OAuth
app.

```sh
git clone <this repo> undertree && cd undertree
cp .env.example .env          # set UNDERTREE_PUBLIC_URL and the OAuth client id/secret
docker compose up -d --build  # first build pulls full TeX Live (~5 GB download)
docker compose exec undertree undertree user add alice --github alice-gh --admin
```

Then point your reverse proxy at `127.0.0.1:3000` and log in as `alice`. More users can be added
in the admin panel or with the CLI:

```sh
docker compose exec undertree undertree user add bob --email bob@uni.example   # Google login
docker compose exec undertree undertree user list
```

[`docs/DEPLOY.md`](docs/DEPLOY.md) covers the full setup:
- Caddy config
- SSH keys for `git@…` remotes
- backups
- updates
- pinning a TeX Live year

## Configuration

Set in `.env`:

| Variable | Purpose |
|---|---|
| `UNDERTREE_PUBLIC_URL` | External URL. Used for OAuth callbacks, the Origin check and Secure cookies. |
| `UNDERTREE_GITHUB_CLIENT_ID` / `_SECRET` | Enables GitHub login. Callback: `<PUBLIC_URL>/api/auth/oauth/github/callback` |
| `UNDERTREE_GOOGLE_CLIENT_ID` / `_SECRET` | Enables Google login. Callback: `<PUBLIC_URL>/api/auth/oauth/google/callback` |
| `UNDERTREE_GITLAB_HOSTS` | GitLab servers users may connect (`host` or `host:port`, comma-separated). Default: empty, i.e. any publicly reachable server. |
| `UNDERTREE_LANGUAGETOOL_URL` | Optional. Spell/grammar check, e.g. `http://languagetool:8010` with `COMPOSE_PROFILES=spellcheck` ([deploy notes](docs/DEPLOY.md#spell-check-languagetool)). Unset: off. |
| `UNDERTREE_SECRET_KEY` | Optional. Base64 32-byte key for stored tokens. Default: generated in `data/secret.key`. |

[`docs/API.md`](docs/API.md#configuration-env) lists all variables.

## Roadmap

In progress:
- Dark/light mode and editor themes

Planned:
- Autocompletion for `\ref`/`\cite`/commands
- Document outline
- Optional `-shell-escape` inside the sandbox, for `minted` and similar packages

Maybe:
- Spell check
- Comments/track changes
- Visual history/diff
- Typst as a second engine

## Development

```sh
UNDERTREE_DEV_LOGIN=true cargo run -- serve   # http://127.0.0.1:3000, dev login without OAuth
cd frontend && npm i && npm run dev           # Vite dev server, proxies /api + /ws to :3000
```

Needs Rust (stable), Node 20, `git` and, to compile documents locally, `latexmk` with a TeX
distribution.

Before a merge request:

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd frontend && npm run lint && npm test && npm run build
```

### Docs

- [`docs/API.md`](docs/API.md): REST and WebSocket contract
- [`docs/AUTH.md`](docs/AUTH.md): login and session design
- [`docs/DEPLOY.md`](docs/DEPLOY.md): deployment
- [`AGENTS.md`](AGENTS.md): original spec and the multi-agent workflow this project is built with

## License

[PolyForm Noncommercial License 1.0.0](LICENSE.md): free to use, change and share for any
noncommercial purpose (personal, research, teaching, public institutions, charities).
Commercial use needs a separate license from the copyright holder.

Required Notice: Copyright (c) 2026 YouDyZ (https://github.com/YouDyZ)

### Third-party data

The optional in-browser spell checker (Hunspell via [nspell](https://github.com/wooorm/nspell), MIT) ships
two dictionaries from [wooorm/dictionaries](https://github.com/wooorm/dictionaries) as separate data files
(`.aff`/`.dic` in the frontend build, loaded only when used). They are not covered by the PolyForm Noncommercial license and keep their own licenses:

- German (`dictionary-de`, igerman98 by Björn Jacke): GPL-2.0 or GPL-3.0
- English (`dictionary-en`): MIT and BSD

The license texts are in the npm packages (`frontend/node_modules/dictionary-*/license`).
