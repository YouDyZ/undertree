//! GitHub / Google OAuth2 login (Authorization Code + PKCE). docs/API.md → Auth, docs/AUTH.md.
//! Only users registered via the admin CLI can log in; there is no self-registration.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::Redirect,
};
use oauth2::{
    basic::BasicClient, reqwest, AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret,
    CsrfToken, EndpointNotSet, EndpointSet, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl,
    Scope, TokenResponse, TokenUrl,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tower_sessions::Session;

use crate::{
    auth::{select_user, AuthSession, User},
    config::Config,
    error::ApiError,
    AppState,
};

type Client = BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Google,
}

impl Provider {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "github" => Some(Self::Github),
            "google" => Some(Self::Google),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Google => "google",
        }
    }

    /// (authorize URL, token URL, scopes). GitHub needs no scope for `GET /user`.
    fn endpoints(self) -> (&'static str, &'static str, &'static [&'static str]) {
        match self {
            Self::Github => (
                "https://github.com/login/oauth/authorize",
                "https://github.com/login/oauth/access_token",
                &[],
            ),
            Self::Google => (
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                &["openid", "email"],
            ),
        }
    }
}

pub struct OAuth {
    clients: Vec<(Provider, Client)>,
    /// no redirects, with timeout; also used for the GitHub/GitLab REST calls (accounts.rs)
    pub http: reqwest::Client,
    /// GitHub REST API base (`UNDERTREE_GITHUB_API_URL`, only tests change it)
    pub github_api: String,
}

impl OAuth {
    pub fn from_config(cfg: &Config) -> Result<Self, String> {
        let creds = [
            (
                Provider::Github,
                &cfg.github_client_id,
                &cfg.github_client_secret,
            ),
            (
                Provider::Google,
                &cfg.google_client_id,
                &cfg.google_client_secret,
            ),
        ];
        let mut clients = Vec::new();
        for (p, id, secret) in creds {
            let (Some(id), Some(secret)) = (id, secret) else {
                if id.is_some() || secret.is_some() {
                    return Err(format!(
                        "{} OAuth needs both client id and secret",
                        p.name()
                    ));
                }
                continue;
            };
            let (auth, token, _) = p.endpoints();
            let redirect = format!(
                "{}/api/auth/oauth/{}/callback",
                cfg.public_url.trim_end_matches('/'),
                p.name()
            );
            let client = BasicClient::new(ClientId::new(id.clone()))
                .set_client_secret(ClientSecret::new(secret.clone()))
                .set_auth_uri(AuthUrl::new(auth.into()).expect("valid URL"))
                .set_token_uri(TokenUrl::new(token.into()).expect("valid URL"))
                .set_redirect_uri(RedirectUrl::new(redirect).map_err(|e| e.to_string())?)
                .set_auth_type(AuthType::RequestBody);
            clients.push((p, client));
        }
        let http = reqwest::Client::builder()
            // following redirects during token exchange opens SSRF holes (oauth2 docs)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("undertree")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            clients,
            http,
            github_api: cfg.github_api_url.trim_end_matches('/').to_owned(),
        })
    }

    pub fn enabled(&self) -> Vec<Provider> {
        self.clients.iter().map(|(p, _)| *p).collect()
    }

    fn client(&self, p: Provider) -> Option<&Client> {
        self.clients.iter().find(|(q, _)| *q == p).map(|(_, c)| c)
    }
}

/// Stored in the session between `start` and `callback`.
#[derive(Serialize, Deserialize)]
struct Pending {
    provider: Provider,
    state: String,
    verifier: String,
    next: String,
    /// connect flow (`/api/auth/connect/github`): the logged-in user the account is stored for
    #[serde(default)]
    connect_user: Option<i64>,
}

const PENDING_KEY: &str = "oauth.pending";

/// Only same-origin absolute paths; blocks `//evil`, `/\evil` and control chars (browsers strip tabs).
fn safe_next(next: Option<String>) -> String {
    next.filter(|n| {
        n.starts_with('/')
            && !n.starts_with("//")
            && !n.contains('\\')
            && !n.chars().any(char::is_control)
    })
    .unwrap_or_else(|| "/".into())
}

#[derive(Deserialize)]
pub struct StartQuery {
    next: Option<String>,
}

pub async fn start(
    State(app): State<Arc<AppState>>,
    session: Session,
    Path(provider): Path<String>,
    Query(q): Query<StartQuery>,
) -> Result<Redirect, ApiError> {
    let p = Provider::parse(&provider)
        .ok_or_else(|| ApiError::not_found("OAuth provider not enabled"))?;
    authorize(&app, &session, p, p.endpoints().2, safe_next(q.next), None).await
}

/// `GET /api/auth/connect/github` (logged in): same OAuth app and callback as the login, but
/// with the scopes to create repos (`workflow` = may push `.github/workflows/*`); the callback
/// stores the token as a connected account of the caller instead of logging in.
pub async fn connect_github(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    session: Session,
) -> Result<Redirect, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let next = "/?connected=github".to_owned();
    let scopes = &["repo", "workflow"];
    authorize(
        &app,
        &session,
        Provider::Github,
        scopes,
        next,
        Some(user.id),
    )
    .await
}

/// Remembers the flow in the session, redirects to the provider.
async fn authorize(
    app: &AppState,
    session: &Session,
    p: Provider,
    scopes: &[&str],
    next: String,
    connect_user: Option<i64>,
) -> Result<Redirect, ApiError> {
    let client =
        (app.oauth.client(p)).ok_or_else(|| ApiError::not_found("OAuth provider not enabled"))?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let mut req = client
        .authorize_url(CsrfToken::new_random)
        .set_pkce_challenge(challenge);
    for scope in scopes {
        req = req.add_scope(Scope::new((*scope).into()));
    }
    let (url, state) = req.url();
    let pending = Pending {
        provider: p,
        state: state.secret().clone(),
        verifier: verifier.secret().clone(),
        next,
        connect_user,
    };
    session
        .insert(PENDING_KEY, pending)
        .await
        .map_err(ApiError::internal)?;
    Ok(Redirect::to(url.as_str()))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

pub async fn callback(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    session: Session,
    Path(provider): Path<String>,
    Query(q): Query<CallbackQuery>,
) -> Redirect {
    // remove first: a pending login is single-use
    let pending: Option<Pending> = session.remove(PENDING_KEY).await.unwrap_or_else(|e| {
        tracing::warn!("oauth {provider}: session: {e}");
        None
    });
    let connect = pending.as_ref().is_some_and(|p| p.connect_user.is_some());
    match finish(&app, &auth, pending, &provider, q).await {
        Ok(next) => Redirect::to(&next),
        Err(code) if connect => Redirect::to(&format!("/?connect_error={code}")),
        Err(code) => Redirect::to(&format!("/login?error={code}")),
    }
}

/// Returns the `next` path or an error code.
async fn finish(
    app: &AppState,
    auth: &AuthSession,
    pending: Option<Pending>,
    provider: &str,
    q: CallbackQuery,
) -> Result<String, &'static str> {
    let oauth = &app.oauth;
    let fail = |what: &str, err: &dyn std::fmt::Display| {
        tracing::warn!("oauth {provider}: {what}: {err}");
        "oauth_failed"
    };
    let pending = pending.ok_or("oauth_failed")?;
    if q.error.is_some() {
        return Err("oauth_denied");
    }
    let p = Provider::parse(provider)
        .filter(|p| *p == pending.provider)
        .ok_or("oauth_failed")?;
    if q.state.as_deref() != Some(pending.state.as_str()) {
        return Err("oauth_failed");
    }
    let client = oauth.client(p).ok_or("oauth_failed")?;
    let token = client
        .exchange_code(AuthorizationCode::new(q.code.ok_or("oauth_failed")?))
        .set_pkce_verifier(PkceCodeVerifier::new(pending.verifier))
        .request_async(&oauth.http)
        .await
        .map_err(|e| fail("token exchange", &e))?;
    let token = token.access_token().secret();
    let identity = fetch_identity(oauth, p, token)
        .await
        .map_err(|e| fail("identity", &e))?;
    if let Some(uid) = pending.connect_user {
        let Identity::Github { login, .. } = identity else {
            return Err("oauth_failed");
        };
        // the session may have changed hands since the connect started
        if auth.user().await.map(|u| u.id) != Some(uid) {
            return Err("oauth_failed");
        }
        let gh = crate::accounts::Forge::Github;
        crate::accounts::save(app, uid, gh, crate::accounts::GITHUB_WEB, &login, token)
            .await
            .map_err(|e| fail("db", &e))?;
        return Ok(pending.next);
    }
    let user = match_identity(&auth.backend().db, &identity)
        .await
        .map_err(|e| fail("db", &e))?
        .ok_or_else(|| {
            tracing::info!("oauth {provider}: unregistered identity {identity:?}");
            "not_registered"
        })?;
    auth.login(&user).await.map_err(|e| fail("login", &e))?;
    Ok(pending.next)
}

#[derive(Debug)]
pub enum Identity {
    Github { id: i64, login: String },
    Google { email: String, email_verified: bool },
}

async fn fetch_identity(
    oauth: &OAuth,
    p: Provider,
    token: &str,
) -> Result<Identity, Box<dyn std::error::Error>> {
    let url = match p {
        Provider::Github => format!("{}/user", oauth.github_api),
        Provider::Google => "https://openidconnect.googleapis.com/v1/userinfo".into(),
    };
    let body = (oauth.http)
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    #[derive(Deserialize)]
    struct Github {
        id: i64,
        login: String,
    }
    #[derive(Deserialize)]
    struct Google {
        email: String,
        #[serde(default)]
        email_verified: bool,
    }
    Ok(match p {
        Provider::Github => {
            let Github { id, login } = serde_json::from_slice(&body)?;
            Identity::Github { id, login }
        }
        Provider::Google => {
            let Google {
                email,
                email_verified,
            } = serde_json::from_slice(&body)?;
            Identity::Google {
                email,
                email_verified,
            }
        }
    })
}

/// GitHub: by numeric id; on first login link the id via the registered `github_login`
/// (afterwards renames on GitHub don't matter). Google: verified e-mail only.
pub async fn match_identity(db: &SqlitePool, identity: &Identity) -> sqlx::Result<Option<User>> {
    match identity {
        Identity::Github { id, login } => {
            let linked: Option<User> = sqlx::query_as(select_user!("github_id = ?"))
                .bind(id)
                .fetch_optional(db)
                .await?;
            if linked.is_some() {
                return Ok(linked);
            }
            sqlx::query_as(
                "UPDATE users SET github_id = ?1 WHERE github_id IS NULL AND github_login = ?2
                 RETURNING id, username, display_name, email, is_admin, commit_email, github_id,
                           github_login",
            )
            .bind(id)
            .bind(login)
            .fetch_optional(db)
            .await
        }
        Identity::Google {
            email,
            email_verified: true,
        } => {
            sqlx::query_as(select_user!("email = ?"))
                .bind(email)
                .fetch_optional(db)
                .await
        }
        Identity::Google { .. } => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!().run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO users (username, display_name, email, github_login) VALUES
             ('alice', 'Alice', 'alice@example.org', 'Alice-GH'),
             ('bob', 'Bob', 'bob@example.org', NULL)",
        )
        .execute(&db)
        .await
        .unwrap();
        db
    }

    fn gh(id: i64, login: &str) -> Identity {
        Identity::Github {
            id,
            login: login.into(),
        }
    }

    fn google(email: &str, email_verified: bool) -> Identity {
        Identity::Google {
            email: email.into(),
            email_verified,
        }
    }

    async fn who(db: &SqlitePool, i: Identity) -> Option<String> {
        match_identity(db, &i).await.unwrap().map(|u| u.username)
    }

    #[tokio::test]
    async fn github_links_by_login_then_matches_by_id() {
        let db = db().await;
        assert_eq!(who(&db, gh(42, "nobody")).await, None);
        // login match is case-insensitive, links id 42
        assert_eq!(who(&db, gh(42, "alice-gh")).await.as_deref(), Some("alice"));
        // renamed on GitHub: still matched by id
        assert_eq!(
            who(&db, gh(42, "alice-new")).await.as_deref(),
            Some("alice")
        );
        // someone else grabbing the old login can't take over the linked account
        assert_eq!(who(&db, gh(99, "Alice-GH")).await, None);
    }

    #[tokio::test]
    async fn google_requires_verified_registered_email() {
        let db = db().await;
        assert_eq!(
            who(&db, google("BOB@example.org", true)).await.as_deref(),
            Some("bob")
        );
        assert_eq!(who(&db, google("bob@example.org", false)).await, None);
        assert_eq!(who(&db, google("eve@example.org", true)).await, None);
    }

    #[test]
    fn next_is_same_origin_only() {
        let n = |s: &str| safe_next(Some(s.into()));
        assert_eq!(n("/papers?x=1"), "/papers?x=1");
        for bad in [
            "//evil.org",
            "/\\evil.org",
            "https://evil.org",
            "/\t/evil.org",
            "",
        ] {
            assert_eq!(n(bad), "/", "{bad:?}");
        }
        assert_eq!(safe_next(None), "/");
    }
}
