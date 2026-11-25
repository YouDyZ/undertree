//! `/api/admin/users`: user management for admins, mirrors the admin CLI (docs/API.md → Admin).

use std::sync::Arc;

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{AuthSession, User},
    error::ApiError,
    projects::nullable,
    AppState,
};

/// Route layer (inside `require_login`): 403 unless the caller is an admin.
pub async fn require_admin(auth: AuthSession, req: Request, next: Next) -> Response {
    match auth.user().await {
        Some(u) if u.is_admin => next.run(req).await,
        _ => ApiError::new(StatusCode::FORBIDDEN, "forbidden", "admins only").into_response(),
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AdminUser {
    id: i64,
    username: String,
    display_name: String,
    email: Option<String>,
    github: Option<String>,
    is_admin: bool,
    commit_email: Option<String>,
    created_at: String,
}

macro_rules! select_admin_user {
    ($tail:literal) => {
        concat!(
            "SELECT id, username, display_name, email, github_login AS github, is_admin, commit_email,
                    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at
             FROM users ",
            $tail
        )
    };
}

/// Unique constraint (username/email/github) → 409, anything else → 500.
fn db_error(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .is_some_and(|d| d.is_unique_violation())
    {
        ApiError::conflict("username, email or github login already in use")
    } else {
        ApiError::internal(e)
    }
}

async fn me(auth: &AuthSession) -> Result<User, ApiError> {
    auth.user().await.ok_or_else(ApiError::unauthorized)
}

async fn find(app: &AppState, id: i64) -> Result<AdminUser, ApiError> {
    sqlx::query_as(select_admin_user!("WHERE id = ?"))
        .bind(id)
        .fetch_optional(&app.db)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("no such user"))
}

pub async fn list(State(app): State<Arc<AppState>>) -> Result<Json<Vec<AdminUser>>, ApiError> {
    sqlx::query_as(select_admin_user!("ORDER BY username"))
        .fetch_all(&app.db)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

#[derive(Deserialize)]
pub struct NewUser {
    username: String,
    display_name: Option<String>,
    email: Option<String>,
    github: Option<String>,
    #[serde(default)]
    is_admin: bool,
}

pub async fn create(
    State(app): State<Arc<AppState>>,
    Json(b): Json<NewUser>,
) -> Result<(StatusCode, Json<AdminUser>), ApiError> {
    let username = b.username.trim();
    if username.is_empty() {
        return Err(ApiError::bad_request("username is empty"));
    }
    if b.email.is_none() && b.github.is_none() {
        return Err(ApiError::bad_request(
            "user needs an email (Google) and/or github login to log in",
        ));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO users (username, display_name, email, github_login, is_admin)
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(username)
    .bind(b.display_name.as_deref().unwrap_or(username))
    .bind(b.email)
    .bind(b.github)
    .bind(b.is_admin)
    .fetch_one(&app.db)
    .await
    .map_err(db_error)?;
    Ok((StatusCode::CREATED, Json(find(&app, id).await?)))
}

#[derive(Deserialize)]
pub struct PatchUser {
    display_name: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    email: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    github: Option<Option<String>>,
    is_admin: Option<bool>,
    #[serde(default, deserialize_with = "nullable")]
    commit_email: Option<Option<String>>,
}

pub async fn patch(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<i64>,
    Json(b): Json<PatchUser>,
) -> Result<Json<AdminUser>, ApiError> {
    if me(&auth).await?.id == id && b.is_admin == Some(false) {
        return Err(ApiError::conflict("you cannot remove your own admin flag"));
    }
    find(&app, id).await?;
    let commit_email = b.commit_email.map(crate::auth::commit_email).transpose()?;
    let mut tx = app.db.begin().await.map_err(ApiError::internal)?;
    if let Some(email) = commit_email {
        sqlx::query("UPDATE users SET commit_email = ? WHERE id = ?")
            .bind(email)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    if let Some(name) = b.display_name {
        sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
            .bind(name)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(email) = b.email {
        sqlx::query("UPDATE users SET email = ? WHERE id = ?")
            .bind(email)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    if let Some(github) = b.github {
        // a different login must not keep the old GitHub account (linked by numeric id) working
        sqlx::query(
            "UPDATE users SET github_id = iif(github_login IS ?1, github_id, NULL), github_login = ?1
             WHERE id = ?2",
        )
        .bind(github)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    }
    if let Some(is_admin) = b.is_admin {
        sqlx::query("UPDATE users SET is_admin = ? WHERE id = ?")
            .bind(is_admin)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(find(&app, id).await?))
}

/// Like `undertree user remove`: deleting the row ends the user's sessions (`get_user` → None).
/// Projects where they are the last owner go to the deleting admin.
pub async fn delete(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let admin = me(&auth).await?;
    if admin.id == id {
        return Err(ApiError::conflict("you cannot delete yourself"));
    }
    let user = find(&app, id).await?;
    let mut tx = app.db.begin().await.map_err(ApiError::internal)?;
    let projects: Vec<i64> =
        sqlx::query_scalar("SELECT project_id FROM project_members WHERE user_id = ?")
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    for sql in [
        // the admin becomes owner where the user is the last one (also if already a member)
        "INSERT INTO project_members (project_id, user_id, role)
           SELECT m.project_id, ?2, 'owner' FROM project_members m
           WHERE m.user_id = ?1 AND m.role = 'owner'
             AND NOT EXISTS (SELECT 1 FROM project_members o WHERE o.project_id = m.project_id
                               AND o.role = 'owner' AND o.user_id != ?1)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'",
        // `owner_id` (creator) must point to an existing user
        "UPDATE projects SET owner_id = ?2 WHERE owner_id = ?1",
    ] {
        sqlx::query(sql)
            .bind(id)
            .bind(admin.id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    // memberships go with ON DELETE CASCADE
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    // close their open doc sockets (4403), like a role change
    let running = app.projects.lock().unwrap();
    for p in projects.iter().filter_map(|pid| running.get(pid)) {
        let _ = p.member_changed.send(user.username.clone());
    }
    Ok(StatusCode::NO_CONTENT)
}
