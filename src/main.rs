mod accounts;
mod admin;
mod anonymize;
mod auth;
mod chat;
mod ci;
mod cli;
mod comments;
mod compile;
mod config;
mod detect;
mod docs;
mod error;
mod events;
mod git;
mod moves;
mod netguard;
mod oauth;
mod projects;
mod sandbox;
mod spellcheck;
mod templates;
mod workspace;
mod zotero;

use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{any, delete, get, post},
    Json, Router,
};
use axum_login::AuthManagerLayerBuilder;
use clap::{Parser, Subcommand};
use config::Config;
use error::ApiError;
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tower_sessions::{
    cookie::{time::Duration, SameSite},
    session_store::ExpiredDeletion,
    Expiry, SessionManagerLayer,
};
use tower_sessions_sqlx_store::SqliteStore;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(flatten)]
    cfg: Config,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the web server
    Serve,
    /// Manage users
    #[command(subcommand)]
    User(cli::UserCmd),
    /// ssh ProxyCommand for project remotes (internal): connect only to public addresses
    #[command(hide = true)]
    SshProxy { host: String, port: u16 },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "undertree=info,tower_http=info".into()),
        )
        .init();

    let Cli { cfg, cmd } = Cli::parse();
    if let Cmd::SshProxy { host, port } = &cmd {
        return netguard::ssh_proxy(host, *port).await;
    }
    cfg.validate()?;
    std::fs::create_dir_all(&cfg.data)?;
    let db =
        auth::open_db(SqliteConnectOptions::new().filename(cfg.data.join("undertree.db"))).await?;

    match cmd {
        Cmd::User(cmd) => cli::run(&db, cmd).await?,
        Cmd::SshProxy { .. } => unreachable!("handled above"),
        Cmd::Serve => {
            let listener = tokio::net::TcpListener::bind(cfg.bind).await?;
            tracing::info!("listening on http://{}", cfg.bind);
            axum::serve(listener, app(&cfg, db).await?).await?;
        }
    }
    Ok(())
}

/// Shared state for handlers; everything per project lives in `projects::Project`.
pub struct AppState {
    pub oauth: oauth::OAuth,
    pub db: SqlitePool,
    pub data: PathBuf,
    pub secrets: projects::Secrets,
    pub projects: Mutex<HashMap<i64, Arc<projects::Project>>>,
    /// public origin for WebSocket `Origin` checks
    pub origin: String,
    /// tests only (see `build`): local `file://` remotes and submodules, and GitLab servers on
    /// `http://` or private addresses (local mock servers, `netguard`)
    pub allow_file: bool,
    /// `UNDERTREE_GITLAB_HOSTS`, lowercased
    pub gitlab_hosts: Vec<String>,
    /// `UNDERTREE_ZOTERO_API_URL` (only tests change it)
    pub zotero_api: String,
    /// `UNDERTREE_LANGUAGETOOL_URL` set: spell check on
    pub languagetool: Option<spellcheck::LanguageTool>,
}

type BoxError = Box<dyn std::error::Error>;

/// In `$DATA`: `git::PINNED_KNOWN_HOSTS`, used by projects with their own deploy key.
const PINNED_HOSTS_FILE: &str = "pinned_known_hosts";

impl AppState {
    pub fn pinned_hosts(&self) -> PathBuf {
        self.data.join(PINNED_HOSTS_FILE)
    }
}

async fn app(cfg: &Config, db: SqlitePool) -> Result<Router, BoxError> {
    build(cfg, db, false).await
}

/// `allow_file` is not configurable: production always runs with `false`.
async fn build(cfg: &Config, db: SqlitePool, allow_file: bool) -> Result<Router, BoxError> {
    Ok(build_with_state(cfg, db, allow_file).await?.0)
}

/// Like `build`, also returns the shared state (tests call into the background tasks).
async fn build_with_state(
    cfg: &Config,
    db: SqlitePool,
    allow_file: bool,
) -> Result<(Router, Arc<AppState>), BoxError> {
    std::fs::create_dir_all(cfg.data.join("projects"))?;
    // rewritten on every start, so updated pinned keys reach existing projects
    std::fs::write(cfg.data.join(PINNED_HOSTS_FILE), git::PINNED_KNOWN_HOSTS)?;
    let state = Arc::new(AppState {
        oauth: oauth::OAuth::from_config(cfg)?,
        db: db.clone(),
        data: cfg.data.canonicalize()?,
        secrets: projects::Secrets::load(cfg.secret_key.as_deref(), &cfg.data)?,
        projects: Mutex::default(),
        origin: cfg.origin().to_owned(),
        allow_file,
        gitlab_hosts: (cfg.gitlab_hosts.iter())
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect(),
        zotero_api: cfg.zotero_api_url.trim_end_matches('/').to_owned(),
        languagetool: (cfg.languagetool_url.as_deref())
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(spellcheck::LanguageTool::new)
            .transpose()?,
    });

    let store = SqliteStore::new(db.clone());
    store.migrate().await?;
    // the app's own migrations ran in `auth::open_db` (tests: before `build`)
    tokio::spawn(templates::resume_previews(state.clone()));
    if cfg.zotero_sync_secs > 0 {
        let every = std::time::Duration::from_secs(cfg.zotero_sync_secs);
        tokio::spawn(zotero::sync_loop(state.clone(), every));
    }
    tokio::spawn(
        store
            .clone()
            .continuously_delete_expired(tokio::time::Duration::from_secs(3600)),
    );
    let sessions = SessionManagerLayer::new(store)
        .with_name("undertree_session")
        .with_secure(cfg.https())
        .with_same_site(SameSite::Lax)
        .with_expiry(Expiry::OnInactivity(Duration::days(30)));
    let auth_layer = AuthManagerLayerBuilder::new(auth::Backend { db }, sessions).build();

    // SPA: unknown non-API paths serve index.html so client-side routing works.
    let spa =
        ServeDir::new(&cfg.static_dir).fallback(ServeFile::new(cfg.static_dir.join("index.html")));

    let providers = json!({ "oauth": state.oauth.enabled(), "dev_login": cfg.dev_login });

    let mut router = Router::new()
        // everything above this route_layer requires a session
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me).patch(auth::patch_me))
        .route("/api/auth/connect/github", get(oauth::connect_github))
        .route("/api/accounts", get(accounts::list).post(accounts::create))
        .route("/api/accounts/{id}", delete(accounts::delete))
        .route(
            "/api/accounts/{id}/zotero/libraries",
            get(zotero::libraries),
        )
        .route(
            "/api/accounts/{id}/zotero/collections",
            get(zotero::collections),
        )
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/templates",
            get(templates::list)
                .post(templates::upload)
                .layer(DefaultBodyLimit::max(templates::MAX_UPLOAD)),
        )
        .route(
            "/api/templates/{id}",
            axum::routing::patch(templates::patch).delete(templates::delete),
        )
        .route(
            "/api/templates/{id}/preview.pdf",
            get(templates::preview_pdf),
        )
        .route("/api/templates/{id}/files", get(templates::files))
        .route(
            "/api/projects/{pid}",
            get(projects::get)
                .patch(projects::patch)
                .delete(projects::delete),
        )
        .route(
            "/api/projects/{pid}/members",
            get(projects::members).post(projects::add_member),
        )
        .route(
            "/api/projects/{pid}/members/{username}",
            delete(projects::remove_member).patch(projects::patch_member),
        )
        .route(
            "/api/projects/{pid}/members/{username}/invite-remote",
            post(accounts::invite_remote),
        )
        .route("/api/projects/{pid}/tree", get(workspace::tree))
        .route("/api/projects/{pid}/files/move", post(moves::post))
        .route(
            "/api/projects/{pid}/files/move/preview",
            get(moves::preview),
        )
        .route(
            "/api/projects/{pid}/files/{*path}",
            get(workspace::get_file)
                .put(workspace::put_file)
                .delete(workspace::delete_file)
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(
            "/api/projects/{pid}/compile",
            get(compile::get).post(compile::post),
        )
        .route("/api/projects/{pid}/compile/log", get(compile::log))
        .route("/api/projects/{pid}/roots", get(compile::roots))
        .route("/api/projects/{pid}/wordcount", get(compile::wordcount))
        .route("/api/projects/{pid}/pdf/{*root}", get(compile::pdf))
        .route(
            "/api/projects/{pid}/synctex/forward",
            get(compile::synctex_forward),
        )
        .route(
            "/api/projects/{pid}/synctex/inverse",
            get(compile::synctex_inverse),
        )
        .route("/api/projects/{pid}/zotero/import", post(zotero::import))
        .route("/api/projects/{pid}/zotero/refresh", post(zotero::refresh))
        .route(
            "/api/projects/{pid}/zotero/links",
            get(zotero::links)
                .patch(zotero::patch_link)
                .delete(zotero::delete_link),
        )
        .route(
            "/api/projects/{pid}/comments",
            get(comments::list).post(comments::create),
        )
        .route(
            "/api/projects/{pid}/comments/{id}",
            axum::routing::patch(comments::patch).delete(comments::delete),
        )
        .route(
            "/api/projects/{pid}/comments/{id}/messages",
            post(comments::reply),
        )
        .route(
            "/api/projects/{pid}/comments/{id}/messages/{mid}",
            axum::routing::patch(comments::edit_message).delete(comments::delete_message),
        )
        .route(
            "/api/projects/{pid}/chat",
            get(chat::list).post(chat::create),
        )
        .route(
            "/api/projects/{pid}/chat/{id}",
            axum::routing::patch(chat::edit).delete(chat::delete),
        )
        .route("/api/projects/{pid}/spellcheck", post(spellcheck::check))
        .route(
            "/api/projects/{pid}/spellcheck/rules",
            axum::routing::put(spellcheck::put_rules),
        )
        .route(
            "/api/projects/{pid}/dictionary",
            get(spellcheck::dictionary).post(spellcheck::add_word),
        )
        .route(
            "/api/projects/{pid}/dictionary/{word}",
            delete(spellcheck::delete_word),
        )
        .route("/api/projects/{pid}/git/status", get(git::status))
        .route("/api/projects/{pid}/git/diff", get(git::diff))
        .route("/api/projects/{pid}/git/log", get(git::log))
        .route("/api/projects/{pid}/git/coauthors", get(git::coauthors))
        .route(
            "/api/projects/{pid}/git/identity",
            axum::routing::patch(git::patch_identity),
        )
        .route("/api/projects/{pid}/git/commit", post(git::commit))
        .route("/api/projects/{pid}/git/pull", post(git::pull))
        .route("/api/projects/{pid}/git/push", post(git::push))
        .route(
            "/api/projects/{pid}/git/submodule-update",
            post(git::submodule_update),
        )
        .route(
            "/ws/projects/{pid}/events",
            get(events::ws).layer(middleware::from_fn_with_state(
                state.clone(),
                auth::same_origin,
            )),
        )
        .merge(
            Router::new()
                .route("/api/admin/users", get(admin::list).post(admin::create))
                .route(
                    "/api/admin/users/{id}",
                    axum::routing::patch(admin::patch).delete(admin::delete),
                )
                .route_layer(middleware::from_fn(admin::require_admin)),
        )
        .route_layer(middleware::from_fn(auth::require_login))
        // public
        .route("/api/health", get(health))
        .route("/api/auth/providers", get(|| async { Json(providers) }))
        .route("/api/auth/oauth/{provider}/start", get(oauth::start))
        .route("/api/auth/oauth/{provider}/callback", get(oauth::callback));
    // outside require_login: unauthenticated doc sockets get close code 4401 (docs/API.md)
    router = router.route(
        "/ws/projects/{pid}/doc/{*path}",
        get(docs::ws).layer(middleware::from_fn_with_state(
            state.clone(),
            auth::same_origin,
        )),
    );
    if cfg.dev_login {
        router = router.route("/api/auth/dev-login", post(auth::dev_login));
    }

    let router = router
        .route(
            "/api/{*rest}",
            any(|| async { ApiError::not_found("no such endpoint") }),
        )
        .fallback_service(spa)
        .with_state(state.clone())
        .layer(auth_layer)
        .layer(TraceLayer::new_for_http());
    Ok((router, state))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{header, Request},
    };
    use http_body_util::BodyExt;
    use std::str::FromStr;
    use tower::ServiceExt;

    fn test_cfg(dev_login: bool) -> Config {
        Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            // leaked on purpose: tests are short-lived processes
            static_dir: "does-not-exist".into(),
            data: tempfile::tempdir().unwrap().keep(),
            public_url: "http://localhost".into(),
            dev_login,
            github_client_id: None,
            github_client_secret: None,
            google_client_id: None,
            google_client_secret: None,
            secret_key: None,
            github_api_url: "https://api.github.com".into(),
            zotero_api_url: "https://api.zotero.org".into(),
            zotero_sync_secs: 0,
            gitlab_hosts: vec![],
            languagetool_url: None,
        }
    }

    async fn test_app_with(cfg: Config) -> Router {
        test_app_inner(cfg, false).await
    }

    /// `allow_file`: local `file://` remotes (the fixture repos)
    async fn test_app_inner(cfg: Config, allow_file: bool) -> Router {
        test_app_db(cfg, allow_file).await.0
    }

    /// Like `test_app_inner`, also returns the DB.
    async fn test_app_db(cfg: Config, allow_file: bool) -> (Router, SqlitePool) {
        let (app, state) = test_app_state(cfg, allow_file).await;
        (app, state.db.clone())
    }

    async fn test_app_state(cfg: Config, allow_file: bool) -> (Router, Arc<AppState>) {
        // single connection: every in-memory connection would otherwise be its own empty DB
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::from_str("sqlite::memory:").unwrap())
            .await
            .unwrap();
        sqlx::migrate!().run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO users (username, display_name, email, is_admin) VALUES
             ('alice', 'Alice', 'a@x.org', 0), ('bob', 'Bob', 'b@x.org', 0),
             ('carol', 'Carol', 'c@x.org', 0), ('root', 'Root', 'r@x.org', 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        build_with_state(&cfg, db, allow_file).await.unwrap()
    }

    async fn test_app() -> Router {
        test_app_with(test_cfg(true)).await
    }

    /// Returns (status, set-cookie, json body or Null).
    async fn call(app: &Router, req: Request<Body>) -> (u16, Option<String>, Value) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            cookie,
            serde_json::from_slice(&body).unwrap_or(Value::Null),
        )
    }

    fn get(uri: &str, cookie: Option<&str>) -> Request<Body> {
        let mut req = Request::get(uri);
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        req.body(Body::empty()).unwrap()
    }

    fn login(username: &str) -> Request<Body> {
        Request::post("/api/auth/dev-login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "username": username }).to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn health_ok() {
        let (status, _, body) = call(&test_app().await, get("/api/health", None)).await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn unknown_api_route_is_json_404() {
        let (status, _, body) = call(&test_app().await, get("/api/nope", None)).await;
        assert_eq!(status, 404);
        assert_eq!(body["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn login_flow() {
        let app = test_app().await;

        let (status, _, body) = call(&app, get("/api/auth/me", None)).await;
        assert_eq!(status, 401);
        assert_eq!(body["error"]["code"], "unauthorized");

        assert_eq!(call(&app, login("nobody")).await.0, 401);

        let (status, cookie, body) = call(&app, login("alice")).await;
        assert_eq!(status, 200);
        assert_eq!(body["username"], "alice");
        let cookie = cookie.expect("session cookie");
        assert!(cookie.starts_with("undertree_session="));

        let (status, _, body) = call(&app, get("/api/auth/me", Some(&cookie))).await;
        assert_eq!(status, 200);
        assert_eq!(body["display_name"], "Alice");

        let logout = Request::post("/api/auth/logout")
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap();
        assert_eq!(call(&app, logout).await.0, 204);
        assert_eq!(call(&app, get("/api/auth/me", Some(&cookie))).await.0, 401);
    }

    #[tokio::test]
    async fn dev_login_disabled_by_default() {
        let app = test_app_with(test_cfg(false)).await;
        assert_eq!(call(&app, login("alice")).await.0, 404);
        let (_, _, body) = call(&app, get("/api/auth/providers", None)).await;
        assert_eq!(body, json!({ "oauth": [], "dev_login": false }));
    }

    #[test]
    fn dev_login_refused_with_https() {
        let mut cfg = test_cfg(true);
        cfg.public_url = "https://example.org".into();
        assert!(cfg.validate().is_err());
    }

    #[tokio::test]
    async fn oauth_start_and_bad_callback() {
        let mut cfg = test_cfg(false);
        cfg.github_client_id = Some("cid".into());
        cfg.github_client_secret = Some("csecret".into());
        let app = test_app_with(cfg).await;

        let (_, _, body) = call(&app, get("/api/auth/providers", None)).await;
        assert_eq!(body["oauth"], json!(["github"]));
        assert_eq!(
            call(&app, get("/api/auth/oauth/google/start", None))
                .await
                .0,
            404
        );

        let res = app
            .clone()
            .oneshot(get("/api/auth/oauth/github/start?next=/p", None))
            .await
            .unwrap();
        assert_eq!(res.status(), 303);
        let loc = res.headers()[header::LOCATION].to_str().unwrap().to_owned();
        assert!(
            loc.starts_with("https://github.com/login/oauth/authorize?"),
            "{loc}"
        );
        assert!(loc.contains("code_challenge_method=S256"));
        assert!(loc.contains("client_id=cid"));
        assert!(loc.contains(
            "redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Fauth%2Foauth%2Fgithub%2Fcallback"
        ));
        let cookie = res.headers()[header::SET_COOKIE].to_str().unwrap();
        let cookie = cookie.split(';').next().unwrap();

        // forged state: rejected, and the pending login is consumed
        let cb = |q: &str| {
            get(
                &format!("/api/auth/oauth/github/callback?{q}"),
                Some(cookie),
            )
        };
        let res = app
            .clone()
            .oneshot(cb("code=x&state=forged"))
            .await
            .unwrap();
        assert_eq!(res.headers()[header::LOCATION], "/login?error=oauth_failed");
        let res = app
            .clone()
            .oneshot(cb("error=access_denied"))
            .await
            .unwrap();
        assert_eq!(res.headers()[header::LOCATION], "/login?error=oauth_failed");
    }

    #[test]
    fn oauth_needs_id_and_secret() {
        let mut cfg = test_cfg(false);
        cfg.google_client_id = Some("only-id".into());
        assert!(oauth::OAuth::from_config(&cfg).is_err());
    }

    /// App logged in as alice with project 1 cloned from `source` over file://; `papers/b` is
    /// deinitialized again like in the fixture. Returns (app, cookie, project repo dir).
    async fn with_project(source: &std::path::Path) -> (Router, String, PathBuf) {
        with_project_cfg(test_cfg(true), source).await
    }

    async fn with_project_cfg(cfg: Config, source: &std::path::Path) -> (Router, String, PathBuf) {
        let data = cfg.data.clone();
        let app = test_app_inner(cfg, true).await;
        let c = call(&app, login("alice")).await.1.unwrap();
        let (status, _, body) = call(&app, new_project(&c, source, json!({}))).await;
        assert_eq!((status, body["id"].as_i64()), (201, Some(1)), "{body}");
        let repo = data.canonicalize().unwrap().join("projects/1/repo");
        if repo.join("papers/b/.git").exists() {
            workspace::tests::git(&repo, &["submodule", "deinit", "-q", "-f", "papers/b"]);
        }
        (app, c, repo)
    }

    /// POST /api/projects from a local repo; `extra` is merged into the body.
    fn new_project(cookie: &str, source: &std::path::Path, extra: Value) -> Request<Body> {
        let mut body =
            json!({ "name": "Paper", "remote_url": format!("file://{}", source.display()) });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        post_json("/api/projects", cookie, body)
    }

    async fn logged_in(cfg: Config) -> (Router, String) {
        let app = test_app_with(cfg).await;
        let cookie = call(&app, login("alice")).await.1.unwrap();
        (app, cookie)
    }

    fn req(method: &str, uri: &str, cookie: &str, body: &'static str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, cookie)
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn files_api_roundtrip_and_boundaries() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;

        assert_eq!(call(&app, get("/api/projects/1/tree", None)).await.0, 401);
        let (status, _, tree) = call(&app, get("/api/projects/1/tree", Some(&c))).await;
        assert_eq!(status, 200);
        assert_eq!(tree["repos"][1]["path"], "papers/a");
        assert_eq!(tree["repos"][2]["initialized"], false);

        let put = |p: &str, body| req("PUT", &format!("/api/projects/1/files/{p}"), &c, body);
        assert_eq!(
            call(&app, put("papers/a/sec/intro.tex", "hello")).await.0,
            204
        );
        let res = app
            .clone()
            .oneshot(get(
                "/api/projects/1/files/papers/a/sec/intro.tex",
                Some(&c),
            ))
            .await
            .unwrap();
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            &res.into_body().collect().await.unwrap().to_bytes()[..],
            b"hello"
        );
        // percent-encoded separators decode to the same path
        assert_eq!(
            call(
                &app,
                get(
                    "/api/projects/1/files/papers%2Fa%2Fsec%2Fintro.tex",
                    Some(&c)
                )
            )
            .await
            .0,
            200
        );

        let (status, _, body) = call(&app, put("papers/b/x.tex", "x")).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (400, Some("invalid_path"))
        );
        for bad in ["..%2Fescape.tex", ".git/config", "papers/a/.git"] {
            assert_eq!(call(&app, put(bad, "x")).await.0, 400, "{bad}");
        }
        assert!(!parent.parent().unwrap().join("escape.tex").exists());

        let outside = parent.parent().unwrap().join("outside.tex");
        std::fs::write(&outside, "outside").unwrap();
        let planted = parent.join("papers/a/.new.tex.undertree-tmp");
        std::os::unix::fs::symlink(&outside, &planted).unwrap();
        assert_eq!(call(&app, put("papers/a/new.tex", "safe")).await.0, 204);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");
        assert!(std::fs::symlink_metadata(&planted)
            .unwrap()
            .file_type()
            .is_symlink());

        let escaped = parent.join("papers/a/escape.tex");
        std::os::unix::fs::symlink(&outside, &escaped).unwrap();
        assert_eq!(
            call(
                &app,
                get("/api/projects/1/files/papers/a/escape.tex", Some(&c))
            )
            .await
            .0,
            400
        );
        assert_eq!(
            call(
                &app,
                req(
                    "DELETE",
                    "/api/projects/1/files/papers/a/escape.tex",
                    &c,
                    ""
                )
            )
            .await
            .0,
            400
        );
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");

        // symlinks into `.git` (parent repo or hooks) are rejected for PUT/GET/DELETE
        std::os::unix::fs::symlink(".git", parent.join("gitlink")).unwrap();
        std::os::unix::fs::symlink(".git/hooks", parent.join("deep")).unwrap();
        for p in ["gitlink/config", "gitlink/new", "deep/pre-commit", "deep"] {
            let uri = format!("/api/projects/1/files/{p}");
            assert_eq!(call(&app, put(p, "x")).await.0, 400, "PUT {p}");
            assert_eq!(call(&app, get(&uri, Some(&c))).await.0, 400, "GET {p}");
            assert_eq!(
                call(&app, req("DELETE", &uri, &c, "")).await.0,
                400,
                "DELETE {p}"
            );
        }
        assert!(parent.join(".git/config").is_file());
        assert!(!parent.join(".git/hooks/pre-commit").exists());

        let stale = parent.join("papers/b/stale.tex");
        std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
        std::fs::write(&stale, "stale").unwrap();
        assert_eq!(
            call(
                &app,
                get("/api/projects/1/files/papers/b/stale.tex", Some(&c))
            )
            .await
            .0,
            400
        );
        assert_eq!(
            call(&app, put("papers/b/stale.tex", "changed")).await.0,
            400
        );
        assert_eq!(
            call(
                &app,
                req("DELETE", "/api/projects/1/files/papers/b/stale.tex", &c, "")
            )
            .await
            .0,
            400
        );
        assert_eq!(std::fs::read_to_string(&stale).unwrap(), "stale");

        let del = |p: &str| req("DELETE", &format!("/api/projects/1/files/{p}"), &c, "");
        assert_eq!(call(&app, del("papers/a/sec")).await.0, 409);
        assert_eq!(call(&app, del("papers/a/sec/intro.tex")).await.0, 204);
        assert_eq!(call(&app, del("papers/a/sec/intro.tex")).await.0, 404);
        assert_eq!(call(&app, del("papers/a/sec")).await.0, 204);
    }

    fn post_compile(root: &str, cookie: &str) -> Request<Body> {
        Request::post("/api/projects/1/compile")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "root": root }).to_string()))
            .unwrap()
    }

    /// Polls `GET /api/projects/1/compile` until the last result satisfies `done`; panics after 60 s.
    async fn compile_result(app: &Router, c: &str, done: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..600 {
            let (status, _, body) = call(
                app,
                get("/api/projects/1/compile?root=papers/a/main.tex", Some(c)),
            )
            .await;
            if status == 200 && done(&body) {
                return body;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("no matching compile result within 60 s");
    }

    #[tokio::test]
    async fn compile_api_validates_roots() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let stale = parent.join("papers/b/stale.tex");
        std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
        std::fs::write(&stale, "\\documentclass{article}").unwrap();

        assert_eq!(
            call(&app, post_compile("papers/a/main.tex", "x")).await.0,
            401
        );
        for (root, status) in [
            ("../x.tex", 400),
            ("README.md", 400),
            ("papers/a/-x.tex", 400),
            ("papers/a/nope.tex", 404),
            ("papers/b/stale.tex", 400),
        ] {
            assert_eq!(call(&app, post_compile(root, &c)).await.0, status, "{root}");
        }
        let bad_body = req("POST", "/api/projects/1/compile", &c, "{}");
        let (status, _, body) = call(&app, bad_body).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (400, Some("invalid_request"))
        );
        for uri in [
            "/api/projects/1/compile?root=papers/a/main.tex",
            "/api/projects/1/compile/log?root=papers/a/main.tex",
            "/api/projects/1/pdf/papers/a/main.tex",
        ] {
            assert_eq!(call(&app, get(uri, Some(&c))).await.0, 404, "{uri}");
        }
        assert_eq!(
            call(&app, get("/api/projects/1/pdf/../x.tex", Some(&c)))
                .await
                .0,
            400
        );
    }

    #[tokio::test]
    async fn compile_cannot_read_files_outside_the_paper() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        std::fs::write(
            parent.join("papers/a/main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\input{/etc/hostname}\n\\end{document}\n",
        )
        .unwrap();
        let (status, _, body) = call(&app, post_compile("papers/a/main.tex", &c)).await;
        assert_eq!(status, 202, "{body}");
        let res = compile_result(&app, &c, |_| true).await;
        assert_eq!(
            res["state"], "failed",
            "absolute \\input must be refused: {res}"
        );
    }

    /// Every engine runs in the Landlock sandbox: LuaTeX's `io.open` can't read server files.
    #[tokio::test]
    async fn compile_engines_are_sandboxed() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (tmp, parent) = workspace::tests::fixture();
        let secret = tmp.path().join("secret.txt");
        std::fs::write(&secret, "s3cret").unwrap();
        let (app, c, parent) = with_project(&parent).await;
        let (status, _, body) = call(
            &app,
            Request::patch("/api/projects/1")
                .header(header::COOKIE, &c)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"compiler":"lualatex"}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(
            (status, &body["compiler"]),
            (200, &json!("lualatex")),
            "{body}"
        );
        std::fs::write(
            parent.join("papers/a/main.tex"),
            format!(
                "\\documentclass{{article}}\n\\begin{{document}}\nEngine: \\directlua{{tex.print(status.luatex_version and 'lua' or '?')}}\n\
                 \\directlua{{local f = io.open('{}', 'r') if f then error('LEAK ' .. f:read('*a')) end}}\n\\end{{document}}\n",
                secret.display()
            ),
        )
        .unwrap();
        let (status, _, body) = call(&app, post_compile("papers/a/main.tex", &c)).await;
        assert_eq!(status, 202, "{body}");
        let res = compile_result(&app, &c, |_| true).await;
        assert_eq!(
            res["state"], "success",
            "lualatex must run and must not read {secret:?}: {res}"
        );
        assert_eq!(
            (&res["engine"], &res["engine_reason"]),
            (&json!("lualatex"), &json!("fixed"))
        );
        assert!(res["pdf_url"].is_string(), "{res}");
    }

    #[tokio::test]
    async fn compile_rejects_external_symlink_input() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let secret = parent.parent().unwrap().join("secret.tex");
        std::fs::write(&secret, "host-secret-content").unwrap();
        std::os::unix::fs::symlink(&secret, parent.join("papers/a/secret.tex")).unwrap();
        std::fs::write(
            parent.join("papers/a/main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\input{secret.tex}\n\\end{document}\n",
        )
        .unwrap();

        assert_eq!(
            call(&app, post_compile("papers/a/main.tex", &c)).await.0,
            202
        );
        let result = compile_result(&app, &c, |r| r["state"] == "failed").await;
        assert!(!result.to_string().contains("host-secret-content"));
        assert_eq!(
            std::fs::read_to_string(&secret).unwrap(),
            "host-secret-content"
        );
    }

    #[tokio::test]
    async fn compile_rejects_external_symlink_output() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let outside = parent.parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "unchanged").unwrap();
        std::os::unix::fs::symlink(&outside, parent.join("papers/a/output.txt")).unwrap();
        std::fs::write(
            parent.join("papers/a/main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\newwrite\\out\n\\immediate\\openout\\out=output.txt\n\\immediate\\write\\out{changed}\n\\immediate\\closeout\\out\nDone.\n\\end{document}\n",
        )
        .unwrap();

        assert_eq!(
            call(&app, post_compile("papers/a/main.tex", &c)).await.0,
            202
        );
        let result = compile_result(&app, &c, |r| r["state"] == "failed").await;
        assert_eq!(result["state"], "failed");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "unchanged");
    }

    #[tokio::test]
    async fn compile_include_from_subdirectory() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let dir = parent.join("papers/a");
        std::fs::create_dir_all(dir.join("chapters/deep")).unwrap();
        std::fs::write(dir.join("chapters/deep/one.tex"), "One.\n").unwrap();
        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\include{chapters/deep/one}\n\\end{document}\n",
        )
        .unwrap();
        assert_eq!(
            call(&app, post_compile("papers/a/main.tex", &c)).await.0,
            202
        );
        let res = compile_result(&app, &c, |_| true).await;
        assert_eq!(res["state"], "success", "{res}");
    }

    #[tokio::test]
    async fn wordcount_counts_included_files() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let dir = parent.join("papers/a");
        std::fs::create_dir_all(dir.join("sections")).unwrap();
        std::fs::write(
            dir.join("sections/intro.tex"),
            "Intro text has five words.\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\section{Hello World}\nThree words $x$.\n\\input{sections/intro}\n\\end{document}\n",
        )
        .unwrap();
        let wc = |root: &str| get(&format!("/api/projects/1/wordcount?root={root}"), Some(&c));
        assert_eq!(call(&app, wc("../x.tex")).await.0, 400);
        if std::process::Command::new("texcount")
            .arg("-h")
            .output()
            .is_err()
        {
            eprintln!("skipping: texcount not on PATH");
            return;
        }
        // an included file stands for its root
        let (status, _, body) = call(&app, wc("papers/a/sections/intro.tex")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            body,
            json!({
                "words": 7, "headers": 2, "captions": 0, "math_inline": 1, "math_display": 0,
                "per_file": [
                    { "path": "papers/a/main.tex", "words": 2 },
                    { "path": "papers/a/sections/intro.tex", "words": 5 },
                ],
            })
        );
        // the private snapshot is gone
        let tmp = parent.parent().unwrap().join("tmp");
        assert_eq!(std::fs::read_dir(tmp).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn clean_compile_removes_stale_build_output() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        std::fs::write(
            parent.join("papers/a/main.tex"),
            "\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n",
        )
        .unwrap();
        let out = parent.parent().unwrap().join("build/papers/a/main.tex");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("stale.aux"), "stale").unwrap();
        let body = json!({ "root": "papers/a/main.tex", "clean": true });
        let (status, _, _) = call(&app, post_json("/api/projects/1/compile", &c, body)).await;
        assert_eq!(status, 202);
        let res = compile_result(&app, &c, |_| true).await;
        assert_eq!(res["state"], "success", "{res}");
        assert!(!out.join("stale.aux").exists());
        assert!(out.join("main.aux").exists());
    }

    #[tokio::test]
    async fn synctex_forward_and_inverse() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let carol = cookie_of(&app, "carol").await;
        let sync = |q: &str, c: &str| get(&format!("/api/projects/1/synctex/{q}"), Some(c));
        let fwd = |file: &str, line: u32| {
            format!("forward?root=papers/a/main.tex&file={file}&line={line}&column=0")
        };
        let inv = |page: u32, x: f64, y: f64| {
            format!("inverse?root=papers/a/main.tex&page={page}&x={x}&y={y}")
        };

        let dir = parent.join("papers/a");
        std::fs::create_dir_all(dir.join("sections")).unwrap();
        std::fs::write(
            dir.join("sections/intro.tex"),
            "Hello from the intro.\n\nSecond paragraph of the intro.\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\nFirst page text.\n\\newpage\n\\input{sections/intro}\n\\end{document}\n",
        )
        .unwrap();

        for q in [fwd("papers/a/main.tex", 3), inv(1, 100.0, 100.0)] {
            let (status, _, body) = call(&app, sync(&q, &c)).await;
            assert_eq!(
                (status, body["error"]["code"].as_str()),
                (404, Some("no_synctex")),
                "{q}"
            );
            assert_eq!(call(&app, sync(&q, &carol)).await.0, 404, "non-member");
        }
        for q in [
            "forward?root=../x.tex&file=papers/a/main.tex&line=1",
            "forward?root=papers/a/main.tex&file=papers/a/../../x.tex&line=1",
            "forward?root=papers/a/main.tex&file=/etc/passwd&line=1",
            "forward?root=papers/a/main.tex&file=papers/b/x.tex&line=1",
            "forward?root=papers/a/main.tex&file=papers/a/main.tex&line=-1",
            "forward?root=papers/a/main.tex&file=papers/a/main.tex",
            "inverse?root=papers/a/main.tex&page=1&x=NaN&y=1",
            "inverse?root=papers/a/main.tex&page=1&x=inf&y=1",
            "inverse?root=papers/a/main.tex&page=1&x=-1&y=1",
            "inverse?root=papers/a/main.tex&page=1&x=1&y=100001",
            "inverse?root=papers/a/main.tex&page=-1&x=1&y=1",
            // 1-based
            "forward?root=papers/a/main.tex&file=papers/a/main.tex&line=0",
            "inverse?root=papers/a/main.tex&page=0&x=1&y=1",
        ] {
            assert_eq!(call(&app, sync(q, &c)).await.0, 400, "{q}");
        }

        let has = |cmd: &str, arg: &str| std::process::Command::new(cmd).arg(arg).output().is_ok();
        if !has("latexmk", "-v") || !has("synctex", "help") {
            eprintln!("skipping: latexmk or synctex not on PATH");
            return;
        }
        assert_eq!(
            call(&app, post_compile("papers/a/main.tex", &c)).await.0,
            202
        );
        let res = compile_result(&app, &c, |_| true).await;
        assert_eq!(res["state"], "success", "{res}");

        // source -> PDF -> source, for the root and for an included file in a subdirectory
        let mut tops = Vec::new();
        for (file, line, page) in [
            ("papers/a/main.tex", 3, 1),
            ("papers/a/sections/intro.tex", 1, 2),
            ("papers/a/sections/intro.tex", 3, 2),
        ] {
            let (status, _, boxes) = call(&app, sync(&fwd(file, line), &c)).await;
            assert_eq!(status, 200, "{boxes}");
            let b = &boxes[0];
            assert_eq!(b["page"], page, "{boxes}");
            let n = |k: &str| b[k].as_f64().unwrap();
            // A4 in points, origin top left: the first line of a page is near the top
            assert!(n("x") > 50.0 && n("w") > 10.0 && n("h") > 1.0, "{boxes}");
            assert!(n("y") > 50.0 && n("y") + n("h") < 842.0, "{boxes}");
            tops.push(n("y"));
            let (x, y) = (n("x") + n("w") / 2.0, n("y") + n("h") / 2.0);
            let (status, _, pos) = call(&app, sync(&inv(page, x, y), &c)).await;
            assert_eq!(status, 200, "{pos}");
            assert_eq!(pos["file"], file, "{pos}");
            assert!(
                pos["line"].as_u64().unwrap().abs_diff(line.into()) <= 1,
                "{pos}"
            );
            assert_eq!(pos["column"], 0, "{pos}");
        }
        assert!(tops[2] > tops[1], "y grows downwards: {tops:?}");

        // no such page; a file that isn't part of this root's PDF
        let (status, _, body) = call(&app, sync(&inv(99, 100.0, 100.0), &c)).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (404, Some("no_match"))
        );
        for file in ["README.md", "papers/a/unused.tex"] {
            let (status, _, boxes) = call(&app, sync(&fwd(file, 1), &c)).await;
            assert_eq!((status, boxes), (200, json!([])), "{file}");
        }

        // an included file as `root` stands for its root, like `POST …/compile`
        let q = "forward?root=papers/a/sections/intro.tex&file=papers/a/sections/intro.tex&line=1";
        let (status, _, boxes) = call(&app, sync(q, &c)).await;
        assert_eq!((status, &boxes[0]["page"]), (200, &json!(2)), "{boxes}");
        // a .tex nothing includes: the repo's only root (no root at all → `no_root`, as in compile)
        std::fs::write(dir.join("loose.tex"), "loose\n").unwrap();
        let q = "inverse?root=papers/a/loose.tex&page=2&x=100&y=130";
        let (status, _, pos) = call(&app, sync(q, &c)).await;
        assert_eq!(status, 200, "{pos}");

        // a run that writes no SyncTeX data must not leave the previous run's behind
        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass{nosuchclassxyz}\n\\begin{document}\nx\n\\end{document}\n",
        )
        .unwrap();
        assert_eq!(
            call(&app, post_compile("papers/a/main.tex", &c)).await.0,
            202
        );
        let res = compile_result(&app, &c, |r| r["state"] == "failed").await;
        assert_eq!(res["state"], "failed", "{res}");
        let (status, _, body) = call(&app, sync(&fwd("papers/a/main.tex", 3), &c)).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (404, Some("no_synctex")),
            "{body}"
        );
    }

    #[tokio::test]
    async fn compile_success_then_auto_recompile_failure() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let dir = parent.join("papers/a");
        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n",
        )
        .unwrap();

        let (status, _, body) = call(&app, post_compile("papers/a/main.tex", &c)).await;
        assert_eq!(status, 202);
        assert_eq!(
            body,
            json!({ "root": "papers/a/main.tex", "state": "queued" })
        );
        let ok = compile_result(&app, &c, |_| true).await;
        assert_eq!(ok["state"], "success", "{ok}");
        let pdf_url = ok["pdf_url"].as_str().unwrap();
        assert!(
            pdf_url.starts_with("/api/projects/1/pdf/papers/a/main.tex?v="),
            "{pdf_url}"
        );

        let res = app.clone().oneshot(get(pdf_url, Some(&c))).await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "application/pdf");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-cache");
        let pdf = res.into_body().collect().await.unwrap().to_bytes();
        assert!(pdf.starts_with(b"%PDF"));
        // build output stays out of the working tree
        assert!(!dir.join("main.aux").exists() && !dir.join("main.pdf").exists());

        // a change in the same repo recompiles the known root, without another POST
        std::fs::create_dir(dir.join("sec")).unwrap();
        std::fs::write(dir.join("sec/intro.tex"), "Intro.\n\n\\foo\n").unwrap();
        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\input{sec/intro}\n\\end{document}\n",
        )
        .unwrap();
        let failed = compile_result(&app, &c, |r| r["state"] == "failed").await;
        // like Overleaf: TeX kept going, the run's PDF is shown next to the errors
        assert!(failed["pdf_url"].is_string(), "{failed}");
        assert_eq!(
            failed["diagnostics"][0],
            json!({ "severity": "error", "file": "papers/a/sec/intro.tex", "line": 3,
                    "message": "Undefined control sequence." }),
            "{failed}"
        );
        // last good PDF is still served
        assert_eq!(call(&app, get(pdf_url, Some(&c))).await.0, 200);
        let res = app
            .clone()
            .oneshot(get(
                "/api/projects/1/compile/log?root=papers/a/main.tex",
                Some(&c),
            ))
            .await
            .unwrap();
        let log = res.into_body().collect().await.unwrap().to_bytes();
        assert!(
            String::from_utf8_lossy(&log).contains("Undefined control sequence"),
            "{}",
            String::from_utf8_lossy(&log)
        );
    }

    fn patch_compiler(cookie: &str, compiler: &str) -> Request<Body> {
        Request::patch("/api/projects/1")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "compiler": compiler }).to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn roots_and_root_resolution() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        // papers/a/main.tex is just "x": its repo has no root
        let (status, _, err) = call(&app, post_compile("papers/a/main.tex", &c)).await;
        assert_eq!(
            (status, &err["error"]["code"]),
            (400, &json!("no_root")),
            "{err}"
        );
        assert_eq!(
            call(&app, get("/api/projects/1/roots", Some(&c))).await.2,
            json!([])
        );

        let dir = parent.join("papers/a");
        std::fs::create_dir_all(dir.join("chapters")).unwrap();
        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass[ngerman]{article}\n\\usepackage{fontspec}\n\\begin{document}\n\
             \\input{chapters/one}\n\\end{document}\n",
        )
        .unwrap();
        std::fs::write(dir.join("chapters/one.tex"), "One.\n").unwrap();
        std::fs::write(
            parent.join("notes.tex"),
            "% !TeX TS-program = lualatex\n\\begin{document}\n\\end{document}\n",
        )
        .unwrap();
        // not listed: hidden, build folder, uninitialized submodule, commented out
        for hidden in [".cache/x.tex", "build/y.tex", "papers/b/stale.tex"] {
            let path = parent.join(hidden);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "\\begin{document}").unwrap();
        }
        std::fs::write(parent.join("draft.tex"), "% \\begin{document}").unwrap();

        let (status, _, roots) = call(&app, get("/api/projects/1/roots", Some(&c))).await;
        assert_eq!(status, 200);
        assert_eq!(
            roots,
            json!([
                { "path": "notes.tex", "repo": "", "engine": "lualatex", "reason": "magic_comment",
                  "language": "auto" },
                { "path": "papers/a/main.tex", "repo": "papers/a", "engine": "xelatex",
                  "reason": "package:fontspec", "language": "de-DE" },
            ])
        );
        assert_eq!(call(&app, get("/api/projects/1/roots", None)).await.0, 401);

        // an included file compiles its root
        let (status, _, body) = call(&app, post_compile("papers/a/chapters/one.tex", &c)).await;
        assert_eq!(
            (status, body),
            (
                202,
                json!({ "root": "papers/a/main.tex", "state": "queued" })
            )
        );
        // the parent repo's root, not the submodule's
        let (status, _, body) = call(&app, post_compile("draft.tex", &c)).await;
        assert_eq!(
            (status, &body["root"]),
            (202, &json!("notes.tex")),
            "{body}"
        );
    }

    fn patch_main_files(cookie: &str, files: Value) -> Request<Body> {
        Request::patch("/api/projects/1")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "main_files": files }).to_string()))
            .unwrap()
    }

    fn post_compile_no_root(cookie: &str) -> Request<Body> {
        post_json("/api/projects/1/compile", cookie, json!({}))
    }

    const DOC: &str =
        "\\documentclass{article}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n";

    #[tokio::test]
    async fn main_files_patch_and_json() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let dir = parent.join("papers/a");
        std::fs::create_dir_all(dir.join("chapters")).unwrap();
        std::fs::write(dir.join("main.tex"), DOC).unwrap();
        std::fs::write(dir.join("chapters/one.tex"), "One.\n").unwrap();
        std::fs::write(parent.join("notes.tex"), "\\begin{document}\\end{document}").unwrap();
        let stale = parent.join("papers/b/stale.tex");
        std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
        std::fs::write(&stale, "\\begin{document}").unwrap();

        let (_, _, p) = call(&app, get("/api/projects/1", Some(&c))).await;
        assert_eq!(p["main_files"], json!([]));
        // included file, traversal, missing file, uninitialized submodule, too many
        let (status, _, err) = call(
            &app,
            patch_main_files(&c, json!(["papers/a/chapters/one.tex"])),
        )
        .await;
        assert_eq!(
            (status, &err["error"]["code"]),
            (400, &json!("no_root")),
            "{err}"
        );
        for (files, expected) in [
            (json!(["../x.tex"]), 400),
            (json!(["papers/a/gone.tex"]), 404),
            (json!(["papers/b/stale.tex"]), 400),
            (json!(vec!["notes.tex"; 21]), 400),
        ] {
            let (status, _, err) = call(&app, patch_main_files(&c, files.clone())).await;
            assert_eq!(status, expected, "{files}: {err}");
        }
        // nothing was stored by the failed attempts
        let (_, _, p) = call(&app, get("/api/projects/1", Some(&c))).await;
        assert_eq!(p["main_files"], json!([]));

        // order kept, duplicates dropped; shows up in GET and the list
        let (status, _, p) = call(
            &app,
            patch_main_files(
                &c,
                json!(["papers/a/main.tex", "notes.tex", "papers/a/main.tex"]),
            ),
        )
        .await;
        assert_eq!(status, 200, "{p}");
        let want = json!(["papers/a/main.tex", "notes.tex"]);
        assert_eq!(p["main_files"], want);
        let (_, _, p) = call(&app, get("/api/projects/1", Some(&c))).await;
        assert_eq!(p["main_files"], want);
        let (_, _, list) = call(&app, get("/api/projects", Some(&c))).await;
        assert_eq!(list[0]["main_files"], want);
        // other fields leave it alone, [] = automatic again
        let (_, _, p) = call(&app, patch_compiler(&c, "xelatex")).await;
        assert_eq!(p["main_files"], want);
        let (_, _, p) = call(&app, patch_main_files(&c, json!([]))).await;
        assert_eq!(p["main_files"], json!([]));
    }

    #[tokio::test]
    async fn main_files_steer_compile_resolution() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let dir = parent.join("papers/a");
        std::fs::create_dir_all(dir.join("chapters")).unwrap();
        // aa.tex wins the automatic resolution of one.tex (alphabetic), z.tex is the main file
        std::fs::write(dir.join("aa.tex"), DOC).unwrap();
        std::fs::write(dir.join("z.tex"), DOC).unwrap();
        std::fs::write(dir.join("chapters/one.tex"), "One.\n").unwrap();
        std::fs::write(dir.join("loose.tex"), "Loose.\n").unwrap();
        std::fs::write(parent.join("notes.tex"), "\\begin{document}\\end{document}").unwrap();

        // without a main file `root` is required, as before
        let (status, _, err) = call(&app, post_compile_no_root(&c)).await;
        assert_eq!(
            (status, &err["error"]["code"]),
            (400, &json!("no_root")),
            "{err}"
        );
        let (_, _, body) = call(&app, post_compile("papers/a/chapters/one.tex", &c)).await;
        assert_eq!(body["root"], "papers/a/aa.tex", "{body}");

        let mains = json!(["notes.tex", "papers/a/z.tex", "papers/a/aa.tex"]);
        assert_eq!(call(&app, patch_main_files(&c, mains)).await.0, 200);
        // omitted root: the first main file
        let (status, _, body) = call(&app, post_compile_no_root(&c)).await;
        assert_eq!(
            (status, &body["root"]),
            (202, &json!("notes.tex")),
            "{body}"
        );
        // an included file: the main file of its repo that includes it (not aa.tex, not notes.tex)
        let (_, _, body) = call(&app, post_compile("papers/a/chapters/one.tex", &c)).await;
        assert_eq!(body["root"], "papers/a/z.tex", "{body}");
        // included by none: the repo's first main file, not the nearest root
        let (_, _, body) = call(&app, post_compile("papers/a/loose.tex", &c)).await;
        assert_eq!(body["root"], "papers/a/z.tex", "{body}");
        // a root compiles itself
        let (_, _, body) = call(&app, post_compile("papers/a/aa.tex", &c)).await;
        assert_eq!(body["root"], "papers/a/aa.tex", "{body}");
        // a stale main file (deleted) falls back to the old logic
        std::fs::remove_file(dir.join("z.tex")).unwrap();
        let (_, _, body) = call(&app, post_compile("papers/a/chapters/one.tex", &c)).await;
        assert_eq!(body["root"], "papers/a/aa.tex", "{body}");
        // omitted root skips stale entries too (notes.tex and z.tex are gone)
        std::fs::remove_file(parent.join("notes.tex")).unwrap();
        let (status, _, body) = call(&app, post_compile_no_root(&c)).await;
        assert_eq!(
            (status, &body["root"]),
            (202, &json!("papers/a/aa.tex")),
            "{body}"
        );
        // saving the stored list again drops the stale entries instead of failing; new ones
        // still have to exist
        let mains = json!(["notes.tex", "papers/a/z.tex", "papers/a/aa.tex"]);
        let (status, _, p) = call(&app, patch_main_files(&c, mains)).await;
        assert_eq!(
            (status, &p["main_files"]),
            (200, &json!(["papers/a/aa.tex"])),
            "{p}"
        );
        let mains = json!(["papers/a/aa.tex", "papers/a/new.tex"]);
        assert_eq!(call(&app, patch_main_files(&c, mains)).await.0, 404);
    }

    #[tokio::test]
    async fn stored_main_file_in_uninitialized_submodule_is_kept() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        workspace::tests::git(
            &parent,
            &["submodule", "update", "--init", "-q", "papers/b"],
        );
        std::fs::write(parent.join("papers/b/other.tex"), "\\begin{document}").unwrap();
        std::fs::write(parent.join("notes.tex"), "\\begin{document}").unwrap();
        let mains = json!(["papers/b/other.tex", "notes.tex"]);
        let (status, _, p) = call(&app, patch_main_files(&c, mains.clone())).await;
        assert_eq!((status, &p["main_files"]), (200, &mains), "{p}");
        // the submodule is deinitialized, notes.tex is deleted: only the latter is dropped
        workspace::tests::git(&parent, &["submodule", "deinit", "-q", "-f", "papers/b"]);
        std::fs::remove_file(parent.join("notes.tex")).unwrap();
        let (status, _, p) = call(&app, patch_main_files(&c, mains)).await;
        assert_eq!(
            (status, &p["main_files"]),
            (200, &json!(["papers/b/other.tex"])),
            "{p}"
        );
        // a stored file that stopped being a root is dropped too
        std::fs::write(parent.join("notes.tex"), "\\begin{document}").unwrap();
        let mains = json!(["papers/b/other.tex", "notes.tex"]);
        assert_eq!(call(&app, patch_main_files(&c, mains.clone())).await.0, 200);
        std::fs::write(parent.join("notes.tex"), "plain").unwrap();
        let (status, _, p) = call(&app, patch_main_files(&c, mains)).await;
        assert_eq!(
            (status, &p["main_files"]),
            (200, &json!(["papers/b/other.tex"])),
            "{p}"
        );
    }

    #[tokio::test]
    async fn main_file_recompiles_after_save_without_prior_compile() {
        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping: latexmk not on PATH");
            return;
        }
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let dir = parent.join("papers/a");
        std::fs::create_dir_all(dir.join("chapters")).unwrap();
        std::fs::write(dir.join("main.tex"), DOC).unwrap();
        std::fs::write(dir.join("chapters/one.tex"), "One.\n").unwrap();
        let (status, _, p) = call(&app, patch_main_files(&c, json!(["papers/a/main.tex"]))).await;
        assert_eq!(status, 200, "{p}");
        // main.tex was never compiled; saving another file of its repo compiles it
        let url = "/api/projects/1/compile?root=papers/a/main.tex";
        assert_eq!(call(&app, get(url, Some(&c))).await.0, 404);
        std::fs::write(dir.join("chapters/one.tex"), "One, saved.\n").unwrap();
        let res = compile_result(&app, &c, |r| r["state"] == "success").await;
        assert_eq!(res["state"], "success", "{res}");
    }

    #[tokio::test]
    async fn compiler_auto_and_fixed() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let (_, _, p) = call(&app, get("/api/projects/1", Some(&c))).await;
        assert_eq!(p["compiler"], "auto", "new projects detect the engine");
        let (status, _, p) = call(&app, patch_compiler(&c, "xelatex")).await;
        assert_eq!((status, &p["compiler"]), (200, &json!("xelatex")), "{p}");
        let (status, _, p) = call(&app, patch_compiler(&c, "auto")).await;
        assert_eq!((status, &p["compiler"]), (200, &json!("auto")), "{p}");
        let (_, _, list) = call(&app, get("/api/projects", Some(&c))).await;
        assert_eq!(list[0]["compiler"], "auto");
        assert!(call(&app, patch_compiler(&c, "tex")).await.0 >= 400);

        if std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_err()
        {
            eprintln!("skipping compile: latexmk not on PATH");
            return;
        }
        std::fs::write(
            parent.join("papers/a/main.tex"),
            "\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\n\
             \\ifdefined\\XeTeXversion XeTeX\\else\\errmessage{not XeTeX}\\fi\n\\end{document}\n",
        )
        .unwrap();
        assert_eq!(
            call(&app, post_compile("papers/a/main.tex", &c)).await.0,
            202
        );
        let res = compile_result(&app, &c, |_| true).await;
        assert_eq!(
            (&res["state"], &res["engine"], &res["engine_reason"]),
            (
                &json!("success"),
                &json!("xelatex"),
                &json!("package:fontspec")
            ),
            "{res}"
        );
    }

    #[tokio::test]
    async fn events_ws_rejects_foreign_origin() {
        let (app, c) = logged_in(test_cfg(true)).await;
        let mut r = get("/ws/projects/1/events", Some(&c));
        r.headers_mut()
            .insert(header::ORIGIN, "http://evil.example".parse().unwrap());
        assert_eq!(call(&app, r).await.0, 403);
        assert_eq!(
            call(&app, get("/ws/projects/1/events", Some(&c))).await.0,
            403
        );
        assert_eq!(
            call(&app, get("/ws/projects/1/doc/papers/a/main.tex", Some(&c)))
                .await
                .0,
            403
        );
        assert_eq!(call(&app, get("/ws/projects/1/events", None)).await.0, 401);
    }

    #[test]
    fn origin_strips_path() {
        let mut cfg = test_cfg(false);
        cfg.public_url = "https://tex.example.org/".into();
        assert_eq!(cfg.origin(), "https://tex.example.org");
        cfg.public_url = "http://localhost:5173".into();
        assert_eq!(cfg.origin(), "http://localhost:5173");
    }

    fn post_json(uri: &str, cookie: &str, body: Value) -> Request<Body> {
        Request::post(uri)
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn git_api_rejects_submodule_symlink_outside_workspace() {
        let (tmp, parent) = workspace::tests::fixture();
        let (app, c, parent) = with_project(&parent).await;
        let submodule = parent.join("papers/a");
        let backup = parent.join("papers/a-backup");
        std::fs::rename(&submodule, &backup).unwrap();
        // a real repo outside the workspace
        std::os::unix::fs::symlink(tmp.path().join("a"), &submodule).unwrap();

        let (status, _, _) = call(
            &app,
            get("/api/projects/1/git/status?repo=papers/a", Some(&c)),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(
            call(
                &app,
                post_json(
                    "/api/projects/1/git/submodule-update",
                    &c,
                    json!({ "path": "papers/a" })
                )
            )
            .await
            .0,
            400
        );
    }

    #[tokio::test]
    async fn commit_takes_only_selected_paths() {
        use workspace::tests::git;
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        git(t, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(t, &["clone", "-q", "remote.git", "seed"]);
        let seed = t.join("seed");
        std::fs::write(seed.join("README.md"), "r").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-qm", "init"]);
        git(&seed, &["push", "-q", "-u", "origin", "main"]);

        let (app, c, ws) = with_project(&t.join("remote.git")).await;
        for f in ["a.tex", "b.tex"] {
            let path = format!("/api/projects/1/files/{f}");
            assert_eq!(call(&app, req("PUT", &path, &c, f)).await.0, 204);
        }
        git(&ws, &["add", "b.tex"]); // staged outside undertree, not selected
        let body = json!({ "repo": "", "message": "only a", "paths": ["a.tex"] });
        let (status, _, body) = call(&app, post_json("/api/projects/1/git/commit", &c, body)).await;
        assert_eq!(status, 200, "{body}");

        let out = |args: &[&str]| {
            let o = std::process::Command::new("git")
                .args(args)
                .current_dir(&ws)
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stdout).into_owned()
        };
        assert_eq!(
            out(&["show", "--name-only", "--format=", "HEAD"]),
            "a.tex\n"
        );
        // b.tex stays staged, a.tex is clean (real index moved forward)
        assert_eq!(out(&["status", "--porcelain"]), "A  b.tex\n");

        // two concurrent commits of different paths each contain only their own path
        for f in ["c.tex", "d.tex"] {
            let path = format!("/api/projects/1/files/{f}");
            assert_eq!(call(&app, req("PUT", &path, &c, f)).await.0, 204);
        }
        let commit = |f: &str| {
            let body = json!({ "repo": "", "message": f, "paths": [f] });
            call(&app, post_json("/api/projects/1/git/commit", &c, body))
        };
        let (r1, r2) = tokio::join!(commit("c.tex"), commit("d.tex"));
        assert_eq!((r1.0, r2.0), (200, 200), "{} {}", r1.2, r2.2);
        for rev in ["HEAD", "HEAD~1"] {
            // subject = the one file the commit was asked to contain
            let shown = out(&["show", "--name-only", "--format=%s", rev]);
            let (subject, files) = shown.split_once("\n\n").unwrap();
            assert_eq!(files, format!("{subject}\n"), "{rev}: {shown}");
        }
        assert_eq!(out(&["status", "--porcelain"]), "A  b.tex\n");
        let leftovers = std::fs::read_dir(ws.join(".git")).unwrap().filter(|e| {
            let name = e.as_ref().unwrap().file_name();
            name.to_string_lossy().starts_with("undertree-commit")
        });
        assert_eq!(leftovers.count(), 0, "temporary index files are removed");
    }

    #[tokio::test]
    async fn git_commit_push_pull_and_conflicts() {
        use workspace::tests::git;
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        git(t, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(t, &["clone", "-q", "remote.git", "seed"]);
        git(t, &["clone", "-q", "remote.git", "other"]);
        let (seed, other) = (t.join("seed"), t.join("other"));
        std::fs::write(seed.join("README.md"), "r").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-qm", "init"]);
        git(&seed, &["push", "-q", "-u", "origin", "main"]);

        let (app, c, ws) = with_project(&t.join("remote.git")).await;
        let commit = |msg: &str| {
            post_json(
                "/api/projects/1/git/commit",
                &c,
                json!({ "repo": "", "message": msg }),
            )
        };

        assert_eq!(
            call(
                &app,
                req("PUT", "/api/projects/1/files/paper.tex", &c, "v1")
            )
            .await
            .0,
            204
        );
        let (status, _, body) = call(&app, commit("add paper")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["short"].as_str().unwrap().len(), 7);
        let author = std::process::Command::new("git")
            .args(["log", "-1", "--format=%an <%ae>"])
            .current_dir(&ws)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&author.stdout).trim(),
            "Alice <a@x.org>"
        );
        let (status, _, body) = call(&app, commit("again")).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (409, Some("conflict"))
        );

        let (_, _, st) = call(&app, get("/api/projects/1/git/status?repo=", Some(&c))).await;
        assert_eq!(
            (st["upstream"].as_str(), st["ahead"].as_u64()),
            (Some("origin/main"), Some(1))
        );
        let (status, _, body) = call(
            &app,
            post_json("/api/projects/1/git/push", &c, json!({ "repo": "" })),
        )
        .await;
        assert_eq!(status, 200, "{body}");

        // someone else pushes; pull fast-forwards our working tree
        git(&other, &["pull", "-q"]);
        std::fs::write(other.join("paper.tex"), "v2").unwrap();
        git(&other, &["commit", "-qam", "v2"]);
        git(&other, &["push", "-q"]);
        let (status, _, body) = call(
            &app,
            post_json("/api/projects/1/git/pull", &c, json!({ "repo": "" })),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(std::fs::read_to_string(ws.join("paper.tex")).unwrap(), "v2");

        // diverged history: push is rejected with 409
        std::fs::write(other.join("paper.tex"), "v3-other").unwrap();
        git(&other, &["commit", "-qam", "v3"]);
        git(&other, &["push", "-q"]);
        assert_eq!(
            call(&app, req("PUT", "/api/projects/1/files/b.tex", &c, "b"))
                .await
                .0,
            204
        );
        assert_eq!(call(&app, commit("b")).await.0, 200);
        let (status, _, body) = call(
            &app,
            post_json("/api/projects/1/git/push", &c, json!({ "repo": "" })),
        )
        .await;
        assert_eq!(status, 409, "{body}");
        let (status, _, _) = call(
            &app,
            post_json("/api/projects/1/git/pull", &c, json!({ "repo": "" })),
        )
        .await;
        assert_eq!(status, 409);

        assert_eq!(
            call(&app, req("PUT", "/api/projects/1/files/b.tex", &c, "b2"))
                .await
                .0,
            204
        );
        let res = app
            .clone()
            .oneshot(get("/api/projects/1/git/diff?repo=&path=b.tex", Some(&c)))
            .await
            .unwrap();
        let diff = res.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&diff).contains("+b2"));
        let (_, _, log) = call(&app, get("/api/projects/1/git/log?repo=&limit=2", Some(&c))).await;
        assert_eq!(log[0]["subject"], "b");
        assert_eq!(log.as_array().unwrap().len(), 2);

        assert_eq!(
            call(&app, get("/api/projects/1/git/status?repo=nope", Some(&c)))
                .await
                .0,
            400
        );
        let bad = post_json(
            "/api/projects/1/git/commit",
            &c,
            json!({ "repo": "", "message": "x", "paths": ["../x"] }),
        );
        assert_eq!(call(&app, bad).await.0, 400);
    }

    #[tokio::test]
    async fn submodule_update_from_ui() {
        use workspace::tests::{fixture, git};
        let (tmp, parent) = fixture();
        // the fixture's submodule remotes are local paths: allowed by the test app (`allow_file`)
        let sub_origin = tmp.path().join("a");
        std::fs::write(sub_origin.join("main.tex"), "upstream change").unwrap();
        git(&sub_origin, &["commit", "-qam", "upstream"]);

        let (app, c, parent) = with_project(&parent).await;
        let update = post_json(
            "/api/projects/1/git/submodule-update",
            &c,
            json!({ "path": "papers/a" }),
        );
        let (status, _, body) = call(&app, update).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            std::fs::read_to_string(parent.join("papers/a/main.tex")).unwrap(),
            "upstream change"
        );
        let (_, _, st) = call(&app, get("/api/projects/1/git/status?repo=", Some(&c))).await;
        assert!(
            st["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["path"] == "papers/a"),
            "{st}"
        );

        // an uninitialized submodule is not a repo for git ops until it is initialized
        assert_eq!(
            call(
                &app,
                get("/api/projects/1/git/status?repo=papers/b", Some(&c))
            )
            .await
            .0,
            400
        );
        let init = post_json(
            "/api/projects/1/git/submodule-update",
            &c,
            json!({ "path": "papers/b", "remote": false }),
        );
        assert_eq!(call(&app, init).await.0, 200);
        assert_eq!(
            call(
                &app,
                get("/api/projects/1/git/status?repo=papers/b", Some(&c))
            )
            .await
            .0,
            200
        );
        let bad = post_json(
            "/api/projects/1/git/submodule-update",
            &c,
            json!({ "path": "papers" }),
        );
        assert_eq!(call(&app, bad).await.0, 400);
    }

    fn json_req(method: &str, uri: &str, cookie: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn cookie_of(app: &Router, user: &str) -> String {
        call(app, login(user)).await.1.unwrap()
    }

    #[tokio::test]
    async fn project_access_control_and_members() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, alice, _) = with_project(&parent).await;
        let bob = cookie_of(&app, "bob").await;
        let carol = cookie_of(&app, "carol").await;
        let root = cookie_of(&app, "root").await;
        let status = |c: &str, uri: &str| {
            let (app, c, uri) = (app.clone(), c.to_owned(), uri.to_owned());
            async move { call(&app, get(&uri, Some(&c))).await.0 }
        };

        let (_, _, p) = call(&app, get("/api/projects/1", Some(&alice))).await;
        assert_eq!(
            (
                &p["name"],
                &p["owner"],
                &p["role"],
                &p["branch"],
                &p["has_token"]
            ),
            (
                &json!("Paper"),
                &json!("alice"),
                &json!("owner"),
                &json!("main"),
                &json!(false)
            ),
            "{p}"
        );
        assert!(p["created_at"].as_str().unwrap().ends_with('Z'), "{p}");

        // not a member / nonexistent / malformed: all the same 404
        for (c, uri) in [
            (&bob, "/api/projects/1"),
            (&carol, "/api/projects/1/tree"),
            (&carol, "/api/projects/1/files/README.md"),
            (&carol, "/api/projects/1/git/status?repo="),
            (&alice, "/api/projects/2/tree"),
            (&alice, "/api/projects/x/tree"),
        ] {
            assert_eq!(status(c, uri).await, 404, "{uri}");
        }
        let (_, _, list) = call(&app, get("/api/projects", Some(&carol))).await;
        assert_eq!(list, json!([]));

        let add = |c: &str, user: &str| {
            post_json("/api/projects/1/members", c, json!({ "username": user }))
        };
        assert_eq!(call(&app, add(&alice, "bob")).await.0, 201);
        assert_eq!(call(&app, add(&alice, "bob")).await.0, 409);
        assert_eq!(call(&app, add(&alice, "alice")).await.0, 409);
        assert_eq!(call(&app, add(&alice, "nobody")).await.0, 404);

        // member: full workspace access, no management
        assert_eq!(status(&bob, "/api/projects/1/tree").await, 200);
        let (_, _, p) = call(&app, get("/api/projects/1", Some(&bob))).await;
        assert_eq!(p["role"], "member");
        assert_eq!(call(&app, add(&bob, "carol")).await.0, 403);
        let rename = |c: &str| json_req("PATCH", "/api/projects/1", c, json!({ "name": "New" }));
        assert_eq!(call(&app, rename(&bob)).await.0, 403);
        assert_eq!(
            call(&app, req("DELETE", "/api/projects/1", &bob, ""))
                .await
                .0,
            403
        );

        // admin: sees and manages everything, also while being a plain member
        let (_, _, p) = call(&app, get("/api/projects/1", Some(&root))).await;
        assert_eq!(p["role"], "admin");
        assert_eq!(status(&root, "/api/projects/1/tree").await, 200);
        let (_, _, list) = call(&app, get("/api/projects", Some(&root))).await;
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(call(&app, add(&alice, "root")).await.0, 201);
        let (code, _, p) = call(&app, rename(&root)).await;
        assert_eq!(
            (code, &p["name"], &p["role"]),
            (200, &json!("New"), &json!("member"))
        );

        let (_, _, members) = call(&app, get("/api/projects/1/members", Some(&bob))).await;
        assert_eq!(
            members,
            json!([
                { "username": "alice", "display_name": "Alice", "role": "owner" },
                { "username": "bob", "display_name": "Bob", "role": "editor" },
                { "username": "root", "display_name": "Root", "role": "editor" },
            ])
        );
        let remove =
            |c: &str, user: &str| req("DELETE", &format!("/api/projects/1/members/{user}"), c, "");
        assert_eq!(
            call(&app, remove(&alice, "alice")).await.0,
            400,
            "last owner"
        );
        assert_eq!(call(&app, remove(&bob, "alice")).await.0, 403);
        assert_eq!(call(&app, remove(&bob, "bob")).await.0, 204);
        assert_eq!(call(&app, remove(&alice, "bob")).await.0, 404);
        assert_eq!(status(&bob, "/api/projects/1/tree").await, 404);
    }

    /// #58: every role × one request per permission class, plus the owner rules.
    #[tokio::test]
    async fn project_roles() {
        const ROLES: [&str; 4] = ["viewer", "commenter", "editor", "owner"];
        let rank = |r: &str| ROLES.iter().position(|x| *x == r).unwrap();
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, alice, _) = with_project(&parent).await;
        let bob = cookie_of(&app, "bob").await;
        let root = cookie_of(&app, "root").await;
        let base = "/api/projects/1";
        let at = |rest: &str| format!("{base}{rest}");
        let set_role = |c: &str, user: &str, role: &str| {
            json_req(
                "PATCH",
                &at(&format!("/members/{user}")),
                c,
                json!({ "role": role }),
            )
        };
        let tex = r"\documentclass{article}\begin{document}x\end{document}";
        let put = req("PUT", &at("/files/papers/a/main.tex"), &alice, tex);
        assert_eq!(call(&app, put).await.0, 204);
        let add = json!({ "username": "bob", "role": "viewer" });
        assert_eq!(
            call(&app, post_json(&at("/members"), &alice, add)).await.0,
            201
        );
        let (_, _, p) = call(&app, get(base, Some(&bob))).await;
        assert_eq!(
            (&p["my_role"], &p["role"]),
            (&json!("viewer"), &json!("member"))
        );
        let (_, _, p) = call(&app, get(base, Some(&alice))).await;
        assert_eq!(
            (&p["my_role"], &p["role"]),
            (&json!("owner"), &json!("owner"))
        );

        // (lowest role allowed, request): 2xx from that role up, 403 below
        let allowed = |c: &str| {
            vec![
                ("viewer", get(&at("/tree"), Some(c))),
                ("viewer", get(&at("/files/README.md"), Some(c))),
                ("viewer", get(&at("/comments"), Some(c))),
                ("viewer", get(&at("/chat"), Some(c))),
                (
                    "commenter",
                    post_json(&at("/chat"), c, json!({ "body": "hi" })),
                ),
                ("viewer", get(&at("/git/status?repo="), Some(c))),
                ("viewer", get(&at("/members"), Some(c))),
                ("viewer", get(&at("/dictionary"), Some(c))),
                ("viewer", post_compile("papers/a/main.tex", c)),
                (
                    "commenter",
                    post_json(
                        &at("/comments"),
                        c,
                        json!({ "path": "papers/a/main.tex", "start": 0, "end": 1, "body": "?" }),
                    ),
                ),
                ("editor", req("PUT", &at("/files/notes.txt"), c, "notes")),
                (
                    "owner",
                    json_req("PATCH", base, c, json!({ "name": "Paper" })),
                ),
            ]
        };
        // writes whose success is tested elsewhere: only the 403 below their role
        let refused = |c: &str| {
            vec![
                ("editor", req("DELETE", &at("/files/README.md"), c, "")),
                (
                    "editor",
                    post_json(&at("/git/commit"), c, json!({ "repo": "", "message": "m" })),
                ),
                (
                    "editor",
                    post_json(&at("/git/pull"), c, json!({ "repo": "" })),
                ),
                (
                    "editor",
                    post_json(&at("/git/push"), c, json!({ "repo": "" })),
                ),
                (
                    "editor",
                    post_json(&at("/git/submodule-update"), c, json!({})),
                ),
                (
                    "editor",
                    req("DELETE", &at("/zotero/links?path=r.bib"), c, ""),
                ),
                (
                    "editor",
                    post_json(&at("/zotero/refresh"), c, json!({ "path": "r.bib" })),
                ),
                (
                    "editor",
                    post_json(&at("/dictionary"), c, json!({ "word": "Wort" })),
                ),
                ("editor", req("DELETE", &at("/dictionary/Wort"), c, "")),
                (
                    "editor",
                    json_req(
                        "PUT",
                        &at("/spellcheck/rules"),
                        c,
                        json!({ "disabled_rules": [] }),
                    ),
                ),
                (
                    "owner",
                    post_json(&at("/members"), c, json!({ "username": "carol" })),
                ),
                ("owner", set_role(c, "alice", "viewer")),
                ("owner", req("DELETE", &at("/members/alice"), c, "")),
                (
                    "owner",
                    post_json(&at("/members/alice/invite-remote"), c, json!({})),
                ),
                ("owner", req("DELETE", base, c, "")),
            ]
        };
        for role in ROLES {
            assert_eq!(call(&app, set_role(&alice, "bob", role)).await.0, 204);
            for (min, r) in allowed(&bob) {
                let what = format!("{role}: {} {}", r.method(), r.uri());
                let (status, _, body) = call(&app, r).await;
                if rank(role) >= rank(min) {
                    assert!((200..300).contains(&status), "{what} → {status} {body}");
                } else {
                    assert_eq!(
                        (status, &body["error"]["code"]),
                        (403, &json!("insufficient_role")),
                        "{what}"
                    );
                }
            }
            for (min, r) in refused(&bob) {
                if rank(role) < rank(min) {
                    let what = format!("{role}: {} {}", r.method(), r.uri());
                    assert_eq!(call(&app, r).await.0, 403, "{what}");
                }
            }
        }

        // bob is owner now, so is alice; demoting or removing the last owner is refused
        assert_eq!(call(&app, set_role(&bob, "alice", "editor")).await.0, 204);
        let (status, _, e) = call(&app, set_role(&bob, "bob", "editor")).await;
        assert_eq!((status, &e["error"]["code"]), (400, &json!("last_owner")));
        let leave = req("DELETE", &at("/members/bob"), &bob, "");
        assert_eq!(call(&app, leave).await.0, 400);
        assert_eq!(call(&app, set_role(&alice, "bob", "viewer")).await.0, 403);
        assert_eq!(call(&app, set_role(&bob, "carol", "viewer")).await.0, 404);
        assert_eq!(call(&app, set_role(&bob, "alice", "admin")).await.0, 422);
        // a site admin acts as owner without being a member
        let (_, _, p) = call(&app, get(base, Some(&root))).await;
        assert_eq!(
            (&p["my_role"], &p["role"]),
            (&json!("owner"), &json!("admin"))
        );
        assert_eq!(call(&app, set_role(&root, "alice", "owner")).await.0, 204);
        let (_, _, members) = call(&app, get(&at("/members"), Some(&alice))).await;
        assert_eq!(
            members,
            json!([
                { "username": "alice", "display_name": "Alice", "role": "owner" },
                { "username": "bob", "display_name": "Bob", "role": "owner" },
            ])
        );
        let leave = req("DELETE", &at("/members/bob"), &bob, "");
        assert_eq!(call(&app, leave).await.0, 204);
        assert_eq!(call(&app, get(base, Some(&bob))).await.0, 404);
    }

    /// Every file below `dir` (recursively) that contains `needle`.
    fn files_containing(dir: &std::path::Path, needle: &str) -> Vec<PathBuf> {
        let mut hits = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let ft = entry.file_type().unwrap();
            if ft.is_dir() {
                hits.extend(files_containing(&path, needle));
            } else if ft.is_file()
                && std::fs::read(&path)
                    .unwrap()
                    .windows(needle.len())
                    .any(|w| w == needle.as_bytes())
            {
                hits.push(path);
            }
        }
        hits
    }

    #[tokio::test]
    async fn project_token_is_never_exposed() {
        const TOKEN: &str = "glpat-SECRET-token-123";
        let (_tmp, parent) = workspace::tests::fixture();
        let cfg = test_cfg(true);
        let data = cfg.data.clone();
        let app = test_app_inner(cfg, true).await;
        let c = cookie_of(&app, "alice").await;
        let mut bodies = Vec::new();

        let (status, _, body) = call(
            &app,
            new_project(&c, &parent, json!({ "token": TOKEN, "username": "me" })),
        )
        .await;
        assert_eq!((status, &body["has_token"]), (201, &json!(true)), "{body}");
        bodies.push(body);
        for uri in ["/api/projects", "/api/projects/1", "/api/projects/1/tree"] {
            bodies.push(call(&app, get(uri, Some(&c))).await.2);
        }
        let (_, _, st) = call(&app, get("/api/projects/1/git/status?repo=", Some(&c))).await;
        assert_eq!(st["branch"], "main", "{st}");
        bodies.push(st);
        // username alone keeps the stored token
        let patch = |body| json_req("PATCH", "/api/projects/1", &c, body);
        let (_, _, p) = call(&app, patch(json!({ "username": "other" }))).await;
        assert_eq!(p["has_token"], true);
        bodies.push(p);
        let (_, _, p) = call(&app, patch(json!({ "token": null }))).await;
        assert_eq!(p["has_token"], false);
        let (_, _, p) = call(&app, patch(json!({ "token": TOKEN }))).await;
        assert_eq!(p["has_token"], true);
        bodies.push(p);

        // clone failure: 502, nothing stored, no temp dir left behind
        let missing = parent.join("missing");
        let (status, _, body) =
            call(&app, new_project(&c, &missing, json!({ "token": TOKEN }))).await;
        assert_eq!(
            (status, &body["error"]["code"]),
            (502, &json!("git_failed")),
            "{body}"
        );
        bodies.push(body);
        let entries: Vec<_> = std::fs::read_dir(data.join("projects"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, ["1"]);

        // credentials in the URL, transport helpers, local paths: refused
        for url in ["https://me:pw@gitlab.com/x.git", "ext::sh -c id", "/etc"] {
            let body = json!({ "name": "x", "remote_url": url });
            let (status, _, err) = call(&app, post_json("/api/projects", &c, body)).await;
            assert_eq!(status, 400, "{url}: {err}");
        }
        // a newline would inject lines into git's credential protocol
        let body = json!({ "name": "x", "remote_url": "https://gitlab.com/x.git",
                           "token": "tok\nhost=evil" });
        assert_eq!(
            call(&app, post_json("/api/projects", &c, body)).await.0,
            400
        );

        for body in &bodies {
            assert!(!body.to_string().contains(TOKEN), "{body}");
        }
        // not in .git/config (parent + submodules), CRDT state or build output
        let projects = data.join("projects");
        assert_eq!(files_containing(&projects, TOKEN), Vec::<PathBuf>::new());
        assert!(files_containing(&projects.join("1/repo/.git"), "[remote \"origin\"]").len() >= 2);
    }

    /// `POST /api/templates` with `fields` and `zip` as `file`.
    fn upload_template(cookie: &str, fields: &[(&str, &str)], zip: &[u8]) -> Request<Body> {
        let mut body = Vec::new();
        for (name, value) in fields {
            body.extend(
                format!(
                    "--B\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
                )
                .as_bytes(),
            );
        }
        body.extend(b"--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.zip\"\r\nContent-Type: application/zip\r\n\r\n");
        body.extend(zip);
        body.extend(b"\r\n--B--\r\n");
        Request::post("/api/templates")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "multipart/form-data; boundary=B")
            .body(Body::from(body))
            .unwrap()
    }

    const THESIS_ZIP: &[(&str, &[u8])] = &[
        (
            "Thesis/Arbeit.tex",
            b"\\input{Header/Header}\n\\begin{document}\nx\n\\end{document}\n",
        ),
        (
            "Thesis/Header/Header.tex",
            b"\\documentclass{book}\n\\usepackage{fontspec}\n",
        ),
        ("Thesis/Arbeit.pdf", b"%PDF"),
    ];

    #[tokio::test]
    async fn template_api() {
        let cfg = test_cfg(true);
        let data = cfg.data.canonicalize().unwrap();
        let (app, db) = test_app_db(cfg, false).await;
        let alice = cookie_of(&app, "alice").await;
        let bob = cookie_of(&app, "bob").await;
        let root = cookie_of(&app, "root").await;
        let zip = templates::tests::zip_of(THESIS_ZIP);

        let (status, _, list) = call(&app, get("/api/templates", Some(&alice))).await;
        assert_eq!(status, 200);
        let ids: Vec<_> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].clone())
            .collect();
        assert_eq!(
            ids,
            [
                json!("builtin:article"),
                json!("builtin:report"),
                json!("builtin:thesis")
            ]
        );
        assert_eq!(
            list[0],
            json!({ "id": "builtin:article", "name": "Leer (article)",
                    "description": "Leeres Dokument mit der Klasse article.",
                    "compiler": "pdflatex", "main_file": "main.tex", "builtin": true,
                    "owner": null, "preview": "ready", "public": true })
        );
        assert_eq!(call(&app, get("/api/templates", None)).await.0, 401);
        assert_eq!(
            call(&app, upload_template("", &[("name", "x")], &zip))
                .await
                .0,
            401
        );

        // any user may upload; it starts private
        let fields = [("name", " Thesis "), ("description", "HTWK")];
        let (status, _, t) = call(&app, upload_template(&alice, &fields, &zip)).await;
        assert_eq!(status, 201, "{t}");
        let id = t["id"].as_str().unwrap().to_owned();
        assert_eq!(
            t,
            json!({ "id": id, "name": "Thesis", "description": "HTWK", "compiler": "xelatex",
                    "main_file": "Arbeit.tex", "builtin": false, "owner": "alice",
                    "preview": "pending", "public": false })
        );
        // extracted without the wrapper folder and the main file's PDF, nothing else left
        let dir = data.join("templates").join(&id);
        assert!(dir.join("Arbeit.tex").is_file() && dir.join("Header/Header.tex").is_file());
        assert!(!dir.join("Arbeit.pdf").exists());
        let created_by: i64 = sqlx::query_scalar("SELECT created_by FROM templates")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(created_by, 1);
        let (_, _, list) = call(&app, get("/api/templates", Some(&alice))).await;
        assert_eq!(list[3]["id"], t["id"]);

        // files: what is left after anonymization, sorted, with sizes
        let files_of = |id: &str, c: &str| get(&format!("/api/templates/{id}/files"), Some(c));
        let (status, _, files) = call(&app, files_of(&id, &alice)).await;
        assert_eq!(status, 200, "{files}");
        let size = |p: &str| std::fs::metadata(dir.join(p)).unwrap().len();
        assert_eq!(
            files,
            json!([{ "path": "Arbeit.tex", "size": size("Arbeit.tex") },
                   { "path": "Header/Header.tex", "size": size("Header/Header.tex") }])
        );
        let (_, _, files) = call(&app, files_of("builtin:report", &bob)).await;
        assert_eq!(files[0]["path"], "chapters/einleitung.tex");
        assert_eq!(files.as_array().unwrap().len(), 3);

        // private: invisible to others (list, preview, files, patch, delete), admins see it
        let preview = |id: &str, c: &str| get(&format!("/api/templates/{id}/preview.pdf"), Some(c));
        let patch = |id: &str, c: &str, body: Value| {
            let mut r = post_json(&format!("/api/templates/{id}"), c, body);
            *r.method_mut() = axum::http::Method::PATCH;
            r
        };
        let del = |id: &str, c: &str| req("DELETE", &format!("/api/templates/{id}"), c, "");
        let (_, _, list) = call(&app, get("/api/templates", Some(&bob))).await;
        assert_eq!(list.as_array().unwrap().len(), 3);
        for r in [
            preview(&id, &bob),
            files_of(&id, &bob),
            patch(&id, &bob, json!({ "public": true })),
            del(&id, &bob),
        ] {
            let (status, _, err) = call(&app, r).await;
            assert_eq!((status, &err["error"]["code"]), (404, &json!("not_found")));
        }
        let (_, _, list) = call(&app, get("/api/templates", Some(&root))).await;
        assert_eq!(list[3]["id"], t["id"]);

        // the owner publishes (and renames); others see it but may not change or delete it
        let body = json!({ "public": true, "name": " Thesis HTWK ", "description": "" });
        let (status, _, p) = call(&app, patch(&id, &alice, body)).await;
        assert_eq!(status, 200, "{p}");
        assert_eq!(
            (&p["public"], &p["name"], &p["description"]),
            (&json!(true), &json!("Thesis HTWK"), &json!(""))
        );
        let (_, _, list) = call(&app, get("/api/templates", Some(&bob))).await;
        assert_eq!(list[3]["name"], "Thesis HTWK");
        assert_eq!(call(&app, files_of(&id, &bob)).await.0, 200);
        let (status, _, err) = call(&app, patch(&id, &bob, json!({ "public": false }))).await;
        assert_eq!((status, &err["error"]["code"]), (403, &json!("forbidden")));
        assert_eq!(call(&app, del(&id, &bob)).await.0, 403);
        assert_eq!(
            call(&app, patch(&id, &alice, json!({ "name": " " })))
                .await
                .0,
            400
        );
        assert_eq!(
            call(
                &app,
                patch("builtin:report", &root, json!({ "public": false }))
            )
            .await
            .0,
            400
        );

        // compiler given wins over detection; unknown compiler / missing name
        let with = |c: &'static str| [("name", "T2"), ("compiler", c)];
        let (status, _, t2) = call(&app, upload_template(&bob, &with("lualatex"), &zip)).await;
        assert_eq!((status, t2["compiler"].clone()), (201, json!("lualatex")));
        let (status, _, _) = call(&app, upload_template(&bob, &with("tex"), &zip)).await;
        assert_eq!(status, 400);
        let (status, _, _) = call(&app, upload_template(&bob, &[], &zip)).await;
        assert_eq!(status, 400);
        // unsafe ZIPs over HTTP
        for (entries, code) in [
            (&[("../evil.tex", &b"x"[..])][..], "unsafe_path"),
            (&[("a.tex", &b"no document"[..])][..], "no_main_file"),
        ] {
            let zip = templates::tests::zip_of(entries);
            let (status, _, err) = call(&app, upload_template(&bob, &fields, &zip)).await;
            assert_eq!((status, err["error"]["code"].clone()), (400, json!(code)));
        }
        let (status, _, err) = call(&app, upload_template(&bob, &fields, b"PK nope")).await;
        assert_eq!(
            (status, err["error"]["code"].clone()),
            (400, json!("invalid_zip"))
        );
        // over the body limit
        let big = vec![b'x'; templates::MAX_UPLOAD + 1];
        let (status, _, err) = call(&app, upload_template(&bob, &fields, &big)).await;
        assert_eq!(
            (status, err["error"]["code"].clone()),
            (400, json!("too_large")),
            "{err}"
        );

        assert_eq!(call(&app, del("builtin:report", &root)).await.0, 400);
        // the owner deletes; an admin deletes someone else's
        assert_eq!(call(&app, del(&id, &alice)).await.0, 204);
        assert!(!dir.exists());
        assert_eq!(call(&app, del(&id, &alice)).await.0, 404);
        let t2_id = t2["id"].as_str().unwrap();
        let t3 = call(&app, upload_template(&bob, &[("name", "T3")], &zip))
            .await
            .2;
        assert_eq!(
            call(&app, del(t3["id"].as_str().unwrap(), &root)).await.0,
            204
        );
        // only T2 is left, no leftovers of the failed uploads (previews may be built meanwhile)
        let left: Vec<String> = std::fs::read_dir(data.join("templates"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.ends_with(".pdf") && !n.ends_with(".log") && !n.starts_with(".preview-"))
            .collect();
        assert_eq!(left, [t2_id]);
        let (_, _, list) = call(&app, get("/api/templates", Some(&bob))).await;
        assert_eq!(list.as_array().unwrap().len(), 4);
        assert_eq!(list[3]["id"], t2["id"]);
    }

    fn has_latexmk() -> bool {
        let found = std::process::Command::new("latexmk")
            .arg("-v")
            .output()
            .is_ok();
        if !found {
            eprintln!("skipping: latexmk not on PATH");
        }
        found
    }

    /// Polls `GET /api/templates` until the preview of `id` is no longer pending.
    async fn preview_state(app: &Router, cookie: &str, id: &str) -> Value {
        for _ in 0..600 {
            let (_, _, list) = call(app, get("/api/templates", Some(cookie))).await;
            let t = list
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == id)
                .cloned();
            let state = t.unwrap()["preview"].clone();
            if state != "pending" {
                return state;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        panic!("preview of {id} still pending");
    }

    #[tokio::test]
    async fn template_preview() {
        let cfg = test_cfg(true);
        let data = cfg.data.canonicalize().unwrap();
        let app = test_app_with(cfg).await;
        let alice = cookie_of(&app, "alice").await;
        // the body image becomes a placeholder, the title page logo stays: both must compile
        let doc = b"\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\
                    \\begin{titlepage}\\includegraphics[width=2cm]{logo}\\end{titlepage}\n\
                    Geheimer Text \\includegraphics[width=3cm]{bilder/foto.jpg}\n\\end{document}\n";
        let zip = templates::tests::zip_of(&[
            ("main.tex", doc),
            ("logo.png", anonymize::PNG),
            ("bilder/foto.jpg", b"not even a JPEG"),
        ]);
        let (status, _, t) = call(&app, upload_template(&alice, &[("name", "P")], &zip)).await;
        assert_eq!(status, 201, "{t}");
        let id = t["id"].as_str().unwrap().to_owned();
        let preview = |id: &str| get(&format!("/api/templates/{id}/preview.pdf"), Some(&alice));
        if !has_latexmk() {
            let state = preview_state(&app, &alice, &id).await;
            assert_eq!(state, "failed");
            let (status, _, err) = call(&app, preview(&id)).await;
            assert_eq!(
                (status, &err["error"]["code"]),
                (404, &json!("preview_failed"))
            );
            return;
        }
        assert_eq!(preview_state(&app, &alice, &id).await, "ready");
        for id in [id.as_str(), "builtin:thesis"] {
            let res = app.clone().oneshot(preview(id)).await.unwrap();
            assert_eq!(res.status(), 200, "{id}");
            assert_eq!(res.headers()[header::CONTENT_TYPE], "application/pdf");
            let pdf = res.into_body().collect().await.unwrap().to_bytes();
            assert!(pdf.starts_with(b"%PDF"), "{id}");
        }
        // next to the template, not in its files (which go into new repos)
        let templates = data.join("templates");
        assert!(templates.join(format!("{id}.pdf")).is_file());
        assert!(templates.join("builtin-preview/thesis.pdf").is_file());
        assert!(!std::fs::read_dir(templates.join(&id)).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".pdf")));
    }

    #[tokio::test]
    async fn pending_previews_resume_on_start() {
        let cfg = test_cfg(true);
        let data = cfg.data.clone();
        let (app, db) = test_app_db(cfg, false).await;
        let alice = cookie_of(&app, "alice").await;
        let zip = templates::tests::zip_of(&[(
            "main.tex",
            b"\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
        )]);
        let (status, _, t) = call(&app, upload_template(&alice, &[("name", "R")], &zip)).await;
        assert_eq!(status, 201, "{t}");
        let id = t["id"].as_str().unwrap().to_owned();
        preview_state(&app, &alice, &id).await;
        // as if the server stopped mid-build: pending, no PDF
        let _ = std::fs::remove_file(data.join("templates").join(format!("{id}.pdf")));
        sqlx::query("UPDATE templates SET preview = 'pending' WHERE id = ?")
            .bind(&id)
            .execute(&db)
            .await
            .unwrap();
        let mut cfg = test_cfg(true);
        cfg.data = data;
        let app = build(&cfg, db, false).await.unwrap();
        let alice = cookie_of(&app, "alice").await;
        let want = if has_latexmk() { "ready" } else { "failed" };
        assert_eq!(preview_state(&app, &alice, &id).await, want);
    }

    #[tokio::test]
    async fn admin_user_api() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, alice, _) = with_project(&parent).await;
        let root = cookie_of(&app, "root").await;
        assert_eq!(
            call(&app, get("/api/admin/users", Some(&alice))).await.0,
            403
        );
        assert_eq!(call(&app, get("/api/admin/users", None)).await.0, 401);

        let (status, _, users) = call(&app, get("/api/admin/users", Some(&root))).await;
        assert_eq!(status, 200);
        assert_eq!(users[0]["username"], "alice");
        assert!(users[0]["created_at"].as_str().unwrap().ends_with('Z'));

        let create = |body| post_json("/api/admin/users", &root, body);
        assert_eq!(
            call(&app, create(json!({ "username": "dave" }))).await.0,
            400
        );
        let (status, _, dave) = call(
            &app,
            create(json!({ "username": "dave", "github": "dave-gh" })),
        )
        .await;
        assert_eq!(status, 201, "{dave}");
        assert_eq!(
            (
                &dave["display_name"],
                &dave["github"],
                &dave["email"],
                &dave["is_admin"]
            ),
            (
                &json!("dave"),
                &json!("dave-gh"),
                &Value::Null,
                &json!(false)
            )
        );
        let dup = create(json!({ "username": "eve", "email": "A@X.org" }));
        assert_eq!(call(&app, dup).await.0, 409);

        let id = dave["id"].as_i64().unwrap();
        let patch =
            |id: i64, body| json_req("PATCH", &format!("/api/admin/users/{id}"), &root, body);
        let (status, _, dave) = call(
            &app,
            patch(
                id,
                json!({ "email": "d@x.org", "github": null, "is_admin": true }),
            ),
        )
        .await;
        assert_eq!(status, 200, "{dave}");
        assert_eq!(
            (&dave["email"], &dave["github"], &dave["is_admin"]),
            (&json!("d@x.org"), &Value::Null, &json!(true))
        );
        assert_eq!(
            call(&app, patch(id, json!({ "email": "b@x.org" }))).await.0,
            409
        );
        assert_eq!(call(&app, patch(999, json!({}))).await.0, 404);
        let (status, _, dave) = call(&app, patch(id, json!({ "commit_email": "d@uni.edu" }))).await;
        assert_eq!((status, &dave["commit_email"]), (200, &json!("d@uni.edu")));
        let bad = patch(id, json!({ "commit_email": "d @uni.edu" }));
        assert_eq!(call(&app, bad).await.0, 400);
        let (_, _, dave) = call(&app, patch(id, json!({ "commit_email": null }))).await;
        assert_eq!(dave["commit_email"], Value::Null);

        let (_, _, me) = call(&app, get("/api/auth/me", Some(&root))).await;
        let me_id = me["id"].as_i64().unwrap();
        assert_eq!(me["is_admin"], true);
        assert_eq!(
            call(&app, patch(me_id, json!({ "is_admin": false })))
                .await
                .0,
            409
        );
        let del = |id: i64| req("DELETE", &format!("/api/admin/users/{id}"), &root, "");
        assert_eq!(call(&app, del(me_id)).await.0, 409);

        // deleting alice: her session ends, her project goes to the deleting admin
        let (_, _, a) = call(&app, get("/api/auth/me", Some(&alice))).await;
        assert_eq!(call(&app, del(a["id"].as_i64().unwrap())).await.0, 204);
        assert_eq!(call(&app, get("/api/auth/me", Some(&alice))).await.0, 401);
        let (_, _, p) = call(&app, get("/api/projects/1", Some(&root))).await;
        assert_eq!((&p["owner"], &p["role"]), (&json!("root"), &json!("owner")));
        assert_eq!(call(&app, del(999)).await.0, 404);
    }

    #[tokio::test]
    async fn comments_api_and_permissions() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, alice, dir) = with_project(&parent).await;
        let bob = cookie_of(&app, "bob").await;
        let carol = cookie_of(&app, "carol").await;
        let root = cookie_of(&app, "root").await;
        let add = post_json(
            "/api/projects/1/members",
            &alice,
            json!({ "username": "bob" }),
        );
        assert_eq!(call(&app, add).await.0, 201);
        let put = req(
            "PUT",
            "/api/projects/1/files/papers/a/c.tex",
            &alice,
            "a😀 hello world\n",
        );
        assert_eq!(call(&app, put).await.0, 204);
        let base = "/api/projects/1/comments";
        let new = |c: &str, path: &str, start: u32, end: u32, body: &str| {
            let body = json!({ "path": path, "start": start, "end": end, "body": body });
            post_json(base, c, body)
        };
        let list = |c: &str, query: &str| get(&format!("{base}{query}"), Some(c));
        let file = "papers/a/c.tex";

        // offsets are UTF-16: the emoji counts 2; the quote comes from the file
        let (status, _, t) = call(&app, new(&alice, file, 4, 9, " Why? ")).await;
        assert_eq!(status, 201, "{t}");
        assert_eq!(
            (&t["quote"], &t["start"], &t["end"], &t["detached"]),
            (&json!("hello"), &json!(4), &json!(9), &json!(false))
        );
        assert_eq!(
            (&t["resolved"], &t["resolved_by"], &t["created_by"]),
            (&json!(false), &Value::Null, &json!("alice"))
        );
        let m = &t["messages"][0];
        assert_eq!(
            (
                &m["author"],
                &m["display_name"],
                &m["body"],
                &m["edited_at"]
            ),
            (
                &json!("alice"),
                &json!("Alice"),
                &json!("Why?"),
                &Value::Null
            )
        );
        let id = t["id"].as_i64().unwrap();

        let long = "x".repeat(10_001);
        for (start, end, body) in [
            (9, 4, "x"),
            (4, 4, "x"),
            (4, 99, "x"),
            (2, 9, "x"), // inside the emoji
            (4, 9, "  "),
            (4, 9, long.as_str()),
        ] {
            let (status, _, e) = call(&app, new(&alice, file, start, end, body)).await;
            assert_eq!(status, 400, "{start}..{end}: {e}");
        }
        assert_eq!(
            call(&app, new(&alice, "papers/a/no.tex", 0, 1, "x"))
                .await
                .0,
            404
        );
        // valid UTF-8 with a NUL byte is binary, as for the editor
        std::fs::write(dir.join("papers/a/nul.tex"), "ab\0cd\n").unwrap();
        let (status, _, e) = call(&app, new(&alice, "papers/a/nul.tex", 0, 2, "x")).await;
        assert_eq!(status, 400, "{e}");

        // non-members see nothing
        assert_eq!(call(&app, list(&carol, "")).await.0, 404);
        assert_eq!(call(&app, new(&carol, file, 4, 9, "x")).await.0, 404);

        // replies: only the author edits or deletes a message
        let msgs = format!("{base}/{id}/messages");
        let (status, _, m) =
            call(&app, post_json(&msgs, &bob, json!({ "body": "Because." }))).await;
        assert_eq!((status, &m["author"]), (201, &json!("bob")), "{m}");
        let msg = format!("{msgs}/{}", m["id"]);
        let edit = |c: &str| json_req("PATCH", &msg, c, json!({ "body": "Fixed." }));
        assert_eq!(call(&app, edit(&alice)).await.0, 403);
        let (status, _, m) = call(&app, edit(&bob)).await;
        assert_eq!((status, &m["body"]), (200, &json!("Fixed.")));
        assert!(m["edited_at"].is_string(), "{m}");
        assert_eq!(call(&app, req("DELETE", &msg, &alice, "")).await.0, 403);

        // any member resolves
        let thread = format!("{base}/{id}");
        let resolve = json_req("PATCH", &thread, &bob, json!({ "resolved": true }));
        let (status, _, t) = call(&app, resolve).await;
        assert_eq!(
            (status, &t["resolved"], &t["resolved_by"]),
            (200, &json!(true), &json!("bob"))
        );
        let (_, _, l) = call(&app, list(&bob, &format!("?path={file}"))).await;
        assert_eq!(l.as_array().unwrap().len(), 1);
        assert_eq!(l[0]["messages"].as_array().unwrap().len(), 2);
        assert_eq!(call(&app, list(&bob, "")).await.2, l);
        assert_eq!(call(&app, list(&bob, "?path=main.tex")).await.2, json!([]));
        assert_eq!(call(&app, req("DELETE", &msg, &bob, "")).await.0, 204);
        let (_, _, l) = call(&app, list(&bob, "")).await;
        assert_eq!(l[0]["messages"].as_array().unwrap().len(), 1);

        // threads: creator or admin
        assert_eq!(call(&app, req("DELETE", &thread, &bob, "")).await.0, 403);
        assert_eq!(call(&app, req("DELETE", &thread, &root, "")).await.0, 204);
        assert_eq!(call(&app, req("DELETE", &thread, &root, "")).await.0, 404);
        assert_eq!(call(&app, list(&alice, "")).await.2, json!([]));

        // deleting the first message deletes the thread
        let (_, _, t) = call(&app, new(&bob, file, 10, 15, "Typo?")).await;
        assert_eq!(t["quote"], "world");
        let first = format!("{base}/{}/messages/{}", t["id"], t["messages"][0]["id"]);
        assert_eq!(call(&app, req("DELETE", &first, &bob, "")).await.0, 204);
        assert_eq!(call(&app, list(&alice, "")).await.2, json!([]));

        // deleting the file deletes its threads
        assert_eq!(call(&app, new(&bob, file, 10, 15, "Typo?")).await.0, 201);
        let del = req("DELETE", "/api/projects/1/files/papers/a/c.tex", &bob, "");
        assert_eq!(call(&app, del).await.0, 204);
        assert_eq!(call(&app, list(&alice, "")).await.2, json!([]));
    }

    /// #61: project chat: roles, pagination, mentions, soft delete, validation, rate limit.
    #[tokio::test]
    async fn chat_api() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, alice, _) = with_project(&parent).await;
        let bob = cookie_of(&app, "bob").await;
        let carol = cookie_of(&app, "carol").await; // not a member
        let root = cookie_of(&app, "root").await; // admin: acts as owner
        let add = json!({ "username": "bob", "role": "viewer" });
        let add = post_json("/api/projects/1/members", &alice, add);
        assert_eq!(call(&app, add).await.0, 201);
        let base = "/api/projects/1/chat";
        let send = |c: &str, body: Value| post_json(base, c, body);
        let list = |c: &str, q: &str| get(&format!("{base}{q}"), Some(c));

        let (status, _, m) = call(
            &app,
            send(&alice, json!({ "body": " Hi @bob @nobody @carol @Root " })),
        )
        .await;
        assert_eq!(status, 201, "{m}");
        assert_eq!(
            (&m["author"], &m["display_name"], &m["body"], &m["mentions"]),
            (
                &json!("alice"),
                &json!("Alice"),
                &json!("Hi @bob @nobody @carol @Root"),
                &json!(["bob"])
            )
        );
        assert_eq!(
            (&m["file"], &m["line"], &m["edited_at"], &m["deleted"]),
            (&Value::Null, &Value::Null, &Value::Null, &json!(false))
        );
        let id = m["id"].as_i64().unwrap();

        // a message with a location
        let at = json!({ "body": "here", "file": "papers/a/main.tex", "line": 7 });
        let (status, _, m) = call(&app, send(&root, at)).await;
        assert_eq!(
            (status, &m["file"], &m["line"]),
            (201, &json!("papers/a/main.tex"), &json!(7))
        );

        // roles: viewers read, commenters and up write; non-members see nothing
        assert_eq!(call(&app, send(&bob, json!({ "body": "x" }))).await.0, 403);
        assert_eq!(call(&app, list(&bob, "")).await.0, 200);
        assert_eq!(call(&app, list(&carol, "")).await.0, 404);
        assert_eq!(
            call(&app, send(&carol, json!({ "body": "x" }))).await.0,
            404
        );

        // validation
        let long = "x".repeat(4001);
        for bad in [
            json!({ "body": "  " }),
            json!({ "body": long }),
            json!({ "body": "x", "file": "../etc/passwd" }),
            json!({ "body": "x", "file": "/abs" }),
            json!({ "body": "x", "file": "a.tex", "line": 0 }),
            json!({ "body": "x", "line": 3 }),
        ] {
            let (status, _, e) = call(&app, send(&alice, bad.clone())).await;
            assert_eq!(status, 400, "{bad}: {e}");
        }

        // pagination: newest page first, each page oldest first
        for i in 0..4 {
            call(&app, send(&alice, json!({ "body": format!("m{i}") }))).await;
        }
        let ids = |l: &Value| -> Vec<i64> {
            (l.as_array().unwrap().iter())
                .map(|m| m["id"].as_i64().unwrap())
                .collect()
        };
        let (_, _, all) = call(&app, list(&bob, "")).await;
        let all = ids(&all);
        assert_eq!(all.len(), 6);
        assert!(all.windows(2).all(|w| w[0] < w[1]));
        let (_, _, page) = call(&app, list(&bob, "?limit=2")).await;
        assert_eq!(ids(&page), all[4..]);
        let (_, _, page) = call(&app, list(&bob, &format!("?limit=2&before={}", all[4]))).await;
        assert_eq!(ids(&page), all[2..4]);
        let (_, _, page) = call(&app, list(&bob, &format!("?before={}", all[1]))).await;
        assert_eq!(ids(&page), all[..1]);

        // edit / delete: author only, and still a writer
        let msg = format!("{base}/{id}");
        let edit = |c: &str, body: &str| json_req("PATCH", &msg, c, json!({ "body": body }));
        assert_eq!(call(&app, edit(&bob, "x")).await.0, 403);
        assert_eq!(call(&app, edit(&root, "x")).await.0, 403, "not even admins");
        assert_eq!(call(&app, edit(&alice, " ")).await.0, 400);
        let (status, _, m) = call(&app, edit(&alice, "Hello @bob")).await;
        assert_eq!(
            (status, &m["body"], &m["mentions"]),
            (200, &json!("Hello @bob"), &json!(["bob"]))
        );
        assert!(m["edited_at"].is_string(), "{m}");
        assert_eq!(call(&app, req("DELETE", &msg, &bob, "")).await.0, 403);
        assert_eq!(call(&app, req("DELETE", &msg, &root, "")).await.0, 403);
        assert_eq!(call(&app, req("DELETE", &msg, &alice, "")).await.0, 204);
        let (_, _, l) = call(&app, list(&bob, "")).await;
        assert_eq!(ids(&l), all, "soft delete keeps the id");
        let gone = &l[0];
        assert_eq!(
            (&gone["deleted"], &gone["body"], &gone["mentions"]),
            (&json!(true), &json!(""), &json!([]))
        );
        assert_eq!(call(&app, req("DELETE", &msg, &alice, "")).await.0, 404);
        assert_eq!(call(&app, edit(&alice, "x")).await.0, 404);
        assert_eq!(
            call(&app, req("DELETE", &format!("{base}/999"), &alice, ""))
                .await
                .0,
            404
        );

        // rate limit: 30 per minute and user (refused requests do not count)
        let mut last = 0;
        for _ in 0..30 {
            last = call(&app, send(&alice, json!({ "body": "spam" }))).await.0;
            if last != 201 {
                break;
            }
        }
        assert_eq!(last, 429);
        let (_, _, e) = call(&app, send(&alice, json!({ "body": "spam" }))).await;
        assert_eq!(e["error"]["code"], "rate_limited");
        assert_eq!(
            call(&app, send(&root, json!({ "body": "still ok" })))
                .await
                .0,
            201
        );
    }

    /// Forms the mock LanguageTool received.
    type LtCalls = Arc<Mutex<Vec<HashMap<String, String>>>>;

    /// Mock LanguageTool `/v2/check`: records each form; reports `Fehlr` and `Projektwort` as
    /// TYPOS and `und und` as grammar, at their UTF-16 offsets in the annotated text (text and
    /// markup); 500 if the text contains `BOOM`.
    async fn mock_languagetool(
        axum::extract::State(calls): axum::extract::State<LtCalls>,
        axum::Form(form): axum::Form<HashMap<String, String>>,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        calls.lock().unwrap().push(form.clone());
        let data: Value = serde_json::from_str(&form["data"]).unwrap();
        let original: String = (data["annotation"].as_array().unwrap().iter())
            .map(|p| p["text"].as_str().or(p["markup"].as_str()).unwrap())
            .collect();
        if original.contains("BOOM") {
            return axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let at = |w: &str| {
            original
                .find(w)
                .map(|i| original[..i].encode_utf16().count())
        };
        let mut matches = Vec::new();
        for (w, cat, rule) in [
            ("Fehlr", "TYPOS", "GERMAN_SPELLER_RULE"),
            ("Projektwort", "TYPOS", "GERMAN_SPELLER_RULE"),
            ("und und", "GRAMMAR", "GERMAN_WORD_REPEAT_RULE"),
        ] {
            if let Some(offset) = at(w) {
                matches.push(json!({
                    "message": format!("bad {w}"), "shortMessage": "kurz",
                    "replacements": (0..8).map(|i| json!({ "value": format!("r{i}") })).collect::<Vec<_>>(),
                    "offset": offset, "length": w.encode_utf16().count(),
                    "rule": { "id": rule, "category": { "id": cat, "name": cat } },
                }));
            }
        }
        Json(json!({ "matches": matches })).into_response()
    }

    #[tokio::test]
    async fn spellcheck_api_and_dictionary() {
        let (_tmp, parent) = workspace::tests::fixture();
        let check = |c: &str, body: Value| post_json("/api/projects/1/spellcheck", c, body);

        // feature off: 404 spellcheck_disabled, the dictionary still works
        let (app, alice, _) = with_project(&parent).await;
        let file = json!({ "path": "papers/a/main.tex" });
        let (status, _, body) = call(&app, check(&alice, file)).await;
        assert_eq!(
            (status, &body["error"]["code"]),
            (404, &json!("spellcheck_disabled"))
        );
        let (status, _, body) = call(&app, get("/api/projects/1/dictionary", Some(&alice))).await;
        assert_eq!(
            (status, body),
            (200, json!({ "words": [], "disabled_rules": [] }))
        );

        let calls: LtCalls = Arc::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg = test_cfg(true);
        cfg.languagetool_url = Some(format!("http://{}/", listener.local_addr().unwrap()));
        let lt = Router::new()
            .route("/v2/check", post(mock_languagetool))
            .with_state(calls.clone());
        tokio::spawn(async move { axum::serve(listener, lt).await.unwrap() });
        let (app, alice, _) = with_project_cfg(cfg, &parent).await;
        let carol = cookie_of(&app, "carol").await;
        let src = "% !TeX spellcheck = de_CH\n\\section{Ein}😀 Fehlr und und Projektwort $x$.\n";
        let put = Request::put("/api/projects/1/files/papers/a/c.tex")
            .header(header::COOKIE, &alice)
            .body(Body::from(src))
            .unwrap();
        assert_eq!(call(&app, put).await.0, 204);
        let path = "papers/a/c.tex";
        let utf16 = |s: &str| s.encode_utf16().count() as u64;
        let pos = |w: &str| utf16(&src[..src.find(w).unwrap()]);

        // whole file from disk: offsets into the file, language from its magic comment
        let (status, _, issues) = call(&app, check(&alice, json!({ "path": path }))).await;
        assert_eq!(status, 200, "{issues}");
        let starts: Vec<u64> = (issues.as_array().unwrap().iter())
            .map(|i| i["start"].as_u64().unwrap())
            .collect();
        assert_eq!(starts, [pos("Fehlr"), pos("Projektwort"), pos("und und")]);
        assert_eq!(
            issues[0],
            json!({ "start": pos("Fehlr"), "end": pos("Fehlr") + 5, "message": "bad Fehlr",
                    "short": "kurz", "rule": "GERMAN_SPELLER_RULE", "category": "TYPOS",
                    "replacements": ["r0", "r1", "r2", "r3", "r4"] })
        );
        {
            let calls = calls.lock().unwrap();
            let form = calls.last().unwrap();
            assert_eq!(
                (form["language"].as_str(), form["level"].as_str()),
                ("de-CH", "default")
            );
            assert_eq!(form["disabledRules"], "WHITESPACE_RULE");
            assert!(
                form["data"].contains(r#"{"interpretAs":"X","markup":"$x$"}"#),
                "{}",
                form["data"]
            );
        }

        // dictionary words (also lowercase) and ignored rules apply to the next check
        let add = |w: &str| post_json("/api/projects/1/dictionary", &alice, json!({ "word": w }));
        assert_eq!(call(&app, add("projektwort")).await.0, 204);
        assert_eq!(call(&app, add("projektwort")).await.0, 204);
        assert_eq!(call(&app, add("zwei Worte")).await.0, 400);
        assert_eq!(call(&app, add("")).await.0, 400);
        for w in [".", "..", "a/b"] {
            assert_eq!(call(&app, add(w)).await.0, 400, "{w}");
        }
        let rules = json!({ "disabled_rules": ["DE_CASE", "DE_CASE", "A_RULE"] });
        let put = json_req("PUT", "/api/projects/1/spellcheck/rules", &alice, rules);
        let (status, _, body) = call(&app, put).await;
        assert_eq!(
            (status, body),
            (200, json!({ "disabled_rules": ["A_RULE", "DE_CASE"] }))
        );
        let bad = json!({ "disabled_rules": ["no spaces"] });
        let put = json_req("PUT", "/api/projects/1/spellcheck/rules", &alice, bad);
        assert_eq!(call(&app, put).await.0, 400);
        let (_, _, dict) = call(&app, get("/api/projects/1/dictionary", Some(&alice))).await;
        assert_eq!(
            dict,
            json!({ "words": ["projektwort"], "disabled_rules": ["A_RULE", "DE_CASE"] })
        );
        let (_, _, issues) = call(&app, check(&alice, json!({ "path": path }))).await;
        let rules: Vec<&str> = (issues.as_array().unwrap().iter())
            .map(|i| i["message"].as_str().unwrap())
            .collect();
        assert_eq!(rules, ["bad Fehlr", "bad und und"]);
        let form = calls.lock().unwrap().last().unwrap().clone();
        assert_eq!(form["disabledRules"], "WHITESPACE_RULE,A_RULE,DE_CASE");

        // a changed paragraph: offsets shifted by `start`; the request's language wins
        let body = json!({ "path": path, "text": "Ein Fehlr", "start": 100, "language": "en-US" });
        let (status, _, issues) = call(&app, check(&alice, body)).await;
        assert_eq!(status, 200, "{issues}");
        assert_eq!(
            (&issues[0]["start"], &issues[0]["end"]),
            (&json!(104), &json!(109))
        );
        let form = calls.lock().unwrap().last().unwrap().clone();
        assert_eq!(form["language"], "en-US");

        // no magic comment, no root: auto
        let body = json!({ "path": "papers/a/main.tex", "text": "x" });
        assert_eq!(call(&app, check(&alice, body)).await.0, 200);
        let form = calls.lock().unwrap().last().unwrap().clone();
        assert_eq!(form["language"], "auto");

        // errors: LT down, too large, bad language, bad path, non-member
        let boom = json!({ "path": path, "text": "BOOM" });
        let (status, _, body) = call(&app, check(&alice, boom)).await;
        assert_eq!(
            (status, &body["error"]["code"]),
            (502, &json!("spellcheck_unavailable"))
        );
        let big = json!({ "path": path, "text": "a".repeat(spellcheck::MAX_TEXT + 1) });
        assert_eq!(call(&app, check(&alice, big)).await.0, 413);
        let lang = json!({ "path": path, "text": "x", "language": "de DE" });
        assert_eq!(call(&app, check(&alice, lang)).await.0, 400);
        let escape = json!({ "path": "../x.tex" });
        assert_eq!(call(&app, check(&alice, escape)).await.0, 400);
        assert_eq!(
            call(&app, check(&carol, json!({ "path": path }))).await.0,
            404
        );
        let carol_dict = get("/api/projects/1/dictionary", Some(&carol));
        assert_eq!(call(&app, carol_dict).await.0, 404);

        let del = req(
            "DELETE",
            "/api/projects/1/dictionary/projektwort",
            &alice,
            "",
        );
        assert_eq!(call(&app, del).await.0, 204);
        let (_, _, dict) = call(&app, get("/api/projects/1/dictionary", Some(&alice))).await;
        assert_eq!(dict["words"], json!([]));
    }

    fn put_text(c: &str, path: &str, body: &str) -> Request<Body> {
        let uri = format!("/api/projects/1/files/{path}");
        let body = Box::leak(body.to_owned().into_boxed_str());
        req("PUT", &uri, c, body)
    }

    const MOVE_MAIN: &str = "\\documentclass{article}\n\\begin{document}\n\\input{sec/intro}\n\\includegraphics{figs/f}\n\\bibliography{refs}\n\\end{document}\n";

    #[tokio::test]
    async fn files_move_and_rename() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, alice, repo) = with_project(&parent).await;
        let bob = cookie_of(&app, "bob").await;
        let add = json!({ "username": "bob", "role": "viewer" });
        let add = post_json("/api/projects/1/members", &alice, add);
        assert_eq!(call(&app, add).await.0, 201);
        for (path, text) in [
            ("papers/a/main.tex", MOVE_MAIN),
            ("papers/a/sec/intro.tex", "hi"),
            ("papers/a/figs/f.png", "png"),
            ("papers/a/refs.bib", "@x"),
        ] {
            assert_eq!(call(&app, put_text(&alice, path, text)).await.0, 204);
        }
        let mv = |c: &str, from: &str, to: &str, refs: bool| {
            let body = json!({ "from": from, "to": to, "update_refs": refs });
            post_json("/api/projects/1/files/move", c, body)
        };
        let code = |b: &Value| b["error"]["code"].as_str().unwrap_or("").to_owned();
        let read = |p: &str| std::fs::read_to_string(repo.join(p)).unwrap();

        // viewers may not move; invalid and conflicting requests change nothing
        let (status, _, b) =
            call(&app, mv(&bob, "papers/a/refs.bib", "papers/a/r.bib", false)).await;
        assert_eq!((status, code(&b).as_str()), (403, "insufficient_role"));
        for (from, to, want_status, want_code) in [
            ("papers/a/nope.tex", "papers/a/x.tex", 404, "not_found"),
            ("papers/a/refs.bib", "papers/a/main.tex", 409, "exists"),
            ("papers/a/sec", "papers/a/figs", 409, "exists"),
            ("papers/a/refs.bib", "refs.bib", 400, "cross_repo"),
            ("README.md", "papers/a/README.md", 400, "cross_repo"),
            ("papers/a", "papers/z", 400, "cross_repo"),
            ("papers", "other", 400, "cross_repo"),
            (
                "papers/a/sec",
                "papers/a/sec/in/side",
                400,
                "invalid_request",
            ),
            ("papers/a/refs.bib", "papers/../x", 400, "invalid_path"),
            ("papers/a/refs.bib", ".git/x", 400, "invalid_path"),
            ("papers/b/other.tex", "papers/b/o.tex", 400, "invalid_path"),
        ] {
            let (status, _, b) = call(&app, mv(&alice, from, to, false)).await;
            assert_eq!(
                (status, code(&b).as_str()),
                (want_status, want_code),
                "{from} -> {to}"
            );
        }
        assert!(repo.join("papers/a/refs.bib").exists() && repo.join("papers/a/sec").exists());

        // a comment thread and the main file follow their file
        let comment =
            json!({ "path": "papers/a/sec/intro.tex", "start": 0, "end": 2, "body": "?" });
        let comment = post_json("/api/projects/1/comments", &alice, comment);
        assert_eq!(call(&app, comment).await.0, 201);
        let main = json!({ "main_files": ["papers/a/main.tex"] });
        let patch = json_req("PATCH", "/api/projects/1", &alice, main);
        assert_eq!(call(&app, patch).await.0, 200);

        // preview (readable for viewers), then move a directory with its references
        let preview = |c: &str| {
            let q = "from=papers/a/sec&to=papers/a/chapters";
            get(&format!("/api/projects/1/files/move/preview?{q}"), Some(c))
        };
        let (status, _, p) = call(&app, preview(&bob)).await;
        assert_eq!(status, 200, "{p}");
        assert_eq!(
            p["references"],
            json!([{ "path": "papers/a/main.tex", "line": 3, "old": "sec/intro", "new": "chapters/intro" }])
        );
        let (status, _, b) =
            call(&app, mv(&alice, "papers/a/sec", "papers/a/chapters", true)).await;
        assert_eq!(status, 200, "{b}");
        assert_eq!(
            b,
            json!({
                "moved": [{ "from": "papers/a/sec/intro.tex", "to": "papers/a/chapters/intro.tex" }],
                "updated_refs": [{ "file": "papers/a/main.tex", "count": 1 }],
            })
        );
        assert_eq!(
            read("papers/a/main.tex"),
            MOVE_MAIN.replace("sec/intro", "chapters/intro")
        );
        assert!(!repo.join("papers/a/sec").exists());
        assert_eq!(read("papers/a/chapters/intro.tex"), "hi");
        let threads = |path: &str| {
            let uri = format!("/api/projects/1/comments?path={path}");
            let (app, c) = (app.clone(), alice.clone());
            async move { call(&app, get(&uri, Some(&c))).await.2 }
        };
        let moved_threads = threads("papers/a/chapters/intro.tex").await;
        assert_eq!(moved_threads.as_array().unwrap().len(), 1);
        assert_eq!(threads("papers/a/sec/intro.tex").await, json!([]));

        // moving the root rebases its references and updates main_files; parent dirs are created
        let (status, _, b) = call(
            &app,
            mv(&alice, "papers/a/main.tex", "papers/a/paper/main.tex", true),
        )
        .await;
        assert_eq!(status, 200, "{b}");
        assert_eq!(
            b["updated_refs"],
            json!([{ "file": "papers/a/paper/main.tex", "count": 3 }])
        );
        let moved = read("papers/a/paper/main.tex");
        for want in ["{../chapters/intro}", "{../figs/f}", "{../refs}"] {
            assert!(moved.contains(want), "{want} in {moved}");
        }
        let (_, _, p) = call(&app, get("/api/projects/1", Some(&alice))).await;
        assert_eq!(p["main_files"], json!(["papers/a/paper/main.tex"]));

        // renaming with references follows them, without they stay (and nothing is reported)
        let (status, _, b) = call(
            &app,
            mv(&alice, "papers/a/refs.bib", "papers/a/lit.bib", true),
        )
        .await;
        assert_eq!(status, 200, "{b}");
        assert_eq!(
            b["updated_refs"],
            json!([{ "file": "papers/a/paper/main.tex", "count": 1 }])
        );
        assert!(read("papers/a/paper/main.tex").contains("{../lit}"));
        let (status, _, b) = call(
            &app,
            mv(&alice, "papers/a/figs/f.png", "papers/a/figs/g.png", false),
        )
        .await;
        assert_eq!((status, &b["updated_refs"]), (200, &json!([])));
        assert!(read("papers/a/paper/main.tex").contains("{../figs/f}"));
    }

    /// #69 + #60: a symlink to `.git` is neither a move source nor a move target.
    #[tokio::test]
    async fn files_move_refuses_symlinks_into_git() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, alice, repo) = with_project(&parent).await;
        assert_eq!(
            call(&app, put_text(&alice, "papers/a/refs.bib", "@x"))
                .await
                .0,
            204
        );
        std::os::unix::fs::symlink(repo.join(".git"), repo.join("papers/a/gl")).unwrap();
        for (from, to) in [
            ("papers/a/refs.bib", "papers/a/gl/x.bib"),
            ("papers/a/gl", "papers/a/moved"),
            ("papers/a/refs.bib", "papers/a/gl"),
        ] {
            let body = json!({ "from": from, "to": to });
            let mv = post_json("/api/projects/1/files/move", &alice, body);
            let (status, _, b) = call(&app, mv).await;
            assert_eq!(
                (status, b["error"]["code"].as_str()),
                (400, Some("invalid_path")),
                "{from} -> {to}"
            );
        }
        assert!(repo.join("papers/a/refs.bib").exists());
        assert!(!repo.join(".git/x.bib").exists());
        assert!(repo.join("papers/a/gl").is_symlink());
    }

    #[tokio::test]
    async fn files_move_updates_zotero_links() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, db) = test_app_db(test_cfg(true), true).await;
        let c = call(&app, login("alice")).await.1.unwrap();
        let (status, _, b) = call(&app, new_project(&c, &parent, json!({}))).await;
        assert_eq!(status, 201, "{b}");
        for path in [
            "papers/a/refs.bib",
            "papers/a/lit/x.bib",
            "papers/a/litx/y.bib",
        ] {
            assert_eq!(call(&app, put_text(&c, path, "@x")).await.0, 204);
            sqlx::query(
                "INSERT INTO zotero_links (project_id, path, library, format)
                 VALUES (1, ?, 'user:1', 'bibtex')",
            )
            .bind(path)
            .execute(&db)
            .await
            .unwrap();
        }
        for (from, to) in [
            ("papers/a/refs.bib", "papers/a/r2.bib"),
            ("papers/a/lit", "papers/a/lib"),
        ] {
            let body = json!({ "from": from, "to": to });
            let mv = post_json("/api/projects/1/files/move", &c, body);
            assert_eq!(call(&app, mv).await.0, 200, "{from}");
        }
        let (_, _, links) = call(&app, get("/api/projects/1/zotero/links", Some(&c))).await;
        let paths: Vec<_> = (links.as_array().unwrap().iter())
            .map(|l| l["path"].as_str().unwrap())
            .collect();
        assert_eq!(
            paths,
            [
                "papers/a/lib/x.bib",
                "papers/a/litx/y.bib",
                "papers/a/r2.bib"
            ]
        );
    }

    #[tokio::test]
    async fn zotero_links_follow_deletes_and_orphans_do_not_block_moves() {
        let (_tmp, parent) = workspace::tests::fixture();
        let (app, db) = test_app_db(test_cfg(true), true).await;
        let c = call(&app, login("alice")).await.1.unwrap();
        let (status, _, b) = call(&app, new_project(&c, &parent, json!({}))).await;
        assert_eq!(status, 201, "{b}");
        // `new.bib` has a link row but no file (orphan)
        for path in ["papers/a/old.bib", "papers/a/gone.bib", "papers/a/new.bib"] {
            if path != "papers/a/new.bib" {
                assert_eq!(call(&app, put_text(&c, path, "@x")).await.0, 204);
            }
            sqlx::query(
                "INSERT INTO zotero_links (project_id, path, library, format)
                 VALUES (1, ?, 'user:1', 'bibtex')",
            )
            .bind(path)
            .execute(&db)
            .await
            .unwrap();
        }
        let del = req("DELETE", "/api/projects/1/files/papers/a/gone.bib", &c, "");
        assert_eq!(call(&app, del).await.0, 204);
        let body = json!({ "from": "papers/a/old.bib", "to": "papers/a/new.bib" });
        let mv = post_json("/api/projects/1/files/move", &c, body);
        assert_eq!(call(&app, mv).await.0, 200);
        let (_, _, links) = call(&app, get("/api/projects/1/zotero/links", Some(&c))).await;
        let paths: Vec<_> = (links.as_array().unwrap().iter())
            .map(|l| l["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, ["papers/a/new.bib"]);
    }

    mod live {
        //! Real TCP + WebSocket: y-sync clients built on yrs, like the browser's y-websocket.
        use super::*;
        use futures_util::{SinkExt, StreamExt};
        use std::time::Duration;
        use tokio_tungstenite::{
            connect_async,
            tungstenite::{client::IntoClientRequest, Message as Ws},
            MaybeTlsStream, WebSocketStream,
        };
        use yrs::{
            encoding::read::Cursor,
            sync::{Awareness, DefaultProtocol, Message, MessageReader, Protocol, SyncMessage},
            updates::{
                decoder::DecoderV1,
                encoder::{Encode, Encoder, EncoderV1},
            },
            GetString, ReadTxn, Text, TextRef, Transact,
        };

        type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

        async fn serve(app: Router) -> std::net::SocketAddr {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            addr
        }

        async fn socket(addr: std::net::SocketAddr, path: &str, cookie: Option<&str>) -> Socket {
            let mut req = format!("ws://{addr}{path}").into_client_request().unwrap();
            req.headers_mut()
                .insert(header::ORIGIN, "http://localhost".parse().unwrap());
            if let Some(c) = cookie {
                req.headers_mut().insert(header::COOKIE, c.parse().unwrap());
            }
            connect_async(req).await.unwrap().0
        }

        struct Client {
            ws: Socket,
            aw: Awareness,
            text: TextRef,
        }

        impl Client {
            async fn connect(addr: std::net::SocketAddr, doc: &str, cookie: &str) -> Self {
                let mut ws = socket(addr, &format!("/ws/projects/1/doc/{doc}"), Some(cookie)).await;
                let ydoc = yrs::Doc::new();
                let text = ydoc.get_or_insert_text("content");
                let aw = Awareness::new(ydoc);
                let mut enc = EncoderV1::new();
                DefaultProtocol.start(&aw, &mut enc).unwrap();
                ws.send(Ws::binary(enc.to_vec())).await.unwrap();
                Self { ws, aw, text }
            }

            fn text(&self) -> String {
                let s = self.text.get_string(&self.aw.doc().transact());
                s
            }

            /// Processes server messages until `done(text)` holds; panics after 5 s.
            async fn until(&mut self, done: impl Fn(&str) -> bool) {
                self.pump(|c| done(&c.text())).await
            }

            /// Awareness states of *other* clients that are still connected.
            fn peers(&self) -> usize {
                let me = self.aw.client_id();
                self.aw
                    .iter()
                    .filter(|(id, s)| *id != me && s.data.is_some())
                    .count()
            }

            async fn pump(&mut self, done: impl Fn(&Self) -> bool) {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                while !done(self) {
                    let msg = tokio::time::timeout_at(deadline, self.ws.next())
                        .await
                        .unwrap_or_else(|_| panic!("timeout, text = {:?}", self.text()))
                        .expect("socket open")
                        .unwrap();
                    if let Ws::Binary(data) = msg {
                        // the browser's y-websocket reads exactly one message per frame (#18)
                        let mut dec = DecoderV1::new(Cursor::new(&data));
                        assert_eq!(MessageReader::new(&mut dec).count(), 1, "frame {data:?}");
                        for reply in DefaultProtocol.handle(&mut self.aw, &data).unwrap() {
                            self.ws.send(Ws::binary(reply.encode_v1())).await.unwrap();
                        }
                    }
                }
            }

            async fn set_user(&mut self, name: &str) {
                self.aw
                    .set_local_state(serde_json::json!({ "user": { "name": name } }))
                    .unwrap();
                let update = self.aw.update().unwrap();
                let msg = Message::Awareness(update).encode_v1();
                self.ws.send(Ws::binary(msg)).await.unwrap();
            }

            async fn insert(&mut self, index: u32, s: &str) {
                let doc = self.aw.doc();
                let sv = doc.transact().state_vector();
                self.text.insert(&mut doc.transact_mut(), index, s);
                let update = doc.transact().encode_state_as_update_v1(&sv);
                let msg = Message::Sync(SyncMessage::Update(update)).encode_v1();
                self.ws.send(Ws::binary(msg)).await.unwrap();
            }

            /// Removes `len` bytes at byte `index`.
            async fn remove(&mut self, index: u32, len: u32) {
                let doc = self.aw.doc();
                let sv = doc.transact().state_vector();
                self.text.remove_range(&mut doc.transact_mut(), index, len);
                let update = doc.transact().encode_state_as_update_v1(&sv);
                let msg = Message::Sync(SyncMessage::Update(update)).encode_v1();
                self.ws.send(Ws::binary(msg)).await.unwrap();
            }
        }

        /// Next close code, skipping other frames.
        async fn close_code(ws: &mut Socket) -> u16 {
            loop {
                let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
                    .await
                    .expect("close in time");
                match msg {
                    Some(Ok(Ws::Close(Some(f)))) => return f.code.into(),
                    Some(Ok(_)) => continue,
                    other => panic!("no close frame: {other:?}"),
                }
            }
        }

        async fn eventually(what: &str, check: impl Fn() -> bool) {
            for _ in 0..50 {
                if check() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("{what} did not happen within 5 s");
        }

        /// #58: viewer/commenter sockets get the doc and awareness, their edits are dropped.
        #[tokio::test]
        async fn viewer_doc_socket_is_read_only() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, alice, repo) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            let bob = cookie_of(&app, "bob").await;
            let add = json!({ "username": "bob", "role": "viewer" });
            let add = post_json("/api/projects/1/members", &alice, add);
            assert_eq!(call(&app, add).await.0, 201);
            let doc = "papers/a/main.tex";

            let mut a = Client::connect(addr, doc, &alice).await;
            let mut v = Client::connect(addr, doc, &bob).await;
            a.until(|t| t == "x").await;
            v.until(|t| t == "x").await;

            // the viewer's edit, then its cursor on the same socket: once the cursor arrived,
            // the edit was handled (and dropped)
            v.insert(0, "EVIL ").await;
            v.set_user("Bob").await;
            a.pump(|c| c.peers() == 1).await;
            a.insert(1, " ok").await;
            v.until(|t| t.ends_with("x ok")).await;
            assert_eq!(a.text(), "x ok");

            let mut late = Client::connect(addr, doc, &alice).await;
            late.pump(|c| c.peers() == 1 && c.text() == "x ok").await;
            let file = repo.join(doc);
            eventually("disk write", || {
                std::fs::read_to_string(&file).unwrap() == "x ok"
            })
            .await;
        }

        #[tokio::test]
        async fn collaborative_editing_with_disk_bridge() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, cookie, parent) = with_project(&parent).await;
            // clones share AppState: HTTP via `call`, WebSockets via the live server
            let addr = serve(app.clone()).await;
            let file = parent.join("papers/a/main.tex");

            let mut anon = socket(addr, "/ws/projects/1/doc/papers/a/main.tex", None).await;
            assert_eq!(close_code(&mut anon).await, 4401);
            let mut missing =
                socket(addr, "/ws/projects/1/doc/papers/a/nope.tex", Some(&cookie)).await;
            assert_eq!(close_code(&mut missing).await, 4404);
            let stale = parent.join("papers/b/stale.tex");
            std::fs::create_dir_all(stale.parent().unwrap()).unwrap();
            std::fs::write(&stale, "stale").unwrap();
            let mut uninitialized =
                socket(addr, "/ws/projects/1/doc/papers/b/stale.tex", Some(&cookie)).await;
            assert_eq!(close_code(&mut uninitialized).await, 4404);

            let mut a = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            let mut b = Client::connect(addr, "papers%2Fa%2Fmain.tex", &cookie).await;
            a.until(|t| t == "x").await;
            b.until(|t| t == "x").await;

            // a joiner sees existing cursors right away (awareness in its own start frame, #18)
            a.set_user("Alice").await;
            b.pump(|c| c.peers() == 1).await;
            let mut late = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            late.pump(|c| c.peers() == 1 && c.text() == "x").await;
            drop(late);

            // edits converge between clients and reach the disk after the debounce
            a.insert(0, "hello ").await;
            b.until(|t| t == "hello x").await;
            b.insert(7, "!").await;
            a.until(|t| t == "hello x!").await;
            eventually("disk flush", || {
                std::fs::read_to_string(&file).unwrap() == "hello x!"
            })
            .await;

            // external change (e.g. git pull) is merged into the live doc, no feedback loop
            std::fs::write(&file, "hello x!\nfrom git\n").unwrap();
            a.until(|t| t.ends_with("from git\n")).await;
            b.until(|t| t.ends_with("from git\n")).await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert_eq!(
                std::fs::read_to_string(&file).unwrap(),
                "hello x!\nfrom git\n"
            );
            assert_eq!(a.text(), "hello x!\nfrom git\n");

            // deleting the file closes its doc sockets
            let del = req(
                "DELETE",
                "/api/projects/1/files/papers/a/main.tex",
                &cookie,
                "",
            );
            assert_eq!(call(&app, del).await.0, 204);
            assert_eq!(close_code(&mut a.ws).await, 4404);
            assert!(!file.exists());
        }

        #[tokio::test]
        async fn git_pull_merges_active_editor_state_and_broadcasts() {
            use workspace::tests::{fixture, git};

            let (tmp, parent) = fixture();
            let (app, cookie, parent) = with_project(&parent).await;
            let source = tmp.path().join("a");
            let submodule = parent.join("papers/a");
            let file = submodule.join("main.tex");
            git(
                &submodule,
                &["checkout", "-q", "-B", "main", "--track", "origin/main"],
            );

            let base = "intro\nmiddle\nend\n";
            std::fs::write(source.join("main.tex"), base).unwrap();
            git(&source, &["add", "main.tex"]);
            git(&source, &["commit", "-qm", "base"]);
            git(&submodule, &["pull", "--ff-only", "-q"]);
            assert_eq!(std::fs::read_to_string(&file).unwrap(), base);

            let addr = serve(app.clone()).await;
            let mut a = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            let mut b = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            a.until(|text| text == base).await;
            b.until(|text| text == base).await;

            a.insert(0, "local edit\n").await;
            b.until(|text| text == format!("local edit\n{base}")).await;
            let pulled = "intro\nmiddle\nend PULLED\n";
            std::fs::write(source.join("main.tex"), pulled).unwrap();
            git(&source, &["add", "main.tex"]);
            git(&source, &["commit", "-qm", "external update"]);

            let (status, _, body) = call(
                &app,
                post_json(
                    "/api/projects/1/git/pull",
                    &cookie,
                    json!({ "repo": "papers/a" }),
                ),
            )
            .await;
            assert_eq!(status, 200, "{body}");

            let expected = "local edit\nintro\nmiddle\nend PULLED\n";
            a.until(|text| text == expected).await;
            b.until(|text| text == expected).await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert_eq!(std::fs::read_to_string(&file).unwrap(), expected);
            assert_eq!(a.text(), expected);
            assert_eq!(b.text(), expected);
        }

        #[tokio::test]
        async fn commits_credit_every_editor() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, alice, parent) = with_project(&parent).await;
            let sub = parent.join("papers/a");
            let last = |fmt: &str| {
                let out = std::process::Command::new("git")
                    .args(["log", "-1", &format!("--format={fmt}")])
                    .current_dir(&sub)
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&out.stdout).trim().to_owned()
            };
            let add = post_json(
                "/api/projects/1/members",
                &alice,
                json!({ "username": "bob" }),
            );
            assert_eq!(call(&app, add).await.0, 201);
            let bob = cookie_of(&app, "bob").await;

            // own commit e-mail
            let me = |c: &str, v: Value| json_req("PATCH", "/api/auth/me", c, v);
            for bad in ["a b@x.org", "<b@x.org>", "nope"] {
                let (status, _, _) = call(&app, me(&bob, json!({ "commit_email": bad }))).await;
                assert_eq!(status, 400, "{bad}");
            }
            let (status, _, user) = call(
                &app,
                me(&bob, json!({ "commit_email": " bob@commit.org " })),
            )
            .await;
            assert_eq!(
                (status, &user["commit_email"]),
                (200, &json!("bob@commit.org"))
            );
            let (_, _, user) = call(&app, get("/api/auth/me", Some(&bob))).await;
            assert_eq!(user["commit_email"], "bob@commit.org");
            assert!(user.get("github_id").is_none());

            // bob edits live, alice commits
            let addr = serve(app.clone()).await;
            let mut a = Client::connect(addr, "papers/a/main.tex", &alice).await;
            let mut b = Client::connect(addr, "papers/a/main.tex", &bob).await;
            a.until(|t| t == "x").await;
            b.until(|t| t == "x").await;
            b.insert(0, "bob ").await;
            a.until(|t| t == "bob x").await;
            let put = req("PUT", "/api/projects/1/files/papers/a/notes.tex", &bob, "n");
            assert_eq!(call(&app, put).await.0, 204);

            let co = |c: &str, q: &str| get(&format!("/api/projects/1/git/coauthors?{q}"), Some(c));
            let (status, _, list) = call(&app, co(&alice, "repo=papers/a")).await;
            assert_eq!(status, 200, "{list}");
            assert_eq!(list, json!([{ "username": "bob", "display_name": "Bob" }]));
            let (_, _, list) = call(&app, co(&bob, "repo=papers/a")).await;
            assert_eq!(list, json!([]), "the caller is the author, not a co-author");
            let (_, _, list) = call(&app, co(&alice, "repo=")).await;
            assert_eq!(
                list,
                json!([]),
                "submodule edits don't credit parent commits"
            );

            let commit = |body: Value| post_json("/api/projects/1/git/commit", &alice, body);
            let main_only = json!(["papers/a/main.tex"]);
            let (status, _, body) = call(
                &app,
                commit(json!({ "repo": "papers/a", "message": "intro", "paths": main_only })),
            )
            .await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(
                last("%an <%ae>|%cn <%ce>"),
                "Alice <a@x.org>|Alice <a@x.org>"
            );
            assert_eq!(last("%B"), "intro\n\nCo-authored-by: Bob <bob@commit.org>");

            // bob didn't edit main.tex again: no trailer; his notes.tex is still pending
            a.insert(0, "alice ").await;
            b.until(|t| t == "alice bob x").await;
            let (status, _, body) = call(
                &app,
                commit(json!({ "repo": "papers/a", "message": "again", "paths": main_only })),
            )
            .await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(last("%B"), "again");
            let (_, _, list) = call(&app, co(&alice, "repo=papers/a")).await;
            assert_eq!(list, json!([{ "username": "bob", "display_name": "Bob" }]));

            // explicit co_authors replace the detected ones and must have project access
            let (status, _, _) = call(
                &app,
                commit(json!({ "repo": "papers/a", "message": "n", "co_authors": ["carol"] })),
            )
            .await;
            assert_eq!(status, 400);
            let (status, _, body) = call(
                &app,
                commit(json!({
                    "repo": "papers/a", "message": "notes", "co_authors": ["root", "alice", "root"]
                })),
            )
            .await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(last("%B"), "notes\n\nCo-authored-by: Root <r@x.org>");
            let (_, _, list) = call(&app, co(&alice, "repo=papers/a")).await;
            assert_eq!(list, json!([]));
        }

        #[tokio::test]
        async fn project_commit_identity() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, alice, cloned_parent) = with_project(&parent).await;
            let sub = cloned_parent.join("papers/a");
            let last = |fmt: &str| {
                let out = std::process::Command::new("git")
                    .args(["log", "-1", &format!("--format={fmt}")])
                    .current_dir(&sub)
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&out.stdout).trim().to_owned()
            };

            let (_, _, p1) = call(&app, get("/api/projects/1", Some(&alice))).await;
            assert_eq!(
                (&p1["commit_name"], &p1["commit_email"]),
                (&Value::Null, &Value::Null)
            );
            let (_, _, list) = call(&app, get("/api/projects", Some(&alice))).await;
            assert_eq!(
                (&list[0]["commit_name"], &list[0]["commit_email"]),
                (&Value::Null, &Value::Null)
            );

            // role checks: non-member -> 404, viewer/commenter -> 403, editor/owner/admin -> 200
            let patch_id = |pid: i64, c: &str, v: Value| {
                json_req("PATCH", &format!("/api/projects/{pid}/git/identity"), c, v)
            };
            assert_eq!(
                call(
                    &app,
                    patch_id(1, &cookie_of(&app, "carol").await, json!({}))
                )
                .await
                .0,
                404
            );
            assert_eq!(
                call(
                    &app,
                    post_json(
                        "/api/projects/1/members",
                        &alice,
                        json!({ "username": "bob", "role": "viewer" })
                    )
                )
                .await
                .0,
                201
            );
            let bob = cookie_of(&app, "bob").await;
            let (st, _, body) = call(&app, patch_id(1, &bob, json!({ "commit_name": "B" }))).await;
            assert_eq!(
                (st, &body["error"]["code"]),
                (403, &json!("insufficient_role"))
            );
            assert_eq!(
                call(
                    &app,
                    json_req(
                        "PATCH",
                        "/api/projects/1/members/bob",
                        &alice,
                        json!({ "role": "commenter" })
                    )
                )
                .await
                .0,
                204
            );
            assert_eq!(
                call(&app, patch_id(1, &bob, json!({ "commit_name": "B" })))
                    .await
                    .0,
                403
            );
            assert_eq!(
                call(
                    &app,
                    json_req(
                        "PATCH",
                        "/api/projects/1/members/bob",
                        &alice,
                        json!({ "role": "editor" })
                    )
                )
                .await
                .0,
                204
            );
            assert_eq!(
                call(&app, patch_id(1, &cookie_of(&app, "root").await, json!({})))
                    .await
                    .0,
                200
            );

            // validation
            for bad_name in ["<Ada>", "...", "Ada\nB"] {
                assert_eq!(
                    call(
                        &app,
                        patch_id(1, &alice, json!({ "commit_name": bad_name }))
                    )
                    .await
                    .0,
                    400,
                    "{bad_name}"
                );
            }
            assert_eq!(
                call(&app, patch_id(1, &alice, json!({ "commit_email": "nope" })))
                    .await
                    .0,
                400
            );

            // partial PATCH preserves the other field
            let (st, _, id_res) = call(
                &app,
                patch_id(1, &alice, json!({ "commit_name": " Dr. Alice " })),
            )
            .await;
            assert_eq!(
                (st, id_res),
                (
                    200,
                    json!({ "commit_name": "Dr. Alice", "commit_email": null })
                )
            );
            let (st, _, id_res) = call(
                &app,
                patch_id(1, &alice, json!({ "commit_email": " alice@uni.edu " })),
            )
            .await;
            assert_eq!(
                (st, id_res),
                (
                    200,
                    json!({ "commit_name": "Dr. Alice", "commit_email": "alice@uni.edu" })
                )
            );
            let (_, _, p1) = call(&app, get("/api/projects/1", Some(&alice))).await;
            assert_eq!(
                (&p1["commit_name"], &p1["commit_email"]),
                (&json!("Dr. Alice"), &json!("alice@uni.edu"))
            );

            // second project remains unaffected
            let (st, _, p2) = call(
                &app,
                post_json(
                    "/api/projects",
                    &alice,
                    json!({ "name": "Second", "remote_url": p1["remote_url"] }),
                ),
            )
            .await;
            assert_eq!(st, 201, "{p2}");
            assert_eq!(
                (&p2["commit_name"], &p2["commit_email"]),
                (&Value::Null, &Value::Null)
            );

            // bob sets a per-project identity too (plus a different profile commit_email to prove override wins)
            assert_eq!(
                call(
                    &app,
                    json_req(
                        "PATCH",
                        "/api/auth/me",
                        &bob,
                        json!({ "commit_email": "bob@profile.org" })
                    )
                )
                .await
                .0,
                200
            );
            assert_eq!(
                call(
                    &app,
                    patch_id(
                        1,
                        &bob,
                        json!({ "commit_name": "Prof. Bob", "commit_email": "bob@uni.edu" })
                    )
                )
                .await
                .0,
                200
            );

            assert_eq!(
                call(
                    &app,
                    req("PUT", "/api/projects/1/files/papers/a/id.tex", &bob, "one")
                )
                .await
                .0,
                204
            );
            assert_eq!(
                call(
                    &app,
                    req(
                        "PUT",
                        "/api/projects/1/files/papers/a/alice.tex",
                        &alice,
                        "two"
                    )
                )
                .await
                .0,
                204
            );
            let (_, _, co) = call(
                &app,
                get("/api/projects/1/git/coauthors?repo=papers/a", Some(&alice)),
            )
            .await;
            assert_eq!(
                co,
                json!([{ "username": "bob", "display_name": "Prof. Bob" }])
            );

            let (st, _, body) = call(
                &app,
                post_json(
                    "/api/projects/1/git/commit",
                    &alice,
                    json!({ "repo": "papers/a", "message": "project identity" }),
                ),
            )
            .await;
            assert_eq!(st, 200, "{body}");
            assert_eq!(
                last("%an <%ae>|%cn <%ce>"),
                "Dr. Alice <alice@uni.edu>|Dr. Alice <alice@uni.edu>"
            );
            assert_eq!(
                last("%B"),
                "project identity\n\nCo-authored-by: Prof. Bob <bob@uni.edu>"
            );

            // resetting restores profile defaults
            let (st, _, id_res) = call(
                &app,
                patch_id(
                    1,
                    &alice,
                    json!({ "commit_name": null, "commit_email": "" }),
                ),
            )
            .await;
            assert_eq!(
                (st, id_res),
                (200, json!({ "commit_name": null, "commit_email": null }))
            );
            let (st, _, _) = call(
                &app,
                patch_id(
                    1,
                    &bob,
                    json!({ "commit_name": null, "commit_email": null }),
                ),
            )
            .await;
            assert_eq!(st, 200);
            assert_eq!(
                call(
                    &app,
                    req("PUT", "/api/projects/1/files/papers/a/id.tex", &bob, "two")
                )
                .await
                .0,
                204
            );
            let (_, _, co) = call(
                &app,
                get("/api/projects/1/git/coauthors?repo=papers/a", Some(&alice)),
            )
            .await;
            assert_eq!(co, json!([{ "username": "bob", "display_name": "Bob" }]));
            let (st, _, body) = call(
                &app,
                post_json(
                    "/api/projects/1/git/commit",
                    &alice,
                    json!({ "repo": "papers/a", "message": "back to defaults" }),
                ),
            )
            .await;
            assert_eq!(st, 200, "{body}");
            assert_eq!(
                last("%an <%ae>|%cn <%ce>"),
                "Alice <a@x.org>|Alice <a@x.org>"
            );
            assert_eq!(
                last("%B"),
                "back to defaults\n\nCo-authored-by: Bob <bob@profile.org>"
            );
        }

        async fn ranges(app: &Router, cookie: &str) -> Vec<(String, u64, u64, bool)> {
            let uri = "/api/projects/1/comments?path=papers/a/main.tex";
            let (_, _, l) = call(app, get(uri, Some(cookie))).await;
            (l.as_array().unwrap().iter())
                .map(|t| {
                    let n = |k: &str| t[k].as_u64().unwrap();
                    let quote = t["quote"].as_str().unwrap().to_owned();
                    (quote, n("start"), n("end"), t["detached"] == true)
                })
                .collect()
        }

        /// Polls `GET …/comments` until the ranges are `want`; panics after 5 s.
        async fn until_ranges(app: &Router, cookie: &str, want: &[(&str, u64, u64, bool)]) {
            let want: Vec<_> = (want.iter())
                .map(|(q, s, e, d)| (q.to_string(), *s, *e, *d))
                .collect();
            for _ in 0..50 {
                if ranges(app, cookie).await == want {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert_eq!(ranges(app, cookie).await, want);
        }

        #[tokio::test]
        async fn comments_follow_edits_and_reanchor_on_load() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, cookie, parent) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            let file = parent.join("papers/a/main.tex");
            std::fs::write(&file, "intro 😀 target and other end\n").unwrap();
            let mut events = socket(addr, "/ws/projects/1/events", Some(&cookie)).await;
            let new = |start: u32, end: u32| {
                let body =
                    json!({ "path": "papers/a/main.tex", "start": start, "end": end, "body": "?" });
                post_json("/api/projects/1/comments", &cookie, body)
            };
            // "intro 😀 " = 9 UTF-16 units
            let (status, _, t) = call(&app, new(9, 15)).await;
            assert_eq!((status, &t["quote"]), (201, &json!("target")), "{t}");
            let ev = next_event(&mut events, |e| e["type"] == "comments").await;
            assert_eq!(
                ev,
                json!({ "type": "comments", "path": "papers/a/main.tex" })
            );
            assert_eq!(call(&app, new(20, 25)).await.2["quote"], "other");

            // open doc: anchors move with edits (GET returns UTF-16, the doc counts bytes)
            let mut c = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            c.until(|t| t.starts_with("intro")).await;
            c.insert(0, "NEW ").await;
            let moved = [("target", 13, 19, false), ("other", 24, 29, false)];
            until_ranges(&app, &cookie, &moved).await;

            // the flush on unload stores them; the file changes while nobody has it open
            c.ws.close(None).await.unwrap();
            drop(c);
            tokio::time::sleep(Duration::from_millis(2000)).await;
            until_ranges(&app, &cookie, &moved).await;
            std::fs::write(&file, "target first, rest\n").unwrap();

            // loading re-anchors: moved quote → nearest occurrence, missing quote → detached
            let mut c = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            c.until(|t| t == "target first, rest\n").await;
            let reanchored = [("target", 0, 6, false), ("other", 24, 29, true)];
            until_ranges(&app, &cookie, &reanchored).await;

            // all of the commented text deleted: detached
            c.remove(0, 6).await;
            let gone = [("target", 0, 0, true), ("other", 24, 29, true)];
            until_ranges(&app, &cookie, &gone).await;
        }

        #[tokio::test]
        async fn compile_request_flushes_live_edits_immediately() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, cookie, parent) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            let mut a = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            a.until(|t| t == "x").await;
            a.insert(0, "\\begin{document} ").await;
            // the server applied the update once it echoes nothing back; give it a moment
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(
                call(&app, post_compile("papers/a/main.tex", &cookie))
                    .await
                    .0,
                202
            );
            // well before the 1 s debounce: Ctrl+S must not wait for it
            let text = std::fs::read_to_string(parent.join("papers/a/main.tex")).unwrap();
            assert_eq!(text, "\\begin{document} x");
        }

        #[tokio::test]
        async fn project_delete_closes_sockets_and_removes_clone() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, cookie, repo) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            let carol = call(&app, login("carol")).await.1.unwrap();
            let mut foreign =
                socket(addr, "/ws/projects/1/doc/papers/a/main.tex", Some(&carol)).await;
            assert_eq!(close_code(&mut foreign).await, 4404);

            let mut a = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            a.until(|t| t == "x").await;
            let mut events = socket(addr, "/ws/projects/1/events", Some(&cookie)).await;
            let project_dir = repo.parent().unwrap().to_owned();
            assert!(project_dir.join("ydocs").is_dir());

            let del = req("DELETE", "/api/projects/1", &cookie, "");
            assert_eq!(call(&app, del).await.0, 204);
            assert_eq!(close_code(&mut a.ws).await, 4404);
            assert_eq!(close_code(&mut events).await, 4404);
            assert!(!project_dir.exists());
            assert_eq!(
                call(&app, get("/api/projects/1/tree", Some(&cookie)))
                    .await
                    .0,
                404
            );
            let (_, _, list) = call(&app, get("/api/projects", Some(&cookie))).await;
            assert_eq!(list, json!([]));
        }

        /// #60: an edit that races with the move is either part of the moved file or rejected;
        /// the old path is never written again.
        #[tokio::test]
        async fn move_does_not_lose_or_misplace_racing_edits() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, alice, repo) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            for n in 0..4 {
                let from = format!("papers/a/old{n}/intro.tex");
                let to_dir = format!("papers/a/new{n}");
                assert_eq!(call(&app, put_text(&alice, &from, "hi")).await.0, 204);
                let mut c = Client::connect(addr, &from, &alice).await;
                c.until(|t| t == "hi").await;
                c.insert(2, "!").await;
                let body = json!({ "from": format!("papers/a/old{n}"), "to": to_dir });
                let mv = post_json("/api/projects/1/files/move", &alice, body);
                assert_eq!(call(&app, mv).await.0, 200);
                assert_eq!(close_code(&mut c.ws).await, 4404);
                // longer than the flush debounce: a stray flush would recreate the old path
                tokio::time::sleep(Duration::from_millis(1500)).await;
                let moved = std::fs::read_to_string(repo.join(&to_dir).join("intro.tex")).unwrap();
                assert!(moved == "hi" || moved == "hi!", "{moved:?}");
                assert!(!repo.join(format!("papers/a/old{n}")).exists());
            }
        }

        /// #60: moving closes the old rooms, announces `moved`, and rewrites references through the
        /// open docs.
        #[tokio::test]
        async fn move_closes_docs_and_edits_open_references() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, alice, repo) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            for (path, text) in [
                ("papers/a/main.tex", MOVE_MAIN),
                ("papers/a/sec/intro.tex", "hi"),
            ] {
                assert_eq!(call(&app, put_text(&alice, path, text)).await.0, 204);
            }
            let mut events = socket(addr, "/ws/projects/1/events", Some(&alice)).await;
            let mut main = Client::connect(addr, "papers/a/main.tex", &alice).await;
            let mut intro = Client::connect(addr, "papers/a/sec/intro.tex", &alice).await;
            main.until(|t| t.contains("sec/intro")).await;
            intro.until(|t| t == "hi").await;
            // an edit that is not flushed yet: the move must carry it
            intro.insert(2, "!").await;
            tokio::time::sleep(Duration::from_millis(200)).await;

            let body =
                json!({ "from": "papers/a/sec", "to": "papers/a/chapters", "update_refs": true });
            let mv = post_json("/api/projects/1/files/move", &alice, body);
            let (status, _, b) = call(&app, mv).await;
            assert_eq!(status, 200, "{b}");
            assert_eq!(
                b["updated_refs"],
                json!([{ "file": "papers/a/main.tex", "count": 1 }])
            );

            let ev = next_event(&mut events, |e| e["type"] == "moved").await;
            assert_eq!(
                ev,
                json!({ "type": "moved", "from": "papers/a/sec", "to": "papers/a/chapters" })
            );
            assert_eq!(close_code(&mut intro.ws).await, 4404);
            // collaborators see the rewrite in the doc itself
            main.until(|t| t.contains("{chapters/intro}") && !t.contains("sec/intro"))
                .await;
            let file = repo.join("papers/a/main.tex");
            eventually("disk write", || {
                (std::fs::read_to_string(&file).unwrap()).contains("{chapters/intro}")
            })
            .await;
            let mut again = Client::connect(addr, "papers/a/chapters/intro.tex", &alice).await;
            again.until(|t| t == "hi!").await;
        }

        #[tokio::test]
        async fn role_change_closes_the_members_doc_sockets() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, cookie, _) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            let added = post_json(
                "/api/projects/1/members",
                &cookie,
                json!({ "username": "carol" }),
            );
            assert_eq!(call(&app, added).await.0, 201);
            let carol = call(&app, login("carol")).await.1.unwrap();
            let mut c = Client::connect(addr, "papers/a/main.tex", &carol).await;
            c.until(|t| t == "x").await;
            let mut a = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            a.until(|t| t == "x").await;
            let patch = json_req(
                "PATCH",
                "/api/projects/1/members/carol",
                &cookie,
                json!({ "role": "viewer" }),
            );
            assert_eq!(call(&app, patch).await.0, 204);
            assert_eq!(close_code(&mut c.ws).await, 4403);
            // someone else's socket stays open
            a.insert(0, "y").await;
        }

        /// #61 review: chat events carry content, so a removed member's open events socket
        /// closes; a role change keeps it (viewers read the chat).
        #[tokio::test]
        async fn removed_member_loses_the_events_socket() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, alice, _) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            for user in ["bob", "carol"] {
                let add = json!({ "username": user });
                let add = post_json("/api/projects/1/members", &alice, add);
                assert_eq!(call(&app, add).await.0, 201);
            }
            let bob = call(&app, login("bob")).await.1.unwrap();
            let carol = call(&app, login("carol")).await.1.unwrap();
            let mut b = socket(addr, "/ws/projects/1/events", Some(&bob)).await;
            let mut c = socket(addr, "/ws/projects/1/events", Some(&carol)).await;
            let chat =
                |body: &str| post_json("/api/projects/1/chat", &alice, json!({ "body": body }));
            let is_chat = |e: &Value| e["type"] == "chat";

            // demotion: the socket stays and still gets the chat
            let patch = json_req(
                "PATCH",
                "/api/projects/1/members/bob",
                &alice,
                json!({ "role": "viewer" }),
            );
            assert_eq!(call(&app, patch).await.0, 204);
            assert_eq!(call(&app, chat("one")).await.0, 201);
            assert_eq!(next_event(&mut b, is_chat).await["message"]["body"], "one");

            // removal: carol's socket closes (4404) instead of delivering the next message
            let rm = req("DELETE", "/api/projects/1/members/carol", &alice, "");
            assert_eq!(call(&app, rm).await.0, 204);
            assert_eq!(close_code(&mut c).await, 4404);
            assert_eq!(call(&app, chat("two")).await.0, 201);
            assert_eq!(next_event(&mut b, is_chat).await["message"]["body"], "two");
        }

        #[tokio::test]
        async fn deleting_a_user_closes_their_doc_sockets() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, cookie, _) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            let added = post_json(
                "/api/projects/1/members",
                &cookie,
                json!({ "username": "carol" }),
            );
            assert_eq!(call(&app, added).await.0, 201);
            let carol = call(&app, login("carol")).await.1.unwrap();
            let mut c = Client::connect(addr, "papers/a/main.tex", &carol).await;
            c.until(|t| t == "x").await;
            let mut a = Client::connect(addr, "papers/a/main.tex", &cookie).await;
            a.until(|t| t == "x").await;
            let root = cookie_of(&app, "root").await;
            let (_, _, me) = call(&app, get("/api/auth/me", Some(&carol))).await;
            let del = req(
                "DELETE",
                &format!("/api/admin/users/{}", me["id"].as_i64().unwrap()),
                &root,
                "",
            );
            assert_eq!(call(&app, del).await.0, 204);
            assert_eq!(close_code(&mut c.ws).await, 4403);
            a.insert(0, "y").await;
        }

        #[tokio::test]
        async fn events_socket_reports_tree_changes() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, cookie, _) = with_project(&parent).await;
            let addr = serve(app.clone()).await;
            let mut events = socket(addr, "/ws/projects/1/events", Some(&cookie)).await;

            let put = req(
                "PUT",
                "/api/projects/1/files/papers/a/new.tex",
                &cookie,
                "y",
            );
            assert_eq!(call(&app, put).await.0, 204);
            let ev = next_event(&mut events, |e| e["type"] != "presence").await;
            assert_eq!(ev, json!({ "type": "tree_changed" }));
        }

        /// Next JSON event on an events socket matching `want`, skipping others; panics after 5 s.
        async fn next_event(ws: &mut Socket, want: impl Fn(&Value) -> bool) -> Value {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                let msg = tokio::time::timeout_at(deadline, ws.next())
                    .await
                    .expect("event in time")
                    .expect("socket open")
                    .unwrap();
                let ev: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
                if want(&ev) {
                    return ev;
                }
            }
        }

        #[tokio::test]
        async fn events_socket_reports_presence() {
            let (_tmp, parent) = workspace::tests::fixture();
            let (app, alice, _) = with_project(&parent).await;
            let add = post_json(
                "/api/projects/1/members",
                &alice,
                json!({ "username": "bob" }),
            );
            assert_eq!(call(&app, add).await.0, 201);
            let bob = cookie_of(&app, "bob").await;
            let addr = serve(app.clone()).await;
            let mut events = socket(addr, "/ws/projects/1/events", Some(&alice)).await;
            let users = |ev: &Value| ev["users"].clone();

            // snapshot first, with alice herself
            let snapshot = next_event(&mut events, |_| true).await;
            assert_eq!(snapshot["type"], "presence");
            assert_eq!(
                users(&snapshot),
                json!([{ "username": "alice", "display_name": "Alice", "file": null }])
            );

            // bob joins and reports the file he has in focus
            let mut b = socket(addr, "/ws/projects/1/events", Some(&bob)).await;
            let focus = |path: Value| {
                let frame = json!({ "type": "focus", "path": path }).to_string();
                Ws::Text(frame.into())
            };
            b.send(focus(json!("papers/a/main.tex"))).await.unwrap();
            let bob_in = |file: &'static str| {
                move |ev: &Value| {
                    ev["type"] == "presence"
                        && ev["users"].as_array().unwrap().len() == 2
                        && ev["users"][1]["file"] == file
                }
            };
            let ev = next_event(&mut events, bob_in("papers/a/main.tex")).await;
            assert_eq!(
                users(&ev)[1],
                json!({ "username": "bob", "display_name": "Bob", "file": "papers/a/main.tex" })
            );

            // an invalid path counts as no focus; garbage frames are ignored
            b.send(Ws::Text("nonsense".into())).await.unwrap();
            b.send(focus(json!("../../etc/passwd"))).await.unwrap();
            let ev = next_event(&mut events, |e| {
                e["type"] == "presence"
                    && e["users"].as_array().unwrap().len() == 2
                    && e["users"][1]["file"].is_null()
            })
            .await;
            assert_eq!(users(&ev)[1]["username"], "bob");

            b.close(None).await.unwrap();
            let ev = next_event(&mut events, |e| e["type"] == "presence").await;
            assert_eq!(users(&ev), users(&snapshot));
        }

        /// Zotero accounts and `.bib` import/refresh against a mock Zotero API.
        mod zotero {
            use super::*;
            use axum::{
                extract::{Query, State},
                http::{HeaderMap, StatusCode, Uri},
                response::{IntoResponse, Response},
            };

            #[derive(Default)]
            struct Data {
                /// items in alice's library
                items: usize,
                /// `Last-Modified-Version` of her library
                version: u64,
                /// (path+query, key header, version header) of every request
                calls: Vec<(String, String, String)>,
            }

            type Mock = Arc<Mutex<Data>>;

            fn bib(format: &str, range: std::ops::Range<usize>) -> String {
                let kind = if format == "bibtex" {
                    "book"
                } else {
                    "article"
                };
                range
                    .map(|i| format!("\n@{kind}{{k{i},\n  title = {{T{i}}},\n}}\n"))
                    .collect()
            }

            /// Keys: `goodkey` (user 123, group 456; group 789 forbidden) and `bobkey` (user 999).
            async fn mock(
                State(m): State<Mock>,
                uri: Uri,
                headers: HeaderMap,
                Query(q): Query<HashMap<String, String>>,
            ) -> Response {
                let h = |k: &str| {
                    headers
                        .get(k)
                        .map_or("", |v| v.to_str().unwrap())
                        .to_owned()
                };
                let (key, version) = (h("zotero-api-key"), h("zotero-api-version"));
                let full = uri.path_and_query().unwrap().as_str().to_owned();
                let since = h("if-modified-since-version");
                let (items, lib_version) = {
                    let mut d = m.lock().unwrap();
                    d.calls.push((full, key.clone(), version.clone()));
                    (d.items, d.version)
                };
                if version != "3" {
                    return (StatusCode::BAD_REQUEST, "API version").into_response();
                }
                let start: usize = q.get("start").map_or(0, |s| s.parse().unwrap());
                let format = q.get("format").cloned().unwrap_or_default();
                let page = |total: usize| {
                    if since == lib_version.to_string() {
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    let end = total.min(start + 100);
                    let mut res = bib(&format, start..end).into_response();
                    let hs = res.headers_mut();
                    hs.insert("last-modified-version", lib_version.into());
                    hs.insert("total-results", total.to_string().parse().unwrap());
                    if start == 0 {
                        hs.insert("backoff", "1".parse().unwrap());
                    }
                    res
                };
                let user = match key.as_str() {
                    "goodkey" => 123,
                    "bobkey" => 999,
                    _ => return (StatusCode::FORBIDDEN, "Invalid key").into_response(),
                };
                match uri.path() {
                    "/keys/current" => {
                        let name = if user == 123 { "zalice" } else { "zbob" };
                        Json(json!({ "userID": user, "username": name, "key": key }))
                            .into_response()
                    }
                    "/users/123/groups" if user == 123 => {
                        Json(json!([{ "id": 456, "data": { "name": "Chair" } }])).into_response()
                    }
                    "/users/123/collections" if user == 123 => Json(json!([
                        { "key": "COLL1", "data": { "name": "Thesis", "parentCollection": false } },
                        { "key": "COLL2", "data": { "name": "Ch1", "parentCollection": "COLL1" } },
                    ]))
                    .into_response(),
                    "/users/123/items/top" if user == 123 => page(items),
                    "/users/123/collections/COLL1/items/top" if user == 123 => page(3),
                    // 100 entries of ~50 KiB per page: the second page crosses the 8 MiB cap
                    "/users/123/collections/BIG/items/top" if user == 123 => {
                        let pad = "x".repeat(50 * 1024);
                        let entries: String = (start..start + 100)
                            .map(|i| format!("@misc{{b{i},\n  note = {{{pad}}},\n}}\n\n"))
                            .collect();
                        ([("total-results", "1000")], entries).into_response()
                    }
                    "/groups/456/items/top" => {
                        let mut res = StatusCode::TOO_MANY_REQUESTS.into_response();
                        res.headers_mut()
                            .insert("retry-after", "120".parse().unwrap());
                        res
                    }
                    _ if user == 123 && uri.path().starts_with("/groups/789/") => {
                        (StatusCode::FORBIDDEN, "Forbidden").into_response()
                    }
                    _ => (StatusCode::NOT_FOUND, "Not found").into_response(),
                }
            }

            fn connect(cookie: &str, key: &str) -> Request<Body> {
                let body = json!({ "provider": "zotero", "token": key });
                post_json("/api/accounts", cookie, body)
            }

            fn import(cookie: &str, body: Value) -> Request<Body> {
                post_json("/api/projects/1/zotero/import", cookie, body)
            }

            fn refresh(cookie: &str, path: &str) -> Request<Body> {
                let body = json!({ "path": path });
                post_json("/api/projects/1/zotero/refresh", cookie, body)
            }

            #[tokio::test]
            async fn zotero_connect_import_refresh() {
                let data: Mock = Arc::default();
                data.lock().unwrap().items = 150;
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}", listener.local_addr().unwrap());
                let api = Router::new().fallback(mock).with_state(data.clone());
                tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });

                let (_tmp, parent) = workspace::tests::fixture();
                let mut cfg = test_cfg(true);
                cfg.zotero_api_url = base;
                let (app, alice, repo) = with_project_cfg(cfg, &parent).await;
                let addr = serve(app.clone()).await;
                let bob = cookie_of(&app, "bob").await;
                let add_bob = json!({ "username": "bob" });
                let res = call(&app, post_json("/api/projects/1/members", &alice, add_bob)).await;
                assert_eq!(res.0, 201, "{}", res.2);

                // connect: bad key 400, good key → Account
                let (status, _, body) = call(&app, connect(&alice, "wrongkey")).await;
                assert_eq!(status, 400, "{body}");
                assert!(body.to_string().contains("rejected"), "{body}");
                assert_eq!(call(&app, connect(&alice, "bad/key")).await.0, 400);
                let (status, _, account) = call(&app, connect(&alice, "goodkey")).await;
                assert_eq!(status, 201, "{account}");
                let id = account["id"].as_i64().unwrap();
                let want = json!({ "id": id, "provider": "zotero",
                                   "base_url": "https://api.zotero.org", "login": "zalice",
                                   "ssh_host_key_fingerprint": null });
                assert_eq!(account, want);
                let (_, _, list) = call(&app, get("/api/accounts", Some(&alice))).await;
                assert_eq!(list, json!([want]));
                assert!(!list.to_string().contains("goodkey"));
                let (status, _, bobs) = call(&app, connect(&bob, "bobkey")).await;
                assert_eq!(status, 201, "{bobs}");

                // libraries and collections, own account only
                let libs = format!("/api/accounts/{id}/zotero/libraries");
                let (status, _, body) = call(&app, get(&libs, Some(&alice))).await;
                assert_eq!(status, 200, "{body}");
                assert_eq!(
                    body,
                    json!([{ "library": "user:123", "name": "My Library" },
                           { "library": "group:456", "name": "Chair" }])
                );
                assert_eq!(call(&app, get(&libs, Some(&bob))).await.0, 404);
                let colls = format!("/api/accounts/{id}/zotero/collections?library=user:123");
                let (status, _, body) = call(&app, get(&colls, Some(&alice))).await;
                assert_eq!(status, 200, "{body}");
                assert_eq!(
                    body,
                    json!([{ "key": "COLL1", "name": "Thesis", "parent": null },
                           { "key": "COLL2", "name": "Ch1", "parent": "COLL1" }])
                );
                let bad = format!("/api/accounts/{id}/zotero/collections?library=user:1/x");
                assert_eq!(call(&app, get(&bad, Some(&alice))).await.0, 400);

                // import: validation first
                let lib = |path: &str, library: &str| {
                    json!({ "account_id": id, "library": library, "collection": null,
                            "path": path, "format": "biblatex" })
                };
                for (body, code) in [
                    (lib("refs.tex", "user:123"), "invalid_request"),
                    (lib("../refs.bib", "user:123"), "invalid_path"),
                    (lib("refs.bib", "user:abc"), "invalid_request"),
                    (lib("refs.bib", "group:789"), "zotero_forbidden"),
                ] {
                    let (status, _, res) = call(&app, import(&alice, body.clone())).await;
                    assert_eq!(
                        (status, res["error"]["code"].clone()),
                        (400, json!(code)),
                        "{body}"
                    );
                }
                assert_eq!(
                    call(&app, import(&bob, lib("refs.bib", "user:123")))
                        .await
                        .0,
                    404
                );
                let (status, _, res) =
                    call(&app, import(&alice, lib("refs.bib", "group:456"))).await;
                assert_eq!(
                    (status, res["error"]["code"].clone()),
                    (502, json!("remote_failed"))
                );
                assert!(!repo.join("refs.bib").exists());

                // 150 items → 2 pages; the Backoff of the first page is honored
                data.lock().unwrap().calls.clear();
                let t0 = std::time::Instant::now();
                let (status, _, res) =
                    call(&app, import(&alice, lib("refs.bib", "user:123"))).await;
                assert_eq!(status, 200, "{res}");
                assert!(t0.elapsed() >= Duration::from_secs(1));
                assert_eq!(res, json!({ "path": "refs.bib", "entries": 150 }));
                let text = std::fs::read_to_string(repo.join("refs.bib")).unwrap();
                assert!(text.starts_with("@article{k0,") && text.contains("@article{k149,"));
                let calls = std::mem::take(&mut data.lock().unwrap().calls);
                let paths: Vec<_> = calls.iter().map(|c| c.0.as_str()).collect();
                assert_eq!(
                    paths,
                    [
                        "/users/123/items/top?format=biblatex&limit=100&start=0",
                        "/users/123/items/top?format=biblatex&limit=100&start=100",
                    ]
                );
                assert!(calls.iter().all(|c| c.1 == "goodkey" && c.2 == "3"));

                // collection as BibTeX into a new directory
                let body = json!({ "account_id": id, "library": "user:123", "collection": "COLL1",
                                   "path": "bib/thesis.bib", "format": "bibtex" });
                let (status, _, res) = call(&app, import(&alice, body)).await;
                assert_eq!((status, res["entries"].clone()), (200, json!(3)), "{res}");
                let text = std::fs::read_to_string(repo.join("bib/thesis.bib")).unwrap();
                assert_eq!(text.matches("@book{").count(), 3);

                // over the editor's size limit: paging stops, nothing is written
                data.lock().unwrap().calls.clear();
                let body = json!({ "account_id": id, "library": "user:123", "collection": "BIG",
                                   "path": "big.bib" });
                let (status, _, res) = call(&app, import(&alice, body)).await;
                assert_eq!(
                    (status, res["error"]["code"].clone()),
                    (413, json!("too_large"))
                );
                assert_eq!(data.lock().unwrap().calls.len(), 2);
                assert!(!repo.join("big.bib").exists());

                let (status, _, links) =
                    call(&app, get("/api/projects/1/zotero/links", Some(&bob))).await;
                assert_eq!(status, 200);
                assert_eq!(links.as_array().unwrap().len(), 2);
                assert_eq!(links[0]["path"], "bib/thesis.bib");
                let refs = &links[1];
                assert_eq!(
                    (
                        &refs["path"],
                        &refs["account_id"],
                        &refs["library"],
                        &refs["collection"],
                        &refs["format"]
                    ),
                    (
                        &json!("refs.bib"),
                        &json!(id),
                        &json!("user:123"),
                        &Value::Null,
                        &json!("biblatex")
                    )
                );
                assert!(refs["updated_at"].as_str().unwrap().ends_with('Z'));

                // refresh by a member: alice's account, the open editor gets the new content
                let mut editor = Client::connect(addr, "refs.bib", &bob).await;
                editor.until(|t| t.contains("k149,")).await;
                // an open doc never takes more than the editor can reopen
                let big = Request::put("/api/projects/1/files/refs.bib")
                    .header(header::COOKIE, &bob)
                    .body(Body::from(vec![b'x'; docs::MAX_DOC_BYTES + 1]))
                    .unwrap();
                let (status, _, res) = call(&app, big).await;
                assert_eq!(
                    (status, res["error"]["code"].clone()),
                    (413, json!("too_large"))
                );
                let nul = req("PUT", "/api/projects/1/files/refs.bib", &bob, "a\0b");
                assert_eq!(call(&app, nul).await.0, 400);
                data.lock().unwrap().items = 151;
                let (status, _, res) = call(&app, refresh(&bob, "refs.bib")).await;
                assert_eq!((status, res["entries"].clone()), (200, json!(151)), "{res}");
                editor.until(|t| t.contains("@article{k150,")).await;
                let calls = std::mem::take(&mut data.lock().unwrap().calls);
                assert!(calls.iter().all(|c| c.1 == "goodkey"));
                eventually("disk flush", || {
                    std::fs::read_to_string(repo.join("refs.bib"))
                        .unwrap()
                        .contains("k150,")
                })
                .await;
                assert_eq!(call(&app, refresh(&bob, "nope.bib")).await.0, 404);

                // unlink, and links whose account is gone
                let unlink = |path: &str| {
                    req(
                        "DELETE",
                        &format!("/api/projects/1/zotero/links?path={path}"),
                        &alice,
                        "",
                    )
                };
                assert_eq!(call(&app, unlink("bib/thesis.bib")).await.0, 204);
                assert_eq!(call(&app, unlink("bib/thesis.bib")).await.0, 404);
                assert!(repo.join("bib/thesis.bib").exists());
                let del = req("DELETE", &format!("/api/accounts/{id}"), &alice, "");
                assert_eq!(call(&app, del).await.0, 204);
                let (status, _, res) = call(&app, refresh(&alice, "refs.bib")).await;
                assert_eq!(
                    (status, res["error"]["code"].clone()),
                    (409, json!("conflict"))
                );
                // a Zotero account is not a Git account
                let remote = json!({ "name": "P", "create_remote":
                                     { "account_id": bobs["id"], "repo_name": "p" } });
                let (status, _, res) = call(&app, post_json("/api/projects", &bob, remote)).await;
                assert_eq!(status, 404, "{res}");
            }

            /// One background sync round against the mock (forgets the recorded calls first).
            async fn sync(
                state: &Arc<AppState>,
                data: &Mock,
                paused: &mut HashMap<i64, tokio::time::Instant>,
            ) -> usize {
                data.lock().unwrap().calls.clear();
                crate::zotero::sync_once(state, paused).await;
                let calls = data.lock().unwrap().calls.len();
                calls
            }

            fn set_library(data: &Mock, items: usize, version: u64) {
                let mut d = data.lock().unwrap();
                (d.items, d.version) = (items, version);
            }

            /// Background sync: 304, changes, same content, auto_sync off, pauses, missing files.
            #[tokio::test]
            async fn zotero_autosync() {
                let data: Mock = Arc::default();
                set_library(&data, 5, 10);
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}", listener.local_addr().unwrap());
                let api = Router::new().fallback(mock).with_state(data.clone());
                tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });

                let (_tmp, parent) = workspace::tests::fixture();
                let mut cfg = test_cfg(true);
                cfg.zotero_api_url = base;
                let repo = cfg.data.canonicalize().unwrap().join("projects/1/repo");
                let (app, state) = test_app_state(cfg, true).await;
                let alice = call(&app, login("alice")).await.1.unwrap();
                let (status, _, b) = call(&app, new_project(&alice, &parent, json!({}))).await;
                assert_eq!(status, 201, "{b}");
                let (_, _, account) = call(&app, connect(&alice, "goodkey")).await;
                let body = json!({ "account_id": account["id"], "library": "user:123",
                                   "path": "refs.bib" });
                assert_eq!(call(&app, import(&alice, body)).await.0, 200);

                let links = || async {
                    let uri = "/api/projects/1/zotero/links";
                    call(&app, get(uri, Some(&alice))).await.2
                };
                let version = || async {
                    sqlx::query_scalar::<_, Option<i64>>(
                        "SELECT library_version FROM zotero_links WHERE path = 'refs.bib'",
                    )
                    .fetch_one(&state.db)
                    .await
                    .unwrap()
                };
                let refs = repo.join("refs.bib");
                let mtime = || std::fs::metadata(&refs).unwrap().modified().unwrap();
                let mut paused = HashMap::new();
                let l = links().await;
                assert_eq!(
                    (&l[0]["auto_sync"], &l[0]["last_error"]),
                    (&json!(true), &Value::Null)
                );
                assert!(l[0]["last_synced_at"].as_str().unwrap().ends_with('Z'));
                assert_eq!(version().await, Some(10));

                // 304: one request, nothing written (a local edit survives)
                std::fs::write(&refs, "local edit").unwrap();
                assert_eq!(sync(&state, &data, &mut paused).await, 1);
                assert_eq!(std::fs::read_to_string(&refs).unwrap(), "local edit");

                // new library version: exported again and written, version stored
                set_library(&data, 6, 11);
                sync(&state, &data, &mut paused).await;
                let text = std::fs::read_to_string(&refs).unwrap();
                assert!(text.contains("@article{k5,"), "{text}");
                assert_eq!(version().await, Some(11));

                // new version, same content: nothing is written
                paused.clear(); // drop the pause of the mock's `Backoff: 1`
                set_library(&data, 6, 12);
                let before = mtime();
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert_eq!(sync(&state, &data, &mut paused).await, 1);
                assert_eq!((mtime(), version().await), (before, Some(12)));

                // auto_sync off: not even asked
                let patch = |path: &str, on: bool| {
                    let body = json!({ "path": path, "auto_sync": on }).to_string();
                    Request::patch("/api/projects/1/zotero/links")
                        .header(header::COOKIE, &alice)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .unwrap()
                };
                assert_eq!(call(&app, patch("refs.bib", false)).await.0, 204);
                assert_eq!(call(&app, patch("nope.bib", false)).await.0, 404);
                assert_eq!(links().await[0]["auto_sync"], json!(false));
                paused.clear(); // drop the pause of the mock's `Backoff: 1`
                set_library(&data, 7, 13);
                assert_eq!(sync(&state, &data, &mut paused).await, 0);
                assert!(!std::fs::read_to_string(&refs).unwrap().contains("k6,"));
                assert_eq!(call(&app, patch("refs.bib", true)).await.0, 204);

                // 429 with Retry-After (the group's library): error stored, account paused
                assert_eq!(call(&app, put_text(&alice, "grp.bib", "@x")).await.0, 204);
                sqlx::query(
                    "INSERT INTO zotero_links (project_id, path, account_id, library, format)
                     VALUES (1, 'grp.bib', ?, 'group:456', 'biblatex')",
                )
                .bind(account["id"].as_i64())
                .execute(&state.db)
                .await
                .unwrap();
                paused.clear(); // drop the pause of the mock's `Backoff: 1`
                sync(&state, &data, &mut paused).await;
                // the failing link says why; the account's later links wait for the pause
                let l = links().await;
                assert_eq!(l[0]["path"], "grp.bib");
                assert!(
                    l[0]["last_error"].as_str().unwrap().contains("pause"),
                    "{l}"
                );
                assert!(!std::fs::read_to_string(&refs).unwrap().contains("k6,"));
                assert_eq!(paused.len(), 1);
                assert_eq!(sync(&state, &data, &mut paused).await, 0);
                sqlx::query("DELETE FROM zotero_links WHERE path = 'grp.bib'")
                    .execute(&state.db)
                    .await
                    .unwrap();
                assert_eq!(sync(&state, &data, &mut HashMap::new()).await, 1);
                assert!(std::fs::read_to_string(&refs).unwrap().contains("k6,"));

                // the account owner must still be an editor of the project: a demoted viewer or
                // a removed member is not synced for any more
                set_library(&data, 8, 14);
                sqlx::query("UPDATE project_members SET role = 'viewer' WHERE user_id = 1")
                    .execute(&state.db)
                    .await
                    .unwrap();
                assert_eq!(sync(&state, &data, &mut HashMap::new()).await, 0);
                sqlx::query("DELETE FROM project_members WHERE user_id = 1")
                    .execute(&state.db)
                    .await
                    .unwrap();
                assert_eq!(sync(&state, &data, &mut HashMap::new()).await, 0);
                assert!(!std::fs::read_to_string(&refs).unwrap().contains("k7,"));
                sqlx::query("INSERT INTO project_members (project_id, user_id, role) VALUES (1, 1, 'editor')")
                    .execute(&state.db)
                    .await
                    .unwrap();
                assert_eq!(sync(&state, &data, &mut HashMap::new()).await, 1);
                assert!(std::fs::read_to_string(&refs).unwrap().contains("k7,"));

                // files that are gone are skipped
                std::fs::remove_file(&refs).unwrap();
                assert_eq!(sync(&state, &data, &mut HashMap::new()).await, 0);
            }
        }
    }

    /// GitHub/GitLab accounts and repos created by undertree, against a mock provider.
    mod remote_accounts {
        use super::*;
        use axum::{
            extract::State,
            http::{HeaderMap, Method, StatusCode, Uri},
        };

        type Calls = Arc<Mutex<Vec<Value>>>;

        #[derive(Clone)]
        struct Mock {
            calls: Calls,
            /// bare repos `<name>.git`, handed out as the repos' "SSH" URLs
            repos: PathBuf,
        }

        /// Records every request; accepts only the token `good`.
        async fn mock_api(
            State(m): State<Mock>,
            method: Method,
            uri: Uri,
            headers: HeaderMap,
            body: String,
        ) -> (StatusCode, Json<Value>) {
            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let path = uri.path_and_query().unwrap().as_str().to_owned();
            let auth = headers
                .get("authorization")
                .map_or("", |v| v.to_str().unwrap());
            m.calls.lock().unwrap().push(
                json!({ "method": method.as_str(), "path": path, "auth": auth, "body": body }),
            );
            if auth != "Bearer good" {
                return (StatusCode::UNAUTHORIZED, Json(json!({ "message": "401" })));
            }
            let name = body["name"].as_str().unwrap_or("");
            let mut url = format!("file://{}/{name}.git", m.repos.display());
            if name.starts_with("badhost") {
                url = format!("ssh://git@bad_host.test/{name}.git");
            }
            if name.starts_with("tofu") {
                // a self-hosted server's SSH (nothing listens on port 1)
                url = format!("ssh://git@127.0.0.1:1/{name}.git");
            }
            let (status, res) = match (method.as_str(), path.as_str()) {
                ("GET", "/gl/api/v4/user") => (200, json!({ "id": 7, "username": "gl-alice" })),
                ("GET", "/gl/api/v4/namespaces/chair%2Fpapers") => (200, json!({ "id": 9 })),
                ("POST", "/gl/api/v4/projects") => (
                    201,
                    json!({ "id": 42, "ssh_url_to_repo": url, "web_url": format!("https://gl.test/{name}") }),
                ),
                ("POST", "/gl/api/v4/projects/42/deploy_keys") => (201, json!({ "id": 1 })),
                ("GET", "/gl/api/v4/users?username=bob") => (200, json!([{ "id": 11 }])),
                ("GET", p) if p.starts_with("/gl/api/v4/users?") => (200, json!([])),
                ("POST", "/gl/api/v4/projects/42/members") => (201, json!({})),
                ("POST", "/gh/user/repos") => (
                    201,
                    json!({
                        "full_name": format!("alice-gh/{name}"), "ssh_url": url,
                        "html_url": format!("https://github.test/alice-gh/{name}"),
                    }),
                ),
                ("POST", "/gh/repos/alice-gh/broken/keys") => {
                    (422, json!({ "message": "key is already in use" }))
                }
                ("POST", "/gh/repos/alice-gh/paper/keys") => (201, json!({ "id": 1 })),
                ("PUT", "/gh/repos/alice-gh/paper/collaborators/bob-gh") => (201, json!({})),
                _ => (404, json!({ "message": "Not Found" })),
            };
            (StatusCode::from_u16(status).unwrap(), Json(res))
        }

        /// The mock is the only listed GitLab host.
        async fn setup() -> (
            Router,
            SqlitePool,
            String,
            PathBuf,
            String,
            Calls,
            tempfile::TempDir,
        ) {
            setup_listing(true).await
        }

        /// (app, db, alice's cookie, data dir, mock base URL, recorded calls, bare repo dir);
        /// `listed`: `UNDERTREE_GITLAB_HOSTS` = the mock, else empty (any server)
        async fn setup_listing(
            listed: bool,
        ) -> (
            Router,
            SqlitePool,
            String,
            PathBuf,
            String,
            Calls,
            tempfile::TempDir,
        ) {
            let repos = tempfile::tempdir().unwrap();
            let calls = Calls::default();
            let mock = Mock {
                calls: calls.clone(),
                repos: repos.path().to_owned(),
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let api = Router::new().fallback(mock_api).with_state(mock);
            tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });

            let mut cfg = test_cfg(true);
            cfg.github_api_url = format!("{base}/gh");
            if listed {
                cfg.gitlab_hosts = vec![base.trim_start_matches("http://").to_owned()];
            }
            let data = cfg.data.canonicalize().unwrap();
            let (app, db) = test_app_db(cfg, true).await;
            let alice = cookie_of(&app, "alice").await;
            (app, db, alice, data, base, calls, repos)
        }

        fn take(calls: &Calls) -> Vec<Value> {
            std::mem::take(&mut *calls.lock().unwrap())
        }

        #[tokio::test]
        async fn gitlab_account_lifecycle() {
            let (app, _, alice, _, base, calls, _repos) = setup().await;
            let connect = |token: &str, url: &str| {
                let body = json!({ "provider": "gitlab", "base_url": url, "token": token });
                post_json("/api/accounts", &alice, body)
            };
            let gl = format!("{base}/gl/");
            let (status, _, body) = call(&app, connect("bad", &gl)).await;
            assert_eq!(status, 400, "{body}");
            assert!(body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("rejected"));
            for bad_url in [
                "ftp://x",
                "https://u:p@gitlab.com",
                "https://gitlab.com?a=b",
            ] {
                assert_eq!(
                    call(&app, connect("good", bad_url)).await.0,
                    400,
                    "{bad_url}"
                );
            }
            // not on UNDERTREE_GITLAB_HOSTS (only the mock is): refused before any request
            let calls_before = calls.lock().unwrap().len();
            for host in ["https://gitlab.com", "https://intranet.example.org"] {
                let (status, _, body) = call(&app, connect("good", host)).await;
                assert_eq!(
                    (status, body["error"]["code"].clone()),
                    (400, json!("host_not_allowed")),
                    "{host}"
                );
            }
            assert_eq!(calls.lock().unwrap().len(), calls_before);
            let gh =
                json!({ "provider": "github", "base_url": "https://github.com", "token": "good" });
            assert_eq!(
                call(&app, post_json("/api/accounts", &alice, gh)).await.0,
                400
            );

            let (status, _, account) = call(&app, connect("good", &gl)).await;
            assert_eq!(status, 201, "{account}");
            let want = json!({ "id": account["id"], "provider": "gitlab",
                               "base_url": format!("{base}/gl"), "login": "gl-alice",
                               "ssh_host_key_fingerprint": null });
            assert_eq!(account, want);
            // the token went to the provider as bearer token
            assert!(take(&calls).iter().any(|c| c["auth"] == "Bearer good"));
            // same server again: updated, not duplicated
            let (_, _, again) = call(&app, connect("good", &gl)).await;
            assert_eq!(again["id"], account["id"]);
            let (status, _, list) = call(&app, get("/api/accounts", Some(&alice))).await;
            assert_eq!((status, list.clone()), (200, json!([want])));
            assert!(!list.to_string().contains("good"));

            let bob = cookie_of(&app, "bob").await;
            let uri = format!("/api/accounts/{}", account["id"]);
            assert_eq!(call(&app, req("DELETE", &uri, &bob, "")).await.0, 404);
            let (_, _, bobs) = call(&app, get("/api/accounts", Some(&bob))).await;
            assert_eq!(bobs, json!([]));
            assert_eq!(call(&app, req("DELETE", &uri, &alice, "")).await.0, 204);
            let (_, _, list) = call(&app, get("/api/accounts", Some(&alice))).await;
            assert_eq!(list, json!([]));
        }

        #[tokio::test]
        async fn any_public_gitlab_by_default() {
            // empty UNDERTREE_GITLAB_HOSTS: any server; the mock on 127.0.0.1 passes only
            // through the tests' escape hatch (`allow_file`)
            let (app, _, alice, _, base, calls, _repos) = setup_listing(false).await;
            let body =
                json!({ "provider": "gitlab", "base_url": format!("{base}/gl"), "token": "good" });
            let (status, _, account) = call(&app, post_json("/api/accounts", &alice, body)).await;
            assert_eq!(status, 201, "{account}");
            take(&calls);

            // production: private addresses and plain http are refused before any request
            let (app, alice) = logged_in(test_cfg(true)).await;
            for url in [
                format!("{base}/gl"),
                "https://localhost/gl".into(),
                "https://127.0.0.1:1".into(),
                "https://[::1]".into(),
                "https://10.0.0.1".into(),
                "https://169.254.169.254".into(),
            ] {
                let body = json!({ "provider": "gitlab", "base_url": url, "token": "good" });
                let (status, _, res) = call(&app, post_json("/api/accounts", &alice, body)).await;
                let code = res["error"]["code"].clone();
                // plain http fails the URL check (`invalid_request`), the rest the guard
                let want = if url.starts_with("http:") {
                    "invalid_request"
                } else {
                    "host_not_allowed"
                };
                assert_eq!((status, code), (400, json!(want)), "{url}: {res}");
            }
            assert!(take(&calls).is_empty());
        }

        #[tokio::test]
        async fn github_connect_redirects_with_repo_scopes() {
            let app = test_app().await;
            assert_eq!(
                call(&app, get("/api/auth/connect/github", None)).await.0,
                401
            );
            let alice = cookie_of(&app, "alice").await;
            // GitHub OAuth not configured
            let res = call(&app, get("/api/auth/connect/github", Some(&alice))).await;
            assert_eq!(res.0, 404);

            let mut cfg = test_cfg(true);
            cfg.github_client_id = Some("cid".into());
            cfg.github_client_secret = Some("csecret".into());
            let (app, alice) = logged_in(cfg).await;
            let res = app
                .clone()
                .oneshot(get("/api/auth/connect/github", Some(&alice)))
                .await
                .unwrap();
            assert_eq!(res.status(), 303);
            let loc = res.headers()[header::LOCATION].to_str().unwrap();
            assert!(
                loc.starts_with("https://github.com/login/oauth/authorize?"),
                "{loc}"
            );
            assert!(loc.contains("scope=repo+workflow"), "{loc}");
            // the same callback as the login (the OAuth app has only one)
            assert!(loc.contains(
                "redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Fauth%2Foauth%2Fgithub%2Fcallback"
            ));
            // a failed connect lands back in the app, not on the login page
            let res = app
                .clone()
                .oneshot(get(
                    "/api/auth/oauth/github/callback?code=x&state=forged",
                    Some(&alice),
                ))
                .await
                .unwrap();
            assert_eq!(
                res.headers()[header::LOCATION],
                "/?connect_error=oauth_failed"
            );
        }

        fn has_ssh_keygen() -> bool {
            let found = std::process::Command::new("ssh-keygen")
                .arg("-?")
                .output()
                .is_ok();
            if !found {
                eprintln!("skipping: ssh-keygen not installed");
            }
            found
        }

        fn show(bare: &std::path::Path, what: &str) -> String {
            git_out(bare, &["show", what])
        }

        fn git_out(bare: &std::path::Path, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .arg("--git-dir")
                .arg(bare)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).unwrap()
        }

        fn mode(path: PathBuf) -> u32 {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777
        }

        #[tokio::test]
        async fn self_hosted_ssh_host_key_is_trusted_on_first_use() {
            if !has_ssh_keygen() {
                return;
            }
            let (app, db, alice, _, base, _, _repos) = setup().await;
            let body =
                json!({ "provider": "gitlab", "base_url": format!("{base}/gl"), "token": "good" });
            let (_, _, gl) = call(&app, post_json("/api/accounts", &alice, body)).await;
            let create = |repo: &str| {
                let body = json!({ "name": repo, "create_remote":
                                   { "account_id": gl["id"], "repo_name": repo } });
                post_json("/api/projects", &alice, body)
            };
            // first use: ssh-keyscan of the repo's SSH host, which has no key to offer here
            let (status, _, err) = call(&app, create("tofu-a")).await;
            let msg = err["error"]["message"].as_str().unwrap();
            assert_eq!(status, 502, "{err}");
            assert!(
                msg.contains("127.0.0.1:1 sent no ed25519 SSH host key"),
                "{msg}"
            );
            // a stored key is reused without scanning: ssh itself then fails to connect
            sqlx::query(
                "UPDATE user_accounts SET ssh_known_hosts = ?, ssh_host_key_fingerprint = 'SHA256:x'",
            )
            .bind("[127.0.0.1]:1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf")
            .execute(&db)
            .await
            .unwrap();
            let (status, _, err) = call(&app, create("tofu-b")).await;
            assert_eq!(
                (status, err["error"]["code"].clone()),
                (502, json!("git_failed")),
                "{err}"
            );
            let (_, _, list) = call(&app, get("/api/accounts", Some(&alice))).await;
            assert_eq!(list[0]["ssh_host_key_fingerprint"], "SHA256:x");
        }

        #[tokio::test]
        async fn unsupported_ssh_host_is_rejected_with_400() {
            let (app, _, alice, _, base, _, _repos) = setup().await;
            let body =
                json!({ "provider": "gitlab", "base_url": format!("{base}/gl"), "token": "good" });
            let (_, _, gl) = call(&app, post_json("/api/accounts", &alice, body)).await;
            let body = json!({ "name": "badhost", "create_remote":
                               { "account_id": gl["id"], "repo_name": "badhost" } });
            let (status, _, err) = call(&app, post_json("/api/projects", &alice, body)).await;
            assert_eq!(status, 400, "{err}");
            assert_eq!(err["error"]["code"], "invalid_request");
            assert!(
                err["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("wird nicht unterstützt"),
                "{err}"
            );
        }

        #[tokio::test]
        async fn create_remote_projects_and_invite() {
            if !has_ssh_keygen() {
                return;
            }
            let (app, db, alice, data, base, calls, repos) = setup().await;
            for name in ["gl-paper", "paper"] {
                workspace::tests::git(
                    repos.path(),
                    &["init", "-q", "--bare", &format!("{name}.git")],
                );
            }
            let body =
                json!({ "provider": "gitlab", "base_url": format!("{base}/gl"), "token": "good" });
            let (_, _, gl) = call(&app, post_json("/api/accounts", &alice, body)).await;
            // GitHub accounts come from the OAuth callback (`accounts::save`); store one directly
            let secrets = projects::Secrets::load(None, &data).unwrap();
            let gh_id: i64 = sqlx::query_scalar(
                "INSERT INTO user_accounts (user_id, provider, base_url, login, token_enc)
                 VALUES (1, 'github', 'https://github.com', 'alice-gh', ?) RETURNING id",
            )
            .bind(secrets.encrypt("good"))
            .fetch_one(&db)
            .await
            .unwrap();
            take(&calls);

            // GitLab, in a group, LuaLaTeX
            let body = json!({ "name": "GL Paper", "compiler": "lualatex", "create_remote": {
                "account_id": gl["id"], "repo_name": "gl-paper", "namespace": "chair/papers" } });
            let (status, _, p1) = call(&app, post_json("/api/projects", &alice, body)).await;
            assert_eq!(status, 201, "{p1}");
            let bare = repos.path().join("gl-paper.git");
            assert_eq!(p1["remote_url"], format!("file://{}", bare.display()));
            assert_eq!(
                (p1["account_id"].clone(), p1["branch"].clone()),
                (gl["id"].clone(), json!("main"))
            );
            let got = take(&calls);
            let create = got
                .iter()
                .find(|c| c["path"] == "/gl/api/v4/projects")
                .unwrap();
            assert_eq!(create["body"]["visibility"], "private");
            assert_eq!(create["body"]["namespace_id"], 9);
            let key = got
                .iter()
                .find(|c| c["path"] == "/gl/api/v4/projects/42/deploy_keys")
                .unwrap();
            assert_eq!(key["body"]["can_push"], true);
            assert_eq!(key["body"]["title"], "undertree gl-paper");
            // host keys only from the pinned file (+ the operator's ~/.ssh/known_hosts)
            let pinned = std::fs::read_to_string(data.join("pinned_known_hosts")).unwrap();
            assert!(
                pinned.contains("github.com ssh-ed25519 ")
                    && pinned.contains("gitlab.com ssh-ed25519 ")
            );
            assert!(key["body"]["key"]
                .as_str()
                .unwrap()
                .starts_with("ssh-ed25519 "));
            // pushed end to end, attributed to alice
            assert!(show(&bare, "main:.gitlab-ci.yml")
                .contains("latexmk -cd -lualatex -interaction=nonstopmode 'main.tex'"));
            assert!(show(&bare, "main:main.tex").contains(r"\documentclass{article}"));
            assert!(show(&bare, "main:.gitignore").contains("*.aux"));
            assert_eq!(
                git_out(&bare, &["log", "-1", "--format=%an <%ae>", "main"]).trim(),
                "Alice <a@x.org>"
            );
            let ssh = data.join("projects/1/ssh");
            assert_eq!(
                (mode(ssh.clone()), mode(ssh.join("id_ed25519"))),
                (0o700, 0o600)
            );
            let (_, _, st) =
                call(&app, get("/api/projects/1/git/status?repo=", Some(&alice))).await;
            assert_eq!(
                (st["upstream"].clone(), st["ahead"].clone()),
                (json!("origin/main"), json!(0)),
                "{st}"
            );

            // GitHub, public, default engine
            let body = json!({ "name": "Paper", "create_remote": {
                "account_id": gh_id, "repo_name": "paper", "private": false } });
            let (status, _, p2) = call(&app, post_json("/api/projects", &alice, body)).await;
            assert_eq!(status, 201, "{p2}");
            let got = take(&calls);
            let create = got.iter().find(|c| c["path"] == "/gh/user/repos").unwrap();
            assert_eq!(
                create["body"],
                json!({ "name": "paper", "private": false, "auto_init": false })
            );
            let key = got
                .iter()
                .find(|c| c["path"] == "/gh/repos/alice-gh/paper/keys")
                .unwrap();
            assert_eq!(key["body"]["read_only"], false);
            let workflow = show(
                &repos.path().join("paper.git"),
                "main:.github/workflows/latex.yml",
            );
            assert!(
                workflow.contains("xu-cheng/latex-action@v3")
                    && workflow.contains("root_file: \"main.tex\"")
            );
            assert!(!workflow.contains("latexmk_use"));

            // deploy key rejected: nothing local is kept, the error names the remote repo
            let body = json!({ "name": "B", "create_remote": { "account_id": gh_id, "repo_name": "broken" } });
            let (status, _, err) = call(&app, post_json("/api/projects", &alice, body)).await;
            assert_eq!(status, 502, "{err}");
            let msg = err["error"]["message"].as_str().unwrap();
            assert!(
                msg.contains("key is already in use")
                    && msg.contains("https://github.test/alice-gh/broken"),
                "{msg}"
            );
            let (_, _, list) = call(&app, get("/api/projects", Some(&alice))).await;
            assert_eq!(list.as_array().unwrap().len(), 2);
            let left: Vec<_> = std::fs::read_dir(data.join("projects"))
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert_eq!(left.len(), 2, "{left:?}");
            // someone else's account
            let bob = cookie_of(&app, "bob").await;
            let body =
                json!({ "name": "X", "create_remote": { "account_id": gh_id, "repo_name": "x" } });
            assert_eq!(
                call(&app, post_json("/api/projects", &bob, body)).await.0,
                404
            );

            // invite into the remote repo
            for pid in [1, 2] {
                let uri = format!("/api/projects/{pid}/members");
                let added = call(&app, post_json(&uri, &alice, json!({ "username": "bob" }))).await;
                assert_eq!(added.0, 201);
            }
            let invite = |pid: i64, who: &str, cookie: &str| {
                let uri = format!("/api/projects/{pid}/members/{who}/invite-remote");
                post_json(&uri, cookie, json!({}))
            };
            let (status, _, err) = call(&app, invite(2, "bob", &alice)).await;
            assert_eq!(status, 400, "no GitHub login known for bob: {err}");
            sqlx::query("UPDATE users SET github_login = 'bob-gh' WHERE username = 'bob'")
                .execute(&db)
                .await
                .unwrap();
            take(&calls);
            assert_eq!(call(&app, invite(2, "bob", &alice)).await.0, 204);
            let got = take(&calls);
            assert_eq!(got.len(), 1);
            assert_eq!(
                got[0]["path"],
                "/gh/repos/alice-gh/paper/collaborators/bob-gh"
            );
            assert_eq!(
                (got[0]["method"].clone(), got[0]["body"].clone()),
                (json!("PUT"), json!({ "permission": "push" }))
            );
            assert_eq!(call(&app, invite(1, "bob", &alice)).await.0, 204);
            let got = take(&calls);
            assert_eq!(got[1]["path"], "/gl/api/v4/projects/42/members");
            assert_eq!(got[1]["body"], json!({ "user_id": 11, "access_level": 30 }));
            assert_eq!(call(&app, invite(1, "carol", &alice)).await.0, 404);
            assert_eq!(call(&app, invite(1, "bob", &bob)).await.0, 403);
            // below editor: refused before any remote call
            sqlx::query("UPDATE project_members SET role = 'commenter' WHERE user_id = (SELECT id FROM users WHERE username = 'bob')")
                .execute(&db)
                .await
                .unwrap();
            take(&calls);
            let (status, _, err) = call(&app, invite(2, "bob", &alice)).await;
            assert_eq!(
                (status, &err["error"]["code"]),
                (400, &json!("invite_role_too_low"))
            );
            assert!(take(&calls).is_empty());
        }

        #[tokio::test]
        async fn create_remote_from_template() {
            if !has_ssh_keygen() {
                return;
            }
            let (app, _, alice, _, base, calls, repos) = setup().await;
            for name in ["thesis", "report"] {
                workspace::tests::git(
                    repos.path(),
                    &["init", "-q", "--bare", &format!("{name}.git")],
                );
            }
            let body =
                json!({ "provider": "gitlab", "base_url": format!("{base}/gl"), "token": "good" });
            let (_, _, gl) = call(&app, post_json("/api/accounts", &alice, body)).await;
            let root = cookie_of(&app, "root").await;
            let zip = templates::tests::zip_of(THESIS_ZIP);
            let (_, _, t) = call(&app, upload_template(&root, &[("name", "T")], &zip)).await;
            take(&calls);
            // private: unknown to alice until root publishes it
            let body = json!({ "name": "x", "create_remote": {
                "account_id": gl["id"], "repo_name": "x", "template_id": t["id"] } });
            let (status, _, err) = call(&app, post_json("/api/projects", &alice, body)).await;
            assert_eq!(status, 400, "{err}");
            let mut publish = post_json(
                &format!("/api/templates/{}", t["id"].as_str().unwrap()),
                &root,
                json!({ "public": true }),
            );
            *publish.method_mut() = axum::http::Method::PATCH;
            assert_eq!(call(&app, publish).await.0, 200);

            // unknown template: refused before the remote repo is created
            let new = |repo: &str, template: &Value, compiler: Option<&str>| {
                let mut body = json!({ "name": repo, "create_remote": {
                    "account_id": gl["id"], "repo_name": repo, "template_id": template } });
                if let Some(c) = compiler {
                    body["compiler"] = json!(c);
                }
                post_json("/api/projects", &alice, body)
            };
            let (status, _, err) = call(&app, new("x", &json!("nope"), None)).await;
            assert_eq!(status, 400, "{err}");
            assert_eq!(take(&calls), Vec::<Value>::new());

            // uploaded template: its files, its main file and (detected) engine in CI; the
            // project itself detects on every compile
            let (status, _, p) = call(&app, new("thesis", &t["id"], None)).await;
            assert_eq!((status, p["compiler"].clone()), (201, json!("auto")), "{p}");
            let bare = repos.path().join("thesis.git");
            let files = git_out(&bare, &["ls-tree", "-r", "--name-only", "main"]);
            assert_eq!(
                files.lines().collect::<Vec<_>>(),
                [
                    ".gitignore",
                    ".gitlab-ci.yml",
                    "Arbeit.tex",
                    "Header/Header.tex"
                ]
            );
            let ci = show(&bare, "main:.gitlab-ci.yml");
            assert!(
                ci.contains("latexmk -cd -xelatex -interaction=nonstopmode 'Arbeit.tex'")
                    && ci.contains("- \"Arbeit.pdf\""),
                "{ci}"
            );
            assert!(show(&bare, "main:.gitignore").ends_with("/Arbeit.pdf\n"));

            // built-in template, the request's engine wins
            let (status, _, p) = call(
                &app,
                new("report", &json!("builtin:report"), Some("lualatex")),
            )
            .await;
            assert_eq!(
                (status, p["compiler"].clone()),
                (201, json!("lualatex")),
                "{p}"
            );
            let bare = repos.path().join("report.git");
            assert!(show(&bare, "main:main.tex").contains(r"\documentclass[11pt,a4paper]{report}"));
            assert!(show(&bare, "main:references.bib").contains("knuth1984"));
            assert!(show(&bare, "main:chapters/einleitung.tex").contains(r"\chapter"));
            assert!(show(&bare, "main:.gitlab-ci.yml").contains("-lualatex"));
        }
    }
}
