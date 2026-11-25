import { useState } from "preact/hooks";
import { type GitAccount, addGitlabAccount, errorText } from "../api";

/** GitLab server + personal access token. A div (not a form) so it can sit inside other forms; Enter submits. */
export function GitlabConnectForm({ onConnected }: { onConnected: (account: GitAccount) => void | Promise<void> }) {
  const [server, setServer] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !server.trim() || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const account = await addGitlabAccount(server.trim(), token.trim());
      setToken("");
      await onConnected(account);
    } catch (err: unknown) {
      setError(errorText(err, "GitLab-Konto konnte nicht verbunden werden."));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void submit();
  };

  return (
    <div class="form-stack">
      <div class="field-row">
        <label class="field">
          <span>GitLab-Server</span>
          <input
            type="url"
            class="text-input"
            placeholder="https://gitlab.example.org"
            value={server}
            disabled={busy}
            onInput={(e) => setServer((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <label class="field">
          <span>Access-Token</span>
          <input
            type="password"
            class="text-input"
            autoComplete="off"
            value={token}
            disabled={busy}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
          />
        </label>
      </div>
      <span class="field-hint">
        Server z. B. <code>https://gitlab.example.org</code> — muss ohne VPN erreichbar sein. Personal Access Token
        mit Scope <code>api</code> (GitLab → Preferences → Access tokens).
      </span>
      {error && <div class="alert alert-error">{error}</div>}
      <div class="form-actions">
        <button
          type="button"
          class="btn-primary btn-sm"
          disabled={busy || !server.trim() || !token.trim()}
          onClick={() => void submit()}
        >
          GitLab verbinden
        </button>
      </div>
    </div>
  );
}
