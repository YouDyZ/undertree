import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type CreateProjectRequest,
  type GitAccount,
  type Project,
  type ScanProjectResult,
  type Template,
  type TexCompiler,
  type User,
  GITHUB_CONNECT_URL,
  TEX_COMPILERS,
  createProject,
  errorText,
  getAuthProviders,
  listAccounts,
  listProjects,
  listTemplates,
  scanProject,
} from "../api";
import {
  NEW_GITHUB,
  NEW_GITLAB,
  accountLabel,
  accountOptions,
  matchAccountForUrl,
  repoNameFromTitle,
} from "../lib/accounts";
import { MEMBER_ROLE_DESCRIPTIONS, MEMBER_ROLE_LABELS } from "../lib/roles";
import { linkClick, navigate } from "../lib/route";
import { DEFAULT_TEMPLATE_ID, compilerBadgeLabel, pickDefaultTemplateId } from "../lib/templates";
import { GitlabConnectForm } from "./GitlabConnectForm";
import { AlertIcon, GitBranchIcon, PlusIcon } from "./Icons";
import { Modal } from "./Modal";
import { PageHeader } from "./PageHeader";
import { TemplatePreviewThumbnail } from "./TemplatePreview";

interface ProjectListPageProps {
  user: User;
  onLoggedOut: () => void;
}

export function ProjectListPage({ user, onLoggedOut }: ProjectListPageProps) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // back from `/api/auth/connect/github` (`?connected=github` / `?connect_error=…`)
  const [connected] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("connected")) return "ok";
    if (q.has("connect_error")) return "error";
    return null;
  });

  useEffect(() => {
    if (connected) window.history.replaceState(null, "", "/");
  }, [connected]);

  useEffect(() => {
    let active = true;
    listProjects()
      .then((list) => active && setProjects(list))
      .catch((err: unknown) => active && setError(errorText(err, "Projekte konnten nicht geladen werden.")));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div class="page">
      <PageHeader user={user} onLoggedOut={onLoggedOut} />
      <main class="page-body">
        <div class="page-title-row">
          <h1>Projekte</h1>
          <div class="page-title-actions">
            <a href="/templates" class="btn-ghost btn-sm" onClick={linkClick}>
              Templates
            </a>
            <button type="button" class="btn-primary btn-sm" onClick={() => setCreating(true)}>
              <PlusIcon size={14} />
              <span>Neues Projekt</span>
            </button>
          </div>
        </div>

        {error && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>{error}</span>
          </div>
        )}
        {connected === "ok" && (
          <div class="alert alert-success" role="status">
            GitHub-Konto verbunden. Unter „Neues Projekt“ kannst du jetzt ein Repository anlegen.
          </div>
        )}
        {connected === "error" && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>GitHub-Konto konnte nicht verbunden werden.</span>
          </div>
        )}

        {projects === null && !error && <div class="muted-text">Lade Projekte…</div>}

        {projects?.length === 0 && (
          <div class="placeholder-card">
            <h2>Noch keine Projekte</h2>
            <p>Verbinde ein Git-Repository über „Neues Projekt“, um gemeinsam daran zu arbeiten.</p>
          </div>
        )}

        {projects && projects.length > 0 && (
          <div class="project-grid">
            {projects.map((p) => (
              <a key={p.id} href={`/p/${p.id}`} class="project-card" onClick={linkClick}>
                <div class="project-card-head">
                  <span class="project-name">{p.name}</span>
                  <span
                    class={`badge badge-role-${p.my_role}`}
                    title={MEMBER_ROLE_DESCRIPTIONS[p.my_role]}
                  >
                    {MEMBER_ROLE_LABELS[p.my_role]}
                  </span>
                </div>
                <span class="mono-dim project-url">{p.remote_url}</span>
                <div class="project-meta">
                  <span class="badge badge-branch">
                    <GitBranchIcon size={11} /> {p.branch}
                  </span>
                  <span class="muted-text">von {p.owner}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </main>

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"connect" | "create">("connect");
  const [name, setName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [compiler, setCompiler] = useState<TexCompiler>("auto");
  const [accounts, setAccounts] = useState<GitAccount[] | null>(null);
  // account id, NEW_GITLAB or NEW_GITHUB
  const [accountSel, setAccountSel] = useState<string>("");
  const [githubAvailable, setGithubAvailable] = useState(false);
  // null = follow the project name
  const [repoName, setRepoName] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(true);
  const [namespace, setNamespace] = useState("");
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  const [scanResult, setScanResult] = useState<ScanProjectResult | null>(null);
  const [scannedKey, setScannedKey] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [addTemplate, setAddTemplate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = mode === "create";
  const repo = repoName ?? repoNameFromTitle(name);
  const account = accounts?.find((a) => String(a.id) === accountSel) ?? null;
  const connecting = accountSel === NEW_GITLAB || accountSel === NEW_GITHUB;
  const selectedTemplate = templates?.find((t) => t.id === templateId) ?? null;

  const currentScanKey = `${remoteUrl.trim()}\0${branch.trim()}\0${username.trim()}\0${token}`;
  const activeScan = scannedKey === currentScanKey ? scanResult : null;
  const matchedAccount = useMemo(
    () => (token ? null : matchAccountForUrl(accounts ?? [], remoteUrl)),
    [accounts, remoteUrl, token]
  );
  const showConnectTemplatePicker =
    !create && activeScan !== null && !activeScan.has_tex_files && (activeScan.is_empty || addTemplate);

  useEffect(() => {
    if (accounts !== null) return;
    listAccounts()
      .then((list) => {
        const gitAccounts = list.filter((a) => a.provider !== "zotero");
        setAccounts(gitAccounts);
        setAccountSel((prev) => prev || (gitAccounts[0] ? String(gitAccounts[0].id) : NEW_GITLAB));
      })
      .catch((err: unknown) => setError(errorText(err, "Konten konnten nicht geladen werden.")));
    getAuthProviders()
      .then((p) => setGithubAvailable(p.oauth.includes("github")))
      .catch(() => {});
  }, [accounts]);

  const needsTemplates = create || (activeScan !== null && !activeScan.has_tex_files);
  useEffect(() => {
    if (!needsTemplates || templates !== null) return;
    let active = true;
    listTemplates()
      .then((list) => {
        if (!active) return;
        setTemplates(list);
        const defId = pickDefaultTemplateId(list);
        setTemplateId(defId);
        const defTpl = list.find((t) => t.id === defId);
        if (defTpl && create) {
          setCompiler(defTpl.compiler);
        }
      })
      .catch((err: unknown) => {
        if (active) setTemplatesError(errorText(err, "Templates konnten nicht geladen werden."));
      });
    return () => {
      active = false;
    };
  }, [needsTemplates, templates, create]);

  const selectTemplate = (tpl: Template) => {
    setTemplateId(tpl.id);
    setCompiler(tpl.compiler);
  };

  const runScan = async (): Promise<ScanProjectResult | null> => {
    setScanning(true);
    setError(null);
    try {
      const res = await scanProject({
        remote_url: remoteUrl.trim(),
        branch: branch.trim() || undefined,
        username: username.trim() || undefined,
        token: token || undefined,
      });
      setScanResult(res);
      setScannedKey(currentScanKey);
      if (!res.has_tex_files) {
        setAddTemplate(true);
      }
      return res;
    } catch (err: unknown) {
      setError(errorText(err, "Repository konnte nicht geprüft werden."));
      return null;
    } finally {
      setScanning(false);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!create && !activeScan) {
      const res = await runScan();
      if (!res || !res.has_tex_files) {
        return;
      }
    }
    setBusy(true);
    const body: CreateProjectRequest = { name: name.trim(), compiler };
    if (create && account) {
      body.create_remote = {
        account_id: account.id,
        repo_name: repo.trim(),
        private: isPrivate,
        namespace: (account.provider === "gitlab" && namespace.trim()) || undefined,
        template_id: templateId || undefined,
      };
    } else {
      body.remote_url = remoteUrl.trim();
      body.branch = branch.trim() || undefined;
      body.username = username.trim() || undefined;
      body.token = token || undefined;
      if (activeScan && !activeScan.has_tex_files && (activeScan.is_empty || addTemplate)) {
        body.template_id = templateId || undefined;
      }
    }
    try {
      const project = await createProject(body);
      navigate(`/p/${project.id}`);
    } catch (err: unknown) {
      setError(errorText(err, "Projekt konnte nicht angelegt werden."));
      setBusy(false);
    }
  };

  const input = (value: string, set: (v: string) => void) => ({
    value,
    disabled: busy || scanning,
    onInput: (e: Event) => set((e.target as HTMLInputElement).value),
  });

  const renderTemplatePicker = () => (
    <div class="field">
      <div class="template-picker-head">
        <span>Template</span>
        <a href="/templates" class="template-picker-link" onClick={linkClick}>
          Alle Templates verwalten →
        </a>
      </div>
      {templates === null && !templatesError && <div class="muted-text">Lade Templates…</div>}
      {templatesError && (
        <div class="alert alert-warn" role="alert">
          <AlertIcon size={15} />
          <span>{templatesError}</span>
        </div>
      )}
      {templates && templates.length > 0 && (
        <div class="template-picker-grid" role="radiogroup" aria-label="Template auswählen">
          {templates.map((tpl) => {
            const selected = tpl.id === templateId;
            return (
              <button
                key={tpl.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy || scanning}
                class={`template-pick-card${selected ? " is-selected" : ""}`}
                onClick={() => selectTemplate(tpl)}
              >
                <TemplatePreviewThumbnail template={tpl} class="template-thumb-sm" />
                <div class="template-pick-info">
                  <div class="template-pick-head">
                    <span class="template-pick-name">{tpl.name}</span>
                    {!tpl.builtin && !tpl.public && <span class="badge badge-detached">Privat</span>}
                  </div>
                  {tpl.description && <span class="template-pick-desc">{tpl.description}</span>}
                  <div class="template-pick-badges">
                    <span class="badge badge-muted">{compilerBadgeLabel(tpl.compiler)}</span>
                    <span class="badge badge-branch">{tpl.main_file}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <Modal
      title="Neues Projekt"
      onClose={onClose}
      busy={busy || scanning}
      class={create || showConnectTemplatePicker ? "modal-wide" : undefined}
    >
      <form class="form-stack" onSubmit={(e) => void submit(e)}>
        <div class="git-tabs" role="tablist">
          {(
            [
              ["connect", "Bestehendes Repo verbinden"],
              ["create", "Neues Repo anlegen"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              class={`git-tab${mode === m ? " is-active" : ""}`}
              disabled={busy}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <label class="field">
          <span>Name</span>
          <input type="text" class="text-input" required autoFocus {...input(name, setName)} />
        </label>
        {create ? (
          <>
            {accounts?.length === 0 && (
              <div class="alert alert-warn">
                Noch kein GitHub- oder GitLab-Konto verbunden. Wähle unten im Feld „Konto“ eine
                „verbinden…“-Option.
              </div>
            )}
            <label class="field">
              <span>Konto</span>
              <select
                class="text-input"
                required
                value={accountSel}
                disabled={busy || !accounts}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  // GitHub connects via OAuth redirect (full page navigation)
                  if (v === NEW_GITHUB) window.location.href = GITHUB_CONNECT_URL;
                  else setAccountSel(v);
                }}
              >
                {accounts &&
                  accountOptions(accounts, githubAvailable).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </select>
            </label>
            {accountSel === NEW_GITLAB && (
              <GitlabConnectForm
                onConnected={(a) => {
                  // the connect is an upsert: replace an account that is already listed
                  setAccounts((prev) => [...(prev ?? []).filter((x) => x.id !== a.id), a]);
                  setAccountSel(String(a.id));
                }}
              />
            )}
            <div class="field-row">
              <label class="field">
                <span>Repo-Name</span>
                <input
                  type="text"
                  class="text-input"
                  required
                  pattern="[A-Za-z0-9_][A-Za-z0-9._\-]*"
                  value={repo}
                  disabled={busy}
                  onInput={(e) => setRepoName((e.target as HTMLInputElement).value)}
                />
              </label>
              {account?.provider === "gitlab" && (
                <label class="field">
                  <span>Gruppe (optional)</span>
                  <input
                    type="text"
                    class="text-input"
                    placeholder={account.login}
                    {...input(namespace, setNamespace)}
                  />
                </label>
              )}
            </div>
            {renderTemplatePicker()}
            <label class="check-field">
              <input
                type="checkbox"
                checked={isPrivate}
                disabled={busy}
                onChange={(e) => setIsPrivate((e.target as HTMLInputElement).checked)}
              />
              <span>Privat</span>
            </label>
            <span class="field-hint">
              Legt das Repository mit dem gewählten Template (Hauptdatei{" "}
              <code>{selectedTemplate?.main_file ?? "main.tex"}</code>) und einer CI-Pipeline an,
              die das PDF mit dem gewählten Compiler baut. Das Projekt bekommt einen eigenen
              SSH-Deploy-Key.
            </span>
          </>
        ) : (
          <>
            <label class="field">
              <span>Repo-URL</span>
              <input
                type="text"
                class="text-input"
                required
                placeholder="https://gitlab.com/gruppe/paper.git oder git@host:pfad.git"
                {...input(remoteUrl, setRemoteUrl)}
              />
            </label>
            <div class="field-row">
              <label class="field">
                <span>Branch (optional)</span>
                <input type="text" class="text-input" placeholder="Standard-Branch" {...input(branch, setBranch)} />
              </label>
              <label class="field">
                <span>Username (optional)</span>
                <input type="text" class="text-input" placeholder="oauth2" {...input(username, setUsername)} />
              </label>
            </div>
          </>
        )}
        <label class="field">
          <span>Compiler</span>
          <select
            class="text-input"
            value={compiler}
            disabled={busy}
            onChange={(e) => setCompiler((e.target as HTMLSelectElement).value as TexCompiler)}
          >
            {TEX_COMPILERS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <span class="field-hint">Später in den Projekt-Einstellungen änderbar.</span>
        </label>
        {!create && (
          <>
            <label class="field">
              <span>Access-Token (optional)</span>
              <input type="password" class="text-input" autoComplete="off" {...input(token, setToken)} />
              {matchedAccount ? (
                <span class="field-hint repo-match-hint">
                  Gespeichertes Konto erkannt (<strong>{accountLabel(matchedAccount)}</strong>) —
                  Token wird automatisch genutzt, sofern hier kein neues eingegeben wird.
                </span>
              ) : (
                <span class="field-hint">
                  GitLab-/GitHub-Personal-Access-Token mit Lese-/Schreibrechten auf das Repository
                  (read/write repository). Für SSH-URLs nicht nötig.
                </span>
              )}
            </label>

            {activeScan && (
              <div class={`repo-scan-box ${activeScan.has_tex_files ? "is-ok" : "is-warn"}`}>
                <div class="repo-scan-summary">
                  <strong>
                    {activeScan.has_tex_files
                      ? "LaTeX-Dateien gefunden"
                      : "Keine .tex-Dateien im Repository gefunden"}
                  </strong>
                  <span class="muted-text">
                    Branch <code>{activeScan.branch}</code> ·{" "}
                    {activeScan.is_empty
                      ? "leeres Repository"
                      : `${activeScan.file_count} Datei(en)`}
                    {activeScan.matched_account &&
                      ` · Token via ${accountLabel({ ...activeScan.matched_account, ssh_host_key_fingerprint: null })}`}
                  </span>
                  {activeScan.has_tex_files && (
                    <span class="muted-text">
                      {activeScan.roots.length > 0
                        ? `Hauptdatei: ${activeScan.roots.join(", ")}`
                        : `Dateien: ${activeScan.tex_files.slice(0, 3).join(", ")}`}
                      {activeScan.detected_compiler &&
                        ` · erkannter Compiler: ${activeScan.detected_compiler}`}
                    </span>
                  )}
                </div>

                {!activeScan.has_tex_files && (
                  <>
                    <label class="check-field">
                      <input
                        type="checkbox"
                        checked={activeScan.is_empty || addTemplate}
                        disabled={busy || scanning || activeScan.is_empty}
                        onChange={(e) => setAddTemplate((e.target as HTMLInputElement).checked)}
                      />
                      <span>
                        {activeScan.is_empty
                          ? "Mit gewähltem LaTeX-Template initialisieren (erforderlich, da Repo leer ist)"
                          : "LaTeX-Template vorab ins Repository hinzufügen (bestehende Dateien bleiben erhalten)"}
                      </span>
                    </label>
                    {showConnectTemplatePicker && renderTemplatePicker()}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {error && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>{error}</span>
          </div>
        )}

        <div class="form-actions">
          {(busy || scanning) && (
            <span class="muted-text busy-hint">
              <span class="boot-spinner spinner-sm" />{" "}
              {scanning
                ? "Repository wird gescannt…"
                : create
                  ? "Repository wird angelegt…"
                  : "Repository wird geklont – das kann etwas dauern…"}
            </span>
          )}
          <button type="button" class="btn-ghost btn-sm" disabled={busy || scanning} onClick={onClose}>
            Abbrechen
          </button>
          {!create && (
            <button
              type="button"
              class="btn-ghost btn-sm"
              disabled={busy || scanning || !remoteUrl.trim()}
              onClick={() => void runScan()}
            >
              {scanning ? "Prüfe…" : "Repository prüfen"}
            </button>
          )}
          <button
            type="submit"
            class="btn-primary btn-sm"
            disabled={busy || scanning || !name.trim() || (create ? connecting || !account || !repo.trim() : !remoteUrl.trim())}
          >
            {busy ? (create ? "Lege an…" : "Klone…") : "Projekt anlegen"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
