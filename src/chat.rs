//! Project chat (docs/API.md → Chat, #61): messages in SQLite, never in git; every change is
//! broadcast as `chat` event on the project's events socket.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::ApiError,
    events::Event,
    projects::{Access, Project, Role},
    AppState,
};

const MAX_BODY: usize = 4000;
const PAGE: i64 = 50;
const MAX_PAGE: i64 = 100;
const PER_MINUTE: u32 = 30;

/// Messages per user and minute (fixed window), in memory.
// ponytail: fixed window, a burst of 2x at the boundary is fine for a chat
#[derive(Default)]
pub struct RateLimit(Mutex<HashMap<i64, (Instant, u32)>>);

impl RateLimit {
    fn admit(&self, user: i64) -> Result<(), ApiError> {
        let mut users = self.0.lock().unwrap();
        let (window, count) = users.entry(user).or_insert((Instant::now(), 0));
        if window.elapsed() >= Duration::from_secs(60) {
            (*window, *count) = (Instant::now(), 0);
        }
        *count += 1;
        if *count > PER_MINUTE {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "too many chat messages, try again shortly",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ChatMessage {
    id: i64,
    author: Option<String>,
    display_name: Option<String>,
    body: String,
    file: Option<String>,
    line: Option<u32>,
    created_at: String,
    edited_at: Option<String>,
    deleted: bool,
    #[sqlx(skip)]
    mentions: Vec<String>,
}

const SELECT: &str = "SELECT m.id, u.username AS author, u.display_name, m.body, m.file, m.line,
        strftime('%Y-%m-%dT%H:%M:%SZ', m.created_at) AS created_at,
        strftime('%Y-%m-%dT%H:%M:%SZ', m.edited_at) AS edited_at, m.deleted
     FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
     WHERE m.project_id = ?1 AND (?2 IS NULL OR m.id < ?2) AND (?3 IS NULL OR m.id = ?3)
     ORDER BY m.id DESC LIMIT ?4";

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Members mentioned in `body` as `@username` (longest match, case-insensitive, not inside a
/// word), canonical spelling, in order of appearance without duplicates.
pub(crate) fn mentions(body: &str, members: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut prev = None::<char>;
    for (i, c) in body.char_indices() {
        if c == '@' && !prev.is_some_and(is_name_char) {
            let rest = &body[i + 1..];
            let hit = (members.iter())
                .filter(|m| {
                    let head = rest.get(..m.len());
                    head.is_some_and(|h| h.eq_ignore_ascii_case(m))
                        && !rest[m.len()..].chars().next().is_some_and(is_name_char)
                })
                .max_by_key(|m| m.len());
            if let Some(m) = hit.filter(|m| !found.contains(m)) {
                found.push(m.clone());
            }
        }
        prev = Some(c);
    }
    found
}

async fn members(p: &Project) -> Result<Vec<String>, ApiError> {
    sqlx::query_scalar(
        "SELECT u.username FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ?",
    )
    .bind(p.id)
    .fetch_all(&p.db)
    .await
    .map_err(ApiError::internal)
}

/// Newest `limit` messages below `before` / the message `only`, oldest first.
async fn fetch(
    p: &Project,
    before: Option<i64>,
    only: Option<i64>,
    limit: i64,
) -> Result<Vec<ChatMessage>, ApiError> {
    let mut msgs: Vec<ChatMessage> = sqlx::query_as(SELECT)
        .bind(p.id)
        .bind(before)
        .bind(only)
        .bind(limit)
        .fetch_all(&p.db)
        .await
        .map_err(ApiError::internal)?;
    let names = members(p).await?;
    for m in &mut msgs {
        m.mentions = mentions(&m.body, &names);
    }
    msgs.reverse();
    Ok(msgs)
}

async fn one(p: &Project, id: i64) -> Result<ChatMessage, ApiError> {
    (fetch(p, None, Some(id), 1).await?.pop()).ok_or_else(|| ApiError::not_found("no such message"))
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

fn broadcast(p: &Project, message: &ChatMessage) {
    let _ = p.events.send(Event::Chat {
        message: message.clone(),
    });
}

#[derive(Deserialize)]
pub struct ListQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

/// Up to `limit` (default 50, max 100) messages older than `before`, oldest first.
pub async fn list(
    State(app): State<Arc<AppState>>,
    access: Access,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<ChatMessage>>, ApiError> {
    let p = app.runtime(access.info.id).await?;
    let limit = q.limit.unwrap_or(PAGE).clamp(1, MAX_PAGE);
    fetch(&p, q.before, None, limit).await.map(Json)
}

#[derive(Deserialize)]
pub struct NewMessage {
    body: String,
    file: Option<String>,
    line: Option<u32>,
}

pub async fn create(
    State(app): State<Arc<AppState>>,
    access: Access,
    Json(b): Json<NewMessage>,
) -> Result<(StatusCode, Json<ChatMessage>), ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let text = body(&b.body)?;
    if let Some(file) = &b.file {
        p.workspace.resolve(file)?;
    }
    if b.line == Some(0) || (b.line.is_some() && b.file.is_none()) {
        return Err(ApiError::bad_request("line needs a file and starts at 1"));
    }
    p.chat_rate.admit(access.user.id)?;
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO chat_messages (project_id, author_id, body, file, line)
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(p.id)
    .bind(access.user.id)
    .bind(text)
    .bind(&b.file)
    .bind(b.line)
    .fetch_one(&p.db)
    .await
    .map_err(ApiError::internal)?;
    let m = one(&p, id).await?;
    broadcast(&p, &m);
    Ok((StatusCode::CREATED, Json(m)))
}

/// The live message `id`, if the caller wrote it; else 404 / 403.
async fn own(p: &Project, access: &Access, id: i64) -> Result<ChatMessage, ApiError> {
    let m = one(p, id).await?;
    if m.deleted {
        return Err(ApiError::not_found("no such message"));
    }
    if m.author.as_deref() != Some(&access.user.username) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only the author may change a message",
        ));
    }
    Ok(m)
}

#[derive(Deserialize)]
pub struct Edit {
    body: String,
}

pub async fn edit(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, id)): Path<(String, i64)>,
    Json(b): Json<Edit>,
) -> Result<Json<ChatMessage>, ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    let text = body(&b.body)?;
    own(&p, &access, id).await?;
    // `deleted = 0`: a concurrent delete (second tab) must not get a body back
    let n = sqlx::query(
        "UPDATE chat_messages SET body = ?, edited_at = CURRENT_TIMESTAMP
         WHERE id = ? AND deleted = 0",
    )
    .bind(text)
    .bind(id)
    .execute(&p.db)
    .await
    .map_err(ApiError::internal)?
    .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found("no such message"));
    }
    let m = one(&p, id).await?;
    broadcast(&p, &m);
    Ok(Json(m))
}

/// Soft delete: the row stays, body, file and line are wiped.
pub async fn delete(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, id)): Path<(String, i64)>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Commenter)?;
    let p = app.runtime(access.info.id).await?;
    own(&p, &access, id).await?;
    sqlx::query(
        "UPDATE chat_messages SET deleted = 1, body = '', file = NULL, line = NULL WHERE id = ?",
    )
    .bind(id)
    .execute(&p.db)
    .await
    .map_err(ApiError::internal)?;
    broadcast(&p, &one(&p, id).await?);
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_shape() {
        let message = ChatMessage {
            id: 3,
            author: Some("bob".into()),
            display_name: Some("Bob".into()),
            body: "hi".into(),
            file: None,
            line: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            edited_at: None,
            deleted: false,
            mentions: vec![],
        };
        assert_eq!(
            serde_json::to_value(Event::Chat { message }).unwrap(),
            serde_json::json!({ "type": "chat", "message": {
                "id": 3, "author": "bob", "display_name": "Bob", "body": "hi", "file": null,
                "line": null, "created_at": "2026-01-01T00:00:00Z", "edited_at": null,
                "deleted": false, "mentions": []
            }})
        );
    }

    #[test]
    fn mention_parsing() {
        let m = |s: &str| {
            let names = ["bob", "bob-x", "Al", "ä1"].map(String::from);
            mentions(s, &names)
        };
        assert_eq!(m("hi @bob, see @al."), ["bob", "Al"]);
        assert_eq!(m("@bob @bob"), ["bob"], "no duplicates");
        assert_eq!(m("@bob-x!"), ["bob-x"], "longest match");
        assert_eq!(
            m("@bobby"),
            Vec::<String>::new(),
            "no prefix of a longer word"
        );
        assert_eq!(m("mail@bob.de"), Vec::<String>::new(), "inside a word");
        assert_eq!(m("@nobody @ä1"), ["ä1"], "only members, unicode ok");
        assert_eq!(m("@Bob"), ["bob"], "case-insensitive, canonical spelling");
    }
}
