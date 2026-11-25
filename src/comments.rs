//! Comment threads on text ranges (docs/API.md → Comments, #53), stored in SQLite, never in git.
//!
//! Offsets in the API and the DB are UTF-16 code units (like `Y.Text` and CodeMirror); the
//! server's yrs docs count UTF-8 bytes, so they are converted here. While a doc is open its room
//! holds a `StickyIndex` pair per thread, so ranges follow every edit (also the diff-replace
//! after `git pull`); `persist` writes them back on each flush. Opening a doc re-anchors its
//! threads against the text (`reanchor`).

use std::{collections::HashMap, io::Read, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use yrs::{Assoc, GetString, IndexedSequence, StickyIndex, TextRef, Transaction};

use crate::{
    docs::{Room, MAX_DOC_BYTES},
    error::ApiError,
    events::Event,
    projects::{Access, Project, Role},
    workspace::Workspace,
    AppState,
};

/// Start (`Assoc::After`) and end (`Assoc::Before`): text typed at either edge stays outside.
pub type Anchor = (StickyIndex, StickyIndex);

const MAX_BODY: usize = 10_000;
const MAX_QUOTE: usize = 1000;

#[derive(Serialize, sqlx::FromRow)]
pub struct Thread {
    id: i64,
    path: String,
    #[sqlx(rename = "start_pos")]
    start: u32,
    #[sqlx(rename = "end_pos")]
    end: u32,
    quote: String,
    detached: bool,
    resolved: bool,
    resolved_by: Option<String>,
    created_by: Option<String>,
    created_at: String,
    #[sqlx(skip)]
    messages: Vec<Msg>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Msg {
    id: i64,
    #[serde(skip)]
    thread_id: i64,
    author: Option<String>,
    display_name: Option<String>,
    body: String,
    created_at: String,
    edited_at: Option<String>,
}

const THREADS: &str =
    "SELECT t.id, t.path, t.start_pos, t.end_pos, t.quote, t.detached, t.resolved,
        r.username AS resolved_by, c.username AS created_by,
        strftime('%Y-%m-%dT%H:%M:%SZ', t.created_at) AS created_at
     FROM comment_threads t
     LEFT JOIN users r ON r.id = t.resolved_by LEFT JOIN users c ON c.id = t.created_by
     WHERE t.project_id = ?1 AND (?2 IS NULL OR t.path = ?2) AND (?3 IS NULL OR t.id = ?3)";

const MESSAGES: &str = "SELECT m.id, m.thread_id, u.username AS author, u.display_name, m.body,
        strftime('%Y-%m-%dT%H:%M:%SZ', m.created_at) AS created_at,
        strftime('%Y-%m-%dT%H:%M:%SZ', m.edited_at) AS edited_at
     FROM comment_messages m JOIN comment_threads t ON t.id = m.thread_id
     LEFT JOIN users u ON u.id = m.author
     WHERE t.project_id = ?1 AND (?2 IS NULL OR t.path = ?2) AND (?3 IS NULL OR t.id = ?3)
       AND (?4 IS NULL OR m.id = ?4)
     ORDER BY m.id";

/// Byte offset of UTF-16 offset `u` in `s`; `None` past the end or inside a surrogate pair.
fn byte_of(s: &str, u: u32) -> Option<usize> {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        if n == u {
            return Some(i);
        }
        n += c.len_utf16() as u32;
        if n > u {
            return None;
        }
    }
    (n == u).then_some(s.len())
}

/// UTF-16 offset of byte offset `b` in `s`.
// ponytail: O(len) per call, fine for papers; keep a line index if docs/threads get huge
fn utf16_of(s: &str, b: usize) -> u32 {
    s.char_indices()
        .take_while(|(i, _)| *i < b)
        .map(|(_, c)| c.len_utf16() as u32)
        .sum()
}

/// `s[start..end]` in UTF-16 offsets, if `start < end` lie within `s`.
pub(crate) fn slice16(s: &str, start: u32, end: u32) -> Option<&str> {
    (start < end).then_some(())?;
    s.get(byte_of(s, start)?..byte_of(s, end)?)
}

/// Where a range stored as `start..end` with `quote` lies in `s` now (UTF-16), `None` = gone:
/// unchanged if `quote` is still at `start`, else the nearest occurrence of `quote`.
fn reanchor(s: &str, start: u32, end: u32, quote: &str) -> Option<(u32, u32)> {
    if quote.is_empty() || end <= start {
        return None;
    }
    let total = utf16_of(s, s.len());
    let at = byte_of(s, start);
    if at.is_some_and(|b| s[b..].starts_with(quote)) {
        return Some((start, end.min(total)));
    }
    // ponytail: exact matches only; fuzzy matching (diff-match-patch) if quotes drift too often
    let target = at.unwrap_or(s.len());
    let best = (s.match_indices(quote))
        .map(|(i, _)| i)
        .min_by_key(|i| i.abs_diff(target))?;
    let new = utf16_of(s, best);
    Some((new, (new + end - start).min(total)))
}

fn sticky(txn: &Transaction, text: &TextRef, s: &str, start: u32, end: u32) -> Option<Anchor> {
    let (a, b) = (byte_of(s, start)? as u32, byte_of(s, end)? as u32);
    Some((
        text.sticky_index(txn, a, Assoc::After)?,
        text.sticky_index(txn, b, Assoc::Before)?,
    ))
}

/// Current UTF-16 range of `anchor`; a range whose text is gone collapses to `(start, start)`.
fn resolve(txn: &Transaction, s: &str, anchor: &Anchor) -> Option<(u32, u32)> {
    let a = utf16_of(s, anchor.0.get_offset(txn)?.index as usize);
    let b = utf16_of(s, anchor.1.get_offset(txn)?.index as usize);
    Some((a, b.max(a)))
}

/// Live ranges of every anchored thread of `room`.
fn live(room: &Room) -> HashMap<i64, (u32, u32)> {
    room.read(|txn, text| {
        let s = text.get_string(txn);
        let anchors = room.comments.lock().unwrap();
        (anchors.iter())
            .filter_map(|(id, a)| Some((*id, resolve(txn, &s, a)?)))
            .collect()
    })
}

fn changed(p: &Project, path: &str) {
    let _ = p.events.send(Event::Comments { path: path.into() });
}

/// Doc just loaded: anchors its threads, re-anchoring them against the current text.
pub async fn attach(p: &Project, room: &Room) {
    if let Err(e) = try_attach(p, room).await {
        tracing::warn!("{}: anchoring comments failed: {e}", room.path());
    }
}

async fn try_attach(p: &Project, room: &Room) -> Result<(), sqlx::Error> {
    let rows: Vec<(i64, u32, u32, String)> = sqlx::query_as(
        "SELECT id, start_pos, end_pos, quote FROM comment_threads
         WHERE project_id = ? AND path = ? AND NOT detached",
    )
    .bind(p.id)
    .bind(room.path())
    .fetch_all(&p.db)
    .await?;
    let moved: Vec<_> = room.read(|txn, text| {
        let s = text.get_string(txn);
        let mut anchors = room.comments.lock().unwrap();
        (rows.into_iter())
            .filter_map(|(id, start, end, quote)| {
                if anchors.contains_key(&id) {
                    return None;
                }
                let pos = reanchor(&s, start, end, &quote)
                    .and_then(|(a, b)| Some(((a, b), sticky(txn, text, &s, a, b)?)));
                let pos = pos.map(|(pos, anchor)| {
                    anchors.insert(id, anchor);
                    pos
                });
                (pos != Some((start, end))).then_some((id, pos))
            })
            .collect()
    });
    for (id, pos) in &moved {
        let (start, end) = pos.unwrap_or_default();
        sqlx::query(
            "UPDATE comment_threads SET detached = ?2,
                start_pos = CASE WHEN ?2 THEN start_pos ELSE ?3 END,
                end_pos = CASE WHEN ?2 THEN end_pos ELSE ?4 END
             WHERE id = ?1",
        )
        .bind(id)
        .bind(pos.is_none())
        .bind(start)
        .bind(end)
        .execute(&p.db)
        .await?;
    }
    if !moved.is_empty() {
        changed(p, room.path());
    }
    Ok(())
}

/// Doc flushed: stores the live ranges; threads whose text is gone become detached.
pub async fn persist(p: &Project, room: &Room) {
    let live = live(room);
    if live.is_empty() {
        return;
    }
    let mut detached = false;
    let res: Result<(), sqlx::Error> = async {
        let mut tx = p.db.begin().await?;
        for (id, (start, end)) in &live {
            sqlx::query(
                "UPDATE comment_threads SET start_pos = ?, end_pos = ?, detached = ? WHERE id = ?",
            )
            .bind(start)
            .bind(end)
            .bind(start == end)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }
    .await;
    if let Err(e) = res {
        return tracing::warn!("{}: storing comment anchors failed: {e}", room.path());
    }
    let mut anchors = room.comments.lock().unwrap();
    for (id, (start, end)) in live {
        if start == end {
            detached |= anchors.remove(&id).is_some();
        }
    }
    drop(anchors);
    if detached {
        changed(p, room.path());
    }
}

/// `from` (file or directory) was moved to `to`: its threads follow.
pub async fn path_moved(p: &Project, from: &str, to: &str) -> Result<(), ApiError> {
    // `substr` instead of LIKE: file names may contain `%` and `_`
    let paths: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT path FROM comment_threads
         WHERE project_id = ?1 AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')",
    )
    .bind(p.id)
    .bind(from)
    .fetch_all(&p.db)
    .await
    .map_err(ApiError::internal)?;
    if paths.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "UPDATE comment_threads SET path = ?3 || substr(path, length(?2) + 1)
         WHERE project_id = ?1 AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')",
    )
    .bind(p.id)
    .bind(from)
    .bind(to)
    .execute(&p.db)
    .await
    .map_err(ApiError::internal)?;
    for (old,) in paths {
        changed(p, &format!("{to}{}", &old[from.len()..]));
    }
    Ok(())
}

/// File deleted through the API: its threads go with it.
pub async fn file_deleted(p: &Project, path: &str) -> Result<(), ApiError> {
    let n = sqlx::query("DELETE FROM comment_threads WHERE project_id = ? AND path = ?")
        .bind(p.id)
        .bind(path)
        .execute(&p.db)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    if n > 0 {
        changed(p, path);
    }
    Ok(())
}

/// Threads of the project (or of one `path` / one `id`), with live offsets of open docs.
async fn threads(
    p: &Project,
    path: Option<&str>,
    id: Option<i64>,
) -> Result<Vec<Thread>, ApiError> {
    let mut threads: Vec<Thread> = sqlx::query_as(THREADS)
        .bind(p.id)
        .bind(path)
        .bind(id)
        .fetch_all(&p.db)
        .await
        .map_err(ApiError::internal)?;
    let msgs: Vec<Msg> = sqlx::query_as(MESSAGES)
        .bind(p.id)
        .bind(path)
        .bind(id)
        .bind(None::<i64>)
        .fetch_all(&p.db)
        .await
        .map_err(ApiError::internal)?;
    let mut by_thread: HashMap<i64, Vec<Msg>> = HashMap::new();
    for m in msgs {
        by_thread.entry(m.thread_id).or_default().push(m);
    }
    let mut rooms: HashMap<String, HashMap<i64, (u32, u32)>> = HashMap::new();
    for t in &mut threads {
        t.messages = by_thread.remove(&t.id).unwrap_or_default();
        let live = (rooms.entry(t.path.clone()))
            .or_insert_with(|| p.docs.get(&t.path).map(|r| live(&r)).unwrap_or_default());
        if let Some(&(start, end)) = live.get(&t.id) {
            (t.start, t.end) = (start, end);
            t.detached |= start == end;
        }
    }
    threads.sort_by(|a, b| (&a.path, a.start, a.id).cmp(&(&b.path, b.start, b.id)));
    Ok(threads)
}

async fn thread(p: &Project, id: i64) -> Result<Thread, ApiError> {
    (threads(p, None, Some(id)).await?.pop()).ok_or_else(|| ApiError::not_found("no such thread"))
}

async fn message(p: &Project, id: i64, mid: i64) -> Result<Msg, ApiError> {
    let msg: Option<Msg> = sqlx::query_as(MESSAGES)
        .bind(p.id)
        .bind(None::<String>)
        .bind(id)
        .bind(mid)
        .fetch_optional(&p.db)
        .await
        .map_err(ApiError::internal)?;
    msg.ok_or_else(|| ApiError::not_found("no such message"))
}

fn body(body: &str) -> Result<&str, ApiError> {
    let body = body.trim();
    if body.is_empty() || body.chars().count() > MAX_BODY {
        return Err(ApiError::bad_request(format!(
            "body must have 1 to {MAX_BODY} characters"
        )));
    }
    Ok(body)
}

fn forbidden(msg: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "forbidden", msg)
}

#[derive(Deserialize)]
pub struct ListQuery {
    path: Option<String>,
}

pub async fn list(
    State(app): State<Arc<AppState>>,
    access: Access,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<Thread>>, ApiError> {
    let p = app.runtime(access.info.id).await?;
    threads(&p, q.path.as_deref(), None).await.map(Json)
}

#[derive(Deserialize)]
pub struct NewThread {
    path: String,
    start: u32,
    end: u32,
    body: String,
}

/// The file's text from disk (for files not open in the editor).
pub(crate) fn disk_text(p: &Project, path: &str) -> Result<String, ApiError> {
    let file = p.workspace.open_file(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ApiError::not_found(format!("{path} not found")),
        _ => ApiError::bad_request(format!("{path} is not a file")),
    })?;
    let mut bytes = Vec::new();
    (file.take(MAX_DOC_BYTES as u64 + 1))
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::bad_request(format!("{path} is not a file")))?;
    if bytes.len() > MAX_DOC_BYTES {
        return Err(ApiError::too_large(format!("{path} is too large")));
    }
    // like `Room::load`: NUL bytes mean binary, the editor won't open it either
    if bytes.contains(&0) {
        return Err(ApiError::bad_request(format!("{path} is not text")));
    }
    String::from_utf8(bytes).map_err(|_| ApiError::bad_request(format!("{path} is not text")))
}

pub async fn create(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<NewThread>,
) -> Result<(StatusCode, Json<Thread>), ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let msg = body(&b.body)?;
    p.workspace.resolve(&b.path)?;
    if Workspace::in_uninitialized(&p.workspace.repos().await, &b.path) {
        return Err(ApiError::invalid_path(&b.path));
    }
    let bad = || ApiError::bad_request("need start < end within the document (UTF-16 offsets)");
    // open doc: quote and anchor from the same state of the text
    let room = p.docs.get(&b.path);
    let (quote, anchor) = match &room {
        Some(room) => room.read(|txn, text| {
            let s = text.get_string(txn);
            let quote = slice16(&s, b.start, b.end).ok_or_else(bad)?;
            Ok::<_, ApiError>((quote.to_owned(), sticky(txn, text, &s, b.start, b.end)))
        })?,
        None => {
            let s = disk_text(&p, &b.path)?;
            (
                slice16(&s, b.start, b.end).ok_or_else(bad)?.to_owned(),
                None,
            )
        }
    };
    let quote: String = quote.chars().take(MAX_QUOTE).collect();
    let mut tx = p.db.begin().await.map_err(ApiError::internal)?;
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO comment_threads (project_id, path, start_pos, end_pos, quote, created_by)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(p.id)
    .bind(&b.path)
    .bind(b.start)
    .bind(b.end)
    .bind(&quote)
    .bind(access.user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO comment_messages (thread_id, author, body) VALUES (?, ?, ?)")
        .bind(id)
        .bind(access.user.id)
        .bind(msg)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    // a concurrent delete may have removed the file (and its threads) between our read and the
    // insert: then this thread must go too. A delete after this check removes it itself.
    if matches!(p.workspace.open_file(&b.path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        sqlx::query("DELETE FROM comment_threads WHERE id = ?")
            .bind(id)
            .execute(&p.db)
            .await
            .map_err(ApiError::internal)?;
        return Err(ApiError::not_found(format!("{} not found", b.path)));
    }
    // the doc may have been loaded or reloaded meanwhile: then anchor like on load
    match (p.docs.get(&b.path), room, anchor) {
        (Some(now), Some(room), Some(anchor)) if Arc::ptr_eq(&now, &room) => {
            room.comments.lock().unwrap().insert(id, anchor);
        }
        (Some(now), ..) => attach(&p, &now).await,
        _ => {}
    }
    changed(&p, &b.path);
    Ok((StatusCode::CREATED, Json(thread(&p, id).await?)))
}

#[derive(Deserialize)]
pub struct Body {
    body: String,
}

pub async fn reply(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, id)): Path<(String, i64)>,
    Json(b): Json<Body>,
) -> Result<(StatusCode, Json<Msg>), ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let msg = body(&b.body)?;
    let t = thread(&p, id).await?;
    let (mid,): (i64,) = sqlx::query_as(
        "INSERT INTO comment_messages (thread_id, author, body) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(id)
    .bind(access.user.id)
    .bind(msg)
    .fetch_one(&p.db)
    .await
    .map_err(ApiError::internal)?;
    changed(&p, &t.path);
    Ok((StatusCode::CREATED, Json(message(&p, id, mid).await?)))
}

#[derive(Deserialize)]
pub struct Resolve {
    resolved: bool,
}

/// Resolve / reopen: commenter or higher.
pub async fn patch(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, id)): Path<(String, i64)>,
    Json(b): Json<Resolve>,
) -> Result<Json<Thread>, ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let t = thread(&p, id).await?;
    sqlx::query("UPDATE comment_threads SET resolved = ?1, resolved_by = CASE WHEN ?1 THEN ?2 END WHERE id = ?3")
        .bind(b.resolved)
        .bind(access.user.id)
        .bind(id)
        .execute(&p.db)
        .await
        .map_err(ApiError::internal)?;
    changed(&p, &t.path);
    Ok(Json(thread(&p, id).await?))
}

/// Thread creator, a project owner or an admin.
pub async fn delete(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, id)): Path<(String, i64)>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let t = thread(&p, id).await?;
    if access.info.my_role < Role::Owner && t.created_by.as_deref() != Some(&access.user.username) {
        return Err(forbidden(
            "only the thread's creator, an owner or an admin may delete it",
        ));
    }
    delete_thread(&p, &t).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_thread(p: &Project, t: &Thread) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM comment_threads WHERE id = ?")
        .bind(t.id)
        .execute(&p.db)
        .await
        .map_err(ApiError::internal)?;
    if let Some(room) = p.docs.get(&t.path) {
        room.comments.lock().unwrap().remove(&t.id);
    }
    changed(p, &t.path);
    Ok(())
}

/// The message `mid` of thread `id`, if the caller wrote it; else 404 / 403.
async fn own_message(p: &Project, access: &Access, id: i64, mid: i64) -> Result<Thread, ApiError> {
    let m = message(p, id, mid).await?;
    if m.author.as_deref() != Some(&access.user.username) {
        return Err(forbidden("only the author may change a message"));
    }
    thread(p, id).await
}

pub async fn edit_message(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, id, mid)): Path<(String, i64, i64)>,
    Json(b): Json<Body>,
) -> Result<Json<Msg>, ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let msg = body(&b.body)?;
    let t = own_message(&p, &access, id, mid).await?;
    sqlx::query("UPDATE comment_messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(msg)
        .bind(mid)
        .execute(&p.db)
        .await
        .map_err(ApiError::internal)?;
    changed(&p, &t.path);
    Ok(Json(message(&p, id, mid).await?))
}

/// Author only; deleting the first message deletes the thread.
pub async fn delete_message(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, id, mid)): Path<(String, i64, i64)>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let t = own_message(&p, &access, id, mid).await?;
    if t.messages.first().is_some_and(|m| m.id == mid) {
        delete_thread(&p, &t).await?;
    } else {
        sqlx::query("DELETE FROM comment_messages WHERE id = ?")
            .bind(mid)
            .execute(&p.db)
            .await
            .map_err(ApiError::internal)?;
        changed(&p, &t.path);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Text, Transact};

    #[test]
    fn utf16_offsets() {
        let s = "a😀b";
        assert_eq!(byte_of(s, 1), Some(1));
        assert_eq!(byte_of(s, 2), None, "inside the surrogate pair");
        assert_eq!(byte_of(s, 3), Some(5));
        assert_eq!(byte_of(s, 4), Some(6));
        assert_eq!(byte_of(s, 5), None);
        assert_eq!(utf16_of(s, 5), 3);
        assert_eq!(slice16(s, 3, 4), Some("b"));
        assert_eq!(slice16(s, 1, 3), Some("😀"));
        assert_eq!(slice16(s, 3, 3), None);
        assert_eq!(slice16(s, 2, 4), None);
    }

    #[test]
    fn reanchor_rules() {
        // quote still at start: unchanged
        assert_eq!(reanchor("x target y", 2, 8, "target"), Some((2, 8)));
        // moved: nearest occurrence (UTF-16 offsets, emoji before it)
        assert_eq!(
            reanchor("target 😀 xx target", 9, 15, "target"),
            Some((13, 19))
        );
        assert_eq!(
            reanchor("xx target yy target", 0, 6, "target"),
            Some((3, 9))
        );
        // gone, or collapsed
        assert_eq!(reanchor("nothing here", 2, 8, "target"), None);
        assert_eq!(reanchor("target", 2, 2, "target"), None);
    }

    #[test]
    fn anchors_follow_edits() {
        let doc = yrs::Doc::new();
        let text = doc.get_or_insert_text("content");
        text.insert(&mut doc.transact_mut(), 0, "a😀b🎉c");
        // "b🎉" = UTF-16 3..6, ending in a non-BMP char
        let anchor = {
            let txn = doc.transact();
            sticky(&txn, &text, &text.get_string(&txn), 3, 6).unwrap()
        };
        let range = || {
            let txn = doc.transact();
            resolve(&txn, &text.get_string(&txn), &anchor).unwrap()
        };
        assert_eq!(range(), (3, 6));
        text.insert(&mut doc.transact_mut(), 0, "xx"); // before
        assert_eq!(range(), (5, 8));
        text.insert(&mut doc.transact_mut(), 12, "!"); // right at the end: outside
        text.insert(&mut doc.transact_mut(), 7, "?"); // right at the start: outside
        assert_eq!(text.get_string(&doc.transact()), "xxa😀?b🎉!c");
        assert_eq!(range(), (6, 9));
        text.remove_range(&mut doc.transact_mut(), 8, 5); // "b🎉" gone
        let (start, end) = range();
        assert_eq!(start, end, "collapsed");
    }
}
