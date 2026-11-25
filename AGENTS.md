# Project Specification: Collaborative LaTeX & Git Submodule Editor

## 1. Goal & Scope
Build a lightweight, self-hosted, web-based collaborative LaTeX editor in **Rust** tailored for academic papers organized as **Git submodules** inside a larger research repository.
- **Target Domain:** `<DEINE-DOMAIN.TLD>` (behind reverse proxy / HTTPS).
- **Core Features:**
  1. Multi-user real-time collaborative editing (CRDT-based) with live cursors.
  2. Browser-based LaTeX compilation (`latexmk`) with automatic PDF hot-reload & error log viewer.
  3. Native Git & Git-Submodule workflow (commit, push, pull, `git submodule update --remote` directly in the UI).
  4. Multi-user authentication: **OAuth-only login via GitHub or Google** (no passwords), session cookies, SQLite user store, admin CLI to register users (no self-registration).
  5. Single-container or Docker-Compose deployment including TeX Live.

## 2. Tech Stack (Strict)
- **Backend:** Rust (Edition 2021+), `axum` (HTTP + WebSockets), `tokio`, `yrs` (Yjs CRDT port for Rust), `sqlx` (SQLite), `axum-login` + `tower-sessions`, `oauth2`, `notify` (debounced file watching).
- **Git Integration:** Use `tokio::process::Command` wrapping the native `git` CLI (NOT `libgit2`/`git2`, to ensure full submodule & SSH-key compatibility).
- **Frontend:** Vanilla TypeScript / Vite (or lightweight React/Preact) bundled into static assets served by `axum` (via `rust-embed` or static dir). Use **CodeMirror 6** + `y-codemirror.next` + `y-websocket` + **PDF.js**.
- **Compiler:** `latexmk -pdf -f -interaction=nonstopmode` (Overleaf-like: PDF despite errors, errors as diagnostics) executed in a non-blocking `tokio::task`.

## 3. Architecture & Critical Invariants
- **Single Source of Truth (CRDT <-> Disk):**
  - While a file has active WebSocket clients, the `yrs::Doc` in memory is the source of truth.
  - Debounce disk writes (e.g., 1000ms after last edit) so `latexmk` and `git` see changes.
  - When an external Git operation (`git pull` or `submodule update`) modifies files on disk, pause file-watcher feedback loops, reload changed files into the active `yrs::Doc` via clean diff/replace, and broadcast updates to clients.
- **Submodule Awareness:**
  - The workspace points to a parent repo path. The UI file tree must clearly distinguish between the parent repo and initialized Git submodules, allowing Git actions (status, diff, commit, push) specifically inside a selected submodule or the parent repo.

## 4. Multi-Agent Coordination Protocol (Issues & Git)
Three autonomous agents collaborate on this repository via **GitLab Issues** (`glab` CLI; the remote is GitLab, so "PR" means Merge Request):
- **Claude Code** — backend & architecture (Rust, auth, CRDT, LaTeX, Git, Docker) — label `agent:claude`
- **Antigravity** — frontend core (Vite/TS scaffold, login, file tree, editor, E2E) — label `agent:antigravity`
- **GitHub Copilot** — frontend panels (PDF viewer, Git panel) and CI — label `agent:copilot`

The binding API contract is [`docs/API.md`](docs/API.md).

1. **Before writing code:** Check open issues (`glab issue list`). Never work on an issue already assigned or labeled `in-progress`.
2. **Claiming work:** Assign yourself / add label `in-progress` and comment on the issue with your implementation plan before creating a branch.
3. **Branching:** Create a dedicated branch per issue: `feat/issue-<number>-<short-slug>` or `fix/issue-<number>-<short-slug>`.
4. **Verification:** Before opening a PR, run `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, and verify frontend build (`npm run build`).
5. **Handoff & Review:** Open a Pull Request referencing `Closes #<number>`. If you discover missing dependencies, API contracts, or bugs in another module, **create a new Git Issue** labeled `agent-sync` describing the exact interface/requirement so the other agent can pick it up.
6. **Communication:** Keep all architectural decisions, API schema changes (WebSocket message formats, REST endpoints), and blockers documented in Issue comments so both agents stay synchronized.
7. **Approval (mandatory) — cross review:** Every Merge Request needs a review and approval by an agent **other than its author** before it is merged. Since 2026-11-24 Copilot has no quota, so Claude and Antigravity review each other's MRs; a Claude MR may also be reviewed by an independent Claude review agent that did not write the code. All agents share one GitLab account and GitLab CE has no approval rules, so the approval is the label `cross-reviewed`, set by the reviewer together with a review comment that names the reviewed head commit (`copilot-approved` keeps counting while Copilot has quota). A green pipeline alone is not enough. New commits pushed after the approval need a fresh look: the reviewer re-confirms in a comment.
