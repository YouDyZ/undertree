import { useEffect, useState } from "preact/hooks";
import {
  type AdminUser,
  type User,
  createUser,
  deleteUser,
  errorText,
  listUsers,
  updateUser,
} from "../api";
import { AlertIcon, TrashIcon } from "./Icons";
import { ConfirmModal } from "./Modal";
import { PageHeader } from "./PageHeader";

interface AdminPageProps {
  user: User;
  onLoggedOut: () => void;
}

export function AdminPage({ user, onLoggedOut }: AdminPageProps) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<AdminUser | null>(null);

  useEffect(() => {
    if (!user.is_admin) return;
    listUsers()
      .then(setUsers)
      .catch((err: unknown) => setError(errorText(err, "Benutzer konnten nicht geladen werden.")));
  }, [user.is_admin]);

  const replace = (updated: AdminUser) =>
    setUsers((prev) => prev?.map((u) => (u.id === updated.id ? updated : u)) ?? null);

  const toggleAdmin = async (u: AdminUser) => {
    setError(null);
    try {
      replace(await updateUser(u.id, { is_admin: !u.is_admin }));
    } catch (err: unknown) {
      setError(errorText(err, "Admin-Status konnte nicht geändert werden."));
    }
  };

  return (
    <div class="page">
      <PageHeader user={user} onLoggedOut={onLoggedOut} />
      <main class="page-body">
        <div class="page-title-row">
          <h1>Benutzerverwaltung</h1>
        </div>

        {!user.is_admin ? (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>Nur für Administratoren.</span>
          </div>
        ) : (
          <>
            {error && (
              <div class="alert alert-error" role="alert">
                <AlertIcon size={16} />
                <span>{error}</span>
              </div>
            )}

            <AddUserForm onCreated={(u) => setUsers((prev) => [...(prev ?? []), u])} />

            {users === null && !error && <div class="muted-text">Lade Benutzer…</div>}
            {users && (
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Anzeigename</th>
                      <th>Google-E-Mail</th>
                      <th>GitHub-Login</th>
                      <th>Admin</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const self = u.id === user.id;
                      return (
                        <tr key={u.id}>
                          <td class="mono">{u.username}</td>
                          <td>{u.display_name}</td>
                          <td>{u.email ?? <span class="muted-text">–</span>}</td>
                          <td>{u.github ?? <span class="muted-text">–</span>}</td>
                          <td>
                            <input
                              type="checkbox"
                              checked={u.is_admin}
                              disabled={self}
                              title={self ? "Eigenen Admin-Status nicht änderbar" : "Admin umschalten"}
                              aria-label={`Admin: ${u.username}`}
                              onChange={() => void toggleAdmin(u)}
                            />
                          </td>
                          <td class="cell-actions">
                            <button
                              type="button"
                              class="icon-btn icon-btn-danger"
                              disabled={self}
                              title={self ? "Eigenen Account nicht löschbar" : "Benutzer löschen"}
                              aria-label={`Benutzer ${u.username} löschen`}
                              onClick={() => setToDelete(u)}
                            >
                              <TrashIcon size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>

      {toDelete && (
        <ConfirmModal
          title="Benutzer löschen"
          message={
            <>
              <strong>{toDelete.username}</strong> wird gelöscht, inklusive Sitzungen und
              Mitgliedschaften. Eigene Projekte gehen an dich über.
            </>
          }
          confirmLabel="Löschen"
          onConfirm={async () => {
            await deleteUser(toDelete.id);
            setUsers((prev) => prev?.filter((u) => u.id !== toDelete.id) ?? null);
          }}
          onClose={() => setToDelete(null)}
        />
      )}
    </div>
  );
}

function AddUserForm({ onCreated }: { onCreated: (u: AdminUser) => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [github, setGithub] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!email.trim() && !github.trim()) {
      setError("Mindestens Google-E-Mail oder GitHub-Login angeben.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await createUser({
          username: username.trim(),
          display_name: displayName.trim() || undefined,
          email: email.trim() || undefined,
          github: github.trim() || undefined,
          is_admin: isAdmin,
        })
      );
      setUsername("");
      setDisplayName("");
      setEmail("");
      setGithub("");
      setIsAdmin(false);
    } catch (err: unknown) {
      setError(errorText(err, "Benutzer konnte nicht angelegt werden."));
    } finally {
      setBusy(false);
    }
  };

  const input = (value: string, set: (v: string) => void) => ({
    value,
    disabled: busy,
    onInput: (e: Event) => set((e.target as HTMLInputElement).value),
  });

  return (
    <form class="panel-card form-stack" onSubmit={(e) => void submit(e)}>
      <h2>Benutzer hinzufügen</h2>
      <div class="field-row">
        <label class="field">
          <span>Username</span>
          <input type="text" class="text-input" required {...input(username, setUsername)} />
        </label>
        <label class="field">
          <span>Anzeigename (optional)</span>
          <input type="text" class="text-input" {...input(displayName, setDisplayName)} />
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span>Google-E-Mail</span>
          <input type="email" class="text-input" {...input(email, setEmail)} />
        </label>
        <label class="field">
          <span>GitHub-Login</span>
          <input type="text" class="text-input" {...input(github, setGithub)} />
        </label>
      </div>
      <span class="field-hint">Mindestens eines von beiden – darüber meldet sich der Benutzer an.</span>
      <label class="check-field">
        <input
          type="checkbox"
          checked={isAdmin}
          disabled={busy}
          onChange={(e) => setIsAdmin((e.target as HTMLInputElement).checked)}
        />
        <span>Administrator</span>
      </label>
      {error && <div class="alert alert-error">{error}</div>}
      <div class="form-actions">
        <button type="submit" class="btn-primary btn-sm" disabled={busy || !username.trim()}>
          {busy ? "Lege an…" : "Benutzer anlegen"}
        </button>
      </div>
    </form>
  );
}
