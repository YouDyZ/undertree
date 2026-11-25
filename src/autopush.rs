//! Conflict-free server-side auto-commit & auto-push per project (docs/API.md → Git).
//!
//! Concurrent edits in the same open file converge inside the single server-side `yrs::Doc`
//! room before being flushed under `app.git_locks`. Before committing and pushing, the remote is
//! fetched; non-overlapping remote changes are fast-forwarded cleanly and overlapping text edits
//! are pre-validated in memory with `diffy::merge`. True line conflicts or binary conflicts
//! abort cleanly without writing conflict markers or leaving `MERGE_HEAD` behind.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
    sync::{atomic::AtomicU64, Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use crate::{
    auth::User,
    error::ApiError,
    events::Event,
    git::{
        effective_email, effective_name, git, git_index, is_github, is_non_fast_forward,
        parse_status, prefixed, project_identities, repo_dir, stdout, users_by_id, FileStatus,
        GitStatus, NETWORK_TIMEOUT,
    },
    projects::{Access, Project, Role},
    AppState,
};

pub const DEFAULT_MESSAGE: &str = "Auto-save: {files}";
const QUIET_WINDOW: Duration = Duration::from_secs(10);
const MAX_DEFER: Duration = Duration::from_secs(60);
const CONCURRENCY: usize = 2;

#[derive(Debug)]
pub(crate) enum AutoPushError {
    Conflict(String),
    Git(String),
    Internal(ApiError),
}

impl AutoPushError {
    fn message(&self) -> String {
        match self {
            Self::Conflict(m) | Self::Git(m) => m.clone(),
            Self::Internal(e) => e.message.clone(),
        }
    }

    fn into_api_error(self) -> ApiError {
        match self {
            Self::Conflict(m) => ApiError::conflict(m),
            Self::Git(m) => ApiError::new(StatusCode::BAD_GATEWAY, "git_failed", m),
            Self::Internal(e) => e,
        }
    }
}

impl From<ApiError> for AutoPushError {
    fn from(e: ApiError) -> Self {
        if e.status == StatusCode::CONFLICT {
            Self::Conflict(e.message)
        } else if e.status == StatusCode::BAD_GATEWAY {
            Self::Git(e.message)
        } else {
            Self::Internal(e)
        }
    }
}

pub fn validate_interval(secs: i64) -> Result<i64, ApiError> {
    if secs == 0 || (60..=86_400).contains(&secs) {
        Ok(secs)
    } else {
        Err(ApiError::bad_request(
            "auto_push_interval_secs must be 0 or between 60 and 86400",
        ))
    }
}

pub fn validate_message(msg: &str) -> Result<String, ApiError> {
    let trimmed = msg.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_MESSAGE.to_owned());
    }
    if trimmed.chars().count() > 200 || trimmed.chars().any(char::is_control) {
        return Err(ApiError::bad_request("invalid auto_push_message"));
    }
    Ok(trimmed.to_owned())
}

/// Howard Hinnant civil-from-days algorithm in UTC, formatted as `YYYY-MM-DD HH:MM UTC`.
pub(crate) fn format_utc_minute(now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {hour:02}:{minute:02} UTC")
}

pub fn format_message(template: &str, changed: &[String], now_utc: &str) -> String {
    let files = if changed.len() <= 3 {
        changed.join(", ")
    } else {
        format!(
            "{} (+{} weitere)",
            changed[..3].join(", "),
            changed.len() - 3
        )
    };
    let rendered = template
        .replace("{files}", &files)
        .replace("{count}", &changed.len().to_string())
        .replace("{time}", now_utc);
    let trimmed = rendered.trim();
    if trimmed.is_empty() {
        format!("Auto-save: {files}")
    } else {
        trimmed.to_owned()
    }
}

fn is_unmerged(f: &FileStatus) -> bool {
    f.index == "U"
        || f.worktree == "U"
        || (f.index == "A" && f.worktree == "A")
        || (f.index == "D" && f.worktree == "D")
}

async fn is_merge_in_progress(dir: &Path, status: &GitStatus) -> bool {
    if status.files.iter().any(is_unmerged) {
        return true;
    }
    let Some(git_dir_rel) = stdout(dir, &["rev-parse", "--git-dir"]).await else {
        return false;
    };
    let git_dir = dir.join(git_dir_rel);
    for marker in [
        "MERGE_HEAD",
        "REBASE_HEAD",
        "CHERRY_PICK_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        if tokio::fs::symlink_metadata(git_dir.join(marker))
            .await
            .is_ok()
        {
            return true;
        }
    }
    false
}

async fn ahead_behind(app: &Project, dir: &Path) -> Result<(u32, u32), AutoPushError> {
    let out = git(
        app,
        dir,
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        None,
    )
    .await?
    .check()?;
    let raw = out.stdout();
    let mut parts = raw.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    Ok((ahead, behind))
}

struct MergeItem {
    rel: String,
    ws_path: String,
    ours: String,
    base: String,
    theirs: String,
    merged: String,
    in_head: bool,
}

async fn prepare_clean_merges(
    app: &Project,
    dir: &Path,
    repo: &str,
    overlapping: &[String],
) -> Result<Vec<MergeItem>, AutoPushError> {
    let mut plan = Vec::with_capacity(overlapping.len());
    for rel in overlapping {
        let ws_path = prefixed(repo, rel);
        let ours = if let Some(room) = app.docs.get(&ws_path) {
            let text = room.text();
            if text.contains('\0') {
                return Err(AutoPushError::Conflict(format!(
                    "Binärer Konflikt in {rel} — bitte manuell pullen/prüfen."
                )));
            }
            text
        } else {
            let abs = dir.join(rel);
            let meta = tokio::fs::symlink_metadata(&abs).await.map_err(|_| {
                AutoPushError::Conflict(format!(
                    "Konflikt in {rel}: Datei wurde lokal gelöscht — bitte manuell prüfen."
                ))
            })?;
            if !meta.is_file() {
                return Err(AutoPushError::Conflict(format!(
                    "Konflikt in {rel}: geänderter Pfad ist keine reguläre Datei."
                )));
            }
            let ours_bytes = tokio::fs::read(&abs)
                .await
                .map_err(|e| ApiError::internal(format!("read {rel}: {e}")))?;
            String::from_utf8(ours_bytes)
                .ok()
                .filter(|s| !s.contains('\0'))
                .ok_or_else(|| {
                    AutoPushError::Conflict(format!(
                        "Binärer Konflikt in {rel} — bitte manuell pullen/prüfen."
                    ))
                })?
        };

        let theirs_spec = format!("@{{u}}:{rel}");
        let theirs_out = git(app, dir, &["show", &theirs_spec], None).await?;
        if !theirs_out.ok() {
            return Err(AutoPushError::Conflict(format!(
                "Konflikt in {rel}: auf Remote gelöscht oder verschoben — bitte manuell prüfen."
            )));
        }
        let theirs = std::str::from_utf8(theirs_out.stdout_bytes())
            .ok()
            .filter(|s| !s.contains('\0'))
            .ok_or_else(|| {
                AutoPushError::Conflict(format!(
                    "Binärer Konflikt in {rel} — bitte manuell pullen/prüfen."
                ))
            })?
            .to_owned();

        let head_spec = format!("HEAD:{rel}");
        let base_out = git(app, dir, &["show", &head_spec], None).await?;
        let (base, in_head) = if base_out.ok() {
            let b = std::str::from_utf8(base_out.stdout_bytes())
                .ok()
                .filter(|s| !s.contains('\0'))
                .ok_or_else(|| {
                    AutoPushError::Conflict(format!(
                        "Binärer Konflikt in {rel} — bitte manuell pullen/prüfen."
                    ))
                })?
                .to_owned();
            (b, true)
        } else {
            (String::new(), false)
        };

        let merged = diffy::merge(&base, &ours, &theirs).map_err(|_| {
            AutoPushError::Conflict(format!(
                "Widersprüchliche Remote-Änderungen in {rel} — bitte manuell pullen/prüfen."
            ))
        })?;
        plan.push(MergeItem {
            rel: rel.clone(),
            ws_path,
            ours,
            base,
            theirs,
            merged,
            in_head,
        });
    }
    Ok(plan)
}

fn classify_ff_merge_error(stderr: &str) -> AutoPushError {
    if is_non_fast_forward(stderr)
        || stderr.contains("would be overwritten by merge")
        || stderr.contains("needs merge")
    {
        AutoPushError::Conflict(stderr.trim().to_owned())
    } else {
        AutoPushError::Git(crate::git::explain(stderr))
    }
}

async fn sync_remote_changes(app: &Project, dir: &Path, repo: &str) -> Result<(), AutoPushError> {
    let _pause = app.docs.pause_sync().await;
    app.docs.flush_repo(&app.workspace, repo, &app.events);

    let fresh_out = git(
        app,
        dir,
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
    let fresh_st = parse_status(repo, &fresh_out.stdout());
    if is_merge_in_progress(dir, &fresh_st).await {
        return Err(AutoPushError::Conflict(
            "Merge oder Rebase aktiv — bitte manuell abschließen.".into(),
        ));
    }

    let remote_out = git(app, dir, &["diff", "--name-only", "-z", "HEAD..@{u}"], None)
        .await?
        .check()?;
    let remote_files: Vec<String> = remote_out
        .stdout()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    let remote_set: HashSet<&str> = remote_files.iter().map(String::as_str).collect();

    let mut overlapping = Vec::new();
    for f in &fresh_st.files {
        let rel = if repo.is_empty() {
            f.path.as_str()
        } else {
            f.path
                .strip_prefix(repo)
                .and_then(|s| s.strip_prefix('/'))
                .unwrap_or(&f.path)
        };
        if remote_set.contains(rel) {
            overlapping.push(rel.to_owned());
        }
    }
    overlapping.sort();
    overlapping.dedup();

    if overlapping.is_empty() {
        let out = git(app, dir, &["merge", "--ff-only", "@{u}"], None).await?;
        if !out.ok() {
            return Err(classify_ff_merge_error(&out.stderr()));
        }
        for rel in &remote_files {
            let ws_path = prefixed(repo, rel);
            if let Some(room) = app.docs.get(&ws_path) {
                room.sync_from_disk(&app.workspace, &app.events);
            }
        }
        let _ = app.events.send(Event::TreeChanged);
        return Ok(());
    }

    // Validate all overlapping files in memory BEFORE mutating the working tree.
    let plan = prepare_clean_merges(app, dir, repo, &overlapping).await?;

    let head_rels: Vec<&str> = plan
        .iter()
        .filter(|m| m.in_head)
        .map(|m| m.rel.as_str())
        .collect();
    if !head_rels.is_empty() {
        let mut co_args = vec!["checkout", "HEAD", "--"];
        co_args.extend(head_rels);
        if let Err(e) = git(app, dir, &co_args, None).await.and_then(|g| g.check()) {
            for m in &plan {
                let _ = tokio::fs::write(dir.join(&m.rel), m.ours.as_bytes()).await;
            }
            return Err(e.into());
        }
    }
    for m in plan.iter().filter(|m| !m.in_head) {
        let _ = tokio::fs::remove_file(dir.join(&m.rel)).await;
    }

    let merge_out = git(app, dir, &["merge", "--ff-only", "@{u}"], None).await?;
    if !merge_out.ok() {
        for m in &plan {
            let _ = tokio::fs::write(dir.join(&m.rel), m.ours.as_bytes()).await;
        }
        return Err(classify_ff_merge_error(&merge_out.stderr()));
    }

    let merged_set: HashSet<&str> = plan.iter().map(|m| m.rel.as_str()).collect();
    for m in &plan {
        if let Some(room) = app.docs.get(&m.ws_path) {
            if room
                .merge_external(&m.base, &m.theirs, &app.workspace, &app.events)
                .is_err()
            {
                let _ = app.workspace.write(&m.ws_path, room.text().as_bytes());
                return Err(AutoPushError::Conflict(format!(
                    "Widersprüchliche Remote-Änderungen in {} — bitte manuell pullen/prüfen.",
                    m.rel
                )));
            }
        } else {
            app.workspace
                .write(&m.ws_path, m.merged.as_bytes())
                .map_err(|e| ApiError::internal(format!("write {}: {e}", m.ws_path)))?;
        }
    }
    for rel in remote_files
        .iter()
        .filter(|r| !merged_set.contains(r.as_str()))
    {
        let ws_path = prefixed(repo, rel);
        if let Some(room) = app.docs.get(&ws_path) {
            room.sync_from_disk(&app.workspace, &app.events);
        }
    }
    let _ = app.events.send(Event::TreeChanged);
    Ok(())
}

async fn resolve_contributors(
    state: &AppState,
    pid: i64,
    ordered_ids: Vec<i64>,
) -> Result<(User, Vec<User>), ApiError> {
    let id_set: BTreeSet<i64> = ordered_ids.iter().copied().collect();
    let loaded = users_by_id(&state.db, &id_set).await?;
    let by_id: HashMap<i64, User> = loaded.into_iter().map(|u| (u.id, u)).collect();
    let mut users: Vec<User> = ordered_ids
        .into_iter()
        .filter_map(|id| by_id.get(&id).cloned())
        .collect();
    if users.is_empty() {
        let owner_id: i64 = sqlx::query_scalar("SELECT owner_id FROM projects WHERE id = ?")
            .bind(pid)
            .fetch_one(&state.db)
            .await
            .map_err(ApiError::internal)?;
        let owner = users_by_id(&state.db, &BTreeSet::from([owner_id]))
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| ApiError::internal("project owner not found"))?;
        return Ok((owner, Vec::new()));
    }
    let author = users.remove(0);
    Ok((author, users))
}

async fn run_repo(
    state: &AppState,
    app: &Project,
    repo: &str,
    msg_template: &str,
) -> Result<Option<String>, AutoPushError> {
    let dir = repo_dir(app, repo).await?;
    let lock = app.git_locks.get(repo);
    let _guard = lock.lock().await;
    app.docs.flush_repo(&app.workspace, repo, &app.events);

    let st_out = git(
        app,
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
    let mut st = parse_status(repo, &st_out.stdout());
    if st.branch.is_none() || st.upstream.is_none() {
        if st.files.is_empty() {
            return Ok(None);
        }
        return Err(AutoPushError::Conflict(
            "Kein Branch oder Upstream konfiguriert — Änderungen können nicht automatisch gepusht werden."
                .into(),
        ));
    }
    if is_merge_in_progress(&dir, &st).await {
        return Err(AutoPushError::Conflict(
            "Merge oder Rebase aktiv — bitte manuell abschließen.".into(),
        ));
    }
    if st.files.is_empty() && st.ahead == 0 {
        return Ok(None);
    }

    git(app, &dir, &["fetch", "--quiet"], Some(NETWORK_TIMEOUT))
        .await?
        .check()?;
    let (ahead, behind) = ahead_behind(app, &dir).await?;
    if behind > 0 {
        if ahead > 0 {
            return Err(AutoPushError::Conflict(
                "Lokaler Branch und Remote sind auseinandergelaufen — bitte manuell pullen.".into(),
            ));
        }
        sync_remote_changes(app, &dir, repo).await?;
        let recheck = git(
            app,
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
        st = parse_status(repo, &recheck.stdout());
        if is_merge_in_progress(&dir, &st).await {
            return Err(AutoPushError::Conflict(
                "Merge oder Rebase aktiv — bitte manuell abschließen.".into(),
            ));
        }
        if st.files.is_empty() && st.ahead == 0 {
            let _ = app.events.send(Event::GitChanged { repo: repo.into() });
            return Ok(None);
        }
    }

    let mark = app.contributions.mark();
    app.docs.flush_repo(&app.workspace, repo, &app.events);

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let idx_name = format!(
        "undertree-autopush-{}-{}.index",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let index = dir.join(
        stdout(&dir, &["rev-parse", "--git-path", &idx_name])
            .await
            .ok_or_else(|| ApiError::internal("git dir not found"))?,
    );
    let _ = std::fs::remove_file(&index);

    let commit_res: Result<Vec<String>, ApiError> = async {
        let has_head = stdout(&dir, &["rev-parse", "--verify", "-q", "HEAD"])
            .await
            .is_some();
        let base: &[&str] = if has_head {
            &["read-tree", "HEAD"]
        } else {
            &["read-tree", "--empty"]
        };
        git_index(&dir, &index, base).await?.check()?;
        git_index(&dir, &index, &["add", "-A", "--"])
            .await?
            .check()?;
        let out = git_index(
            &dir,
            &index,
            &["diff", "--cached", "--name-only", "-z", "--no-renames"],
        )
        .await?
        .check()?;
        let changed: Vec<String> = out
            .stdout()
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(|p| prefixed(repo, p))
            .collect();
        if changed.is_empty() {
            return Ok(Vec::new());
        }

        let ordered_ids = app.contributions.ordered_users(&changed, mark);
        let (author, co_authors) = resolve_contributors(state, app.id, ordered_ids).await?;
        let github = stdout(&dir, &["remote", "get-url", "origin"])
            .await
            .is_some_and(|url| is_github(&url));
        let identities = project_identities(&state.db, app.id).await?;
        let name = format!(
            "user.name={}",
            effective_name(&author, identities.get(&author.id))
        );
        let email = format!(
            "user.email={}",
            effective_email(&author, identities.get(&author.id), github)
        );
        let message = format_message(
            msg_template,
            &changed,
            &format_utc_minute(SystemTime::now()),
        );
        let trailers: Vec<String> = co_authors
            .iter()
            .map(|u| {
                let ov = identities.get(&u.id);
                format!(
                    "Co-authored-by: {} <{}>",
                    effective_name(u, ov),
                    effective_email(u, ov, github)
                )
            })
            .collect();
        let mut args = vec!["-c", &name, "-c", &email, "commit", "-q", "-m", &message];
        for t in &trailers {
            args.extend(["--trailer", t]);
        }
        git_index(&dir, &index, &args).await?.check()?;
        Ok(changed)
    }
    .await;
    let _ = std::fs::remove_file(&index);
    let changed = commit_res?;

    if !changed.is_empty() {
        if let Err(e) = git(app, &dir, &["reset", "-q", "--"], None)
            .await
            .and_then(|g| g.check())
        {
            tracing::warn!("index refresh after auto-commit failed: {}", e.message);
        }
        app.contributions.clear(&changed, mark);
    }

    let push_out = git(app, &dir, &["push"], Some(NETWORK_TIMEOUT)).await?;
    if !push_out.ok() {
        return Err(if is_non_fast_forward(&push_out.stderr()) {
            AutoPushError::Conflict(push_out.stderr().trim().to_owned())
        } else {
            AutoPushError::Git(crate::git::explain(&push_out.stderr()))
        });
    }

    let sha = git(app, &dir, &["rev-parse", "HEAD"], None)
        .await?
        .check()?
        .stdout()
        .trim()
        .to_owned();
    let _ = app.events.send(Event::GitChanged { repo: repo.into() });
    Ok(Some(sha))
}

async fn mark_ok(state: &AppState, pid: i64, pushed: bool) {
    let sql = if pushed {
        "UPDATE projects
         SET auto_push_last_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
             auto_push_last_error = NULL
         WHERE id = ?"
    } else {
        "UPDATE projects SET auto_push_last_error = NULL WHERE id = ?"
    };
    if let Err(e) = sqlx::query(sql).bind(pid).execute(&state.db).await {
        tracing::warn!("auto-push {pid}: status update failed: {e}");
    }
}

async fn mark_err(state: &AppState, pid: i64, msg: &str) {
    if let Err(e) = sqlx::query("UPDATE projects SET auto_push_last_error = ? WHERE id = ?")
        .bind(msg)
        .bind(pid)
        .execute(&state.db)
        .await
    {
        tracing::warn!("auto-push {pid}: error update failed: {e}");
    }
}

pub(crate) async fn run_project(
    state: &Arc<AppState>,
    pid: i64,
    msg_template: &str,
) -> Result<Option<String>, AutoPushError> {
    let app = state.runtime(pid).await?;
    let repos = app.workspace.repos().await;
    // Submodules first so the parent sees updated gitlinks if committed together.
    let mut targets: Vec<String> = repos
        .iter()
        .filter(|r| !r.path.is_empty() && r.initialized)
        .map(|r| r.path.clone())
        .collect();
    targets.push(String::new());

    let mut pushed_sha: Option<String> = None;
    for repo in targets {
        match run_repo(state, &app, &repo, msg_template).await {
            Ok(Some(sha)) => pushed_sha = Some(sha),
            Ok(None) => {}
            Err(e) => {
                mark_err(state, pid, &e.message()).await;
                return Err(e);
            }
        }
    }
    mark_ok(state, pid, pushed_sha.is_some()).await;
    Ok(pushed_sha)
}

pub async fn trigger(
    State(state): State<Arc<AppState>>,
    access: Access,
) -> Result<Json<Value>, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    let pid = access.info.id;
    let sha = run_project(&state, pid, &access.info.auto_push_message)
        .await
        .map_err(AutoPushError::into_api_error)?;
    let (last_at, last_error): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT auto_push_last_at, auto_push_last_error FROM projects WHERE id = ?")
            .bind(pid)
            .fetch_one(&state.db)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(json!({
        "pushed": sha.is_some(),
        "sha": sha,
        "auto_push_last_at": last_at,
        "auto_push_last_error": last_error,
    })))
}

#[derive(sqlx::FromRow)]
struct ScheduledProject {
    id: i64,
    auto_push_interval_secs: i64,
    auto_push_message: String,
}

#[derive(Default)]
pub(crate) struct ScheduleState {
    last_attempt: HashMap<i64, std::time::Instant>,
    defer_since: HashMap<i64, std::time::Instant>,
}

pub(crate) async fn poll_once(state: &Arc<AppState>, sched: &Arc<Mutex<ScheduleState>>) {
    let rows: Vec<ScheduledProject> = match sqlx::query_as(
        "SELECT id, auto_push_interval_secs, auto_push_message
         FROM projects WHERE auto_push_interval_secs > 0 ORDER BY id",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return tracing::warn!("auto-push query: {e}"),
    };

    let now = std::time::Instant::now();
    let due: Vec<ScheduledProject> = {
        let mut s = sched.lock().unwrap();
        let active: HashSet<i64> = rows.iter().map(|r| r.id).collect();
        s.last_attempt.retain(|id, _| active.contains(id));
        s.defer_since.retain(|id, _| active.contains(id));

        let loaded = state.projects.lock().unwrap();
        let mut out = Vec::new();
        for r in rows {
            let interval = Duration::from_secs(r.auto_push_interval_secs as u64);
            if s.last_attempt
                .get(&r.id)
                .is_some_and(|t| now.saturating_duration_since(*t) < interval)
            {
                continue;
            }
            let touching = loaded
                .get(&r.id)
                .and_then(|rt| rt.contributions.last_touch())
                .is_some_and(|t| now.saturating_duration_since(t) < QUIET_WINDOW);
            if touching {
                let first = *s.defer_since.entry(r.id).or_insert(now);
                if now.saturating_duration_since(first) < MAX_DEFER {
                    continue;
                }
            }
            s.defer_since.remove(&r.id);
            s.last_attempt.insert(r.id, now);
            out.push(r);
        }
        out
    };

    let permits = Arc::new(Semaphore::new(CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for p in due {
        let (state, permits) = (state.clone(), permits.clone());
        tasks.spawn(async move {
            let _permit = permits.acquire().await;
            if let Err(e) = run_project(&state, p.id, &p.auto_push_message).await {
                tracing::warn!("auto-push {}: {}", p.id, e.message());
            }
        });
    }
    while let Some(res) = tasks.join_next().await {
        if let Err(e) = res {
            tracing::warn!("auto-push task failed: {e}");
        }
    }
}

pub async fn sync_loop(state: Arc<AppState>, every: Duration) {
    let sched = Arc::new(Mutex::new(ScheduleState::default()));
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        poll_once(&state, &sched).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_auto_push_settings() {
        assert_eq!(validate_interval(0).unwrap(), 0);
        assert_eq!(validate_interval(60).unwrap(), 60);
        assert_eq!(validate_interval(300).unwrap(), 300);
        assert_eq!(validate_interval(86_400).unwrap(), 86_400);
        for bad in [-1, 1, 59, 86_401] {
            assert!(validate_interval(bad).is_err(), "{bad}");
        }

        assert_eq!(validate_message("").unwrap(), DEFAULT_MESSAGE);
        assert_eq!(validate_message("   ").unwrap(), DEFAULT_MESSAGE);
        assert_eq!(
            validate_message("  Backup {time}  ").unwrap(),
            "Backup {time}"
        );
        assert!(validate_message("bad\nline").is_err());
        assert!(validate_message(&"a".repeat(201)).is_err());
    }

    #[test]
    fn format_message_placeholders() {
        assert_eq!(format_utc_minute(UNIX_EPOCH), "1970-01-01 00:00 UTC");
        let files = vec!["a.tex".into(), "b.tex".into()];
        assert_eq!(
            format_message("Auto-save: {files} ({count} @ {time})", &files, "12:00"),
            "Auto-save: a.tex, b.tex (2 @ 12:00)"
        );
        let many: Vec<String> = ["1", "2", "3", "4", "5"]
            .into_iter()
            .map(ToOwned::to_owned)
            .collect();
        assert_eq!(
            format_message(DEFAULT_MESSAGE, &many, "t"),
            "Auto-save: 1, 2, 3 (+2 weitere)"
        );
        assert_eq!(
            format_message("   ", &files, "t"),
            "Auto-save: a.tex, b.tex"
        );
    }
}
