//! Connected GitHub/GitLab/Zotero accounts (docs/API.md → Accounts) and the provider REST calls
//! that create repos, register deploy keys and invite members (Zotero calls: zotero.rs).
//!
//! Tokens are stored encrypted like project tokens (`projects::Secrets`) and are never returned.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use oauth2::reqwest::{self, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    auth::{select_user, AuthSession, User},
    error::ApiError,
    netguard,
    projects::{Access, Role},
    AppState,
};

/// `base_url` of every GitHub account.
// ponytail: github.com only; GitHub Enterprise needs a per-account API base like GitLab
pub const GITHUB_WEB: &str = "https://github.com";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Forge {
    Github,
    Gitlab,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Account {
    pub id: i64,
    /// a `Forge` or `"zotero"`
    pub provider: String,
    pub base_url: String,
    pub login: String,
    /// GitLab on a self-hosted server: the SSH host key trusted on first use (`SHA256:…`), set
    /// by the first `create_remote`
    pub ssh_host_key_fingerprint: Option<String>,
}

pub fn remote_failed(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, "remote_failed", msg)
}

/// Stores the account (same user + provider + server: login and token are replaced).
pub async fn save(
    app: &AppState,
    user_id: i64,
    forge: Forge,
    base_url: &str,
    login: &str,
    token: &str,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "INSERT INTO user_accounts (user_id, provider, base_url, login, token_enc)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, provider, base_url)
         DO UPDATE SET login = excluded.login, token_enc = excluded.token_enc
         RETURNING id",
    )
    .bind(user_id)
    .bind(forge)
    .bind(base_url)
    .bind(login)
    .bind(app.secrets.encrypt(token))
    .fetch_one(&app.db)
    .await
}

/// An account ready for API calls.
pub struct Conn {
    pub forge: Forge,
    pub base_url: String,
    api: String,
    token: String,
    /// GitHub only; GitLab gets a client pinned to the vetted address per request (netguard)
    http: reqwest::Client,
    /// `UNDERTREE_GITLAB_HOSTS` at the time of this request
    gitlab_hosts: Vec<String>,
    /// tests only (`AppState::allow_file`): local mock servers
    allow_private: bool,
}

/// `host[:port]` of `scheme://host[:port][/path]`, lowercased.
fn authority(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    rest.split('/').next().unwrap_or("").to_ascii_lowercase()
}

/// With a non-empty `UNDERTREE_GITLAB_HOSTS`, GitLab servers must be on it. Either way every
/// request also passes `netguard` (public addresses only).
fn check_host(forge: Forge, base_url: &str, allowed: &[String]) -> Result<(), ApiError> {
    let host = authority(base_url);
    if forge == Forge::Github || allowed.is_empty() || allowed.contains(&host) {
        return Ok(());
    }
    Err(netguard::not_allowed(format!(
        "GitLab server {host} is not allowed on this undertree (allowed: {}); ask the admin \
         to add it to UNDERTREE_GITLAB_HOSTS",
        allowed.join(", ")
    )))
}

impl Conn {
    fn new(app: &AppState, forge: Forge, base_url: String, token: String) -> Self {
        let api = match forge {
            Forge::Github => app.oauth.github_api.clone(),
            Forge::Gitlab => format!("{base_url}/api/v4"),
        };
        Self {
            forge,
            base_url,
            api,
            token,
            http: app.oauth.http.clone(),
            gitlab_hosts: app.gitlab_hosts.clone(),
            allow_private: app.allow_file,
        }
    }

    /// Account `id`; with `owner`, only if it belongs to that user (else 404).
    pub async fn load(app: &AppState, id: i64, owner: Option<i64>) -> Result<Self, ApiError> {
        let (forge, base_url, token): (Forge, String, Vec<u8>) = sqlx::query_as(
            "SELECT provider, base_url, token_enc FROM user_accounts
             WHERE id = ?1 AND (?2 IS NULL OR user_id = ?2) AND provider IN ('github', 'gitlab')",
        )
        .bind(id)
        .bind(owner)
        .fetch_optional(&app.db)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("no such account"))?;
        let token = app.secrets.decrypt(&token).ok_or_else(|| {
            ApiError::bad_request("the account's token cannot be decrypted, connect it again")
        })?;
        Ok(Self::new(app, forge, base_url, token))
    }

    fn name(&self) -> &'static str {
        match self.forge {
            Forge::Github => "GitHub",
            Forge::Gitlab => "GitLab",
        }
    }

    /// (status, JSON body or `Null`); only network failures are errors.
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), ApiError> {
        // stored accounts too: the allowlist may have shrunk since they were connected
        check_host(self.forge, &self.base_url, &self.gitlab_hosts)?;
        let http = match self.forge {
            Forge::Github => self.http.clone(),
            Forge::Gitlab => netguard::client(&self.api, self.allow_private).await?,
        };
        let mut req = http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(&self.token)
            .header("Accept", "application/json");
        if self.forge == Forge::Github {
            req = req.header("X-GitHub-Api-Version", "2022-11-28");
        }
        if let Some(body) = body {
            req = (req.header("Content-Type", "application/json")).body(body.to_string());
        }
        let unreachable = |e: reqwest::Error| {
            remote_failed(format!(
                "{} ({}) unreachable: {e}",
                self.name(),
                self.base_url
            ))
        };
        let res = req.send().await.map_err(unreachable)?;
        let status = res.status().as_u16();
        let bytes = res.bytes().await.map_err(unreachable)?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        ))
    }

    /// 2xx body, else `502 remote_failed` with the provider's message.
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ApiError> {
        let (status, v) = self.send(method, path, body).await?;
        if (200..300).contains(&status) {
            return Ok(v);
        }
        let msg = match &v["message"] {
            Value::String(s) => s.clone(),
            Value::Null => v["error"]
                .as_str()
                .map_or_else(|| v.to_string(), Into::into),
            m => m.to_string(),
        };
        let msg: String = msg.chars().take(300).collect();
        Err(remote_failed(format!(
            "{} API: {status} {msg}",
            self.name()
        )))
    }

    /// Creates the empty repo `spec.repo_name`.
    pub async fn create_repo(&self, spec: &CreateRemote) -> Result<NewRepo, ApiError> {
        let name = spec.repo_name.trim();
        let ok_char = |c: char| c.is_ascii_alphanumeric() || "._-".contains(c);
        if name.is_empty()
            || name.len() > 100
            || name.starts_with(['.', '-'])
            || !name.chars().all(ok_char)
        {
            return Err(ApiError::bad_request(
                "repo_name: letters, digits, '.', '_' and '-' only",
            ));
        }
        let namespace = (spec.namespace.as_deref().map(str::trim)).filter(|n| !n.is_empty());
        let field = |v: &Value, k: &str| {
            let s = v[k]
                .as_str()
                .map(str::to_owned)
                .or_else(|| v[k].as_i64().map(|i| i.to_string()));
            s.ok_or_else(|| remote_failed(format!("{}: unexpected response (no {k})", self.name())))
        };
        match self.forge {
            Forge::Github => {
                if namespace.is_some() {
                    return Err(ApiError::bad_request(
                        "namespace is only supported for GitLab",
                    ));
                }
                let body = json!({ "name": name, "private": spec.private, "auto_init": false });
                let v = self.call(Method::POST, "/user/repos", Some(body)).await?;
                Ok(NewRepo {
                    id: field(&v, "full_name")?,
                    ssh_url: field(&v, "ssh_url")?,
                    web_url: field(&v, "html_url")?,
                })
            }
            Forge::Gitlab => {
                let visibility = if spec.private { "private" } else { "public" };
                let mut body = json!({
                    "name": name, "path": name, "visibility": visibility,
                    "initialize_with_readme": false,
                });
                if let Some(ns) = namespace {
                    let v = self
                        .call(Method::GET, &format!("/namespaces/{}", enc(ns)), None)
                        .await?;
                    body["namespace_id"] = v["id"].clone();
                }
                let v = self.call(Method::POST, "/projects", Some(body)).await?;
                Ok(NewRepo {
                    id: field(&v, "id")?,
                    ssh_url: field(&v, "ssh_url_to_repo")?,
                    web_url: field(&v, "web_url")?,
                })
            }
        }
    }

    /// Registers `key` (OpenSSH public key) as deploy key with write access on repo `id`.
    pub async fn add_deploy_key(&self, id: &str, title: &str, key: &str) -> Result<(), ApiError> {
        let (path, body) = match self.forge {
            Forge::Github => (
                format!("/repos/{id}/keys"),
                json!({ "title": title, "key": key, "read_only": false }),
            ),
            Forge::Gitlab => (
                format!("/projects/{id}/deploy_keys"),
                json!({ "title": title, "key": key, "can_push": true }),
            ),
        };
        self.call(Method::POST, &path, Some(body)).await.map(drop)
    }
}

#[derive(Deserialize)]
pub struct CreateRemote {
    pub account_id: i64,
    pub repo_name: String,
    #[serde(default = "yes")]
    pub private: bool,
    /// GitLab group path, e.g. `chair/papers`
    pub namespace: Option<String>,
    /// initial content (templates.rs), default the built-in article
    pub template_id: Option<String>,
}

fn yes() -> bool {
    true
}

/// A repo just created on the provider.
pub struct NewRepo {
    /// for later API calls: `owner/name` (GitHub) or the numeric project id (GitLab)
    pub id: String,
    pub ssh_url: String,
    pub web_url: String,
}

/// Percent-encodes everything but RFC 3986 unreserved characters (one path segment / value).
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `https://host[/path]` without credentials, query or fragment; trailing `/` dropped.
/// `allow_http`: tests only (local mock server).
fn server_url(raw: &str, allow_http: bool) -> Result<String, ApiError> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://").filter(|_| allow_http));
    match rest {
        Some(rest)
            if !rest.is_empty()
                && !rest.starts_with(['/', '-'])
                && !rest.contains(['@', '?', '#', '\\'])
                && !rest.chars().any(|c| c.is_whitespace() || c.is_control()) =>
        {
            Ok(url.to_owned())
        }
        _ => Err(ApiError::bad_request(
            "base_url must be https://host[/path] without credentials or query",
        )),
    }
}

async fn me(auth: &AuthSession) -> Result<User, ApiError> {
    auth.user().await.ok_or_else(ApiError::unauthorized)
}

pub async fn list(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
) -> Result<Json<Vec<Account>>, ApiError> {
    let user = me(&auth).await?;
    sqlx::query_as(
        "SELECT id, provider, base_url, login, ssh_host_key_fingerprint FROM user_accounts
         WHERE user_id = ? ORDER BY id",
    )
    .bind(user.id)
    .fetch_all(&app.db)
    .await
    .map(Json)
    .map_err(ApiError::internal)
}

#[derive(Deserialize)]
pub struct NewAccount {
    provider: String,
    /// GitLab only
    #[serde(default)]
    base_url: String,
    token: String,
}

/// GitLab (validated with `GET /api/v4/user`) or Zotero; GitHub connects via OAuth.
pub async fn create(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Json(b): Json<NewAccount>,
) -> Result<(StatusCode, Json<Account>), ApiError> {
    let user = me(&auth).await?;
    let token = b.token.trim();
    if token.is_empty() || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ApiError::bad_request(
            "token is empty or contains whitespace",
        ));
    }
    match b.provider.as_str() {
        "gitlab" => {}
        "zotero" => {
            let account = crate::zotero::connect(&app, user.id, token).await?;
            return Ok((StatusCode::CREATED, Json(account)));
        }
        "github" => {
            return Err(ApiError::bad_request(
                "GitHub accounts are connected via /api/auth/connect/github",
            ))
        }
        _ => {
            return Err(ApiError::bad_request(
                "provider must be \"gitlab\" or \"zotero\"",
            ))
        }
    }
    let base_url = server_url(&b.base_url, app.allow_file)?;
    let conn = Conn::new(&app, Forge::Gitlab, base_url.clone(), token.into());
    let (status, v) = conn.send(Method::GET, "/user", None).await?;
    let login = match (status, v["username"].as_str()) {
        (200, Some(login)) => login.to_owned(),
        (401 | 403, _) => {
            return Err(ApiError::bad_request(format!(
                "GitLab rejected the token ({status}); it needs the scope `api`"
            )))
        }
        _ => {
            return Err(ApiError::bad_request(format!(
                "{base_url} does not look like a GitLab server (GET /api/v4/user → {status})"
            )))
        }
    };
    let id = save(&app, user.id, Forge::Gitlab, &base_url, &login, token)
        .await
        .map_err(ApiError::internal)?;
    // reconnecting keeps the trusted host key
    let ssh_host_key_fingerprint =
        sqlx::query_scalar("SELECT ssh_host_key_fingerprint FROM user_accounts WHERE id = ?")
            .bind(id)
            .fetch_one(&app.db)
            .await
            .map_err(ApiError::internal)?;
    let account = Account {
        id,
        provider: "gitlab".into(),
        base_url,
        login,
        ssh_host_key_fingerprint,
    };
    Ok((StatusCode::CREATED, Json(account)))
}

pub async fn delete(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let user = me(&auth).await?;
    let deleted = sqlx::query("DELETE FROM user_accounts WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    if deleted == 0 {
        return Err(ApiError::not_found("no such account"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/projects/{pid}/members/{username}/invite-remote` (owner/admin): adds a member to
/// the remote repo with the creator's account (GitHub collaborator `push`, GitLab Developer).
pub async fn invite_remote(
    State(app): State<Arc<AppState>>,
    access: Access,
    Path((_, username)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    access.info.my_role.require(Role::Owner)?;
    let pid = access.info.id;
    let (account_id, repo): (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT account_id, remote_repo FROM projects WHERE id = ?")
            .bind(pid)
            .fetch_one(&app.db)
            .await
            .map_err(ApiError::internal)?;
    let (Some(account_id), Some(repo)) = (account_id, repo) else {
        return Err(ApiError::bad_request(
            "the remote repo was not created by undertree, or its account was disconnected",
        ));
    };
    let target: User = sqlx::query_as(select_user!(
        "username = ? AND id IN (SELECT user_id FROM project_members WHERE project_id = ?)"
    ))
    .bind(&username)
    .bind(pid)
    .fetch_optional(&app.db)
    .await
    .map_err(ApiError::internal)?
    .ok_or_else(|| ApiError::not_found(format!("{username} is not a member")))?;
    // the remote grants push: not for members who cannot write here
    let role: Role =
        sqlx::query_scalar("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
            .bind(pid)
            .bind(target.id)
            .fetch_one(&app.db)
            .await
            .map_err(ApiError::internal)?;
    if role < Role::Editor {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invite_role_too_low",
            format!("{username} is only {role:?}: the remote repo grants push access, make them editor first")
                .to_lowercase(),
        ));
    }
    let conn = Conn::load(&app, account_id, None).await?;
    match conn.forge {
        Forge::Github => {
            let login = target.github_login.ok_or_else(|| {
                ApiError::bad_request(format!(
                    "no GitHub login known for {username} (an admin can add it in the user list)"
                ))
            })?;
            let path = format!("/repos/{repo}/collaborators/{}", enc(&login));
            let body = json!({ "permission": "push" });
            conn.call(Method::PUT, &path, Some(body)).await?;
        }
        Forge::Gitlab => {
            // their own connected account on that server, else the same username
            let login: Option<String> = sqlx::query_scalar(
                "SELECT login FROM user_accounts
                 WHERE user_id = ? AND provider = 'gitlab' AND base_url = ?",
            )
            .bind(target.id)
            .bind(&conn.base_url)
            .fetch_optional(&app.db)
            .await
            .map_err(ApiError::internal)?;
            let login = login.unwrap_or(target.username);
            let users = conn
                .call(
                    Method::GET,
                    &format!("/users?username={}", enc(&login)),
                    None,
                )
                .await?;
            let user_id = users[0]["id"].as_i64().ok_or_else(|| {
                ApiError::bad_request(format!(
                    "no GitLab user {login} on {} (they can connect their account in the profile)",
                    conn.base_url
                ))
            })?;
            let body = json!({ "user_id": user_id, "access_level": 30 });
            conn.call(
                Method::POST,
                &format!("/projects/{repo}/members"),
                Some(body),
            )
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_url_validation() {
        let ok = |u: &str| server_url(u, false).map_err(|e| e.message);
        assert_eq!(
            ok("https://gitlab.com/").as_deref(),
            Ok("https://gitlab.com")
        );
        assert_eq!(
            ok(" https://git.uni.de/gitlab ").as_deref(),
            Ok("https://git.uni.de/gitlab")
        );
        for bad in [
            "http://gitlab.com",
            "https://",
            "https://user:pw@gitlab.com",
            "https://gitlab.com?x=1",
            "https://gitlab.com#x",
            "https://-x",
            "gitlab.com",
            "ftp://gitlab.com",
        ] {
            assert!(server_url(bad, false).is_err(), "{bad}");
        }
        assert!(server_url("http://127.0.0.1:1234", true).is_ok());
    }

    #[test]
    fn gitlab_hosts_are_allowlisted() {
        let allowed = ["gitlab.com".to_owned(), "git.uni.de:8443".to_owned()];
        let ok = |url: &str| check_host(Forge::Gitlab, url, &allowed).is_ok();
        assert!(ok("https://gitlab.com") && ok("https://GitLab.com/sub"));
        assert!(ok("https://git.uni.de:8443/gitlab"));
        for bad in [
            "https://git.uni.de",
            "https://gitlab.com.evil.org",
            "https://10.0.0.1",
        ] {
            assert!(!ok(bad), "{bad}");
        }
        let err = check_host(Forge::Gitlab, "https://intranet", &allowed).unwrap_err();
        assert_eq!((err.status.as_u16(), err.code), (400, "host_not_allowed"));
        assert!(check_host(Forge::Github, "https://github.com", &[]).is_ok());
    }

    #[test]
    fn encodes_path_segments() {
        assert_eq!(enc("chair/papers"), "chair%2Fpapers");
        assert_eq!(enc("a.b_c-d~"), "a.b_c-d~");
        assert_eq!(enc("x y&z"), "x%20y%26z");
    }
}
