//! Git & submodule API over the native `git` CLI (no libgit2, see AGENTS.md).
//! docs/API.md → Git.

use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    process::Output,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::process::Command;

use crate::{
    auth::{select_user, AuthSession, User},
    error::ApiError,
    events::Event,
    projects::{Access, Project, ProjectCtx, Role},
    workspace::{is_within, RepoKind},
    AppState,
};

pub(crate) const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// Project git credentials (token from an encrypted DB column, see projects.rs).
#[derive(Clone)]
pub struct Creds {
    pub username: String,
    pub token: String,
    /// Normalized `host[:port]` (`:443` stripped, lowercased) when `remote_url` is `https://`.
    pub host: Option<String>,
}

/// Extracts normalized lowercase `host[:port]` (`:443` stripped) from an `https://` URL.
pub(crate) fn https_host(url: &str) -> Option<String> {
    let prefix = url.get(..8)?;
    if !prefix.eq_ignore_ascii_case("https://") {
        return None;
    }
    let rest = &url[8..];
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    if auth.is_empty() || auth.contains('@') {
        return None;
    }
    let lower = auth.to_ascii_lowercase();
    Some(lower.strip_suffix(":443").unwrap_or(&lower).to_owned())
}

/// Per-project git environment.
#[derive(Clone, Default)]
pub struct Remote {
    pub creds: Option<Creds>,
    /// local `file://` remotes/submodules; only tests set this (see `AppState::allow_file`)
    pub allow_file: bool,
    /// the project's own deploy key, see `PROJECT_SSH`
    pub ssh: Option<ProjectSsh>,
}

#[derive(Clone)]
pub struct ProjectSsh {
    /// private key (`…/ssh/id_ed25519`)
    pub key: PathBuf,
    /// file with `PINNED_KNOWN_HOSTS` (`AppState::pinned_hosts`)
    pub pinned_hosts: PathBuf,
}

/// SSH for projects with their own deploy key: only that key, no host config, and host keys only
/// from `PINNED_KNOWN_HOSTS`, the project's `ssh/known_hosts` (a self-hosted GitLab's key, trusted
/// on first use when undertree created the repo) or the operator's `~/.ssh/known_hosts`.
/// Paths come via env, so the shell never parses them; the inner quotes keep ssh from splitting
/// a path at spaces. `PROJECT_SSH_PROXY` adds the `ssh-proxy` ProxyCommand (only public
/// addresses, see `netguard::ssh_proxy`); tests with local remotes run without it.
const PROJECT_SSH: &str = r#"ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -i "$UNDERTREE_SSH_KEY" -o "UserKnownHostsFile=\"$UNDERTREE_SSH_KNOWN_HOSTS\" \"$UNDERTREE_SSH_PROJECT_HOSTS\" ~/.ssh/known_hosts""#;
const PROJECT_SSH_PROXY: &str = r#" -o "ProxyCommand=\"$UNDERTREE_SSH_PROXY\" ssh-proxy %h %p""#;

/// Officially published host keys of github.com and gitlab.com, see
/// https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
/// and https://docs.gitlab.com/ee/user/gitlab_com/#ssh-known_hosts-entries (fetched 2026-11-23,
/// fingerprints checked against those pages). Self-hosted servers go into `~/.ssh/known_hosts`.
pub const PINNED_KNOWN_HOSTS: &str = "\
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf
gitlab.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=
gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9
";

/// git stderr, plus what to do when ssh rejected an unknown host key.
pub fn explain(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.contains("Host key verification failed") || stderr.contains("host key is known") {
        format!(
            "{stderr}\nThe server's SSH host key is unknown: verify its fingerprint, then add it to \
             ./ssh/known_hosts (ssh-keyscan -t ed25519 <host> >> ssh/known_hosts)."
        )
    } else {
        stderr.to_owned()
    }
}

/// Reads host-scoped HTTPS credentials from env so tokens never leak to other hosts (e.g.
/// submodules or cross-host redirects) and never hit `.git/config`, argv or the remote URL.
const CREDENTIAL_HELPER: &str = r#"credential.helper=!f() { test "$1" = get || exit 0; proto=""; host=""; while IFS= read -r line; do case "$line" in protocol=*) proto=${line#protocol=} ;; host=*) host=${line#host=} ;; "") break ;; esac; done; host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]'); host=${host%:443}; if [ "$proto" = "https" ] && [ -n "$UNDERTREE_GIT_HOST" ] && [ "$host" = "$UNDERTREE_GIT_HOST" ]; then echo "username=$UNDERTREE_GIT_USERNAME"; echo "password=$UNDERTREE_GIT_TOKEN"; fi; }; f"#;

/// `git <args>` in `dir`, never prompting. `-c` options reach submodule subprocesses too
/// (git passes them on via GIT_CONFIG_PARAMETERS).
pub fn command(dir: &Path, args: &[&str], remote: &Remote) -> Command {
    let mut cmd = Command::new("git");
    // no host-level helper (e.g. ~/.git-credentials) may leak into any project
    cmd.args(["-c", "credential.helper="]);
    if let Some(c) = &remote.creds {
        if let Some(host) = &c.host {
            cmd.args(["-c", CREDENTIAL_HELPER])
                .env("UNDERTREE_GIT_HOST", host)
                .env("UNDERTREE_GIT_USERNAME", &c.username)
                .env("UNDERTREE_GIT_TOKEN", &c.token);
        }
    }
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        // a malicious repo must not pull `file://` submodules (other projects' clones on this host)
        .env(
            "GIT_ALLOW_PROTOCOL",
            if remote.allow_file {
                "https:ssh:file"
            } else {
                "https:ssh"
            },
        )
        // untranslated messages: error classification below matches on English stderr
        .env("LC_ALL", "C")
        .kill_on_drop(true);
    if let Some(ssh) = &remote.ssh {
        let mut ssh_cmd = PROJECT_SSH.to_owned();
        if !remote.allow_file {
            if let Ok(exe) = std::env::current_exe() {
                ssh_cmd.push_str(PROJECT_SSH_PROXY);
                cmd.env("UNDERTREE_SSH_PROXY", exe);
            }
        }
        cmd.env("GIT_SSH_COMMAND", ssh_cmd)
            .env("UNDERTREE_SSH_KEY", &ssh.key)
            .env("UNDERTREE_SSH_KNOWN_HOSTS", &ssh.pinned_hosts)
            .env(
                "UNDERTREE_SSH_PROJECT_HOSTS",
                ssh.key.with_file_name("known_hosts"),
            );
    } else if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    cmd
}

/// Replaces every occurrence of `secret` in `bytes` with `***`.
pub fn scrub(bytes: Vec<u8>, secret: &str) -> Vec<u8> {
    if secret.is_empty() {
        return bytes;
    }
    let s = secret.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(s) {
            out.extend_from_slice(b"***");
            i += s.len();
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Runs git (see `command`); the token is scrubbed from stdout/stderr.
pub async fn run(dir: &Path, args: &[&str], remote: &Remote) -> std::io::Result<Output> {
    let mut out = command(dir, args, remote).output().await?;
    if let Some(c) = &remote.creds {
        out.stdout = scrub(out.stdout, &c.token);
        out.stderr = scrub(out.stderr, &c.token);
    }
    Ok(out)
}

/// stdout of a successful local run, trimmed; `None` if git failed.
pub async fn stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let out = run(dir, args, &Remote::default()).await.ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// One lock per repo: no two git commands mutate the same repo at once.
#[derive(Default)]
pub struct Locks(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl Locks {
    pub(crate) fn get(&self, repo: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.0
            .lock()
            .unwrap()
            .entry(repo.into())
            .or_default()
            .clone()
    }
}

/// Workspace-relative paths → ids of the users who changed them (doc edits, file API) since the
/// path was last committed; the source of the `Co-authored-by` trailers.
// ponytail: in memory only, lost on restart (the next commit then credits only its author);
// persist to SQLite if restarts between edit and commit turn out to matter
/// Each entry carries the sequence number of its latest touch, so a commit clears only what
/// happened before it looked (`mark`), never edits that arrive while it runs.
#[derive(Default)]
pub struct Contributions(Mutex<(u64, Option<Instant>, HashMap<String, Touches>)>);

/// user id → sequence number of their latest touch
type Touches = HashMap<i64, u64>;

/// `changed` (a file git reports) is `touched` itself or lies in it (a deleted directory).
fn covers(touched: &str, changed: &str) -> bool {
    !touched.is_empty() && is_within(changed, touched)
}

impl Contributions {
    pub fn touch(&self, path: &str, uid: i64) {
        let (seq, last_touch, map) = &mut *self.0.lock().unwrap();
        *seq += 1;
        *last_touch = Some(Instant::now());
        map.entry(path.into()).or_default().insert(uid, *seq);
    }

    pub fn last_touch(&self) -> Option<Instant> {
        self.0.lock().unwrap().1
    }

    /// Current position; pass it to `clear` to keep everything touched afterwards.
    pub(crate) fn mark(&self) -> u64 {
        self.0.lock().unwrap().0
    }

    /// Users who touched `changed` paths up to `upto` (`u64::MAX`: everything so far).
    pub(crate) fn users(&self, changed: &[String], upto: u64) -> BTreeSet<i64> {
        let (_, _, map) = &*self.0.lock().unwrap();
        map.iter()
            .filter(|(t, _)| changed.iter().any(|c| covers(t, c)))
            .flat_map(|(_, users)| users.iter().filter(|(_, s)| **s <= upto).map(|(u, _)| *u))
            .collect()
    }

    /// Distinct user ids who touched `changed` up to `upto`, most recently active first.
    pub(crate) fn ordered_users(&self, changed: &[String], upto: u64) -> Vec<i64> {
        let (_, _, map) = &*self.0.lock().unwrap();
        let mut latest: HashMap<i64, u64> = HashMap::new();
        for (t, users) in map {
            if !changed.iter().any(|c| covers(t, c)) {
                continue;
            }
            for (&uid, &s) in users {
                if s <= upto {
                    latest
                        .entry(uid)
                        .and_modify(|prev| *prev = (*prev).max(s))
                        .or_insert(s);
                }
            }
        }
        let mut out: Vec<(i64, u64)> = latest.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        out.into_iter().map(|(uid, _)| uid).collect()
    }

    /// Forgets touches of `changed` paths up to `upto`.
    pub(crate) fn clear(&self, changed: &[String], upto: u64) {
        let (_, _, map) = &mut *self.0.lock().unwrap();
        map.retain(|t, users| {
            if changed.iter().any(|c| covers(t, c)) {
                users.retain(|_, s| *s > upto);
            }
            !users.is_empty()
        });
    }
}

/// Host of an `https://`, `ssh://` or scp-style (`git@host:path`) remote is github.com.
pub(crate) fn is_github(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    host.split(':')
        .next()
        .is_some_and(|h| h.eq_ignore_ascii_case("github.com"))
}

/// Commit e-mail of `u`, chosen so GitHub/GitLab attribute the commit to the user's account:
/// own `commit_email` > GitHub noreply (on github.com remotes) > (Google) `email` > GitHub
/// noreply > `<username>@users.undertree`.
pub fn author_email(u: &User, github_remote: bool) -> String {
    let noreply = match (u.github_id, &u.github_login) {
        (Some(id), Some(login)) => Some(format!("{id}+{login}@users.noreply.github.com")),
        _ => None,
    };
    u.commit_email
        .clone()
        .or_else(|| noreply.clone().filter(|_| github_remote))
        .or_else(|| u.email.clone())
        .or(noreply)
        .unwrap_or_else(|| format!("{}@users.undertree", u.username))
}

fn sanitize_ident_name(raw: &str) -> String {
    raw.replace(|c: char| c.is_control() || c == '<' || c == '>', "")
}

/// Display name safe for `Name <email>` (no control chars, no `<>`).
pub fn ident_name(u: &User) -> String {
    sanitize_ident_name(&u.display_name)
}

pub(crate) type IdentityOverride = (Option<String>, Option<String>);

pub(crate) async fn project_identities(
    db: &SqlitePool,
    pid: i64,
) -> Result<HashMap<i64, IdentityOverride>, ApiError> {
    let rows: Vec<(i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT user_id, commit_name, commit_email
           FROM project_commit_identities WHERE project_id = ?",
    )
    .bind(pid)
    .fetch_all(db)
    .await
    .map_err(ApiError::internal)?;
    Ok(rows
        .into_iter()
        .map(|(uid, name, email)| (uid, (name, email)))
        .collect())
}

pub(crate) fn effective_name(u: &User, ov: Option<&IdentityOverride>) -> String {
    ov.and_then(|(n, _)| n.as_deref())
        .map(sanitize_ident_name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| ident_name(u))
}

pub(crate) fn effective_email(
    u: &User,
    ov: Option<&IdentityOverride>,
    github_remote: bool,
) -> String {
    ov.and_then(|(_, e)| e.clone())
        .unwrap_or_else(|| author_email(u, github_remote))
}

/// Users with these ids, in a stable order.
pub(crate) async fn users_by_id(
    db: &SqlitePool,
    ids: &BTreeSet<i64>,
) -> Result<Vec<User>, ApiError> {
    sqlx::query_as(select_user!(
        "id IN (SELECT value FROM json_each(?)) ORDER BY display_name, username"
    ))
    .bind(json!(ids).to_string())
    .fetch_all(db)
    .await
    .map_err(ApiError::internal)
}

/// Explicit `co_authors`: each must be owner/member of project `pid` or an admin, else 400.
async fn project_users(db: &SqlitePool, pid: i64, names: &[String]) -> Result<Vec<User>, ApiError> {
    let users: Vec<User> = sqlx::query_as(select_user!(
        "username IN (SELECT value FROM json_each(?1))
           AND (is_admin OR id = (SELECT owner_id FROM projects WHERE id = ?2)
                OR id IN (SELECT user_id FROM project_members WHERE project_id = ?2))
         ORDER BY display_name, username"
    ))
    .bind(json!(names).to_string())
    .bind(pid)
    .fetch_all(db)
    .await
    .map_err(ApiError::internal)?;
    let unknown: Vec<&str> = (names.iter())
        .filter(|n| !users.iter().any(|u| &u.username == *n))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(ApiError::bad_request(format!(
            "not a project member: {}",
            unknown.join(", ")
        )));
    }
    Ok(users)
}

pub(crate) struct Git {
    output: Output,
}

impl Git {
    pub(crate) fn ok(&self) -> bool {
        self.output.status.success()
    }
    pub(crate) fn stdout_bytes(&self) -> &[u8] {
        &self.output.stdout
    }
    pub(crate) fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.output.stdout).into_owned()
    }
    pub(crate) fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.output.stderr).into_owned()
    }
    /// Successful run or `502 git_failed` with stderr.
    pub(crate) fn check(self) -> Result<Self, ApiError> {
        if self.ok() {
            Ok(self)
        } else {
            Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "git_failed",
                explain(&self.stderr()),
            ))
        }
    }
    fn streams(&self) -> Json<Value> {
        Json(json!({ "stdout": self.stdout(), "stderr": self.stderr() }))
    }
}

pub(crate) async fn git(
    app: &Project,
    dir: &Path,
    args: &[&str],
    timeout: Option<Duration>,
) -> Result<Git, ApiError> {
    let remote = app.remote.lock().unwrap().clone();
    let fut = run(dir, args, &remote);
    let output = match timeout {
        Some(t) => tokio::time::timeout(t, fut)
            .await
            .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "git_failed", "git timed out"))?,
        None => fut.await,
    }
    .map_err(ApiError::internal)?;
    Ok(Git { output })
}

/// Local git run against a separate index file (`GIT_INDEX_FILE`); no remote access.
pub(crate) async fn git_index(dir: &Path, index: &Path, args: &[&str]) -> Result<Git, ApiError> {
    let output = command(dir, args, &Remote::default())
        .env("GIT_INDEX_FILE", index)
        .output()
        .await
        .map_err(ApiError::internal)?;
    Ok(Git { output })
}

/// Parent repo (`""`) or an initialized submodule; anything else is 400.
pub(crate) async fn repo_dir(app: &Project, repo: &str) -> Result<PathBuf, ApiError> {
    let known = app
        .workspace
        .repos()
        .await
        .into_iter()
        .any(|r| r.path == repo && r.initialized);
    if !known {
        return Err(ApiError::bad_request(format!("not a repository: {repo:?}")));
    }
    if repo.is_empty() {
        return Ok(app.workspace.root().to_owned());
    }
    let path = app.workspace.resolve(repo)?;
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| ApiError::invalid_path(repo))?;
    if !canonical.starts_with(app.workspace.root()) {
        return Err(ApiError::invalid_path(repo));
    }
    Ok(canonical)
}

/// Workspace-relative `path` → path relative to `repo` (must lie inside it).
fn repo_relative<'a>(app: &Project, repo: &str, path: &'a str) -> Result<&'a str, ApiError> {
    let path = path.strip_suffix('/').unwrap_or(path);
    app.workspace.resolve(path)?;
    if repo.is_empty() {
        return Ok(path);
    }
    match path.strip_prefix(repo).and_then(|p| p.strip_prefix('/')) {
        Some(rel) if is_within(path, repo) => Ok(rel),
        _ => Err(ApiError::invalid_path(path)),
    }
}

pub(crate) fn prefixed(repo: &str, path: &str) -> String {
    if repo.is_empty() {
        path.to_owned()
    } else {
        format!("{repo}/{path}")
    }
}

#[derive(Deserialize)]
pub struct RepoQuery {
    repo: String,
    path: Option<String>,
    #[serde(default)]
    staged: bool,
    limit: Option<usize>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileStatus {
    pub(crate) path: String,
    pub(crate) index: String,
    pub(crate) worktree: String,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct GitStatus {
    pub(crate) repo: String,
    pub(crate) branch: Option<String>,
    pub(crate) upstream: Option<String>,
    pub(crate) ahead: u32,
    pub(crate) behind: u32,
    pub(crate) files: Vec<FileStatus>,
}

/// Parses `git status --porcelain=v2 --branch -z`; XY codes are reported v1-style (`.` → ` `).
pub(crate) fn parse_status(repo: &str, out: &str) -> GitStatus {
    let mut st = GitStatus {
        repo: repo.into(),
        ..Default::default()
    };
    let xy = |code: &str| -> (String, String) {
        let mut c = code.chars().map(|c| if c == '.' { ' ' } else { c });
        let (x, y) = (c.next().unwrap_or(' '), c.next().unwrap_or(' '));
        (x.into(), y.into())
    };
    let mut records = out.split('\0');
    while let Some(rec) = records.next() {
        if let Some(head) = rec.strip_prefix("# branch.head ") {
            st.branch = (head != "(detached)").then(|| head.into());
        } else if let Some(up) = rec.strip_prefix("# branch.upstream ") {
            st.upstream = Some(up.into());
        } else if let Some(ab) = rec.strip_prefix("# branch.ab ") {
            let mut it = ab.split(' ');
            st.ahead = it
                .next()
                .and_then(|a| a.trim_start_matches('+').parse().ok())
                .unwrap_or(0);
            st.behind = it
                .next()
                .and_then(|b| b.trim_start_matches('-').parse().ok())
                .unwrap_or(0);
        } else if let Some(path) = rec.strip_prefix("? ") {
            let path = path.strip_suffix('/').unwrap_or(path);
            if !path.is_empty() {
                st.files.push(FileStatus {
                    path: prefixed(repo, path),
                    index: "?".into(),
                    worktree: "?".into(),
                });
            }
        } else {
            // "1 XY sub mH mI mW hH hI path" | "2 XY sub mH mI mW hH hI Xscore path\0orig" |
            // "u XY sub m1 m2 m3 mW h1 h2 h3 path"
            let fields = match rec.chars().next() {
                Some('1') => 9,
                Some('2') => 10,
                Some('u') => 11,
                _ => continue,
            };
            let parts: Vec<&str> = rec.splitn(fields, ' ').collect();
            if parts.len() < fields {
                continue;
            }
            if rec.starts_with('2') {
                records.next(); // original path of a rename
            }
            let (index, worktree) = xy(parts[1]);
            st.files.push(FileStatus {
                path: prefixed(repo, parts[fields - 1]),
                index,
                worktree,
            });
        }
    }
    st
}

pub async fn status(
    ProjectCtx(app, _): ProjectCtx,
    Query(q): Query<RepoQuery>,
) -> Result<Json<GitStatus>, ApiError> {
    let dir = repo_dir(&app, &q.repo).await?;
    app.docs.flush_repo(&app.workspace, &q.repo, &app.events);
    let out = git(
        &app,
        &dir,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
        None,
    )
    .await?
    .check()?;
    Ok(Json(parse_status(&q.repo, &out.stdout())))
}

pub async fn diff(
    ProjectCtx(app, _): ProjectCtx,
    Query(q): Query<RepoQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let dir = repo_dir(&app, &q.repo).await?;
    app.docs.flush_repo(&app.workspace, &q.repo, &app.events);
    let mut args = vec!["diff"];
    if q.staged {
        args.push("--cached");
    }
    if let Some(p) = &q.path {
        args.extend(["--", repo_relative(&app, &q.repo, p)?]);
    }
    let out = git(&app, &dir, &args, None).await?.check()?;
    Ok((
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        out.stdout(),
    ))
}

#[derive(Serialize)]
pub struct LogEntry {
    sha: String,
    short: String,
    author: String,
    date: String,
    subject: String,
}

pub async fn log(
    ProjectCtx(app, _): ProjectCtx,
    Query(q): Query<RepoQuery>,
) -> Result<Json<Vec<LogEntry>>, ApiError> {
    let dir = repo_dir(&app, &q.repo).await?;
    let n = q.limit.unwrap_or(20).clamp(1, 200).to_string();
    let out = git(
        &app,
        &dir,
        &["log", "-n", &n, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e"],
        None,
    )
    .await?;
    if !out.ok() {
        return Ok(Json(vec![])); // no commits yet
    }
    let entries = out
        .stdout()
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            let [sha, short, author, date, subject] = f[..] else {
                return None;
            };
            Some(LogEntry {
                sha: sha.into(),
                short: short.into(),
                author: author.into(),
                date: date.into(),
                subject: subject.into(),
            })
        })
        .collect();
    Ok(Json(entries))
}

/// Files the next commit of `repo` (restricted to repo-relative `paths`) would contain,
/// workspace-relative, and the users who changed them.
async fn detected(
    app: &Project,
    dir: &Path,
    repo: &str,
    paths: &[&str],
) -> Result<(Vec<String>, BTreeSet<i64>), ApiError> {
    let mut args = vec![
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--",
    ];
    args.extend(paths);
    let out = git(app, dir, &args, None).await?.check()?;
    let changed: Vec<String> = (parse_status(repo, &out.stdout()).files.into_iter())
        .map(|f| f.path)
        .collect();
    let users = app.contributions.users(&changed, u64::MAX);
    Ok((changed, users))
}

/// `GET …/git/coauthors?repo=…&paths=…&paths=…` (`paths` optional, repeatable).
pub async fn coauthors(
    State(state): State<Arc<AppState>>,
    ProjectCtx(app, _): ProjectCtx,
    auth: AuthSession,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let repo = (q.iter().find(|(k, _)| k == "repo"))
        .map(|(_, v)| v.as_str())
        .ok_or_else(|| ApiError::bad_request("repo is required"))?;
    let paths = (q.iter().filter(|(k, _)| k == "paths"))
        .map(|(_, p)| repo_relative(&app, repo, p))
        .collect::<Result<Vec<_>, _>>()?;
    let dir = repo_dir(&app, repo).await?;
    app.docs.flush_repo(&app.workspace, repo, &app.events);
    let (_, ids) = detected(&app, &dir, repo, &paths).await?;
    let users = users_by_id(&state.db, &ids).await?;
    let identities = project_identities(&state.db, app.id).await?;
    Ok(Json(
        (users.into_iter().filter(|u| u.id != user.id))
            .map(|u| {
                json!({
                    "username": u.username,
                    "display_name": effective_name(&u, identities.get(&u.id)),
                })
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct PatchIdentity {
    #[serde(default, deserialize_with = "crate::projects::nullable")]
    commit_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::projects::nullable")]
    commit_email: Option<Option<String>>,
}

#[derive(Serialize)]
pub struct CommitIdentity {
    pub commit_name: Option<String>,
    pub commit_email: Option<String>,
}

/// `PATCH /api/projects/{pid}/git/identity` *(editor)* — per-project author override for the caller.
pub async fn patch_identity(
    State(state): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<PatchIdentity>,
) -> Result<Json<CommitIdentity>, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    let next_name = match b.commit_name {
        Some(v) => crate::auth::commit_name(v)?,
        None => access.info.commit_name,
    };
    let next_email = match b.commit_email {
        Some(v) => crate::auth::commit_email(v)?,
        None => access.info.commit_email,
    };
    if next_name.is_none() && next_email.is_none() {
        sqlx::query("DELETE FROM project_commit_identities WHERE project_id = ? AND user_id = ?")
            .bind(access.info.id)
            .bind(access.user.id)
            .execute(&state.db)
            .await
            .map_err(ApiError::internal)?;
    } else {
        sqlx::query(
            "INSERT INTO project_commit_identities (project_id, user_id, commit_name, commit_email)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (project_id, user_id) DO UPDATE
               SET commit_name = excluded.commit_name, commit_email = excluded.commit_email",
        )
        .bind(access.info.id)
        .bind(access.user.id)
        .bind(&next_name)
        .bind(&next_email)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(Json(CommitIdentity {
        commit_name: next_name,
        commit_email: next_email,
    }))
}

#[derive(Deserialize)]
pub struct CommitBody {
    repo: String,
    message: String,
    paths: Option<Vec<String>>,
    /// usernames; `None` = everyone detected (see `detected`)
    co_authors: Option<Vec<String>>,
}

pub async fn commit(
    State(state): State<Arc<AppState>>,
    ProjectCtx(app, role): ProjectCtx,
    auth: AuthSession,
    Json(body): Json<CommitBody>,
) -> Result<Json<Value>, ApiError> {
    role.require(Role::Editor)?;
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    if body.message.trim().is_empty() {
        return Err(ApiError::bad_request("commit message is empty"));
    }
    let explicit = match &body.co_authors {
        Some(names) => Some(project_users(&state.db, app.id, names).await?),
        None => None,
    };
    let dir = repo_dir(&app, &body.repo).await?;
    let paths = body
        .paths
        .iter()
        .flatten()
        .map(|p| repo_relative(&app, &body.repo, p))
        .collect::<Result<Vec<_>, _>>()?;
    let lock = app.git_locks.get(&body.repo);
    let _guard = lock.lock().await;
    // edits after this point may miss the commit: they stay credited for the next one
    let mark = app.contributions.mark();
    app.docs.flush_repo(&app.workspace, &body.repo, &app.events);

    // Commit through a private index built from HEAD: exactly the selected paths go in, whatever
    // else is staged in the real index stays staged and out of this commit, and edits made after
    // staging are neither committed nor credited (they stay credited for the next commit).
    // commits are serialized per repo (`git_locks` above); the unique name keeps that from being
    // the only thing standing between two requests sharing one index
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = format!(
        "undertree-commit-{}-{}.index",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let index = dir.join(
        stdout(&dir, &["rev-parse", "--git-path", &name])
            .await
            .ok_or_else(|| ApiError::internal("git dir not found"))?,
    );
    let _ = std::fs::remove_file(&index);
    let result: Result<Vec<String>, ApiError> = async {
        let has_head = stdout(&dir, &["rev-parse", "--verify", "-q", "HEAD"])
            .await
            .is_some();
        let base: &[&str] = if has_head {
            &["read-tree", "HEAD"]
        } else {
            &["read-tree", "--empty"]
        };
        git_index(&dir, &index, base).await?.check()?;
        let mut add = vec!["add", "-A", "--"];
        add.extend(&paths);
        git_index(&dir, &index, &add).await?.check()?;
        // credit exactly what is staged, by touches that were flushed before staging
        let cached = ["diff", "--cached", "--name-only", "-z", "--no-renames"];
        let out = git_index(&dir, &index, &cached).await?.check()?;
        let changed: Vec<String> = (out.stdout().split('\0'))
            .filter(|p| !p.is_empty())
            .map(|p| prefixed(&body.repo, p))
            .collect();
        if changed.is_empty() {
            return Err(ApiError::conflict("nothing to commit"));
        }
        let ids = app.contributions.users(&changed, mark);
        let mut co_authors = match explicit {
            Some(users) => users,
            None => users_by_id(&state.db, &ids).await?,
        };
        co_authors.retain(|u| u.id != user.id);

        // GitHub attributes noreply addresses; elsewhere the (verified) account e-mail works
        let github = stdout(&dir, &["remote", "get-url", "origin"])
            .await
            .is_some_and(|url| is_github(&url));
        let identities = project_identities(&state.db, app.id).await?;
        // author = committer = the user clicking commit (per-project override > profile default)
        let name = format!(
            "user.name={}",
            effective_name(&user, identities.get(&user.id))
        );
        let email = format!(
            "user.email={}",
            effective_email(&user, identities.get(&user.id), github)
        );
        let trailers: Vec<String> = (co_authors.iter())
            .map(|u| {
                let ov = identities.get(&u.id);
                format!(
                    "Co-authored-by: {} <{}>",
                    effective_name(u, ov),
                    effective_email(u, ov, github)
                )
            })
            .collect();
        let mut args = vec![
            "-c",
            &name,
            "-c",
            &email,
            "commit",
            "-q",
            "-m",
            &body.message,
        ];
        for t in &trailers {
            args.extend(["--trailer", t]);
        }
        git_index(&dir, &index, &args).await?.check()?;
        Ok(changed)
    }
    .await;
    let _ = std::fs::remove_file(&index);
    let changed = result?;
    // the real index still has the old HEAD for the committed paths: move just those forward
    let mut reset = vec!["reset", "-q", "--"];
    reset.extend(&paths);
    if let Err(e) = git(&app, &dir, &reset, None).await.and_then(|g| g.check()) {
        tracing::warn!("index refresh after commit failed: {}", e.message);
    }
    app.contributions.clear(&changed, mark);
    let sha = git(&app, &dir, &["rev-parse", "HEAD"], None)
        .await?
        .check()?
        .stdout();
    let sha = sha.trim();
    let _ = app.events.send(Event::GitChanged {
        repo: body.repo.clone(),
    });
    Ok(Json(
        json!({ "sha": sha, "short": &sha[..7.min(sha.len())] }),
    ))
}

#[derive(Deserialize)]
pub struct RepoBody {
    repo: String,
}

pub(crate) fn is_non_fast_forward(stderr: &str) -> bool {
    [
        "Not possible to fast-forward",
        "[rejected]",
        "non-fast-forward",
        "diverge",
    ]
    .iter()
    .any(|m| stderr.contains(m))
}

/// pull/push: 409 for non-fast-forward situations, 502 for other failures.
async fn network_op(app: &Project, repo: &str, args: &[&str]) -> Result<Json<Value>, ApiError> {
    let dir = repo_dir(app, repo).await?;
    let lock = app.git_locks.get(repo);
    let _guard = lock.lock().await;
    app.docs.flush_repo(&app.workspace, repo, &app.events);
    let out = git(app, &dir, args, Some(NETWORK_TIMEOUT)).await?;
    if !out.ok() && is_non_fast_forward(&out.stderr()) {
        return Err(ApiError::conflict(out.stderr().trim()));
    }
    let out = out.check()?;
    let _ = app.events.send(Event::GitChanged { repo: repo.into() });
    Ok(out.streams())
}

pub async fn pull(
    ProjectCtx(app, role): ProjectCtx,
    Json(b): Json<RepoBody>,
) -> Result<Json<Value>, ApiError> {
    role.require(Role::Editor)?;
    // changed files reach open docs via the watcher (3-way merge, see docs.rs)
    let res = network_op(&app, &b.repo, &["pull", "--ff-only", "--autostash"]).await?;
    let _ = app.events.send(Event::TreeChanged);
    Ok(res)
}

pub async fn push(
    ProjectCtx(app, role): ProjectCtx,
    Json(b): Json<RepoBody>,
) -> Result<Json<Value>, ApiError> {
    role.require(Role::Editor)?;
    network_op(&app, &b.repo, &["push"]).await
}

#[derive(Deserialize)]
pub struct SubmoduleBody {
    path: Option<String>,
    remote: Option<bool>,
}

pub async fn submodule_update(
    ProjectCtx(app, role): ProjectCtx,
    Json(b): Json<SubmoduleBody>,
) -> Result<Json<Value>, ApiError> {
    role.require(Role::Editor)?;
    let root = app.workspace.root().to_owned();
    if let Some(p) = &b.path {
        let known = app
            .workspace
            .repos()
            .await
            .iter()
            .any(|r| r.kind == RepoKind::Submodule && r.path == *p);
        if !known {
            return Err(ApiError::bad_request(format!("not a submodule: {p:?}")));
        }
    }
    let target = b.path.as_deref().unwrap_or("");
    let lock = app.git_locks.get("");
    let _guard = lock.lock().await;
    app.docs.flush_repo(&app.workspace, target, &app.events);
    let mut args = vec!["submodule", "update", "--init"];
    if b.remote.unwrap_or(true) {
        args.push("--remote");
    }
    if let Some(p) = &b.path {
        args.extend(["--", p.as_str()]);
    }
    let out = git(&app, &root, &args, Some(NETWORK_TIMEOUT))
        .await?
        .check()?;
    for repo in ["", target] {
        let _ = app.events.send(Event::GitChanged { repo: repo.into() });
    }
    let _ = app.events.send(Event::TreeChanged);
    Ok(out.streams())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0\
                   # branch.ab +2 -1\0\
                   1 .M N... 100644 100644 100644 aaa bbb intro.tex\0\
                   1 A. N... 000000 100644 100644 000 ccc new dir/file.tex\0\
                   2 R. N... 100644 100644 100644 ddd ddd R100 b.tex\0a.tex\0\
                   1 .M SC.. 160000 160000 160000 eee fff sub\0\
                   ? notes.txt\0\
                   ? nested-dir/\0";
        let st = parse_status("papers/a", out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        let files: Vec<_> = st
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.index.as_str(), f.worktree.as_str()))
            .collect();
        assert_eq!(
            files,
            [
                ("papers/a/intro.tex", " ", "M"),
                ("papers/a/new dir/file.tex", "A", " "),
                ("papers/a/b.tex", "R", " "),
                ("papers/a/sub", " ", "M"),
                ("papers/a/notes.txt", "?", "?"),
                ("papers/a/nested-dir", "?", "?"),
            ]
        );
        let detached = parse_status("", "# branch.head (detached)\0");
        assert_eq!(detached.branch, None);
    }

    fn with_creds(allow_file: bool) -> Remote {
        Remote {
            creds: Some(Creds {
                username: "oauth2".into(),
                token: "tok-123".into(),
                host: Some("gitlab.com".into()),
            }),
            allow_file,
            ssh: None,
        }
    }

    #[test]
    fn credentials_only_via_env() {
        let cmd = command(Path::new("/"), &["push"], &with_creds(false));
        let cmd = cmd.as_std();
        let args: Vec<_> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(
            args,
            ["-c", "credential.helper=", "-c", CREDENTIAL_HELPER, "push"]
        );
        assert!(!args.iter().any(|a| a.contains("tok-123")));
        let env: HashMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_str().unwrap(), v.and_then(|v| v.to_str())))
            .collect();
        assert_eq!(env["UNDERTREE_GIT_HOST"], Some("gitlab.com"));
        assert_eq!(env["UNDERTREE_GIT_TOKEN"], Some("tok-123"));
        assert_eq!(env["UNDERTREE_GIT_USERNAME"], Some("oauth2"));
        assert_eq!(env["GIT_ALLOW_PROTOCOL"], Some("https:ssh"));

        let plain = command(Path::new("/"), &["status"], &Remote::default());
        assert!(!plain
            .as_std()
            .get_envs()
            .any(|(k, _)| k == "UNDERTREE_GIT_TOKEN"));
    }

    #[test]
    fn project_ssh_key_is_used_without_shell_parsing() {
        // a data dir with a space, a quote and shell syntax must neither break nor inject
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("a b'$(touch pwned)");
        let ssh = ProjectSsh {
            key: dir.join("id_ed25519"),
            pinned_hosts: dir.join("pinned_known_hosts"),
        };
        let remote = Remote {
            ssh: Some(ssh.clone()),
            ..Remote::default()
        };
        let cmd = command(Path::new("/"), &["fetch"], &remote);
        let env: HashMap<_, _> = (cmd.as_std().get_envs())
            .map(|(k, v)| (k.to_str().unwrap(), v.unwrap().to_owned()))
            .collect();
        assert_eq!(
            env["GIT_SSH_COMMAND"],
            format!("{PROJECT_SSH}{PROJECT_SSH_PROXY}").as_str()
        );
        let exe = std::env::current_exe().unwrap();
        assert_eq!(env["UNDERTREE_SSH_PROXY"], exe);
        // local test remotes: no proxy
        let local = Remote {
            allow_file: true,
            ..remote.clone()
        };
        let local_env: HashMap<_, _> = (command(Path::new("/"), &["fetch"], &local)
            .as_std()
            .get_envs())
        .map(|(k, v)| (k.to_str().unwrap().to_owned(), v.unwrap().to_owned()))
        .collect();
        assert_eq!(local_env["GIT_SSH_COMMAND"], PROJECT_SSH);
        assert_eq!(env["UNDERTREE_SSH_KEY"], ssh.key);
        assert_eq!(env["UNDERTREE_SSH_KNOWN_HOSTS"], ssh.pinned_hosts);
        assert_eq!(env["UNDERTREE_SSH_PROJECT_HOSTS"], dir.join("known_hosts"));
        assert!(!command(Path::new("/"), &["fetch"], &Remote::default())
            .as_std()
            .get_envs()
            .any(|(k, _)| k == "UNDERTREE_SSH_KEY"));

        // `ssh -G` prints the resolved config without connecting (`-i` needs an existing file)
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(&ssh.key, "").unwrap();
        let Ok(out) = std::process::Command::new("sh")
            .args([
                "-c",
                &format!(
                    "{} -G example.org",
                    env["GIT_SSH_COMMAND"].to_str().unwrap()
                ),
            ])
            .current_dir(tmp.path())
            .envs(env.iter().filter(|(k, _)| k.starts_with("UNDERTREE_SSH")))
            .output()
        else {
            return;
        };
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            eprintln!("skipping ssh -G check: {err}");
            return;
        }
        let cfg = String::from_utf8_lossy(&out.stdout);
        let line = |key: &str| {
            let prefix = format!("{key} ");
            let found = cfg.lines().find_map(|l| l.strip_prefix(&prefix));
            found
                .unwrap_or_else(|| panic!("no {key} in {cfg}"))
                .to_owned()
        };
        assert_eq!(line("identityfile"), ssh.key.display().to_string());
        // the pinned provider keys, the project's own (TOFU) and the operator's
        // (ssh expands `~` with the passwd home, which need not be $HOME)
        let hosts = line("userknownhostsfile");
        let pinned = ssh.pinned_hosts.display().to_string();
        let project = dir.join("known_hosts").display().to_string();
        let operator = hosts
            .strip_prefix(&format!("{pinned} {project} "))
            .unwrap_or_default();
        assert!(
            operator.ends_with("/.ssh/known_hosts") && !operator.contains(' '),
            "{hosts}"
        );
        assert_eq!(line("globalknownhostsfile"), "/dev/null");
        // TCP only through the vetting proxy; host keys are still checked for the hostname
        assert_eq!(
            line("proxycommand"),
            format!("\"{}\" ssh-proxy %h %p", exe.display())
        );
        // `-G` prints StrictHostKeyChecking=yes as "true" (accept-new would be "accept-new")
        assert_eq!(line("stricthostkeychecking"), "true");
        assert_eq!(line("identitiesonly"), "yes");
        assert!(!tmp.path().join("pwned").exists());
    }

    #[test]
    fn unknown_host_key_explains_the_fix() {
        let msg = explain("Host key verification failed.\nfatal: Could not read from remote");
        assert!(
            msg.contains("./ssh/known_hosts") && msg.contains("ssh-keyscan"),
            "{msg}"
        );
        assert_eq!(explain(" fatal: other \n"), "fatal: other");
    }

    #[tokio::test]
    async fn credential_helper_answers_git() {
        use tokio::io::AsyncWriteExt;
        let dir = tempfile::tempdir().unwrap();
        let run_fill = |input: &'static [u8]| {
            let p = dir.path().to_owned();
            async move {
                let mut child = command(&p, &["credential", "fill"], &with_creds(false))
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(input).await.unwrap();
                drop(stdin);
                let out = child.wait_with_output().await.unwrap();
                String::from_utf8_lossy(&out.stdout).into_owned()
            }
        };

        let ok = run_fill(b"protocol=https\nhost=GitLab.com:443\n\n").await;
        assert!(ok.contains("username=oauth2\n"), "{ok}");
        assert!(ok.contains("password=tok-123\n"), "{ok}");

        let wrong_host = run_fill(b"protocol=https\nhost=evil.example\n\n").await;
        assert!(
            !wrong_host.contains("tok-123"),
            "leaked token: {wrong_host}"
        );

        let wrong_proto = run_fill(b"protocol=http\nhost=gitlab.com\n\n").await;
        assert!(
            !wrong_proto.contains("tok-123"),
            "leaked token: {wrong_proto}"
        );
    }

    #[test]
    fn scrubs_token() {
        assert_eq!(
            scrub(b"fatal: auth tok-123 for tok-123@x".to_vec(), "tok-123"),
            b"fatal: auth *** for ***@x"
        );
        assert_eq!(scrub(b"abc".to_vec(), ""), b"abc");
    }

    #[tokio::test]
    async fn file_submodules_blocked_in_production() {
        let (_tmp, parent) = crate::workspace::tests::fixture();
        // deinit keeps the module's git dir; drop it so the update has to clone
        std::fs::remove_dir_all(parent.join(".git/modules/papers/b")).unwrap();
        // papers/b points to a local repo; even an explicit allow in config must not help
        let args = [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "update",
            "--init",
            "--",
            "papers/b",
        ];
        let out = run(&parent, &args, &with_creds(false)).await.unwrap();
        assert!(!out.status.success());
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("transport 'file' not allowed"), "{stderr}");
        assert!(!parent.join("papers/b/other.tex").exists());

        let out = run(&parent, &args, &with_creds(true)).await.unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(parent.join("papers/b/other.tex").exists());
    }

    #[test]
    fn author_email_rule() {
        let user = |email: Option<&str>, gh: bool, commit: Option<&str>| User {
            id: 1,
            username: "ada".into(),
            display_name: "Ada".into(),
            email: email.map(Into::into),
            is_admin: false,
            commit_email: commit.map(Into::into),
            github_id: gh.then_some(42),
            github_login: gh.then(|| "ada-gh".into()),
        };
        let noreply = "42+ada-gh@users.noreply.github.com";
        let own = Some("me@uni.edu");
        let google = Some("ada@gmail.com");
        for (u, github_remote, want) in [
            (user(google, true, own), true, "me@uni.edu"),
            (user(None, false, own), false, "me@uni.edu"),
            (user(google, true, None), true, noreply),
            (user(google, true, None), false, "ada@gmail.com"),
            (user(google, false, None), true, "ada@gmail.com"),
            (user(None, true, None), false, noreply),
            (user(None, false, None), true, "ada@users.undertree"),
        ] {
            assert_eq!(author_email(&u, github_remote), want);
        }
        // a login without a linked id (never logged in) has no noreply address
        let mut u = user(None, true, None);
        u.github_id = None;
        assert_eq!(author_email(&u, true), "ada@users.undertree");
    }

    #[test]
    fn effective_identity_overrides_defaults() {
        let u = User {
            id: 1,
            username: "ada".into(),
            display_name: "Ada".into(),
            email: Some("ada@gmail.com".into()),
            is_admin: false,
            commit_email: Some("ada@profile.org".into()),
            github_id: Some(42),
            github_login: Some("ada-gh".into()),
        };
        assert_eq!(effective_name(&u, None), "Ada");
        assert_eq!(effective_email(&u, None, true), "ada@profile.org");
        let ov = (Some("Dr. Ada".into()), Some("ada@uni.edu".into()));
        assert_eq!(effective_name(&u, Some(&ov)), "Dr. Ada");
        assert_eq!(effective_email(&u, Some(&ov), true), "ada@uni.edu");
        let partial = (None, Some("only@mail.org".into()));
        assert_eq!(effective_name(&u, Some(&partial)), "Ada");
        assert_eq!(effective_email(&u, Some(&partial), false), "only@mail.org");
    }

    #[test]
    fn github_remote_detection() {
        for url in [
            "https://github.com/me/paper.git",
            "https://GitHub.com:443/me/paper",
            "ssh://git@github.com/me/paper.git",
            "git@github.com:me/paper.git",
        ] {
            assert!(is_github(url), "{url}");
        }
        for url in [
            "https://gitlab.com/me/paper.git",
            "git@gitlab.com:github.com/x.git",
            "https://github.com.evil.org/x",
            "file:///tmp/github.com",
        ] {
            assert!(!is_github(url), "{url}");
        }
    }

    #[test]
    fn contributions_match_committed_paths() {
        let c = Contributions::default();
        c.touch("a/main.tex", 1);
        c.touch("a/old", 2); // deleted directory
        c.touch("b.tex", 3);
        let changed = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            c.users(&changed(&["a/main.tex", "a/old/x.tex"]), u64::MAX),
            BTreeSet::from([1, 2])
        );
        // a submodule pointer change doesn't credit edits inside the submodule
        assert_eq!(c.users(&changed(&["a"]), u64::MAX), BTreeSet::new());
        let mark = c.mark();
        c.touch("b.tex", 4); // arrives while the commit runs
                             // its edit is not staged yet: not credited in this commit ...
        assert_eq!(
            c.users(&changed(&["b.tex"]), mark),
            BTreeSet::from([3]),
            "touch after staging is not credited"
        );
        c.clear(&changed(&["a/main.tex", "b.tex"]), mark);
        assert_eq!(
            c.users(&changed(&["a/main.tex", "b.tex"]), u64::MAX),
            BTreeSet::from([4]),
            "... but stays credited for the next one, earlier touches are cleared"
        );
        c.touch("b.tex", 3); // re-touch after the mark keeps the user
        c.clear(&changed(&["b.tex"]), mark);
        assert_eq!(
            c.users(&changed(&["b.tex"]), u64::MAX),
            BTreeSet::from([3, 4])
        );
    }

    #[test]
    fn non_fast_forward_detection() {
        assert!(is_non_fast_forward(
            " ! [rejected]        main -> main (fetch first)"
        ));
        assert!(is_non_fast_forward(
            "fatal: Not possible to fast-forward, aborting."
        ));
        assert!(!is_non_fast_forward("fatal: could not read Username"));
    }
}
