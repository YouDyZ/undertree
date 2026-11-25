use std::{net::SocketAddr, path::PathBuf};

/// Server configuration. Every flag can be set via its `UNDERTREE_*` env var (see docs/API.md).
#[derive(clap::Args, Debug, Clone)]
pub struct Config {
    /// Listen address
    #[arg(long, env = "UNDERTREE_BIND", default_value = "127.0.0.1:3000")]
    pub bind: SocketAddr,

    /// Directory with the built frontend (index.html + assets)
    #[arg(long, env = "UNDERTREE_STATIC_DIR", default_value = "frontend/dist")]
    pub static_dir: PathBuf,

    /// Directory for the SQLite DB, project clones, CRDT state and build output
    #[arg(long, env = "UNDERTREE_DATA", default_value = "data")]
    pub data: PathBuf,

    /// base64 32-byte key encrypting stored git tokens (default: generated `$DATA/secret.key`)
    #[arg(long, env = "UNDERTREE_SECRET_KEY", hide_env_values = true)]
    pub secret_key: Option<String>,

    /// External URL, e.g. https://<DEINE-DOMAIN.TLD> (https => Secure cookies)
    #[arg(
        long,
        env = "UNDERTREE_PUBLIC_URL",
        default_value = "http://localhost:3000"
    )]
    pub public_url: String,

    /// Enable POST /api/auth/dev-login (local dev / E2E only, refused with https)
    #[arg(long, env = "UNDERTREE_DEV_LOGIN", default_value_t = false)]
    pub dev_login: bool,

    #[arg(long, env = "UNDERTREE_GITHUB_CLIENT_ID")]
    pub github_client_id: Option<String>,
    #[arg(long, env = "UNDERTREE_GITHUB_CLIENT_SECRET", hide_env_values = true)]
    pub github_client_secret: Option<String>,
    #[arg(long, env = "UNDERTREE_GOOGLE_CLIENT_ID")]
    pub google_client_id: Option<String>,
    #[arg(long, env = "UNDERTREE_GOOGLE_CLIENT_SECRET", hide_env_values = true)]
    pub google_client_secret: Option<String>,

    /// GitLab servers users may connect accounts on: `host` or `host:port`, comma-separated;
    /// empty (default): any server reachable from the internet
    #[arg(long, env = "UNDERTREE_GITLAB_HOSTS", value_delimiter = ',')]
    pub gitlab_hosts: Vec<String>,

    /// LanguageTool server for spell/grammar check, e.g. http://languagetool:8010 (unset = off)
    #[arg(long, env = "UNDERTREE_LANGUAGETOOL_URL")]
    pub languagetool_url: Option<String>,

    /// GitHub REST API base; only tests point it elsewhere (a local mock server)
    #[arg(
        long,
        env = "UNDERTREE_GITHUB_API_URL",
        default_value = "https://api.github.com",
        hide = true
    )]
    pub github_api_url: String,

    /// Zotero Web API base; only tests point it elsewhere (a local mock server)
    #[arg(
        long,
        env = "UNDERTREE_ZOTERO_API_URL",
        default_value = "https://api.zotero.org",
        hide = true
    )]
    pub zotero_api_url: String,

    /// Seconds between checks of the Zotero-linked .bib files for changes; 0 = off
    #[arg(long, env = "UNDERTREE_ZOTERO_SYNC_SECS", default_value_t = 300)]
    pub zotero_sync_secs: u64,

    /// Seconds between checks of projects with auto-push enabled; 0 = off
    #[arg(long, env = "UNDERTREE_AUTO_PUSH_POLL_SECS", default_value_t = 15)]
    pub auto_push_poll_secs: u64,
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if self.dev_login && self.https() {
            return Err("UNDERTREE_DEV_LOGIN must not be enabled with an https public URL".into());
        }
        Ok(())
    }

    /// `scheme://host[:port]` of the public URL, compared against the `Origin` header.
    pub fn origin(&self) -> &str {
        let url = &self.public_url;
        let host_start = url.find("://").map_or(0, |i| i + 3);
        url[host_start..]
            .find('/')
            .map_or(url.as_str(), |i| &url[..host_start + i])
    }

    pub fn https(&self) -> bool {
        self.public_url.starts_with("https://")
    }
}
