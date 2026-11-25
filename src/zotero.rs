//! Zotero (docs/API.md → Zotero): an API key as connected account, its libraries and
//! collections, and `.bib` files imported from them and refreshed later (`zotero_links`).
//!
//! All calls go to the fixed Zotero API (`UNDERTREE_ZOTERO_API_URL` only changes for tests), the
//! key only ever in the `Zotero-API-Key` header, never in a URL.

use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use oauth2::reqwest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::time::Instant;

use crate::{
    accounts::{remote_failed, Account},
    auth::AuthSession,
    docs::MAX_DOC_BYTES,
    error::ApiError,
    projects::{Access, Role},
    workspace, AppState,
};

/// `base_url` of every Zotero account.
pub const ZOTERO_WEB: &str = "https://api.zotero.org";
const PAGE: usize = 100;
/// cap per import; the size cap is the editor's (`MAX_DOC_BYTES`), so the file stays editable
const MAX_ENTRIES: usize = 20_000;
/// longest `Backoff` / `Retry-After` we sleep for, longer → `502`
const MAX_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Format {
    #[default]
    Biblatex,
    Bibtex,
}

impl Format {
    fn as_str(self) -> &'static str {
        match self {
            Format::Biblatex => "biblatex",
            Format::Bibtex => "bibtex",
        }
    }
}

/// One `200` response of a list endpoint.
struct Page {
    total: Option<usize>,
    /// `Last-Modified-Version`: the library's version
    version: Option<i64>,
    body: Bytes,
}

/// A downloaded bibliography.
struct Bib {
    text: String,
    entries: usize,
    /// library version of the first page
    version: Option<i64>,
}

struct Client {
    http: reqwest::Client,
    api: String,
    key: String,
    /// from `Backoff` / `Retry-After`: no request before this
    not_before: Option<Instant>,
}

fn forbidden() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "zotero_forbidden",
        "the Zotero key has no access to this library (or was revoked)",
    )
}

impl Client {
    fn new(app: &AppState, key: String) -> Self {
        Self {
            http: app.oauth.http.clone(),
            api: app.zotero_api.clone(),
            key,
            not_before: None,
        }
    }

    /// GET `path` (from `/`) → (`Total-Results`, body), honoring `Backoff` and `Retry-After`.
    async fn get(&mut self, path: &str) -> Result<(Option<usize>, Bytes), ApiError> {
        let page = self.get_since(path, None).await?;
        Ok(page.map_or_else(Default::default, |p| (p.total, p.body)))
    }

    /// Like `get`; with `since` (a library version) `None` means `304 Not Modified`.
    async fn get_since(
        &mut self,
        path: &str,
        since: Option<i64>,
    ) -> Result<Option<Page>, ApiError> {
        for _ in 0..3 {
            if let Some(t) = self.not_before {
                if t > Instant::now() + MAX_WAIT {
                    // `not_before` stays, so the caller can keep pausing this account
                    return Err(remote_failed(
                        "Zotero asks to pause requests for a while (rate limit), try again later",
                    ));
                }
                tokio::time::sleep_until(t).await;
                self.not_before = None;
            }
            let mut req = (self.http.get(format!("{}{path}", self.api)))
                .header("Zotero-API-Key", &self.key)
                .header("Zotero-API-Version", "3");
            if let Some(v) = since {
                req = req.header("If-Modified-Since-Version", v);
            }
            let res = req
                .send()
                .await
                .map_err(|e| remote_failed(format!("Zotero unreachable: {}", e.without_url())))?;
            let status = res.status().as_u16();
            let num = |name: &str| {
                let v = res.headers().get(name)?.to_str().ok()?;
                v.trim().parse::<u64>().ok()
            };
            let (backoff, retry_after) = (num("backoff"), num("retry-after"));
            let total = num("total-results").map(|n| n as usize);
            let version = num("last-modified-version").map(|v| v as i64);
            let retry = status == 429 || (status == 503 && retry_after.is_some());
            let wait = if retry {
                Some(retry_after.unwrap_or(5))
            } else {
                backoff
            };
            if let Some(secs) = wait {
                self.not_before = Some(Instant::now() + Duration::from_secs(secs));
            }
            if retry {
                continue;
            }
            if status == 304 {
                return Ok(None);
            }
            let body = res
                .bytes()
                .await
                .map_err(|e| remote_failed(format!("Zotero unreachable: {}", e.without_url())))?;
            return match status {
                200..=299 => Ok(Some(Page {
                    total,
                    version,
                    body,
                })),
                403 => Err(forbidden()),
                404 => Err(ApiError::not_found("no such Zotero library or collection")),
                _ => {
                    let msg: String = String::from_utf8_lossy(&body).chars().take(300).collect();
                    Err(remote_failed(format!(
                        "Zotero API: {status} {}",
                        msg.trim()
                    )))
                }
            };
        }
        Err(remote_failed(
            "Zotero keeps rate-limiting requests, try again later",
        ))
    }

    /// All elements of a paged JSON array endpoint.
    async fn json_pages(&mut self, path: &str) -> Result<Vec<Value>, ApiError> {
        let mut out = Vec::new();
        loop {
            let (total, body) = self
                .get(&format!("{path}?limit={PAGE}&start={}", out.len()))
                .await?;
            let page: Vec<Value> = serde_json::from_slice(&body)
                .map_err(|_| remote_failed("Zotero: unexpected response"))?;
            let n = page.len();
            out.extend(page);
            if n < PAGE || total.is_some_and(|t| out.len() >= t) || out.len() >= MAX_ENTRIES {
                return Ok(out);
            }
        }
    }

    /// The library (`lib` from `lib_path`) or one collection as BibLaTeX/BibTeX. Top-level items
    /// only: child notes/attachments export nothing. With `since` (the library version of the
    /// last export) `None` if Zotero says nothing changed (`304` on the first page).
    async fn bib(
        &mut self,
        lib: &str,
        collection: Option<&str>,
        format: Format,
        since: Option<i64>,
    ) -> Result<Option<Bib>, ApiError> {
        let items = match collection {
            Some(key) => format!("{lib}/collections/{key}/items/top"),
            None => format!("{lib}/items/top"),
        };
        let (mut out, mut entries, mut start, mut version) = (String::new(), 0, 0, None);
        loop {
            let path = format!(
                "{items}?format={}&limit={PAGE}&start={start}",
                format.as_str()
            );
            let since = if start == 0 { since } else { None };
            let Some(p) = self.get_since(&path, since).await? else {
                return Ok(None);
            };
            let (total, body) = (p.total, p.body);
            if start == 0 {
                version = p.version;
            }
            let page = String::from_utf8_lossy(&body);
            let page = page.trim();
            let n = page.lines().filter(|l| l.starts_with('@')).count();
            entries += n;
            if !page.is_empty() {
                out.push_str(page);
                out.push_str("\n\n");
            }
            if entries > MAX_ENTRIES || out.len() > MAX_DOC_BYTES {
                return Err(ApiError::too_large(format!(
                    "the library is too large to import (max {MAX_ENTRIES} entries / {} MiB)",
                    MAX_DOC_BYTES >> 20
                )));
            }
            start += PAGE;
            let done = match total {
                Some(t) => start >= t,
                None => n < PAGE,
            };
            if done || page.is_empty() {
                out.truncate(out.trim_end().len());
                if !out.is_empty() {
                    out.push('\n');
                }
                return Ok(Some(Bib {
                    text: out,
                    entries,
                    version,
                }));
            }
        }
    }
}

/// `POST /api/accounts` with `provider: "zotero"`: validates the key with `GET /keys/current`.
pub async fn connect(app: &AppState, user_id: i64, key: &str) -> Result<Account, ApiError> {
    if !key.bytes().all(|b| b.is_ascii_alphanumeric()) || key.len() > 64 {
        return Err(ApiError::bad_request("not a Zotero API key"));
    }
    let mut client = Client::new(app, key.into());
    let (_, body) = client.get("/keys/current").await.map_err(|e| {
        if e.code == "zotero_forbidden" || e.status == StatusCode::NOT_FOUND {
            ApiError::bad_request("Zotero rejected the API key")
        } else {
            e
        }
    })?;
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (Some(uid), Some(login)) = (v["userID"].as_i64(), v["username"].as_str()) else {
        return Err(remote_failed("Zotero: unexpected response (no userID)"));
    };
    let id = sqlx::query_scalar(
        "INSERT INTO user_accounts (user_id, provider, base_url, login, token_enc, remote_id)
         VALUES (?, 'zotero', ?, ?, ?, ?)
         ON CONFLICT (user_id, provider, base_url) DO UPDATE SET
            login = excluded.login, token_enc = excluded.token_enc, remote_id = excluded.remote_id
         RETURNING id",
    )
    .bind(user_id)
    .bind(ZOTERO_WEB)
    .bind(login)
    .bind(app.secrets.encrypt(key))
    .bind(uid.to_string())
    .fetch_one(&app.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Account {
        id,
        provider: "zotero".into(),
        base_url: ZOTERO_WEB.into(),
        login: login.into(),
        ssh_host_key_fingerprint: None,
    })
}

/// (Zotero userID, client) of Zotero account `id`; with `owner` only if it's theirs, else 404.
async fn account(
    app: &AppState,
    id: i64,
    owner: Option<i64>,
) -> Result<(String, Client), ApiError> {
    let (uid, key): (String, Vec<u8>) = sqlx::query_as(
        "SELECT remote_id, token_enc FROM user_accounts
         WHERE id = ?1 AND provider = 'zotero' AND (?2 IS NULL OR user_id = ?2)",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(&app.db)
    .await
    .map_err(ApiError::internal)?
    .ok_or_else(|| ApiError::not_found("no such Zotero account"))?;
    let key = app.secrets.decrypt(&key).ok_or_else(|| {
        ApiError::bad_request("the Zotero key cannot be decrypted, connect it again")
    })?;
    Ok((uid, Client::new(app, key)))
}

/// `user:<id>` / `group:<id>` → API path prefix.
fn lib_path(library: &str) -> Result<String, ApiError> {
    let bad = || ApiError::bad_request("library must be \"user:<id>\" or \"group:<id>\"");
    let (kind, id) = library.split_once(':').ok_or_else(bad)?;
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    match kind {
        "user" => Ok(format!("/users/{id}")),
        "group" => Ok(format!("/groups/{id}")),
        _ => Err(bad()),
    }
}

fn check_collection(key: &str) -> Result<(), ApiError> {
    if key.is_empty() || key.len() > 32 || !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(ApiError::bad_request("invalid collection key"));
    }
    Ok(())
}

async fn me(auth: &AuthSession) -> Result<i64, ApiError> {
    Ok(auth.user().await.ok_or_else(ApiError::unauthorized)?.id)
}

#[derive(Serialize)]
pub struct Library {
    library: String,
    name: String,
}

pub async fn libraries(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<i64>,
) -> Result<Json<Vec<Library>>, ApiError> {
    let (uid, mut client) = account(&app, id, Some(me(&auth).await?)).await?;
    let groups = client.json_pages(&format!("/users/{uid}/groups")).await?;
    let mut out = vec![Library {
        library: format!("user:{uid}"),
        name: "My Library".into(),
    }];
    out.extend(groups.iter().filter_map(|g| {
        Some(Library {
            library: format!("group:{}", g["id"].as_i64()?),
            name: g["data"]["name"].as_str().unwrap_or_default().into(),
        })
    }));
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct LibraryQuery {
    library: String,
}

#[derive(Serialize)]
pub struct Collection {
    key: String,
    name: String,
    parent: Option<String>,
}

pub async fn collections(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<i64>,
    Query(q): Query<LibraryQuery>,
) -> Result<Json<Vec<Collection>>, ApiError> {
    let lib = lib_path(&q.library)?;
    let (_, mut client) = account(&app, id, Some(me(&auth).await?)).await?;
    let all = client.json_pages(&format!("{lib}/collections")).await?;
    let out = all.iter().filter_map(|c| {
        Some(Collection {
            key: c["key"].as_str()?.into(),
            name: c["data"]["name"].as_str().unwrap_or_default().into(),
            // `false` for top-level collections
            parent: c["data"]["parentCollection"].as_str().map(Into::into),
        })
    });
    Ok(Json(out.collect()))
}

#[derive(Deserialize)]
pub struct Import {
    account_id: i64,
    library: String,
    collection: Option<String>,
    path: String,
    #[serde(default)]
    format: Format,
}

/// Downloads the bibliography (not if unchanged since `since`) and writes it to `link.path` as
/// user `uid` (through the CRDT if open), unless the file already has that content. `None`: Zotero
/// says nothing changed, else (entries, library version).
async fn fetch_and_write(
    app: &AppState,
    pid: i64,
    uid: i64,
    client: &mut Client,
    link: &Import,
    since: Option<i64>,
) -> Result<Option<(usize, Option<i64>)>, ApiError> {
    let lib = lib_path(&link.library)?;
    let bib = client.bib(&lib, link.collection.as_deref(), link.format, since);
    let Some(bib) = bib.await? else {
        return Ok(None);
    };
    let rt = app.runtime(pid).await?;
    let current = match rt.docs.get(&link.path) {
        Some(room) => Some(room.text()),
        None => (rt.workspace.read(&link.path).ok()).and_then(|b| String::from_utf8(b).ok()),
    };
    // no spurious writes: they would show up as changes in Git and trigger recompiles
    if current.as_deref() != Some(bib.text.as_str()) {
        workspace::write_file(&rt, uid, link.path.clone(), bib.text.into()).await?;
    }
    Ok(Some((bib.entries, bib.version)))
}

/// Stores the outcome of a sync; `fetched` = Zotero had changes (else it was only checked).
async fn mark_ok(db: &SqlitePool, pid: i64, path: &str, version: Option<i64>, fetched: bool) {
    let res = sqlx::query(
        "UPDATE zotero_links SET library_version = COALESCE(?3, library_version),
            last_synced_at = CURRENT_TIMESTAMP, last_error = NULL,
            updated_at = CASE WHEN ?4 THEN CURRENT_TIMESTAMP ELSE updated_at END
         WHERE project_id = ?1 AND path = ?2",
    )
    .bind(pid)
    .bind(path)
    .bind(version)
    .bind(fetched)
    .execute(db)
    .await;
    if let Err(e) = res {
        tracing::warn!("zotero link {pid}:{path}: {e}");
    }
}

async fn mark_err(db: &SqlitePool, pid: i64, path: &str, msg: &str) {
    let msg: String = msg.chars().take(300).collect();
    let res =
        sqlx::query("UPDATE zotero_links SET last_error = ?3 WHERE project_id = ?1 AND path = ?2")
            .bind(pid)
            .bind(path)
            .bind(msg)
            .execute(db)
            .await;
    if let Err(e) = res {
        tracing::warn!("zotero link {pid}:{path}: {e}");
    }
}

pub async fn import(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<Import>,
) -> Result<Json<Value>, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    lib_path(&b.library)?;
    if let Some(key) = &b.collection {
        check_collection(key)?;
    }
    if !b.path.to_ascii_lowercase().ends_with(".bib") {
        return Err(ApiError::bad_request("path must be a .bib file"));
    }
    app.runtime(access.info.id)
        .await?
        .workspace
        .resolve(&b.path)?;
    let (_, mut client) = account(&app, b.account_id, Some(access.user.id)).await?;
    let (pid, uid) = (access.info.id, access.user.id);
    let (entries, version) = (fetch_and_write(&app, pid, uid, &mut client, &b, None).await?)
        .ok_or_else(|| remote_failed("Zotero: unexpected 304"))?;
    sqlx::query(
        "INSERT INTO zotero_links (project_id, path, account_id, library, collection, format,
                                   created_by, library_version, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (project_id, path) DO UPDATE SET
            account_id = excluded.account_id, library = excluded.library,
            collection = excluded.collection, format = excluded.format,
            created_by = excluded.created_by, updated_at = CURRENT_TIMESTAMP,
            library_version = excluded.library_version, last_synced_at = CURRENT_TIMESTAMP,
            last_error = NULL",
    )
    .bind(access.info.id)
    .bind(&b.path)
    .bind(b.account_id)
    .bind(&b.library)
    .bind(&b.collection)
    .bind(b.format)
    .bind(access.user.id)
    .bind(version)
    .execute(&app.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(json!({ "path": b.path, "entries": entries })))
}

#[derive(Deserialize)]
pub struct PathBody {
    path: String,
}

/// Re-imports with the stored link, using the account of whoever created it.
pub async fn refresh(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<PathBody>,
) -> Result<Json<Value>, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    let pid = access.info.id;
    let (account_id, library, collection, format): (Option<i64>, String, Option<String>, Format) =
        sqlx::query_as(
            "SELECT account_id, library, collection, format FROM zotero_links
             WHERE project_id = ? AND path = ?",
        )
        .bind(pid)
        .bind(&b.path)
        .fetch_optional(&app.db)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found(format!("{} is not linked to Zotero", b.path)))?;
    let account_id = account_id.ok_or_else(|| {
        ApiError::conflict(
            "the Zotero account of this link was disconnected; import the file again with your account",
        )
    })?;
    let (_, mut client) = account(&app, account_id, None).await?;
    let link = Import {
        account_id,
        library,
        collection,
        path: b.path,
        format,
    };
    let uid = access.user.id;
    let (entries, version) = (fetch_and_write(&app, pid, uid, &mut client, &link, None).await?)
        .ok_or_else(|| remote_failed("Zotero: unexpected 304"))?;
    mark_ok(&app.db, pid, &link.path, version, true).await;
    Ok(Json(json!({ "path": link.path, "entries": entries })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Link {
    path: String,
    account_id: Option<i64>,
    library: String,
    collection: Option<String>,
    format: Format,
    updated_at: String,
    auto_sync: bool,
    last_synced_at: Option<String>,
    last_error: Option<String>,
}

pub async fn links(
    State(app): State<Arc<AppState>>,
    access: Access,
) -> Result<Json<Vec<Link>>, ApiError> {
    sqlx::query_as(
        "SELECT path, account_id, library, collection, format,
                strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at, auto_sync,
                strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_at) AS last_synced_at, last_error
         FROM zotero_links WHERE project_id = ? ORDER BY path",
    )
    .bind(access.info.id)
    .fetch_all(&app.db)
    .await
    .map(Json)
    .map_err(ApiError::internal)
}

#[derive(Deserialize)]
pub struct AutoSync {
    path: String,
    auto_sync: bool,
}

/// Switches the background sync of one link on or off.
pub async fn patch_link(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<AutoSync>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    let updated =
        sqlx::query("UPDATE zotero_links SET auto_sync = ? WHERE project_id = ? AND path = ?")
            .bind(b.auto_sync)
            .bind(access.info.id)
            .bind(&b.path)
            .execute(&app.db)
            .await
            .map_err(ApiError::internal)?
            .rows_affected();
    if updated == 0 {
        return Err(ApiError::not_found(format!(
            "{} is not linked to Zotero",
            b.path
        )));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Forgets the link; the file stays.
pub async fn delete_link(
    State(app): State<Arc<AppState>>,
    access: Access,
    Query(q): Query<PathBody>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Editor)?;
    let deleted = sqlx::query("DELETE FROM zotero_links WHERE project_id = ? AND path = ?")
        .bind(access.info.id)
        .bind(&q.path)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    if deleted == 0 {
        return Err(ApiError::not_found(format!(
            "{} is not linked to Zotero",
            q.path
        )));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Server start: every `every` the links with `auto_sync` are checked against Zotero. Pauses
/// (`Backoff` / `Retry-After`) of an account hold over to the following rounds.
pub async fn sync_loop(app: Arc<AppState>, every: Duration) {
    let mut paused = HashMap::new();
    let mut tick = tokio::time::interval_at(Instant::now() + every, every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        sync_once(&app, &mut paused).await;
    }
}

/// At most this many Zotero accounts are queried at the same time.
const SYNC_CONCURRENCY: usize = 2;

#[derive(sqlx::FromRow)]
struct SyncLink {
    project_id: i64,
    path: String,
    account_id: i64,
    user_id: i64,
    library: String,
    collection: Option<String>,
    format: Format,
    library_version: Option<i64>,
}

/// One round over all links with `auto_sync`; accounts in `paused` are skipped until then.
pub(crate) async fn sync_once(app: &Arc<AppState>, paused: &mut HashMap<i64, Instant>) {
    let links: Vec<SyncLink> = match sqlx::query_as(
        "SELECT l.project_id, l.path, l.account_id, a.user_id, l.library, l.collection,
                l.format, l.library_version
         FROM zotero_links l JOIN user_accounts a ON a.id = l.account_id
         WHERE l.auto_sync = 1
           AND (EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = l.project_id
                        AND m.user_id = a.user_id AND m.role IN ('owner', 'editor'))
                OR EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id AND u.is_admin = 1))
         ORDER BY l.account_id, l.project_id, l.path",
    )
    .fetch_all(&app.db)
    .await
    {
        Ok(l) => l,
        Err(e) => return tracing::warn!("zotero sync: {e}"),
    };
    let mut by_account: BTreeMap<i64, Vec<SyncLink>> = BTreeMap::new();
    for l in links {
        by_account.entry(l.account_id).or_default().push(l);
    }
    let permits = Arc::new(tokio::sync::Semaphore::new(SYNC_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for (account_id, links) in by_account {
        if paused.get(&account_id).is_some_and(|t| *t > Instant::now()) {
            continue;
        }
        let (app, permits) = (app.clone(), permits.clone());
        tasks.spawn(async move {
            let _permit = permits.acquire().await;
            (account_id, sync_account(&app, account_id, links).await)
        });
    }
    while let Some(done) = tasks.join_next().await {
        match done {
            Ok((id, Some(t))) => paused.insert(id, t),
            Ok((id, None)) => paused.remove(&id),
            Err(e) => {
                tracing::warn!("zotero sync: {e}");
                continue;
            }
        };
    }
}

/// The links of one account one after another (so they share Zotero's pauses); returns the end
/// of a pause Zotero asked for.
async fn sync_account(app: &AppState, account_id: i64, links: Vec<SyncLink>) -> Option<Instant> {
    let mut client = match account(app, account_id, None).await {
        Ok((_, c)) => c,
        Err(e) => {
            for l in links {
                mark_err(&app.db, l.project_id, &l.path, &e.message).await;
            }
            return None;
        }
    };
    for l in links {
        // file gone: nothing to keep current (looked up on disk, so a 304 never loads a project)
        let file = app.project_dir(l.project_id).join("repo").join(&l.path);
        if tokio::fs::symlink_metadata(file).await.is_err() {
            continue;
        }
        let pid = l.project_id;
        let link = Import {
            account_id,
            library: l.library,
            collection: l.collection,
            path: l.path,
            format: l.format,
        };
        let res = fetch_and_write(app, pid, l.user_id, &mut client, &link, l.library_version).await;
        match res {
            Ok(Some((_, version))) => mark_ok(&app.db, pid, &link.path, version, true).await,
            Ok(None) => mark_ok(&app.db, pid, &link.path, None, false).await,
            Err(e) => {
                tracing::warn!("zotero sync {pid}:{}: {}", link.path, e.message);
                mark_err(&app.db, pid, &link.path, &e.message).await;
            }
        }
        // asked to pause for longer than we wait: the account's other links would fail too
        if client
            .not_before
            .is_some_and(|t| t > Instant::now() + MAX_WAIT)
        {
            break;
        }
    }
    client.not_before.filter(|t| *t > Instant::now())
}

/// The file at `path` was deleted: its link goes with it.
pub async fn file_deleted(db: &sqlx::SqlitePool, pid: i64, path: &str) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM zotero_links WHERE project_id = ? AND path = ?")
        .bind(pid)
        .bind(path)
        .execute(db)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// `from` (file or directory) was moved to `to`: links of the files below it follow.
pub async fn path_moved(
    db: &sqlx::SqlitePool,
    pid: i64,
    from: &str,
    to: &str,
) -> Result<(), ApiError> {
    // `substr` instead of LIKE: file names may contain `%` and `_`
    sqlx::query(
        // OR REPLACE: an orphaned link at the target path must not fail the move
        "UPDATE OR REPLACE zotero_links SET path = ?3 || substr(path, length(?2) + 1)
         WHERE project_id = ?1 AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')",
    )
    .bind(pid)
    .bind(from)
    .bind(to)
    .execute(db)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_ids_are_strict() {
        assert_eq!(lib_path("user:123").unwrap(), "/users/123");
        assert_eq!(lib_path("group:4").unwrap(), "/groups/4");
        for bad in [
            "user:",
            "user:1a",
            "group:-1",
            "users:1",
            "user:1/../x",
            "1",
            "",
        ] {
            assert!(lib_path(bad).is_err(), "{bad}");
        }
        assert!(check_collection("ABCD1234").is_ok());
        assert!(check_collection("AB/CD").is_err() && check_collection("").is_err());
    }
}
