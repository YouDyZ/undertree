import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type CompileResult,
  type MemberRole,
  type Project,
  type ProjectMember,
  type RootFile,
  type TexCompiler,
  type UpdateProjectRequest,
  TEX_COMPILERS,
  type User,
  addMember,
  deleteProject,
  errorText,
  getProject,
  inviteRemote,
  listMembers,
  listProjectRoots,
  removeMember,
  updateMemberRole,
  updateProject,
  updateProjectCommitIdentity,
} from "../api";
import {
  MEMBER_ROLES,
  MEMBER_ROLE_LABELS,
  canEditProject,
  canInviteMemberToRemote,
  canLeaveProject,
  canManageProject,
  canRemoveMember,
  formatRoleError,
} from "../lib/roles";
import { formatAutoCompilerStatus, mainFileOptions, toggleMainFile } from "../lib/roots";
import {
  AUTO_PUSH_PRESETS,
  DEFAULT_AUTO_PUSH_MESSAGE,
  formatAutoPushTimestamp,
} from "../lib/gitReminder";
import { navigate } from "../lib/route";
import { TrashIcon } from "./Icons";
import { ConfirmModal, Modal } from "./Modal";
import { SpellcheckSettings } from "./SpellcheckSettings";

interface ProjectSettingsProps {
  project: Project;
  user: User;
  roots?: RootFile[];
  selectedRoot?: string | null;
  lastCompileResult?: CompileResult | null;
  onClose: () => void;
  onProjectChanged: (project: Project) => void;
}

export function ProjectSettings({
  project,
  user,
  roots,
  selectedRoot = null,
  lastCompileResult = null,
  onClose,
  onProjectChanged,
}: ProjectSettingsProps) {
  const canManage = canManageProject(project.my_role);
  const canEdit = canEditProject(project.my_role);

  const [name, setName] = useState(project.name);
  const [commitName, setCommitName] = useState(project.commit_name ?? "");
  const [commitEmail, setCommitEmail] = useState(project.commit_email ?? "");
  const [autoPushSecs, setAutoPushSecs] = useState(project.auto_push_interval_secs);
  const [autoPushMessage, setAutoPushMessage] = useState(
    project.auto_push_message || DEFAULT_AUTO_PUSH_MESSAGE
  );
  const [gitUser, setGitUser] = useState("");
  const [token, setToken] = useState("");
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [loadedRoots, setLoadedRoots] = useState<RootFile[] | null>(null);
  const [newMember, setNewMember] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<MemberRole>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "leave" | null>(null);

  useEffect(() => {
    setCommitName(project.commit_name ?? "");
    setCommitEmail(project.commit_email ?? "");
  }, [project.id, project.commit_name, project.commit_email]);

  useEffect(() => {
    setAutoPushSecs(project.auto_push_interval_secs);
    setAutoPushMessage(project.auto_push_message || DEFAULT_AUTO_PUSH_MESSAGE);
  }, [project.id, project.auto_push_interval_secs, project.auto_push_message]);

  useEffect(() => {
    listMembers(project.id)
      .then(setMembers)
      .catch((err: unknown) => setError(errorText(err, "Mitglieder konnten nicht geladen werden.")));
  }, [project.id]);

  useEffect(() => {
    if (roots !== undefined) return;
    let cancelled = false;
    listProjectRoots(project.id)
      .then((list) => {
        if (!cancelled) setLoadedRoots(list);
      })
      .catch(() => {
        if (!cancelled) setLoadedRoots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, roots]);

  const effectiveRoots = roots ?? loadedRoots ?? [];

  const mainFileChoices = useMemo(
    () => mainFileOptions(effectiveRoots, project.main_files),
    [effectiveRoots, project.main_files]
  );

  const autoStatus = useMemo(() => {
    if (project.compiler !== "auto") return null;
    if (
      lastCompileResult?.engine &&
      lastCompileResult.engine_reason &&
      lastCompileResult.engine_reason !== "fixed" &&
      (!selectedRoot || lastCompileResult.root === selectedRoot)
    ) {
      return formatAutoCompilerStatus(lastCompileResult.engine, lastCompileResult.engine_reason);
    }
    const activeRoot =
      (selectedRoot ? effectiveRoots.find((r) => r.path === selectedRoot) : undefined) ??
      effectiveRoots[0] ??
      null;
    if (activeRoot) {
      return formatAutoCompilerStatus(activeRoot.engine, activeRoot.reason);
    }
    return null;
  }, [project.compiler, lastCompileResult, selectedRoot, effectiveRoots]);

  const run = async (action: () => Promise<void>, success: string, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      return true;
    } catch (err: unknown) {
      setError(formatRoleError(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const patch = (body: UpdateProjectRequest, success: string) =>
    run(
      async () => onProjectChanged(await updateProject(project.id, body)),
      success,
      "Speichern fehlgeschlagen."
    );

  const saveToken = (e: Event) => {
    e.preventDefault();
    const body: UpdateProjectRequest = { token };
    if (gitUser.trim()) body.username = gitUser.trim();
    void patch(body, "Token gespeichert.").then((ok) => ok && setToken(""));
  };

  const trimmedCommitName = commitName.trim() || null;
  const trimmedCommitEmail = commitEmail.trim() || null;
  const commitIdentityDirty =
    trimmedCommitName !== project.commit_name || trimmedCommitEmail !== project.commit_email;

  const saveCommitIdentity = (e: Event) => {
    e.preventDefault();
    void run(
      async () => {
        const res = await updateProjectCommitIdentity(project.id, {
          commit_name: trimmedCommitName,
          commit_email: trimmedCommitEmail,
        });
        onProjectChanged({ ...project, ...res });
      },
      "Git-Autor für dieses Projekt gespeichert.",
      "Speichern fehlgeschlagen."
    );
  };

  const trimmedAutoPushMsg = autoPushMessage.trim() || DEFAULT_AUTO_PUSH_MESSAGE;
  const autoPushDirty =
    autoPushSecs !== project.auto_push_interval_secs ||
    trimmedAutoPushMsg !== (project.auto_push_message || DEFAULT_AUTO_PUSH_MESSAGE);

  const saveAutoPush = (e: Event) => {
    e.preventDefault();
    void patch(
      {
        auto_push_interval_secs: autoPushSecs,
        auto_push_message: trimmedAutoPushMsg,
      },
      "Auto-Push-Einstellungen gespeichert."
    );
  };

  const resetCommitIdentity = () => {
    void run(
      async () => {
        const res = await updateProjectCommitIdentity(project.id, {
          commit_name: null,
          commit_email: null,
        });
        setCommitName(res.commit_name ?? "");
        setCommitEmail(res.commit_email ?? "");
        onProjectChanged({ ...project, ...res });
      },
      "Git-Autor auf Profil-Standard zurückgesetzt.",
      "Zurücksetzen fehlgeschlagen."
    );
  };

  const add = (e: Event) => {
    e.preventDefault();
    const username = newMember.trim();
    void run(
      async () => {
        await addMember(project.id, username, newMemberRole);
        setMembers(await listMembers(project.id));
        setNewMember("");
        setNewMemberRole("editor");
      },
      `${username} (${MEMBER_ROLE_LABELS[newMemberRole]}) hinzugefügt.`,
      "Mitglied konnte nicht hinzugefügt werden."
    );
  };

  const changeRole = (username: string, role: MemberRole) =>
    void run(
      async () => {
        await updateMemberRole(project.id, username, role);
        setMembers(await listMembers(project.id));
        if (username === user.username) {
          onProjectChanged(await getProject(project.id));
        }
      },
      `Rolle von ${username} auf „${MEMBER_ROLE_LABELS[role]}“ geändert.`,
      "Rolle konnte nicht geändert werden."
    );

  const remove = (username: string) =>
    void run(
      async () => {
        await removeMember(project.id, username);
        setMembers((prev) => prev?.filter((m) => m.username !== username) ?? null);
      },
      `${username} entfernt.`,
      "Mitglied konnte nicht entfernt werden."
    );

  const field = (value: string, set: (v: string) => void) => ({
    value,
    disabled: busy,
    onInput: (e: Event) => set((e.target as HTMLInputElement).value),
  });

  return (
    <Modal title="Projekt-Einstellungen" onClose={onClose} busy={busy}>
      <div class="settings-sections">
        {error && <div class="alert alert-error" role="alert">{error}</div>}
        {notice && <div class="alert alert-success" role="status">{notice}</div>}

        {canManage && (
          <form
            class="settings-section form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void patch({ name: name.trim() }, "Projekt umbenannt.");
            }}
          >
            <h3>Name</h3>
            <div class="inline-form">
              <input type="text" class="text-input" required {...field(name, setName)} />
              <button
                type="submit"
                class="btn-primary btn-sm"
                disabled={busy || !name.trim() || name.trim() === project.name}
              >
                Umbenennen
              </button>
            </div>
          </form>
        )}

        {canManage && (
          <div class="settings-section form-stack">
            <h3>Compiler</h3>
            <select
              class="text-input"
              value={project.compiler}
              disabled={busy}
              onChange={(e) => {
                const compiler = (e.target as HTMLSelectElement).value as TexCompiler;
                void patch({ compiler }, "Compiler geändert. Nächster Lauf nutzt ihn.");
              }}
            >
              {TEX_COMPILERS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {project.compiler === "auto" && (
              <span class="field-hint">
                {autoStatus ?? "Erkennt die benötigte Engine pro Root-Datei beim Kompilieren."}
              </span>
            )}
          </div>
        )}

        {project.my_role === "owner" && (
          <div class="settings-section form-stack">
            <h3>Hauptdatei(en)</h3>
            {mainFileChoices.length === 0 ? (
              <span class="muted-text">Keine LaTeX-Root gefunden.</span>
            ) : (
              <ul class="member-list">
                {mainFileChoices.map((path) => (
                  <li key={path}>
                    <label>
                      <input
                        type="checkbox"
                        checked={project.main_files.includes(path)}
                        disabled={busy}
                        onChange={(e) =>
                          void patch(
                            {
                              main_files: toggleMainFile(
                                project.main_files,
                                path,
                                (e.target as HTMLInputElement).checked
                              ),
                            },
                            "Hauptdatei(en) gespeichert."
                          )
                        }
                      />{" "}
                      <span class="mono">{path}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <span class="field-hint">
              Leer = automatisch. Die erste angekreuzte Datei wird standardmäßig kompiliert, alle
              angekreuzten nach dem Speichern neu.
            </span>
          </div>
        )}

        {canManage && (
          <form class="settings-section form-stack" onSubmit={saveToken}>
            <h3>Zugangs-Token</h3>
            <span class="muted-text">
              {project.has_token ? "Ein Token ist hinterlegt." : "Kein Token hinterlegt."}{" "}
              <span class="mono-dim">{project.remote_url}</span>
            </span>
            <div class="field-row">
              <label class="field">
                <span>Username (optional)</span>
                <input type="text" class="text-input" placeholder="oauth2" {...field(gitUser, setGitUser)} />
              </label>
              <label class="field">
                <span>Neues Access-Token</span>
                <input type="password" class="text-input" autoComplete="off" {...field(token, setToken)} />
              </label>
            </div>
            <span class="field-hint">
              GitLab-/GitHub-PAT mit Lese-/Schreibrechten auf das Repository. Für SSH-URLs nicht nötig.
            </span>
            <div class="form-actions">
              {project.has_token && (
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void patch({ token: null }, "Token entfernt.")}
                >
                  Token entfernen
                </button>
              )}
              <button type="submit" class="btn-primary btn-sm" disabled={busy || !token}>
                {project.has_token ? "Token ersetzen" : "Token speichern"}
              </button>
            </div>
          </form>
        )}

        {canManage && (
          <form class="settings-section form-stack" onSubmit={saveAutoPush}>
            <h3>Auto-Push</h3>
            <div class="field-row">
              <label class="field">
                <span>Intervall</span>
                <select
                  class="text-input"
                  value={String(autoPushSecs)}
                  disabled={busy}
                  onChange={(e) => setAutoPushSecs(Number((e.target as HTMLSelectElement).value))}
                >
                  {AUTO_PUSH_PRESETS.map((p) => (
                    <option key={p.secs} value={String(p.secs)}>
                      {p.label}
                    </option>
                  ))}
                  {!AUTO_PUSH_PRESETS.some((p) => p.secs === autoPushSecs) && (
                    <option value={String(autoPushSecs)}>Alle {autoPushSecs} Sekunden</option>
                  )}
                </select>
              </label>
              <label class="field">
                <span>Auto-Commit-Nachricht</span>
                <input
                  type="text"
                  class="text-input"
                  maxLength={200}
                  placeholder={DEFAULT_AUTO_PUSH_MESSAGE}
                  {...field(autoPushMessage, setAutoPushMessage)}
                />
              </label>
            </div>
            <span class="field-hint">
              Platzhalter: <code>{"{files}"}</code>, <code>{"{count}"}</code>,{" "}
              <code>{"{time}"}</code>. Gemeinsame Editor-Änderungen laufen über CRDT ohne
              Merge-Konflikte zusammen (mit <code>Co-authored-by</code>). Letzter Auto-Push:{" "}
              {formatAutoPushTimestamp(project.auto_push_last_at)}.
            </span>
            {project.auto_push_last_error && (
              <div class="alert alert-error" role="alert">
                Letzter Auto-Push-Fehler: {project.auto_push_last_error}
              </div>
            )}
            <div class="form-actions">
              <button type="submit" class="btn-primary btn-sm" disabled={busy || !autoPushDirty}>
                Speichern
              </button>
            </div>
          </form>
        )}

        <section class="settings-section form-stack">
          <h3>Mitglieder</h3>
          {members === null ? (
            <span class="muted-text">Lade Mitglieder…</span>
          ) : (
            <ul class="member-list">
              {members.map((m) => (
                <li key={m.username}>
                  <span>
                    {m.display_name} <span class="mono-dim">@{m.username}</span>
                  </span>
                  <span class="member-actions">
                    {canManage ? (
                      <select
                        class="text-input member-role-select"
                        aria-label={`Rolle für ${m.username}`}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) => {
                          const nextRole = (e.target as HTMLSelectElement).value as MemberRole;
                          if (nextRole !== m.role) {
                            void changeRole(m.username, nextRole);
                          }
                        }}
                      >
                        {MEMBER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {MEMBER_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span class={`badge badge-role-${m.role}`}>
                        {MEMBER_ROLE_LABELS[m.role]}
                      </span>
                    )}
                    {canInviteMemberToRemote(canManage, project.account_id !== null, m) && (
                      <button
                        type="button"
                        class="btn-ghost btn-xs"
                        disabled={busy}
                        title="Als Collaborator (GitHub) bzw. Developer (GitLab) ins Remote-Repository eintragen"
                        onClick={() =>
                          void run(
                            () => inviteRemote(project.id, m.username),
                            `${m.username} ins Remote-Repository eingeladen.`,
                            "Einladen fehlgeschlagen."
                          )
                        }
                      >
                        Ins Remote einladen
                      </button>
                    )}
                    {canRemoveMember(canManage, m, user.username, members) && (
                      <button
                        type="button"
                        class="icon-btn icon-btn-danger"
                        disabled={busy}
                        title="Entfernen"
                        aria-label={`${m.username} entfernen`}
                        onClick={() => remove(m.username)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <form class="inline-form" onSubmit={add}>
              <input
                type="text"
                class="text-input"
                placeholder="Username hinzufügen"
                {...field(newMember, setNewMember)}
              />
              <select
                class="text-input member-role-select"
                aria-label="Rolle für neues Mitglied"
                value={newMemberRole}
                disabled={busy}
                onChange={(e) =>
                  setNewMemberRole((e.target as HTMLSelectElement).value as MemberRole)
                }
              >
                {MEMBER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {MEMBER_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <button type="submit" class="btn-primary btn-sm" disabled={busy || !newMember.trim()}>
                Hinzufügen
              </button>
            </form>
          )}
          {canLeaveProject(project, members, user.username) && (
            <div class="form-actions">
              <button type="button" class="btn-danger btn-sm" onClick={() => setConfirm("leave")}>
                Projekt verlassen
              </button>
            </div>
          )}
        </section>

        <SpellcheckSettings projectId={project.id} canEdit={canEdit} />

        {canEdit && (
          <form class="settings-section form-stack" onSubmit={saveCommitIdentity}>
            <h3>Git-Autor (dieses Projekt)</h3>
            <div class="field-row">
              <label class="field">
                <span>Commit-Name (optional)</span>
                <input
                  type="text"
                  class="text-input"
                  placeholder={user.display_name}
                  {...field(commitName, setCommitName)}
                />
              </label>
              <label class="field">
                <span>Commit-E-Mail (optional)</span>
                <input
                  type="email"
                  class="text-input"
                  placeholder={user.commit_email ?? user.email ?? "automatisch"}
                  {...field(commitEmail, setCommitEmail)}
                />
              </label>
            </div>
            <span class="field-hint">
              Gilt nur für dich in diesem Projekt (Author/Committer und <code>Co-authored-by</code>).
              Leer = dein Profil-Standard.
            </span>
            <div class="form-actions">
              {(project.commit_name !== null || project.commit_email !== null) && (
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  disabled={busy}
                  onClick={resetCommitIdentity}
                >
                  Zurücksetzen
                </button>
              )}
              <button type="submit" class="btn-primary btn-sm" disabled={busy || !commitIdentityDirty}>
                Speichern
              </button>
            </div>
          </form>
        )}

        {canManage && (
          <section class="settings-section danger-zone form-stack">
            <h3>Projekt löschen</h3>
            <span class="muted-text">
              Löscht den lokalen Klon, CRDT-Zustand und Build-Ausgaben. Das Remote-Repository bleibt
              unberührt.
            </span>
            <div class="form-actions">
              <button type="button" class="btn-danger btn-sm" onClick={() => setConfirm("delete")}>
                Projekt löschen…
              </button>
            </div>
          </section>
        )}
      </div>

      {confirm === "delete" && (
        <ConfirmModal
          title="Projekt löschen"
          message={
            <>
              <strong>{project.name}</strong> wird endgültig vom Server entfernt.
            </>
          }
          confirmLabel="Endgültig löschen"
          requireText={project.name}
          onConfirm={async () => {
            await deleteProject(project.id);
            navigate("/");
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "leave" && (
        <ConfirmModal
          title="Projekt verlassen"
          message={
            <>
              Du verlierst den Zugriff auf <strong>{project.name}</strong>, bis dich der Eigentümer
              erneut einlädt.
            </>
          }
          confirmLabel="Verlassen"
          onConfirm={async () => {
            try {
              await removeMember(project.id, user.username);
              navigate("/");
            } catch (err: unknown) {
              throw new Error(formatRoleError(err, "Projekt konnte nicht verlassen werden."));
            }
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </Modal>
  );
}
