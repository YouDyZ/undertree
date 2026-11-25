import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type Template,
  type TemplateCompiler,
  type User,
  deleteTemplate,
  errorText,
  listTemplates,
  updateTemplate,
  uploadTemplate,
} from "../api";
import {
  canManageTemplate,
  compilerBadgeLabel,
  formatTemplateUploadError,
  hasPendingPreviews,
  previewStatusLabel,
  shouldApplyTemplatePoll,
  upsertTemplate,
  validateTemplateUploadForm,
} from "../lib/templates";
import {
  AlertIcon,
  EyeIcon,
  GlobeIcon,
  LockIcon,
  TrashIcon,
  UploadIcon,
} from "./Icons";
import { ConfirmModal } from "./Modal";
import { PageHeader } from "./PageHeader";
import { TemplatePreviewModal, TemplatePreviewThumbnail } from "./TemplatePreview";

interface TemplatesPageProps {
  user: User;
  onLoggedOut: () => void;
}

const UPLOAD_POLL_INTERVAL_MS = 2000;

export function TemplatesPage({ user, onLoggedOut }: TemplatesPageProps) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recentUploadId, setRecentUploadId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Template | null>(null);

  // Upload form state
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [compiler, setCompiler] = useState<"" | TemplateCompiler>("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listVersionRef = useRef(0);
  const activeMutationsRef = useRef(0);

  const runTemplateMutation = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    activeMutationsRef.current += 1;
    listVersionRef.current += 1;
    try {
      return await fn();
    } finally {
      activeMutationsRef.current = Math.max(0, activeMutationsRef.current - 1);
    }
  }, []);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        onLoggedOut();
        return true;
      }
      return false;
    },
    [onLoggedOut]
  );

  useEffect(() => {
    let active = true;
    const loadVersion = listVersionRef.current;
    listTemplates()
      .then((list) => {
        if (active && loadVersion === listVersionRef.current) setTemplates(list);
      })
      .catch((err: unknown) => {
        if (!active || handleAuthError(err)) return;
        setLoadError(errorText(err, "Templates konnten nicht geladen werden."));
      });
    return () => {
      active = false;
    };
  }, [handleAuthError]);

  // Poll automatically ONLY while at least one template has preview === "pending"
  const hasPending = templates !== null && hasPendingPreviews(templates);
  useEffect(() => {
    if (!hasPending) return;
    let active = true;
    let inFlight = false;

    const timer = window.setInterval(() => {
      if (inFlight || activeMutationsRef.current > 0) return;
      inFlight = true;
      const pollVersion = listVersionRef.current;
      void listTemplates()
        .then((next) => {
          if (
            active &&
            shouldApplyTemplatePoll(
              pollVersion,
              listVersionRef.current,
              activeMutationsRef.current
            )
          ) {
            setTemplates(next);
          }
        })
        .catch((err: unknown) => {
          if (active) handleAuthError(err);
        })
        .finally(() => {
          inFlight = false;
        });
    }, UPLOAD_POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasPending, handleAuthError]);

  const handleFileChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    setFile(chosen);
    setUploadError(null);
    if (chosen && !name.trim()) {
      setName(chosen.name.replace(/\.zip$/i, ""));
    }
  };

  const handleUpload = async (e: Event) => {
    e.preventDefault();
    const validationError = validateTemplateUploadForm({ name, file });
    if (validationError) {
      setUploadError(validationError);
      return;
    }
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    setActionError(null);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name.trim());
    fd.append("description", description.trim());
    if (compiler) {
      fd.append("compiler", compiler);
    }

    try {
      const created = await runTemplateMutation(() => uploadTemplate(fd));
      listVersionRef.current += 1;
      setTemplates((prev) => upsertTemplate(prev ?? [], created));
      setRecentUploadId(created.id);
      setSelectedId(created.id);
      setFile(null);
      setName("");
      setDescription("");
      setCompiler("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (err: unknown) {
      if (handleAuthError(err)) return;
      setUploadError(formatTemplateUploadError(err));
    } finally {
      setUploading(false);
    }
  };

  const handleTemplateUpdated = useCallback((updated: Template) => {
    listVersionRef.current += 1;
    setTemplates((prev) => (prev ? upsertTemplate(prev, updated) : null));
  }, []);

  const handleTemplateDeleted = useCallback((deletedId: string) => {
    listVersionRef.current += 1;
    setTemplates((prev) => prev?.filter((t) => t.id !== deletedId) ?? null);
    setSelectedId((prev) => (prev === deletedId ? null : prev));
    setRecentUploadId((prev) => (prev === deletedId ? null : prev));
  }, []);

  const performTogglePublic = useCallback(
    async (tpl: Template): Promise<Template> => {
      return runTemplateMutation(async () => {
        const updated = await updateTemplate(tpl.id, { public: !tpl.public });
        handleTemplateUpdated(updated);
        return updated;
      });
    },
    [runTemplateMutation, handleTemplateUpdated]
  );

  const performDeleteTemplate = useCallback(
    async (id: string): Promise<void> => {
      await runTemplateMutation(async () => {
        await deleteTemplate(id);
        handleTemplateDeleted(id);
      });
    },
    [runTemplateMutation, handleTemplateDeleted]
  );

  const handleModalTogglePublic = useCallback(
    async (tpl: Template): Promise<Template> => {
      try {
        return await performTogglePublic(tpl);
      } catch (err: unknown) {
        handleAuthError(err);
        throw err;
      }
    },
    [performTogglePublic, handleAuthError]
  );

  const handleModalDeleteTemplate = useCallback(
    async (id: string): Promise<void> => {
      try {
        await performDeleteTemplate(id);
      } catch (err: unknown) {
        handleAuthError(err);
        throw err;
      }
    },
    [performDeleteTemplate, handleAuthError]
  );

  const togglePublic = async (tpl: Template) => {
    setTogglingId(tpl.id);
    setActionError(null);
    try {
      await performTogglePublic(tpl);
    } catch (err: unknown) {
      if (handleAuthError(err)) return;
      setActionError(errorText(err, "Sichtbarkeit konnte nicht geändert werden."));
    } finally {
      setTogglingId(null);
    }
  };

  const selectedTemplate = templates?.find((t) => t.id === selectedId) ?? null;
  const recentTemplate = templates?.find((t) => t.id === recentUploadId) ?? null;

  return (
    <div class="page">
      <PageHeader user={user} onLoggedOut={onLoggedOut} />
      <main class="page-body">
        <div class="page-title-row">
          <div>
            <h1>Templates</h1>
            <p class="muted-text page-subtitle">
              Vorlagen für neue LaTeX-Repositories. Eigene ZIP-Uploads werden automatisch
              anonymisiert und als Vorschau gerendert.
            </p>
          </div>
        </div>

        <form class="panel-card form-stack" onSubmit={(e) => void handleUpload(e)}>
          <div class="template-upload-head">
            <h2>Template hochladen (.zip)</h2>
            <span class="field-hint">Max. 25 MB · startet privat bis zur Freigabe</span>
          </div>

          <div class="field-row">
            <label class="field">
              <span>ZIP-Archiv (z. B. Overleaf-Export)</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                class="text-input"
                disabled={uploading}
                onChange={handleFileChange}
              />
            </label>
            <label class="field">
              <span>Name</span>
              <input
                type="text"
                class="text-input"
                required
                placeholder="z. B. ICML 2027 Paper"
                value={name}
                disabled={uploading}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="field template-compiler-field">
              <span>Compiler</span>
              <select
                class="text-input"
                value={compiler}
                disabled={uploading}
                onChange={(e) => setCompiler((e.target as HTMLSelectElement).value as "" | TemplateCompiler)}
              >
                <option value="">Automatisch erkennen</option>
                <option value="pdflatex">pdfLaTeX</option>
                <option value="xelatex">XeLaTeX</option>
                <option value="lualatex">LuaLaTeX</option>
              </select>
            </label>
          </div>

          <label class="field">
            <span>Beschreibung (optional)</span>
            <input
              type="text"
              class="text-input"
              placeholder="Kurze Beschreibung des Layouts oder Verwendungszwecks"
              value={description}
              disabled={uploading}
              onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
            />
          </label>

          {uploadError && (
            <div class="alert alert-error" role="alert">
              <AlertIcon size={16} />
              <span>{uploadError}</span>
            </div>
          )}

          <div class="form-actions">
            {uploading && (
              <span class="muted-text busy-hint">
                <span class="boot-spinner spinner-sm" /> Lade hoch &amp; anonymisiere…
              </span>
            )}
            <button type="submit" class="btn-primary btn-sm" disabled={uploading || !file || !name.trim()}>
              <UploadIcon size={14} />
              <span>{uploading ? "Wird hochgeladen…" : "Template hochladen"}</span>
            </button>
          </div>
        </form>

        {recentTemplate && (
          <div
            class={`alert ${recentTemplate.preview === "failed" ? "alert-warn" : "alert-success"} template-recent-banner`}
            role="status"
          >
            {recentTemplate.preview === "pending" ? (
              <span class="boot-spinner spinner-sm" />
            ) : (
              <EyeIcon size={16} />
            )}
            <div class="template-publish-banner-text">
              {recentTemplate.preview === "pending" && (
                <>
                  <strong>Wird anonymisiert, Vorschau wird erstellt…</strong>{" "}
                  <span>
                    „{recentTemplate.name}“ ist zunächst privat. Sobald die Vorschau bereit ist,
                    kannst du es prüfen und veröffentlichen.
                  </span>
                </>
              )}
              {recentTemplate.preview === "ready" && (
                <>
                  <strong>Vorschau für „{recentTemplate.name}“ ist fertig.</strong>{" "}
                  <span>
                    {recentTemplate.public
                      ? "Das Template ist jetzt öffentlich sichtbar."
                      : "Prüfe Vorschau und Dateiliste – möchtest du das Template veröffentlichen?"}
                  </span>
                </>
              )}
              {recentTemplate.preview === "failed" && (
                <>
                  <strong>Vorschau für „{recentTemplate.name}“ fehlgeschlagen.</strong>{" "}
                  <span>
                    Das Template wurde anonymisiert gespeichert, die PDF-Vorschau konnte aber nicht
                    kompiliert werden.
                  </span>
                </>
              )}
            </div>
            <div class="template-recent-actions">
              <button
                type="button"
                class="btn-ghost btn-xs"
                onClick={() => setSelectedId(recentTemplate.id)}
              >
                Vorschau &amp; Dateien
              </button>
              {canManageTemplate(recentTemplate, user) &&
                !recentTemplate.public &&
                recentTemplate.preview === "ready" && (
                  <button
                    type="button"
                    class="btn-primary btn-xs"
                    disabled={togglingId === recentTemplate.id}
                    onClick={() => void togglePublic(recentTemplate)}
                  >
                    Veröffentlichen?
                  </button>
                )}
            </div>
          </div>
        )}

        {loadError && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>{loadError}</span>
          </div>
        )}
        {actionError && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={16} />
            <span>{actionError}</span>
          </div>
        )}

        {templates === null && !loadError && <div class="muted-text">Lade Templates…</div>}

        {templates && templates.length === 0 && (
          <div class="placeholder-card">
            <h2>Keine Templates vorhanden</h2>
            <p>Lade oben ein ZIP-Archiv hoch, um ein neues LaTeX-Template anzulegen.</p>
          </div>
        )}

        {templates && templates.length > 0 && (
          <div class="template-grid">
            {templates.map((tpl) => {
              const manageable = canManageTemplate(tpl, user);
              const isRecent = tpl.id === recentUploadId;
              return (
                <article
                  key={tpl.id}
                  class={`template-card${isRecent ? " is-highlighted" : ""}`}
                >
                  <button
                    type="button"
                    class="template-card-preview-btn"
                    onClick={() => setSelectedId(tpl.id)}
                    aria-label={`Vorschau für ${tpl.name} öffnen`}
                  >
                    <TemplatePreviewThumbnail template={tpl} />
                  </button>

                  <div class="template-card-body">
                    <div class="template-card-head">
                      <button
                        type="button"
                        class="template-card-title"
                        onClick={() => setSelectedId(tpl.id)}
                      >
                        {tpl.name}
                      </button>
                      {tpl.builtin ? (
                        <span class="badge badge-parent">Eingebaut</span>
                      ) : tpl.public ? (
                        <span class="badge badge-admin">Öffentlich</span>
                      ) : (
                        <span class="badge badge-detached">Privat</span>
                      )}
                    </div>

                    {tpl.description && <p class="template-card-desc">{tpl.description}</p>}

                    <div class="template-card-meta">
                      <span class="badge badge-muted">{compilerBadgeLabel(tpl.compiler)}</span>
                      <span class="badge badge-branch" title="Hauptdatei">
                        {tpl.main_file}
                      </span>
                      {tpl.preview !== "ready" && (
                        <span
                          class={`badge ${tpl.preview === "pending" ? "badge-detached" : "badge-uninit"}`}
                        >
                          {previewStatusLabel(tpl.preview)}
                        </span>
                      )}
                    </div>

                    <div class="template-card-footer">
                      <span class="muted-text template-owner">
                        {tpl.owner ? `von ${tpl.owner}` : tpl.builtin ? "Standard-Vorlage" : ""}
                      </span>
                      <div class="template-card-actions">
                        <button
                          type="button"
                          class="btn-ghost btn-xs"
                          onClick={() => setSelectedId(tpl.id)}
                          title="Vorschau und anonymisierte Dateien ansehen"
                        >
                          <EyeIcon size={12} />
                          <span>Details</span>
                        </button>
                        {manageable && (
                          <>
                            <button
                              type="button"
                              class={tpl.public ? "btn-ghost btn-xs" : "btn-primary btn-xs"}
                              disabled={togglingId === tpl.id}
                              onClick={() => void togglePublic(tpl)}
                              title={tpl.public ? "Auf privat setzen" : "Für alle veröffentlichen"}
                            >
                              {tpl.public ? <LockIcon size={11} /> : <GlobeIcon size={11} />}
                              <span>{tpl.public ? "Privat" : "Öffentlich"}</span>
                            </button>
                            <button
                              type="button"
                              class="icon-btn icon-btn-danger"
                              title="Template löschen"
                              aria-label={`Template ${tpl.name} löschen`}
                              onClick={() => setToDelete(tpl)}
                            >
                              <TrashIcon size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {selectedTemplate && (
        <TemplatePreviewModal
          template={selectedTemplate}
          user={user}
          highlightPublish={selectedTemplate.id === recentUploadId}
          onClose={() => setSelectedId(null)}
          onUpdated={handleTemplateUpdated}
          onDeleted={handleTemplateDeleted}
          onTogglePublic={handleModalTogglePublic}
          onDeleteTemplate={handleModalDeleteTemplate}
        />
      )}

      {toDelete && (
        <ConfirmModal
          title="Template löschen"
          message={
            <>
              <strong>{toDelete.name}</strong> wird dauerhaft gelöscht. Bestehende Projekte bleiben
              unberührt.
            </>
          }
          confirmLabel="Löschen"
          onConfirm={async () => {
            try {
              await performDeleteTemplate(toDelete.id);
            } catch (err: unknown) {
              handleAuthError(err);
              throw err;
            }
          }}
          onClose={() => setToDelete(null)}
        />
      )}
    </div>
  );
}
