//! Users, sessions and the `/api/auth/*` handlers (docs/API.md → Auth). Login is OAuth-only.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use axum_login::{AuthUser, AuthnBackend, UserId};
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};

use crate::{error::ApiError, AppState};

pub type AuthSession = axum_login::AuthSession<Backend>;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub email: Option<String>,
    pub is_admin: bool,
    /// overrides the commit author e-mail (see `git::author_email`)
    pub commit_email: Option<String>,
    #[serde(skip)]
    pub github_id: Option<i64>,
    #[serde(skip)]
    pub github_login: Option<String>,
}

macro_rules! select_user {
    ($where:literal) => {
        concat!(
            "SELECT id, username, display_name, email, is_admin, commit_email, github_id, github_login
             FROM users WHERE ",
            $where
        )
    };
}
pub(crate) use select_user;

impl AuthUser for User {
    type Id = i64;

    fn id(&self) -> i64 {
        self.id
    }

    /// No password to rotate: sessions end when the user is removed (`get_user` → None).
    fn session_auth_hash(&self) -> &[u8] {
        self.username.as_bytes()
    }
}

pub async fn open_db(opts: SqliteConnectOptions) -> sqlx::Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .connect_with(opts.create_if_missing(true))
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

#[derive(Clone, Debug)]
pub struct Backend {
    pub db: SqlitePool,
}

impl Backend {
    pub async fn user_by_username(&self, username: &str) -> sqlx::Result<Option<User>> {
        sqlx::query_as(select_user!("username = ?"))
            .bind(username)
            .fetch_optional(&self.db)
            .await
    }
}

impl AuthnBackend for Backend {
    type User = User;
    /// Unused: every login flow (OAuth callback, dev login) resolves the user itself and
    /// calls `AuthSession::login` directly.
    type Credentials = ();
    type Error = sqlx::Error;

    async fn authenticate(&self, _: ()) -> sqlx::Result<Option<User>> {
        Ok(None)
    }

    async fn get_user(&self, id: &UserId<Self>) -> sqlx::Result<Option<User>> {
        sqlx::query_as(select_user!("id = ?"))
            .bind(id)
            .fetch_optional(&self.db)
            .await
    }
}

/// Route layer: 401 unless a user is logged in.
pub async fn require_login(auth: AuthSession, req: Request, next: Next) -> Response {
    match auth.user().await {
        Some(_) => next.run(req).await,
        None => ApiError::unauthorized().into_response(),
    }
}

/// WebSocket upgrades: browsers always send `Origin`; reject foreign ones (cross-site WS hijacking).
pub async fn same_origin(State(app): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    match req.headers().get(axum::http::header::ORIGIN) {
        Some(origin) if origin.as_bytes() == app.origin.as_bytes() => next.run(req).await,
        origin => {
            tracing::warn!(
                ?origin,
                "rejecting WebSocket request without a matching Origin"
            );
            ApiError::new(StatusCode::FORBIDDEN, "forbidden", "origin not allowed").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct DevLogin {
    username: String,
}

/// Only routed when `UNDERTREE_DEV_LOGIN=true` (never together with https, see `Config::validate`).
pub async fn dev_login(
    auth: AuthSession,
    Json(DevLogin { username }): Json<DevLogin>,
) -> Result<Json<User>, ApiError> {
    let user = auth
        .backend()
        .user_by_username(&username)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "unknown user"))?;
    auth.login(&user).await.map_err(ApiError::internal)?;
    Ok(Json(user))
}

pub async fn logout(auth: AuthSession) -> Result<StatusCode, ApiError> {
    auth.logout().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(auth: AuthSession) -> Result<Json<User>, ApiError> {
    auth.user()
        .await
        .map(Json)
        .ok_or_else(ApiError::unauthorized)
}

/// `commit_name` input: trimmed, `""`/`null` clears it; else max 200 chars, no control chars
/// or `<>` and at least one non-punctuation character usable inside `Name <email>`.
pub fn commit_name(value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(name) = value.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    let valid = name.chars().count() <= 200
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>'))
        && !name
            .trim_matches(|c: char| {
                c.is_whitespace() || matches!(c, '.' | ',' | ':' | ';' | '"' | '\\' | '\'')
            })
            .is_empty();
    if !valid {
        return Err(ApiError::bad_request("invalid commit_name"));
    }
    Ok(Some(name))
}

/// `commit_email` input: trimmed, `""`/`null` clears it; else a plausible address that is safe
/// inside `Name <email>` (no whitespace, control chars, `<>` or `,`).
pub fn commit_email(value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(email) = value.map(|e| e.trim().to_owned()).filter(|e| !e.is_empty()) else {
        return Ok(None);
    };
    let plausible = email.len() <= 254
        && !email
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | ','))
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.contains('@')
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        });
    if !plausible {
        return Err(ApiError::bad_request("invalid commit_email"));
    }
    Ok(Some(email))
}

#[derive(Deserialize)]
pub struct PatchMe {
    #[serde(default, deserialize_with = "crate::projects::nullable")]
    commit_email: Option<Option<String>>,
}

pub async fn patch_me(auth: AuthSession, Json(b): Json<PatchMe>) -> Result<Json<User>, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    if let Some(email) = b.commit_email {
        sqlx::query("UPDATE users SET commit_email = ? WHERE id = ?")
            .bind(commit_email(email)?)
            .bind(user.id)
            .execute(&auth.backend().db)
            .await
            .map_err(ApiError::internal)?;
    }
    auth.backend()
        .get_user(&user.id)
        .await
        .map_err(ApiError::internal)?
        .map(Json)
        .ok_or_else(ApiError::unauthorized)
}

#[cfg(test)]
mod tests {
    #[test]
    fn commit_email_validation() {
        let check = |e: &str| super::commit_email(Some(e.into())).map_err(|_| ());
        assert_eq!(check(" a.b+c@x.org "), Ok(Some("a.b+c@x.org".into())));
        assert_eq!(
            check("1+me@users.noreply.github.com"),
            Ok(Some("1+me@users.noreply.github.com".into()))
        );
        assert_eq!(check(""), Ok(None));
        assert_eq!(super::commit_email(None).map_err(|_| ()), Ok(None));
        for bad in [
            "x",
            "@x.org",
            "a@",
            "a@x",
            "a@.x",
            "a@x.",
            "a b@x.org",
            "a@x.org\nb",
            "a@x\u{7}.org",
            "<a@x.org>",
            "a@b@x.org",
            "a@x.org,b@y.org",
        ] {
            assert!(check(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn commit_name_validation() {
        let check = |n: &str| super::commit_name(Some(n.into())).map_err(|_| ());
        assert_eq!(
            check(" Dr. Ada Lovelace "),
            Ok(Some("Dr. Ada Lovelace".into()))
        );
        assert_eq!(check(""), Ok(None));
        assert_eq!(check("   "), Ok(None));
        assert_eq!(super::commit_name(None).map_err(|_| ()), Ok(None));
        let long = "a".repeat(201);
        for bad in [
            "<Ada>",
            "Ada <x>",
            "Ada\nLovelace",
            "Ada\u{7}",
            "...",
            ".,:",
            long.as_str(),
        ] {
            assert!(check(bad).is_err(), "{bad:?}");
        }
    }
}
