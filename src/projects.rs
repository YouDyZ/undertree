//! Projects: git repositories cloned by URL (+ optional token), each with its own runtime
//! (workspace, CRDT docs, compiler, events, file watcher). docs/API.md → Projects.
//!
//! Invariants:
//! - tokens are stored encrypted (ChaCha20-Poly1305) and only ever reach the git child process
//!   via env (see `git::command`); never returned, logged, or written to `.git/config`
//! - a project the caller may not access is indistinguishable from a missing one (404)

use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{FromRequestParts, Path, RawPathParams, State},
    http::{request::Parts, StatusCode},
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::SqlitePool;
use tokio::sync::watch;

use crate::{
    accounts,
    auth::{AuthSession, User},
    compile::{Compiler, Engine, Setting},
    docs::{self, Docs},
    error::ApiError,
    events::{self, Events},
    git::{self, Creds, Remote},
    templates,
    workspace::Workspace,
    AppState,
};

const CLONE_TIMEOUT: Duration = Duration::from_secs(600);
const DEFAULT_GIT_USERNAME: &str = "oauth2";

/// Encrypts stored git tokens. Blob layout: 12-byte random nonce || ciphertext.
pub struct Secrets(ChaCha20Poly1305);

impl Secrets {
    /// `UNDERTREE_SECRET_KEY` (base64, 32 bytes), else `$DATA/secret.key` (created with mode 0600).
    pub fn load(env_key: Option<&str>, data: &FsPath) -> Result<Self, String> {
        let decode = |b64: &str, from: &str| {
            let key = B64
                .decode(b64.trim())
                .map_err(|e| format!("{from}: invalid base64: {e}"))?;
            ChaCha20Poly1305::new_from_slice(&key)
                .map(Self)
                .map_err(|_| format!("{from}: key must be 32 bytes"))
        };
        if let Some(key) = env_key {
            return decode(key, "UNDERTREE_SECRET_KEY");
        }
        let path = data.join("secret.key");
        match std::fs::read_to_string(&path) {
            Ok(key) => decode(&key, &path.display().to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = ChaCha20Poly1305::generate_key(&mut OsRng);
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&path)
                    .and_then(|mut f| f.write_all(B64.encode(key).as_bytes()))
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                tracing::info!("generated {}", path.display());
                Ok(Self(ChaCha20Poly1305::new(&key)))
            }
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn encrypt(&self, plain: &str) -> Vec<u8> {
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ct = (self.0)
            .encrypt(&nonce, plain.as_bytes())
            .expect("in-memory encryption cannot fail");
        [nonce.as_slice(), &ct].concat()
    }

    pub fn decrypt(&self, blob: &[u8]) -> Option<String> {
        if blob.len() < 12 {
            return None;
        }
        let (nonce, ct) = blob.split_at(12);
        let plain = self.0.decrypt(Nonce::from_slice(nonce), ct).ok()?;
        String::from_utf8(plain).ok()
    }
}

/// Only `https://`, `ssh://` and scp-style `user@host:path`; no embedded credentials, local
/// paths, `file://`, transport helpers (`ext::`) or option-looking values.
/// Username/token go into git's line-based credential protocol: a newline would inject fields.
fn plain_field(what: &str, value: Option<&str>) -> Result<(), ApiError> {
    if value.is_some_and(|v| v.chars().any(|c| c.is_whitespace() || c.is_control())) {
        return Err(ApiError::bad_request(format!(
            "{what} must not contain whitespace or control characters"
        )));
    }
    Ok(())
}

pub fn validate_remote_url(url: &str, allow_file: bool) -> Result<(), String> {
    let bad = |why: &str| Err(format!("invalid remote_url: {why}"));
    if url.is_empty()
        || url.starts_with('-')
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return bad("empty, option-like or contains whitespace");
    }
    if url.contains("::") {
        return bad("transport helpers are not allowed");
    }
    if let Some(rest) = url.strip_prefix("https://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.contains('@') {
            return bad("must not contain credentials, use the token field");
        }
        if authority.is_empty() || authority.starts_with('-') {
            return bad("missing host");
        }
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let authority = rest.split('/').next().unwrap_or("");
        let (user, host) = authority.rsplit_once('@').unwrap_or(("", authority));
        if user.contains(':') {
            return bad("must not contain credentials");
        }
        if host.is_empty() || host.starts_with('-') || user.starts_with('-') {
            return bad("missing or invalid host");
        }
        return Ok(());
    }
    if allow_file && url.starts_with("file://") {
        return Ok(());
    }
    if url.contains("://") {
        return bad("only https://, ssh:// or user@host:path are supported");
    }
    // scp-style: `user@host:path` (git reads anything with `/` before the `:` as a local path)
    match url.split_once(':') {
        Some((user_host, path)) if !user_host.contains('/') && !path.is_empty() => {
            match user_host.split_once('@') {
                Some((user, host))
                    if !user.is_empty()
                        && !host.is_empty()
                        && !host.starts_with('-')
                        && !host.contains('@') =>
                {
                    Ok(())
                }
                _ => bad("expected user@host:path"),
            }
        }
        _ => bad("only https://, ssh:// or user@host:path are supported"),
    }
}

/// Runtime of one project; created on first access, see `AppState::runtime`.
pub struct Project {
    pub id: i64,
    pub db: SqlitePool,
    pub workspace: Workspace,
    pub events: Events,
    pub docs: Docs,
    pub compiler: Compiler,
    pub git_locks: git::Locks,
    /// who changed which path since its last commit (Co-authored-by trailers)
    pub contributions: git::Contributions,
    /// who is connected right now, and in which files
    pub presence: events::Presence,
    /// chat messages per user and minute
    pub chat_rate: crate::chat::RateLimit,
    pub remote: Mutex<Remote>,
    /// set once on DELETE: event sockets close (4404), the file watcher stops
    pub deleted: watch::Sender<bool>,
    /// username whose membership role changed or ended: their doc sockets close and reconnect
    pub member_changed: tokio::sync::broadcast::Sender<String>,
}

/// Resolves once the project is deleted (or its runtime dropped).
pub async fn gone(deleted: &mut watch::Receiver<bool>) {
    let _ = deleted.wait_for(|d| *d).await;
}

/// `projects.main_files`: JSON array in the DB, plain array in the API.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct MainFiles(pub Vec<String>);

impl TryFrom<String> for MainFiles {
    type Error = serde_json::Error;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        serde_json::from_str(&s).map(Self)
    }
}

/// Project role, ordered by what it may do; each role may everything the lower ones may
/// (docs/API.md → Projects → Roles). Site admins act as `Owner` on every project.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, sqlx::Type,
)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Commenter,
    Editor,
    Owner,
}

impl Role {
    /// `403 insufficient_role` unless this role is at least `min`.
    pub fn require(self, min: Role) -> Result<(), ApiError> {
        if self < min {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "insufficient_role",
                format!("this needs the project role {min:?} or higher").to_lowercase(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ProjectInfo {
    pub id: i64,
    pub name: String,
    pub remote_url: String,
    pub branch: String,
    pub owner: String,
    /// legacy: `owner` | `member` | `admin` (admin without membership)
    pub role: String,
    /// effective role of the caller (admins: `owner`)
    pub my_role: Role,
    pub has_token: bool,
    #[sqlx(try_from = "String")]
    pub compiler: Setting,
    /// workspace-relative roots compiled by default, in priority order; empty = automatic
    #[sqlx(try_from = "String")]
    pub main_files: MainFiles,
    /// account the remote repo was created with (`create_remote`), enables invite-remote
    pub account_id: Option<i64>,
    /// caller's per-project commit author name override (`None` = user display_name)
    pub commit_name: Option<String>,
    /// caller's per-project commit author e-mail override (`None` = profile/default rule)
    pub commit_email: Option<String>,
    pub created_at: String,
}

/// Projects visible to user `?1` (`?2` = is admin), with the caller's role.
macro_rules! select_project {
    ($tail:literal) => {
        concat!(
            "SELECT p.id, p.name, p.remote_url, p.branch, o.username AS owner,
                CASE WHEN m.role = 'owner' THEN 'owner'
                     WHEN m.role IS NOT NULL THEN 'member'
                     ELSE 'admin' END AS role,
                CASE WHEN ?2 THEN 'owner' ELSE m.role END AS my_role,
                p.token_enc IS NOT NULL AS has_token,
                CASE WHEN p.compiler_auto THEN 'auto' ELSE p.compiler END AS compiler,
                p.main_files, p.account_id,
                ci.commit_name, ci.commit_email,
                strftime('%Y-%m-%dT%H:%M:%SZ', p.created_at) AS created_at
             FROM projects p JOIN users o ON o.id = p.owner_id
             LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?1
             LEFT JOIN project_commit_identities ci ON ci.project_id = p.id AND ci.user_id = ?1
             WHERE (?2 OR m.role IS NOT NULL) ",
            $tail
        )
    };
}

async fn project_info(app: &AppState, user: &User, pid: i64) -> Result<ProjectInfo, ApiError> {
    sqlx::query_as(select_project!("AND p.id = ?3"))
        .bind(user.id)
        .bind(user.is_admin)
        .bind(pid)
        .fetch_optional(&app.db)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("no such project"))
}

impl AppState {
    pub fn project_dir(&self, pid: i64) -> PathBuf {
        self.data.join("projects").join(pid.to_string())
    }

    /// Git environment from the DB (token decrypted).
    async fn load_remote(&self, pid: i64) -> Result<Remote, ApiError> {
        let (username, token): (String, Option<Vec<u8>>) =
            sqlx::query_as("SELECT git_username, token_enc FROM projects WHERE id = ?")
                .bind(pid)
                .fetch_one(&self.db)
                .await
                .map_err(ApiError::internal)?;
        let creds = token.and_then(|blob| {
            let token = self.secrets.decrypt(&blob);
            if token.is_none() {
                tracing::warn!("project {pid}: stored token cannot be decrypted (key changed?)");
            }
            Some(Creds {
                username,
                token: token?,
            })
        });
        let key = self.project_dir(pid).join("ssh/id_ed25519");
        Ok(Remote {
            creds,
            allow_file: self.allow_file,
            ssh: key.exists().then(|| git::ProjectSsh {
                key,
                pinned_hosts: self.pinned_hosts(),
            }),
        })
    }

    /// Loaded runtime of `pid`, creating it on first use.
    // ponytail: runtimes stay in memory until the project is deleted (no idle unloading);
    // add an LRU/idle timeout if many projects make the watchers/memory matter
    pub async fn runtime(&self, pid: i64) -> Result<Arc<Project>, ApiError> {
        if let Some(p) = self.projects.lock().unwrap().get(&pid) {
            return Ok(p.clone());
        }
        let remote = self.load_remote(pid).await?;
        let (engine, auto, main_files): (Engine, bool, String) =
            sqlx::query_as("SELECT compiler, compiler_auto, main_files FROM projects WHERE id = ?")
                .bind(pid)
                .fetch_one(&self.db)
                .await
                .map_err(ApiError::internal)?;
        let mut projects = self.projects.lock().unwrap();
        if let Some(p) = projects.get(&pid) {
            return Ok(p.clone());
        }
        let dir = self.project_dir(pid);
        let open = || -> Result<Project, Box<dyn std::error::Error>> {
            let compiler = Compiler::new(&dir)?;
            *compiler.setting.lock().unwrap() = Setting::of(engine, auto);
            *compiler.main_files.lock().unwrap() = MainFiles::try_from(main_files)?.0;
            Ok(Project {
                id: pid,
                db: self.db.clone(),
                workspace: Workspace::open(&dir.join("repo"))?,
                events: events::channel(),
                docs: Docs::new(dir.join("ydocs"))?,
                compiler,
                git_locks: git::Locks::default(),
                contributions: git::Contributions::default(),
                presence: events::Presence::default(),
                chat_rate: Default::default(),
                remote: Mutex::new(remote),
                deleted: watch::Sender::new(false),
                member_changed: tokio::sync::broadcast::channel(16).0,
            })
        };
        let project =
            Arc::new(open().map_err(|e| ApiError::internal(format!("project {pid}: {e}")))?);
        docs::spawn_watcher(project.clone()).map_err(ApiError::internal)?;
        projects.insert(pid, project.clone());
        // so the first flush recompiles the main files even after a restart
        tokio::spawn(crate::compile::seed_main_files(project.clone()));
        Ok(project)
    }
}

/// Logged-in caller with access to the `{pid}` project (member or admin), else 401/404.
/// Role checks: `access.info.my_role.require(…)?`.
pub struct Access {
    pub info: ProjectInfo,
    pub user: User,
}

impl FromRequestParts<Arc<AppState>> for Access {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<AppState>) -> Result<Self, ApiError> {
        let auth = AuthSession::from_request_parts(parts, app)
            .await
            .map_err(|(_, msg)| ApiError::internal(msg))?;
        let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
        let params = RawPathParams::from_request_parts(parts, app)
            .await
            .map_err(ApiError::internal)?;
        let pid = params
            .iter()
            .find(|(k, _)| *k == "pid")
            .and_then(|(_, v)| v.parse::<i64>().ok())
            .ok_or_else(|| ApiError::not_found("no such project"))?;
        let info = project_info(app, &user, pid).await?;
        Ok(Self { info, user })
    }
}

/// Runtime of an accessible project and the caller's role, for every workspace/doc/compile/git
/// route; writing routes start with `role.require(…)?`.
pub struct ProjectCtx(pub Arc<Project>, pub Role);

impl FromRequestParts<Arc<AppState>> for ProjectCtx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<AppState>) -> Result<Self, ApiError> {
        let access = Access::from_request_parts(parts, app).await?;
        Ok(Self(
            app.runtime(access.info.id).await?,
            access.info.my_role,
        ))
    }
}

/// `Some(None)` = explicit `null`, `None` = field absent (use with `#[serde(default)]`).
pub fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

pub async fn list(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
) -> Result<Json<Vec<ProjectInfo>>, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    sqlx::query_as(select_project!("ORDER BY p.id DESC"))
        .bind(user.id)
        .bind(user.is_admin)
        .fetch_all(&app.db)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

#[derive(Deserialize)]
pub struct NewProject {
    name: String,
    /// either an existing repo …
    remote_url: Option<String>,
    branch: Option<String>,
    username: Option<String>,
    token: Option<String>,
    /// … or one undertree creates
    create_remote: Option<accounts::CreateRemote>,
    /// default `auto`
    compiler: Option<Setting>,
}

/// Clones `url` into `dir/repo`, returns the checked-out branch.
async fn clone(
    dir: &FsPath,
    url: &str,
    b: &NewProject,
    remote: &Remote,
) -> Result<String, ApiError> {
    let failed = |msg: String| ApiError::new(StatusCode::BAD_GATEWAY, "git_failed", msg);
    let branch = b.branch.as_ref().map(|br| format!("--branch={br}"));
    let mut args = vec!["clone", "-q", "--recurse-submodules"];
    args.extend(branch.as_deref());
    args.extend(["--", url, "repo"]);
    let out = tokio::time::timeout(CLONE_TIMEOUT, git::run(dir, &args, remote))
        .await
        .map_err(|_| failed("git clone timed out".into()))?
        .map_err(ApiError::internal)?;
    if !out.status.success() {
        return Err(failed(git::explain(&String::from_utf8_lossy(&out.stderr))));
    }
    git::stdout(&dir.join("repo"), &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok_or_else(|| failed("cloned repository has no HEAD".into()))
}

pub async fn create(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Json(mut b): Json<NewProject>,
) -> Result<(StatusCode, Json<ProjectInfo>), ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let name = b.name.trim().to_owned();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is empty"));
    }
    let url = match (&b.remote_url, b.create_remote.take()) {
        (None, Some(spec)) => {
            let pid = create_with_remote(&app, &user, &name, b.compiler, spec).await?;
            let info = project_info(&app, &user, pid).await?;
            return Ok((StatusCode::CREATED, Json(info)));
        }
        (Some(url), None) => url.clone(),
        _ => {
            return Err(ApiError::bad_request(
                "give either remote_url or create_remote",
            ))
        }
    };
    validate_remote_url(&url, app.allow_file).map_err(ApiError::bad_request)?;
    if b.branch
        .as_deref()
        .is_some_and(|br| br.is_empty() || br.starts_with('-'))
    {
        return Err(ApiError::bad_request("invalid branch"));
    }
    plain_field("username", b.username.as_deref())?;
    plain_field("token", b.token.as_deref())?;
    let username = non_empty(b.username.clone()).unwrap_or_else(|| DEFAULT_GIT_USERNAME.to_owned());
    let token = b.token.clone().filter(|t| !t.is_empty());
    let remote = Remote {
        creds: token.clone().map(|token| Creds {
            username: username.clone(),
            token,
        }),
        allow_file: app.allow_file,
        ssh: None,
    };

    let tmp = new_tmp(&app, "clone").await?;
    let branch = match clone(&tmp, &url, &b, &remote).await {
        Ok(branch) => branch,
        Err(e) => return Err(rollback(&tmp, e).await),
    };
    let mut tx = match app.db.begin().await {
        Ok(tx) => tx,
        Err(e) => return Err(rollback(&tmp, ApiError::internal(e)).await),
    };
    let inserted = sqlx::query_scalar(
        "INSERT INTO projects
           (name, remote_url, branch, owner_id, git_username, token_enc, compiler, compiler_auto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&name)
    .bind(&url)
    .bind(&branch)
    .bind(user.id)
    .bind(&username)
    .bind(token.map(|t| app.secrets.encrypt(&t)))
    .bind(b.compiler.and_then(Setting::fixed).unwrap_or_default())
    .bind(b.compiler.unwrap_or_default() == Setting::Auto)
    .fetch_one(&mut *tx)
    .await;
    let pid = install(&app, &tmp, tx, inserted, user.id).await?;
    let info = project_info(&app, &user, pid).await?;
    Ok((StatusCode::CREATED, Json(info)))
}

/// 24 random hex digits.
pub fn random_hex() -> String {
    hex(&ChaCha20Poly1305::generate_nonce(&mut OsRng))
}

/// Fresh `$DATA/projects/.<kind>-<random>` to prepare a project in.
async fn new_tmp(app: &AppState, kind: &str) -> Result<PathBuf, ApiError> {
    let tmp = app
        .data
        .join("projects")
        .join(format!(".{kind}-{}", random_hex()));
    tokio::fs::create_dir_all(&tmp)
        .await
        .map_err(ApiError::internal)?;
    Ok(tmp)
}

/// Moves the prepared `tmp` to `projects/{pid}` once its row is `inserted` (with `owner` as its
/// owner member); on failure nothing of the project is left.
async fn install(
    app: &AppState,
    tmp: &FsPath,
    mut tx: sqlx::Transaction<'static, sqlx::Sqlite>,
    inserted: sqlx::Result<i64>,
    owner: i64,
) -> Result<i64, ApiError> {
    // the row stays uncommitted, so invisible to every other request, until the workspace is
    // in place; dropping `tx` on any failure rolls the insert back
    let pid = match inserted {
        Ok(pid) => pid,
        Err(e) => return Err(rollback(tmp, ApiError::internal(e)).await),
    };
    let member = sqlx::query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')",
    )
    .bind(pid)
    .bind(owner)
    .execute(&mut *tx)
    .await;
    if let Err(e) = member {
        return Err(rollback(tmp, ApiError::internal(e)).await);
    }
    let dir = app.project_dir(pid);
    // AUTOINCREMENT ids are never reused, so anything here is debris of a crash
    let _ = tokio::fs::remove_dir_all(&dir).await;
    if let Err(e) = tokio::fs::rename(tmp, &dir).await {
        drop(tx);
        return Err(rollback(tmp, ApiError::internal(e)).await);
    }
    if let Err(e) = tx.commit().await {
        return Err(rollback(&dir, ApiError::internal(e)).await);
    }
    Ok(pid)
}

/// Removes `tmp` (or the installed dir) after `err`; cleanup failures are logged and appended to
/// the error, so nothing is left behind silently. The row itself is never committed on failure.
async fn rollback(tmp: &FsPath, err: ApiError) -> ApiError {
    let mut failed = Vec::new();
    match tokio::fs::remove_dir_all(tmp).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            tracing::error!("{}: cleanup after a failed create: {e}", tmp.display());
            let name = tmp.file_name().unwrap_or_default().to_string_lossy();
            failed.push(format!("projects/{name} was not removed"));
        }
        _ => {}
    }
    if failed.is_empty() {
        return err;
    }
    let msg = format!("{}; cleanup failed: {}", err.message, failed.join(", "));
    ApiError::new(err.status, err.code, msg)
}

/// Creates the repo on the provider, prepares everything locally in a temp dir (own deploy key in
/// `ssh/`, starter content with CI, first commit by `user`, push) and only then adds the project.
/// After the remote exists, a failure removes everything local but not the remote repo (its URL
/// is in the error, so the user can delete it).
async fn create_with_remote(
    app: &AppState,
    user: &User,
    name: &str,
    compiler: Option<Setting>,
    spec: accounts::CreateRemote,
) -> Result<i64, ApiError> {
    let template_id = spec.template_id.as_deref().unwrap_or(templates::DEFAULT);
    let template = (templates::find(app, template_id, user).await?)
        .ok_or_else(|| ApiError::bad_request(format!("unknown template {template_id:?}")))?;
    let setting = compiler.unwrap_or_default();
    // with `auto`, the template's detected engine is what auto finds: CI builds with it
    let compiler = setting.fixed().unwrap_or(template.compiler);
    let conn = accounts::Conn::load(app, spec.account_id, Some(user.id)).await?;
    let repo = conn.create_repo(&spec).await?;
    let left_behind = |e: ApiError| {
        let msg = format!(
            "{} (the repository {} was already created, delete it there before retrying)",
            e.message, repo.web_url
        );
        ApiError::new(e.status, e.code, msg)
    };
    validate_remote_url(&repo.ssh_url, app.allow_file)
        .map_err(|e| left_behind(ApiError::new(StatusCode::BAD_GATEWAY, "remote_failed", e)))?;
    let tmp = new_tmp(app, "create").await.map_err(left_behind)?;
    let title = format!("undertree {}", spec.repo_name.trim());
    let init = async {
        starter_files(app, &tmp.join("repo"), &template, conn.forge, compiler).await?;
        init_remote_repo(app, &tmp, &title, user, &conn, &repo, spec.account_id).await
    };
    if let Err(e) = init.await {
        return Err(left_behind(rollback(&tmp, e).await));
    }
    let mut tx = match app.db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            let e = rollback(&tmp, ApiError::internal(e)).await;
            return Err(left_behind(e));
        }
    };
    let inserted = sqlx::query_scalar(
        "INSERT INTO projects
           (name, remote_url, branch, owner_id, compiler, compiler_auto, account_id, remote_repo)
         VALUES (?, ?, 'main', ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(name)
    .bind(&repo.ssh_url)
    .bind(user.id)
    .bind(compiler)
    .bind(setting == Setting::Auto)
    .bind(spec.account_id)
    .bind(&repo.id)
    .fetch_one(&mut *tx)
    .await;
    install(app, &tmp, tx, inserted, user.id)
        .await
        .map_err(left_behind)
}

/// The files of `template` in `work`, plus `.gitignore` and CI building its main file, unless the
/// template brings its own.
async fn starter_files(
    app: &AppState,
    work: &FsPath,
    template: &templates::Template,
    forge: accounts::Forge,
    compiler: Engine,
) -> Result<(), ApiError> {
    templates::copy_files(app, template, work).await?;
    let (ci_path, ci) = crate::ci::pipeline(forge, compiler, &template.main_file);
    for (path, content) in [
        (".gitignore", crate::ci::gitignore(&template.main_file)),
        (ci_path, ci),
    ] {
        let path = work.join(path);
        if tokio::fs::try_exists(&path)
            .await
            .map_err(ApiError::internal)?
        {
            continue;
        }
        tokio::fs::create_dir_all(path.parent().expect("has parent"))
            .await
            .map_err(ApiError::internal)?;
        tokio::fs::write(path, content)
            .await
            .map_err(ApiError::internal)?;
    }
    Ok(())
}

/// Self-hosted servers (not the pinned github.com/gitlab.com): the account's host key for
/// `ssh_url`'s host, else trust on first use (`netguard::keyscan`, stored on the account). Goes to
/// `ssh/known_hosts`, which `git::PROJECT_SSH` reads besides the pinned keys.
async fn trust_host_key(
    app: &AppState,
    account_id: i64,
    ssh_url: &str,
    ssh: &FsPath,
) -> Result<(), ApiError> {
    let Some((host, port)) = crate::netguard::ssh_host(ssh_url) else {
        // only the test mocks' `file://` repos have no SSH host; a host `ssh_host` rejects
        // (`_`, IDN) must not skip the scan silently, the clone would fail later
        if ssh_url.starts_with("file://") {
            return Ok(());
        }
        return Err(ApiError::bad_request(format!(
            "SSH-Host von {ssh_url} wird nicht unterstützt"
        )));
    };
    if port == 22 && ["github.com", "gitlab.com"].contains(&host.as_str()) {
        return Ok(());
    }
    let file = ssh.join("known_hosts");
    // the operator's own pin wins: nothing to scan or store
    let field = crate::netguard::known_hosts_host(&host, port);
    // ssh itself reads `~` from the passwd entry, not `$HOME`
    if let Some(home) = crate::netguard::passwd_home() {
        let operator = home.join(".ssh/known_hosts");
        let pinned = tokio::process::Command::new("ssh-keygen")
            .arg("-F")
            .arg(&field)
            .arg("-f")
            .arg(&operator)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success());
        if pinned {
            return Ok(());
        }
    }
    // one trust decision per account at a time: concurrent first creates reuse the first scan
    static TOFU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _tofu = TOFU.lock().await;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT ssh_known_hosts FROM user_accounts WHERE id = ?")
            .bind(account_id)
            .fetch_one(&app.db)
            .await
            .map_err(ApiError::internal)?;
    // a later key change makes ssh fail (StrictHostKeyChecking=yes), it is never re-trusted
    if let Some(line) = stored.filter(|l| l.split(' ').next() == Some(&field)) {
        return tokio::fs::write(file, format!("{line}\n"))
            .await
            .map_err(ApiError::internal);
    }
    // ponytail: one host per account (a GitLab has one SSH host); another host replaces it
    let line = crate::netguard::keyscan(&host, port, app.allow_file).await?;
    tokio::fs::write(&file, format!("{line}\n"))
        .await
        .map_err(ApiError::internal)?;
    let fingerprint = crate::netguard::fingerprint(&file).await?;
    sqlx::query(
        "UPDATE user_accounts SET ssh_known_hosts = ?, ssh_host_key_fingerprint = ? WHERE id = ?",
    )
    .bind(&line)
    .bind(&fingerprint)
    .bind(account_id)
    .execute(&app.db)
    .await
    .map_err(ApiError::internal)?;
    tracing::info!("account {account_id}: trusting SSH host key {fingerprint} of {field}");
    Ok(())
}

/// `title` = deploy key title and key comment.
async fn init_remote_repo(
    app: &AppState,
    tmp: &FsPath,
    title: &str,
    user: &User,
    conn: &accounts::Conn,
    repo: &accounts::NewRepo,
    account_id: i64,
) -> Result<(), ApiError> {
    let ssh = tmp.join("ssh");
    tokio::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&ssh)
        .await
        .map_err(ApiError::internal)?;
    trust_host_key(app, account_id, &repo.ssh_url, &ssh).await?;
    let keygen = tokio::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", title, "-f"])
        .arg(ssh.join("id_ed25519"))
        .output()
        .await
        .map_err(|e| ApiError::internal(format!("ssh-keygen: {e}")))?;
    if !keygen.status.success() {
        let err = String::from_utf8_lossy(&keygen.stderr);
        return Err(ApiError::internal(format!("ssh-keygen: {err}")));
    }
    let public = tokio::fs::read_to_string(ssh.join("id_ed25519.pub"))
        .await
        .map_err(ApiError::internal)?;
    conn.add_deploy_key(&repo.id, title, public.trim()).await?;

    let work = tmp.join("repo");
    let remote = Remote {
        creds: None,
        allow_file: app.allow_file,
        ssh: Some(git::ProjectSsh {
            key: ssh.join("id_ed25519"),
            pinned_hosts: app.pinned_hosts(),
        }),
    };
    let github = conn.forge == accounts::Forge::Github;
    let ident = [
        format!("user.name={}", git::ident_name(user)),
        format!("user.email={}", git::author_email(user, github)),
    ];
    let steps: [&[&str]; 5] = [
        &["init", "-q", "-b", "main"],
        &["add", "-A"],
        &[
            "-c",
            &ident[0],
            "-c",
            &ident[1],
            "commit",
            "-q",
            "-m",
            "Initial commit",
        ],
        &["remote", "add", "origin", &repo.ssh_url],
        &["push", "-q", "-u", "origin", "main"],
    ];
    for args in steps {
        let out = tokio::time::timeout(CLONE_TIMEOUT, git::run(&work, args, &remote))
            .await
            .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "git_failed", "git timed out"))?
            .map_err(ApiError::internal)?;
        if !out.status.success() {
            let err = git::explain(&String::from_utf8_lossy(&out.stderr));
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, "git_failed", err));
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn get(access: Access) -> Json<ProjectInfo> {
    Json(access.info)
}

#[derive(Deserialize)]
pub struct PatchProject {
    name: Option<String>,
    username: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    token: Option<Option<String>>,
    compiler: Option<Setting>,
    main_files: Option<Vec<String>>,
}

pub async fn patch(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<PatchProject>,
) -> Result<Json<ProjectInfo>, ApiError> {
    access.info.my_role.require(Role::Owner)?;
    let pid = access.info.id;
    plain_field("username", b.username.as_deref())?;
    plain_field("token", b.token.as_ref().and_then(|t| t.as_deref()))?;
    let main_files = match b.main_files {
        Some(files) => {
            let rt = app.runtime(pid).await?;
            Some(crate::compile::check_main_files(&rt, files).await?)
        }
        None => None,
    };
    let mut tx = app.db.begin().await.map_err(ApiError::internal)?;
    if let Some(name) = b.name {
        let name = non_empty(Some(name)).ok_or_else(|| ApiError::bad_request("name is empty"))?;
        sqlx::query("UPDATE projects SET name = ? WHERE id = ?")
            .bind(name)
            .bind(pid)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    if let Some(username) = b.username {
        sqlx::query("UPDATE projects SET git_username = ? WHERE id = ?")
            .bind(non_empty(Some(username)).unwrap_or_else(|| DEFAULT_GIT_USERNAME.to_owned()))
            .bind(pid)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    if let Some(token) = b.token {
        let blob = token
            .filter(|t| !t.is_empty())
            .map(|t| app.secrets.encrypt(&t));
        sqlx::query("UPDATE projects SET token_enc = ? WHERE id = ?")
            .bind(blob)
            .bind(pid)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    if let Some(compiler) = b.compiler {
        // `auto` keeps the last fixed engine in `compiler`
        sqlx::query(
            "UPDATE projects SET compiler = COALESCE(?, compiler), compiler_auto = ? WHERE id = ?",
        )
        .bind(compiler.fixed())
        .bind(compiler == Setting::Auto)
        .bind(pid)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }
    if let Some(files) = &main_files {
        sqlx::query("UPDATE projects SET main_files = ? WHERE id = ?")
            .bind(serde_json::to_string(files).map_err(ApiError::internal)?)
            .bind(pid)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    let loaded = app.projects.lock().unwrap().get(&pid).cloned();
    if let Some(rt) = loaded {
        *rt.remote.lock().unwrap() = app.load_remote(pid).await?;
        if let Some(compiler) = b.compiler {
            *rt.compiler.setting.lock().unwrap() = compiler;
        }
        if let Some(files) = main_files {
            *rt.compiler.main_files.lock().unwrap() = files;
            crate::compile::seed_main_files(rt).await;
        }
    }
    Ok(Json(project_info(&app, &access.user, pid).await?))
}

pub async fn delete(
    State(app): State<Arc<AppState>>,
    access: Access,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Owner)?;
    let pid = access.info.id;
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(pid)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?;
    let runtime = app.projects.lock().unwrap().remove(&pid);
    if let Some(rt) = runtime {
        rt.deleted.send_replace(true);
        rt.docs.close_all();
    }
    // ponytail: a compile or git command still running may write into the dir while it is
    // removed; the leftovers are unreachable (ids are never reused)
    match tokio::fs::remove_dir_all(app.project_dir(pid)).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            tracing::warn!("project {pid}: removing its directory failed: {e}")
        }
        _ => {}
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Member {
    username: String,
    display_name: String,
    role: Role,
}

pub async fn members(
    State(app): State<Arc<AppState>>,
    access: Access,
) -> Result<Json<Vec<Member>>, ApiError> {
    sqlx::query_as(
        "SELECT u.username, u.display_name, m.role
           FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1
                              WHEN 'commenter' THEN 2 ELSE 3 END, u.username",
    )
    .bind(access.info.id)
    .fetch_all(&app.db)
    .await
    .map(Json)
    .map_err(ApiError::internal)
}

#[derive(Deserialize)]
pub struct NewMember {
    username: String,
    /// default `editor`
    role: Option<Role>,
}

pub async fn add_member(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<NewMember>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Owner)?;
    let user_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(&b.username)
        .fetch_optional(&app.db)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found(format!("no such user: {}", b.username)))?;
    let added = sqlx::query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING",
    )
    .bind(access.info.id)
    .bind(user_id)
    .bind(b.role.unwrap_or(Role::Editor))
    .execute(&app.db)
    .await
    .map_err(ApiError::internal)?
    .rows_affected();
    if added == 0 {
        return Err(ApiError::conflict(format!(
            "{} is already a member",
            b.username
        )));
    }
    Ok(StatusCode::CREATED)
}

/// Runs `sql` (`?1` = project, `?2` = username, `?3` = `role`) on a membership: `404` if there
/// is none, `400 last_owner` (nothing changes) if the project would be left without an owner.
async fn change_member(
    app: &AppState,
    pid: i64,
    username: &str,
    sql: &'static str,
    role: Option<Role>,
) -> Result<(), ApiError> {
    let mut tx = app.db.begin().await.map_err(ApiError::internal)?;
    let changed = sqlx::query(sql)
        .bind(pid)
        .bind(username)
        .bind(role)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    if changed == 0 {
        return Err(ApiError::not_found(format!("{username} is not a member")));
    }
    let owners: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_members WHERE project_id = ? AND role = 'owner'",
    )
    .bind(pid)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if owners == 0 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "last_owner",
            "a project needs at least one owner, make someone else owner first",
        ));
    }
    tx.commit().await.map_err(ApiError::internal)?;
    if let Some(p) = app.projects.lock().unwrap().get(&pid) {
        let _ = p.member_changed.send(username.to_owned());
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct MemberRole {
    role: Role,
}

pub async fn patch_member(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, username)): Path<(String, String)>,
    Json(b): Json<MemberRole>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Owner)?;
    let sql = "UPDATE project_members SET role = ?3
               WHERE project_id = ?1 AND user_id = (SELECT id FROM users WHERE username = ?2)";
    change_member(&app, access.info.id, &username, sql, Some(b.role)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner, or the member themselves (leaving).
pub async fn remove_member(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, username)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    if access.user.username != username {
        access.info.my_role.require(Role::Owner)?;
    }
    let sql = "DELETE FROM project_members
               WHERE project_id = ?1 AND user_id = (SELECT id FROM users WHERE username = ?2)";
    change_member(&app, access.info.id, &username, sql, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_url_validation() {
        for ok in [
            "https://gitlab.com/me/paper.git",
            "https://github.com:443/me/paper",
            "ssh://git@gitlab.com/me/paper.git",
            "ssh://gitlab.com:2222/me/paper.git",
            "git@github.com:me/paper.git",
        ] {
            assert!(validate_remote_url(ok, false).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "https://user:pw@gitlab.com/me/paper.git",
            "https://oauth2@gitlab.com/x",
            "ssh://git:pw@host/x",
            "ssh://-oProxyCommand=evil/x",
            "file:///srv/data/projects/2/repo",
            "ext::sh -c evil",
            "ext::evil",
            "/srv/data/projects/2/repo",
            "../other",
            "repo",
            "-uevil",
            "--upload-pack=evil",
            "http://gitlab.com/me/paper.git",
            "git://gitlab.com/me/paper.git",
            "git@-oevil:x",
            "host:path",
            "./a:b",
            "https://gitlab.com/a b",
        ] {
            assert!(validate_remote_url(bad, false).is_err(), "{bad:?}");
        }
        assert!(validate_remote_url("file:///tmp/x", true).is_ok());
    }

    /// 0012: members become editors, the creator becomes owner.
    #[tokio::test]
    async fn roles_migration() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let migrator = sqlx::migrate!();
        migrator.run_to(10, &db).await.unwrap();
        for sql in [
            "INSERT INTO users (id, username, display_name) VALUES (1, 'a', 'A'), (2, 'b', 'B')",
            "INSERT INTO projects (id, name, remote_url, branch, owner_id)
             VALUES (1, 'P', 'git@h:p', 'main', 1)",
            "INSERT INTO project_members (project_id, user_id) VALUES (1, 2)",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        migrator.run(&db).await.unwrap();
        let roles: Vec<(i64, String)> =
            sqlx::query_as("SELECT user_id, role FROM project_members ORDER BY user_id")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(roles, [(1, "owner".into()), (2, "editor".into())]);
        let bad = sqlx::query("UPDATE project_members SET role = 'admin' WHERE user_id = 2");
        assert!(bad.execute(&db).await.is_err(), "CHECK constraint");
    }

    #[test]
    fn secrets_roundtrip_and_key_file() {
        let dir = tempfile::tempdir().unwrap();
        let s = Secrets::load(None, dir.path()).unwrap();
        let blob = s.encrypt("glpat-secret");
        assert!(!blob.windows(12).any(|w| w == b"glpat-secret"));
        assert_ne!(blob, s.encrypt("glpat-secret"), "random nonce");
        assert_eq!(s.decrypt(&blob).as_deref(), Some("glpat-secret"));
        let mut tampered = blob.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(s.decrypt(&tampered), None);

        use std::os::unix::fs::PermissionsExt;
        let key_file = dir.path().join("secret.key");
        let mode = std::fs::metadata(&key_file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // the same key is reused after a restart, and also works as UNDERTREE_SECRET_KEY
        let again = Secrets::load(None, dir.path()).unwrap();
        assert_eq!(again.decrypt(&blob).as_deref(), Some("glpat-secret"));
        let key = std::fs::read_to_string(&key_file).unwrap();
        let env = Secrets::load(Some(&key), FsPath::new("/nonexistent")).unwrap();
        assert_eq!(env.decrypt(&blob).as_deref(), Some("glpat-secret"));
        assert!(Secrets::load(Some("c2hvcnQ="), dir.path()).is_err());
    }
}
