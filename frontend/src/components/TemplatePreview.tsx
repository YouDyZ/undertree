import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  type Template,
  type TemplateFile,
  type User,
  deleteTemplate,
  errorText,
  listTemplateFiles,
  templatePreviewUrl,
  updateTemplate,
} from "../api";
import {
  canManageTemplate,
  compilerBadgeLabel,
  formatBytes,
  previewStatusLabel,
} from "../lib/templates";
import { AlertIcon, EyeIcon, FileIcon, GlobeIcon, LockIcon, TrashIcon } from "./Icons";
import { ConfirmModal, Modal } from "./Modal";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function isPdfCancellationError(err: unknown): boolean {
  if (err instanceof pdfjsLib.RenderingCancelledException) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (
    err instanceof Error &&
    (err.name === "RenderingCancelledException" ||
      err.name === "AbortError" ||
      err.message === "Worker was destroyed")
  ) {
    return true;
  }
  return false;
}

interface TemplatePreviewThumbnailProps {
  template: Template;
  class?: string;
}

/**
 * Renders page 1 of a template's preview PDF onto a canvas, or shows a pending/failed state.
 * Cleans up fetch, loading task, PDF document, and render task on unmount or template change.
 */
export function TemplatePreviewThumbnail({ template, class: cls }: TemplatePreviewThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (template.preview !== "ready") {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let pdfDoc: PDFDocumentProxy | null = null;
    let renderTask: RenderTask | null = null;

    setStatus("loading");

    void (async () => {
      try {
        const res = await fetch(templatePreviewUrl(template.id, template.preview), {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const buffer = await res.arrayBuffer();
        if (cancelled) return;

        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        const doc = await loadingTask.promise;
        if (cancelled) {
          void doc.destroy().catch(() => {});
          return;
        }
        loadingTask = null;
        pdfDoc = doc;

        const page = await doc.getPage(1);
        if (cancelled) {
          page.cleanup();
          return;
        }

        const canvas = canvasRef.current;
        if (!canvas) {
          page.cleanup();
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = 260;
        const scale = targetWidth / Math.max(1, baseViewport.width);
        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));

        renderTask = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        try {
          await renderTask.promise;
        } finally {
          renderTask = null;
          page.cleanup();
        }

        if (!cancelled) {
          setStatus("ready");
        }
      } catch (err: unknown) {
        if (cancelled || isPdfCancellationError(err)) return;
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
        renderTask = null;
      }
      if (loadingTask) {
        const t = loadingTask;
        loadingTask = null;
        void t.destroy().catch(() => {});
      }
      if (pdfDoc) {
        const d = pdfDoc;
        pdfDoc = null;
        void d.destroy().catch(() => {});
      }
    };
  }, [template.id, template.preview]);

  const wrapperClass = cls ? `template-thumb ${cls}` : "template-thumb";

  if (template.preview === "pending") {
    return (
      <div class={wrapperClass}>
        <div class="template-thumb-state">
          <span class="boot-spinner spinner-sm" />
          <span>Wird anonymisiert &amp; gerendert…</span>
        </div>
      </div>
    );
  }

  if (template.preview === "failed") {
    return (
      <div class={`${wrapperClass} is-failed`}>
        <div class="template-thumb-state">
          <AlertIcon size={18} />
          <span>Vorschau fehlgeschlagen</span>
        </div>
      </div>
    );
  }

  return (
    <div class={wrapperClass}>
      <canvas
        ref={canvasRef}
        class={`template-thumb-canvas${status === "ready" ? " is-visible" : ""}`}
      />
      {status === "loading" && (
        <div class="template-thumb-state template-thumb-overlay">
          <span class="boot-spinner spinner-sm" />
          <span>Lade Vorschau…</span>
        </div>
      )}
      {status === "error" && (
        <div class="template-thumb-state template-thumb-overlay">
          <FileIcon size={18} />
          <span>Keine Vorschau</span>
        </div>
      )}
    </div>
  );
}

export interface TemplatePreviewModalProps {
  template: Template;
  user: User;
  highlightPublish?: boolean;
  onClose: () => void;
  onUpdated: (updated: Template) => void;
  onDeleted: (deletedId: string) => void;
  onTogglePublic?: (tpl: Template) => Promise<Template | void>;
  onDeleteTemplate?: (id: string) => Promise<void>;
}

/** Full template preview modal: multi-page PDF rendering, anonymized file list, publish & delete controls. */
export function TemplatePreviewModal({
  template,
  user,
  highlightPublish = false,
  onClose,
  onUpdated,
  onDeleted,
  onTogglePublic,
  onDeleteTemplate,
}: TemplatePreviewModalProps) {
  const pagesHostRef = useRef<HTMLDivElement | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const activeRenderTasksRef = useRef<Set<RenderTask>>(new Set());
  const renderSeqRef = useRef(0);

  const [pdfState, setPdfState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  const [files, setFiles] = useState<TemplateFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  const [toggling, setToggling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const manageable = canManageTemplate(template, user);

  const cleanupPdf = useCallback(() => {
    renderSeqRef.current += 1;
    for (const task of activeRenderTasksRef.current) {
      try {
        task.cancel();
      } catch {
        // ignore
      }
    }
    activeRenderTasksRef.current.clear();
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      fetchAbortRef.current = null;
    }
    if (loadingTaskRef.current) {
      const t = loadingTaskRef.current;
      loadingTaskRef.current = null;
      void t.destroy().catch(() => {});
    }
    if (pdfDocRef.current) {
      const d = pdfDocRef.current;
      pdfDocRef.current = null;
      void d.destroy().catch(() => {});
    }
  }, []);

  useEffect(() => cleanupPdf, [cleanupPdf]);

  // Fetch anonymized file list
  useEffect(() => {
    let active = true;
    setFiles(null);
    setFilesError(null);
    listTemplateFiles(template.id)
      .then((list) => {
        if (active) setFiles(list);
      })
      .catch((err: unknown) => {
        if (active) setFilesError(errorText(err, "Dateiliste konnte nicht geladen werden."));
      });
    return () => {
      active = false;
    };
  }, [template.id]);

  // Fetch and render all PDF pages when preview is ready
  useEffect(() => {
    cleanupPdf();
    if (pagesHostRef.current) {
      pagesHostRef.current.replaceChildren();
    }
    setPageCount(0);
    setPdfError(null);

    if (template.preview !== "ready") {
      setPdfState("idle");
      return;
    }

    let cancelled = false;
    const seq = ++renderSeqRef.current;
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setPdfState("loading");

    void (async () => {
      try {
        const res = await fetch(templatePreviewUrl(template.id, template.preview), {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Vorschau-PDF konnte nicht geladen werden (HTTP ${res.status})`);
        }
        const buffer = await res.arrayBuffer();
        if (cancelled || seq !== renderSeqRef.current) return;

        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        loadingTaskRef.current = loadingTask;
        const doc = await loadingTask.promise;
        if (cancelled || seq !== renderSeqRef.current) {
          void doc.destroy().catch(() => {});
          return;
        }
        if (loadingTaskRef.current === loadingTask) {
          loadingTaskRef.current = null;
        }
        pdfDocRef.current = doc;
        setPageCount(doc.numPages);

        const host = pagesHostRef.current;
        if (!host) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetWidth = Math.max(280, Math.min(540, (host.clientWidth || 500) - 24));
        const wrappers: HTMLDivElement[] = [];

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
          if (cancelled || seq !== renderSeqRef.current) return;
          const page = await doc.getPage(pageNum);
          if (cancelled || seq !== renderSeqRef.current) {
            page.cleanup();
            return;
          }

          const baseViewport = page.getViewport({ scale: 1 });
          const scale = targetWidth / Math.max(1, baseViewport.width);
          const viewport = page.getViewport({ scale });

          const wrapper = document.createElement("div");
          wrapper.className = "template-modal-page";
          wrapper.style.width = `${Math.floor(viewport.width)}px`;
          wrapper.style.height = `${Math.floor(viewport.height)}px`;

          const canvas = document.createElement("canvas");
          canvas.className = "template-modal-canvas";
          canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
          canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          wrapper.appendChild(canvas);

          const renderTask = page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          });
          activeRenderTasksRef.current.add(renderTask);
          try {
            await renderTask.promise;
          } finally {
            activeRenderTasksRef.current.delete(renderTask);
            page.cleanup();
          }

          if (cancelled || seq !== renderSeqRef.current) return;
          wrappers.push(wrapper);
        }

        if (cancelled || seq !== renderSeqRef.current) return;
        host.replaceChildren(...wrappers);
        setPdfState("ready");
      } catch (err: unknown) {
        if (cancelled || seq !== renderSeqRef.current || isPdfCancellationError(err)) return;
        setPdfError(errorText(err, "PDF-Vorschau konnte nicht gerendert werden."));
        setPdfState("error");
      }
    })();

    return () => {
      cancelled = true;
      cleanupPdf();
    };
  }, [template.id, template.preview, cleanupPdf]);

  const togglePublic = async () => {
    setToggling(true);
    setActionError(null);
    try {
      if (onTogglePublic) {
        await onTogglePublic(template);
      } else {
        const updated = await updateTemplate(template.id, { public: !template.public });
        onUpdated(updated);
      }
    } catch (err: unknown) {
      setActionError(errorText(err, "Sichtbarkeit konnte nicht geändert werden."));
    } finally {
      setToggling(false);
    }
  };

  return (
    <Modal title={template.name} onClose={onClose} class="modal-wide">
      <div class="template-modal-stack">
        <div class="template-modal-meta">
          <div class="template-badges">
            {template.builtin ? (
              <span class="badge badge-parent">Eingebaut</span>
            ) : template.public ? (
              <span class="badge badge-admin">
                <GlobeIcon size={10} /> Öffentlich
              </span>
            ) : (
              <span class="badge badge-detached">
                <LockIcon size={10} /> Privat
              </span>
            )}
            <span class="badge badge-muted">{compilerBadgeLabel(template.compiler)}</span>
            <span class="badge badge-branch" title="Hauptdatei">
              {template.main_file}
            </span>
            {template.owner && <span class="muted-text">von {template.owner}</span>}
          </div>

          {manageable && (
            <div class="template-modal-actions">
              <button
                type="button"
                class={template.public ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
                disabled={toggling}
                onClick={() => void togglePublic()}
              >
                {template.public ? <LockIcon size={13} /> : <GlobeIcon size={13} />}
                <span>
                  {toggling
                    ? "Speichere…"
                    : template.public
                      ? "Auf privat setzen"
                      : "Veröffentlichen"}
                </span>
              </button>
              <button
                type="button"
                class="btn-danger btn-sm"
                disabled={toggling}
                onClick={() => setConfirmDelete(true)}
              >
                <TrashIcon size={13} />
                <span>Löschen</span>
              </button>
            </div>
          )}
        </div>

        {template.description && <p class="template-modal-desc">{template.description}</p>}

        {manageable && !template.public && (
          <div
            class={`alert ${highlightPublish && template.preview === "ready" ? "alert-success" : "alert-warn"} template-publish-banner`}
            role="status"
          >
            <EyeIcon size={16} />
            <div class="template-publish-banner-text">
              <strong>
                {template.preview === "pending"
                  ? "Wird anonymisiert & gerendert…"
                  : "Dieses Template ist aktuell privat."}
              </strong>{" "}
              <span>
                Prüfe die anonymisierten Dateien und die PDF-Vorschau. Veröffentlichen? Dann können
                alle angemeldeten Nutzer das Template beim Anlegen neuer Projekte verwenden.
              </span>
            </div>
            {template.preview === "ready" && (
              <button
                type="button"
                class="btn-primary btn-xs"
                disabled={toggling}
                onClick={() => void togglePublic()}
              >
                Veröffentlichen?
              </button>
            )}
          </div>
        )}

        {actionError && (
          <div class="alert alert-error" role="alert">
            <AlertIcon size={15} />
            <span>{actionError}</span>
          </div>
        )}

        <div class="template-modal-grid">
          <section class="template-modal-preview-col">
            <div class="template-section-head">
              <h3>PDF-Vorschau</h3>
              <span class="muted-text">
                {template.preview === "ready" && pageCount > 0
                  ? `${pageCount} ${pageCount === 1 ? "Seite" : "Seiten"}`
                  : previewStatusLabel(template.preview)}
              </span>
            </div>

            <div class="template-modal-pdf-scroller">
              {template.preview === "pending" && (
                <div class="template-modal-placeholder">
                  <span class="boot-spinner" />
                  <span>Wird anonymisiert &amp; gerendert…</span>
                </div>
              )}
              {template.preview === "failed" && (
                <div class="template-modal-placeholder is-failed">
                  <AlertIcon size={20} />
                  <span>
                    Die Vorschau konnte nicht kompiliert werden. Du kannst die Dateien prüfen oder
                    das Template trotzdem verwenden.
                  </span>
                </div>
              )}
              {template.preview === "ready" && pdfState === "loading" && (
                <div class="template-modal-placeholder">
                  <span class="boot-spinner" />
                  <span>Lade PDF-Vorschau…</span>
                </div>
              )}
              {template.preview === "ready" && pdfState === "error" && (
                <div class="template-modal-placeholder is-failed">
                  <AlertIcon size={20} />
                  <span>{pdfError ?? "Vorschau nicht verfügbar."}</span>
                </div>
              )}
              <div ref={pagesHostRef} class="template-modal-pages" />
            </div>
          </section>

          <section class="template-modal-files-col">
            <div class="template-section-head">
              <h3>Anonymisierte Dateien</h3>
              {files && (
                <span class="muted-text">
                  {files.length} {files.length === 1 ? "Datei" : "Dateien"}
                </span>
              )}
            </div>

            <div class="template-files-box">
              {files === null && !filesError && (
                <div class="muted-text template-files-empty">Lade Dateiliste…</div>
              )}
              {filesError && (
                <div class="alert alert-error" role="alert">
                  <AlertIcon size={14} />
                  <span>{filesError}</span>
                </div>
              )}
              {files && files.length === 0 && (
                <div class="muted-text template-files-empty">Keine Dateien gefunden.</div>
              )}
              {files && files.length > 0 && (
                <ul class="template-file-list">
                  {files.map((f) => (
                    <li key={f.path} class="template-file-row">
                      <span class="template-file-name mono" title={f.path}>
                        <FileIcon size={13} />
                        <span>{f.path}</span>
                      </span>
                      <span class="template-file-meta">
                        {f.path === template.main_file && (
                          <span class="badge badge-parent">Hauptdatei</span>
                        )}
                        <span class="mono-dim">{formatBytes(f.size)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Template löschen"
          message={
            <>
              <strong>{template.name}</strong> wird dauerhaft gelöscht. Bestehende Projekte, die
              daraus erstellt wurden, bleiben unberührt.
            </>
          }
          confirmLabel="Löschen"
          onConfirm={async () => {
            if (onDeleteTemplate) {
              await onDeleteTemplate(template.id);
            } else {
              await deleteTemplate(template.id);
              onDeleted(template.id);
            }
            onClose();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  );
}
