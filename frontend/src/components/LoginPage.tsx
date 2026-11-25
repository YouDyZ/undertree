import { useEffect, useState } from "preact/hooks";
import {
  type AuthProviders,
  type OAuthProvider,
  type User,
  devLogin,
  getAuthProviders,
  oauthStartUrl,
  sanitizeNextPath,
} from "../api";
import { AlertIcon, GitHubIcon, GoogleIcon, TreeLogoIcon } from "./Icons";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_denied: "Anmeldung beim OAuth-Provider wurde abgebrochen.",
  not_registered:
    "Dieser Account ist nicht für dieses Undertree-Workspace freigeschaltet. Bitte kontaktiere einen Administrator.",
  oauth_failed: "OAuth-Anmeldung fehlgeschlagen. Bitte versuche es erneut.",
};

function getQueryErrorMessage(): string | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("error");
  if (!code) return null;
  return OAUTH_ERROR_MESSAGES[code] ?? `Anmeldung fehlgeschlagen (${code}).`;
}

function getQueryNextPath(): string {
  const params = new URLSearchParams(window.location.search);
  return sanitizeNextPath(params.get("next"));
}

const PROVIDER_META: Record<OAuthProvider, { label: string }> = {
  github: { label: "Mit GitHub anmelden" },
  google: { label: "Mit Google anmelden" },
};

interface LoginPageProps {
  onAuthenticated: (user: User) => void;
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [devUsername, setDevUsername] = useState("");
  const [devError, setDevError] = useState<string | null>(null);
  const [devSubmitting, setDevSubmitting] = useState(false);

  const queryError = getQueryErrorMessage();
  const nextPath = getQueryNextPath();

  useEffect(() => {
    let active = true;
    getAuthProviders()
      .then((res) => {
        if (!active) return;
        setProviders(res);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : "Server nicht erreichbar";
        setLoadError(msg);
      });
    return () => {
      active = false;
    };
  }, []);

  const enabledOAuth = (providers?.oauth ?? []).filter(
    (p): p is OAuthProvider => p === "github" || p === "google"
  );
  const devLoginEnabled = providers?.dev_login === true;

  const handleDevLogin = async (e: Event) => {
    e.preventDefault();
    const trimmed = devUsername.trim();
    if (!trimmed) return;
    setDevSubmitting(true);
    setDevError(null);
    try {
      const user = await devLogin(trimmed);
      if (nextPath && nextPath !== "/") {
        window.history.replaceState(null, "", nextPath);
      } else {
        window.history.replaceState(null, "", "/");
      }
      onAuthenticated(user);
    } catch (err: unknown) {
      setDevError(err instanceof Error ? err.message : "Dev-Login fehlgeschlagen.");
    } finally {
      setDevSubmitting(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-card">
        <div class="login-brand">
          <div class="login-logo">
            <TreeLogoIcon size={28} />
          </div>
          <div>
            <h1>undertree</h1>
            <p class="login-subtitle">Collaborative LaTeX &amp; Git Submodule Editor</p>
          </div>
        </div>

        {queryError && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>{queryError}</span>
          </div>
        )}

        {loadError && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>Auth-Provider konnten nicht geladen werden: {loadError}</span>
          </div>
        )}

        <div class="login-actions">
          {providers === null && !loadError && (
            <div class="login-loading">Lade Anmeldeoptionen…</div>
          )}

          {providers !== null && enabledOAuth.length === 0 && !devLoginEnabled && (
            <div class="alert alert-warn" role="status">
              <AlertIcon size={16} />
              <span>
                Kein OAuth-Provider konfiguriert. Bitte <code>UNDERTREE_GITHUB_CLIENT_ID</code>{" "}
                oder <code>UNDERTREE_GOOGLE_CLIENT_ID</code> im Server setzen.
              </span>
            </div>
          )}

          {enabledOAuth.map((provider) => (
            <a
              key={provider}
              class={`btn-oauth btn-oauth-${provider}`}
              href={oauthStartUrl(provider, nextPath)}
            >
              {provider === "github" ? <GitHubIcon size={18} /> : <GoogleIcon size={18} />}
              <span>{PROVIDER_META[provider].label}</span>
            </a>
          ))}
        </div>

        {devLoginEnabled && (
          <form class="dev-login-box" onSubmit={(e) => void handleDevLogin(e)}>
            <div class="dev-login-header">
              <span class="badge badge-detached">DEV-LOGIN</span>
              <span class="muted-text">Nur lokal aktiv (UNDERTREE_DEV_LOGIN)</span>
            </div>
            <div class="dev-login-row">
              <input
                type="text"
                class="text-input"
                placeholder="Username (z. B. alice)"
                value={devUsername}
                disabled={devSubmitting}
                onInput={(e) => setDevUsername((e.target as HTMLInputElement).value)}
              />
              <button
                type="submit"
                class="btn-primary btn-sm"
                disabled={devSubmitting || !devUsername.trim()}
              >
                Anmelden
              </button>
            </div>
            {devError && <div class="form-error">{devError}</div>}
          </form>
        )}

        <p class="login-footnote">
          Zugang ausschließlich für freigeschaltete Google- oder GitHub-Accounts.
        </p>
      </div>
    </div>
  );
}
