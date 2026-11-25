import { useEffect, useState } from "preact/hooks";
import {
  type GitAccount,
  type User,
  GITHUB_CONNECT_URL,
  addZoteroAccount,
  deleteAccount,
  errorText,
  getAuthProviders,
  getMe,
  listAccounts,
  updateMe,
} from "../api";
import { accountLabel } from "../lib/accounts";
import { formatZoteroError } from "../lib/zotero";
import { GitlabConnectForm } from "./GitlabConnectForm";
import { ExternalLinkIcon, TrashIcon } from "./Icons";
import { Modal } from "./Modal";

/** User name in the top bar; opens the profile (commit e-mail) on click. */
export function UserName({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        class="user-name user-name-btn"
        title="Profil"
        onClick={() => setOpen(true)}
      >
        {user.display_name}
      </button>
      {open && <ProfileModal user={user} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ProfileModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [email, setEmail] = useState(user.commit_email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the `user` prop may predate an earlier save
  useEffect(() => {
    getMe()
      .then((me) => setEmail(me.commit_email ?? ""))
      .catch(() => {});
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateMe({ commit_email: email.trim() || null });
      onClose();
    } catch (err: unknown) {
      setError(errorText(err, "Speichern fehlgeschlagen."));
      setBusy(false);
    }
  };

  return (
    <Modal title="Profil" onClose={onClose} busy={busy}>
      <form class="form-stack" onSubmit={(e) => void submit(e)}>
        <div class="muted-text">
          {user.display_name} ({user.username})
        </div>
        <label class="field">
          <span>Commit-E-Mail (optional)</span>
          <input
            type="email"
            class="text-input"
            placeholder="automatisch"
            value={email}
            disabled={busy}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </label>
        <span class="field-hint">
          Mit dieser Adresse erscheinst du in Commits als Autor bzw. Mitautor. GitHub und GitLab
          ordnen Commits nur zu, wenn die Adresse in deinem Konto hinterlegt ist (GitHub: Settings →
          Emails, z. B. die <code>…@users.noreply.github.com</code>-Adresse; GitLab: bestätigte
          E-Mail oder die Commit-E-Mail aus den Profileinstellungen). Leer = automatisch: bei
          GitHub-Login die noreply-Adresse für github.com-Repos, sonst deine Login-E-Mail.
        </span>
        {error && <div class="alert alert-error">{error}</div>}
        <div class="form-actions">
          <button type="button" class="btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" class="btn-primary btn-sm" disabled={busy}>
            {busy ? "Speichere…" : "Speichern"}
          </button>
        </div>
      </form>
      <ConnectedAccounts />
    </Modal>
  );
}

/** GitHub (OAuth), GitLab (server + PAT) and Zotero (API key) accounts. */
function ConnectedAccounts() {
  const [accounts, setAccounts] = useState<GitAccount[] | null>(null);
  const [github, setGithub] = useState(false);
  const [zoteroToken, setZoteroToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [zoteroError, setZoteroError] = useState<string | null>(null);

  useEffect(() => {
    listAccounts()
      .then(setAccounts)
      .catch((err: unknown) => setListError(errorText(err, "Konten konnten nicht geladen werden.")));
    getAuthProviders()
      .then((p) => setGithub(p.oauth.includes("github")))
      .catch(() => {});
  }, []);

  const run = async (
    action: () => Promise<void>,
    setTargetError: (msg: string | null) => void,
    formatErr: (err: unknown) => string
  ) => {
    setBusy(true);
    setListError(null);
    setZoteroError(null);
    try {
      await action();
      setAccounts(await listAccounts());
    } catch (err: unknown) {
      setTargetError(formatErr(err));
    } finally {
      setBusy(false);
    }
  };

  const addZotero = (e: Event) => {
    e.preventDefault();
    void run(
      async () => {
        await addZoteroAccount(zoteroToken.trim());
        setZoteroToken("");
      },
      setZoteroError,
      (err) => formatZoteroError(err, "Zotero-Konto konnte nicht verbunden werden.", "connect")
    );
  };

  return (
    <section class="settings-section form-stack">
      <h3>Verbundene Konten</h3>
      <span class="field-hint">
        GitHub und GitLab zum Anlegen von Repositories und Einladen von Projektmitgliedern; Zotero
        zum Importieren und Aktualisieren von Literaturverzeichnissen.
      </span>
      {accounts === null ? (
        <span class="muted-text">Lade Konten…</span>
      ) : accounts.length === 0 ? (
        <span class="muted-text">Noch kein Konto verbunden.</span>
      ) : (
        <ul class="member-list">
          {accounts.map((a) => (
            <li key={a.id}>
              <span>{accountLabel(a)}</span>
              <button
                type="button"
                class="icon-btn icon-btn-danger"
                disabled={busy}
                title="Trennen"
                aria-label={`${accountLabel(a)} trennen`}
                onClick={() =>
                  void run(
                    () => deleteAccount(a.id),
                    setListError,
                    (err) => errorText(err, "Konto konnte nicht getrennt werden.")
                  )
                }
              >
                <TrashIcon size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {listError && <div class="alert alert-error">{listError}</div>}
      {github && (
        <div class="form-actions">
          <a class="btn-ghost btn-sm" href={GITHUB_CONNECT_URL}>
            GitHub verbinden
          </a>
        </div>
      )}
      <div class="form-stack settings-subsection">
        <h4>GitLab verbinden</h4>
        <GitlabConnectForm onConnected={async () => setAccounts(await listAccounts())} />
      </div>
      <form class="form-stack settings-subsection" onSubmit={addZotero}>
        <h4>Zotero verbinden</h4>
        <label class="field">
          <span>Zotero API-Key</span>
          <input
            type="password"
            class="text-input"
            autoComplete="off"
            required
            placeholder="Privaten API-Key einfügen"
            value={zoteroToken}
            disabled={busy}
            onInput={(e) => setZoteroToken((e.target as HTMLInputElement).value)}
          />
        </label>
        <span class="field-hint">
          Erstelle einen API-Key unter{" "}
          <a
            href="https://www.zotero.org/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
          >
            zotero.org/settings/keys <ExternalLinkIcon size={11} />
          </a>{" "}
          mit Leserecht für deine Bibliothek (<em>Allow library access</em>) sowie bei Gruppen mit{" "}
          <em>Read Only</em> für die gewünschten Gruppen.
        </span>
        {zoteroError && <div class="alert alert-error">{zoteroError}</div>}
        <div class="form-actions">
          <button type="submit" class="btn-primary btn-sm" disabled={busy || !zoteroToken.trim()}>
            Zotero verbinden
          </button>
        </div>
      </form>
    </section>
  );
}
