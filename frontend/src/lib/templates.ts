import {
  ApiError,
  type Template,
  type TemplateCompiler,
  type TemplatePreviewState,
  type TexCompiler,
  type User,
  errorText,
} from "../api";

export const MAX_TEMPLATE_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_TEMPLATE_ID = "builtin:article";

const COMPILER_LABELS: Record<TexCompiler, string> = {
  auto: "Automatisch",
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};

const PREVIEW_LABELS: Record<TemplatePreviewState, string> = {
  pending: "Wird erstellt…",
  ready: "Vorschau bereit",
  failed: "Vorschau fehlgeschlagen",
};

/** Returns true if the user may edit visibility/metadata or delete the template. */
export function canManageTemplate(tpl: Template, user: User): boolean {
  return !tpl.builtin && (user.is_admin || tpl.owner === user.username);
}

/** Returns true while at least one template is still building its anonymized PDF preview. */
export function hasPendingPreviews(templates: readonly Template[]): boolean {
  return templates.some((t) => t.preview === "pending");
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Sorts templates according to GET /api/templates order: built-ins first
 * (preserving their relative order), then uploaded templates ordered by
 * UTF-16/binary code units (`ORDER BY t.name, t.id` semantics in SQLite).
 */
export function sortTemplates(templates: readonly Template[]): Template[] {
  const builtins: Template[] = [];
  const uploaded: Template[] = [];
  for (const tpl of templates) {
    if (tpl.builtin) {
      builtins.push(tpl);
    } else {
      uploaded.push(tpl);
    }
  }
  uploaded.sort(
    (a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id)
  );
  return [...builtins, ...uploaded];
}

/** Inserts or updates a template by `id` while preserving contract sort order. */
export function upsertTemplate(templates: readonly Template[], item: Template): Template[] {
  const next = templates.filter((t) => t.id !== item.id);
  next.push(item);
  return sortTemplates(next);
}

/** Returns true only when no newer mutation started or is still in flight. */
export function shouldApplyTemplatePoll(
  pollVersion: number,
  currentVersion: number,
  activeMutations: number
): boolean {
  return pollVersion === currentVersion && activeMutations === 0;
}

/** Picks the default template id (`builtin:article` if available, else the first entry). */
export function pickDefaultTemplateId(templates: readonly Template[]): string {
  const builtinArticle = templates.find((t) => t.id === DEFAULT_TEMPLATE_ID);
  if (builtinArticle) return builtinArticle.id;
  return templates[0]?.id ?? DEFAULT_TEMPLATE_ID;
}

/** Maps backend upload error codes into clear German messages for the UI. */
export function formatTemplateUploadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "too_large" || err.status === 413) {
      return "Die ZIP-Datei überschreitet das Größenlimit (max. 25 MB Upload, 50 MB entpackt, 2000 Einträge oder Verdacht auf ZIP-Bombe).";
    }
    switch (err.code) {
      case "invalid_zip":
        return "Ungültiges ZIP-Archiv: Die Datei konnte nicht entpackt werden (oder ein Pfad ist Datei und Ordner zugleich).";
      case "no_main_file":
        return "Keine Hauptdatei gefunden: Das Archiv muss mindestens eine .tex-Datei mit \\begin{document} enthalten.";
      case "unsafe_path":
        return "Unsicherer Pfad oder ungültiger Name der Hauptdatei (keine absoluten Pfade, .., Backslashes, Symlinks oder Sonderzeichen wie * ? [ ] ! #).";
      case "invalid_request":
        return err.message
          ? `Ungültige Anfrage: ${err.message}`
          : "Ungültige Anfrage. Bitte Name und ZIP-Datei prüfen.";
      default:
        break;
    }
  }
  return errorText(err, "Template konnte nicht hochgeladen werden.");
}

/** Validates template upload form inputs client-side before sending multipart data. */
export function validateTemplateUploadForm(input: {
  name: string;
  file: Pick<File, "name" | "size"> | null;
}): string | null {
  if (!input.name.trim()) {
    return "Bitte einen Namen für das Template angeben.";
  }
  if (!input.file) {
    return "Bitte eine .zip-Datei auswählen.";
  }
  if (!input.file.name.toLowerCase().endsWith(".zip")) {
    return "Nur .zip-Archive werden als Template unterstützt.";
  }
  if (input.file.size <= 0) {
    return "Die ausgewählte ZIP-Datei ist leer.";
  }
  if (input.file.size > MAX_TEMPLATE_UPLOAD_BYTES) {
    return "Die ZIP-Datei darf maximal 25 MB groß sein.";
  }
  return null;
}

/** Formats a byte count for display in file lists. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

/** Human-readable label for a LaTeX engine badge. */
export function compilerBadgeLabel(compiler: TemplateCompiler | TexCompiler): string {
  return COMPILER_LABELS[compiler] ?? compiler;
}

/** Human-readable label for a template preview build state. */
export function previewStatusLabel(preview: TemplatePreviewState): string {
  return PREVIEW_LABELS[preview] ?? preview;
}
