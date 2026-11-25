import { ApiError } from "../api";

/** Displayed page at scale 1 (PDF points, after PDF.js applied `rotation`) and the CSS scale. */
export interface PageGeometry {
  scale: number;
  /** viewport rotation in degrees: 0, 90, 180 or 270 */
  rotation: number;
  width: number;
  height: number;
}

export interface PageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function normRotation(rotation: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Maps a point in unrotated page space (SyncTeX: points, top-left origin) to displayed points. */
function pageToDisplayPoint(x: number, y: number, g: PageGeometry): { u: number; v: number } {
  switch (normRotation(g.rotation)) {
    case 90:
      return { u: g.width - y, v: x };
    case 180:
      return { u: g.width - x, v: g.height - y };
    case 270:
      return { u: y, v: g.height - x };
    default:
      return { u: x, v: y };
  }
}

/**
 * CSS px offset inside a rendered page (origin top left) -> SyncTeX page coordinates
 * (PDF points, origin top left, unrotated page).
 */
export function displayToPagePoint(
  dx: number,
  dy: number,
  g: PageGeometry
): { x: number; y: number } {
  const u = dx / g.scale;
  const v = dy / g.scale;
  switch (normRotation(g.rotation)) {
    case 90:
      return { x: v, y: g.width - u };
    case 180:
      return { x: g.width - u, y: g.height - v };
    case 270:
      return { x: g.height - v, y: u };
    default:
      return { x: u, y: v };
  }
}

/** SyncTeX box (points, unrotated page) -> CSS rect inside the rendered page. */
export function pageBoxToCssRect(box: PageBox, g: PageGeometry): CssRect {
  const a = pageToDisplayPoint(box.x, box.y, g);
  const b = pageToDisplayPoint(box.x + box.w, box.y + box.h, g);
  return {
    left: Math.min(a.u, b.u) * g.scale,
    top: Math.min(a.v, b.v) * g.scale,
    width: Math.abs(b.u - a.u) * g.scale,
    height: Math.abs(b.v - a.v) * g.scale,
  };
}

export const NO_PDF_SYNC_HINT = "Noch kein PDF vorhanden: erst kompilieren.";

/**
 * What to do with a source -> PDF request: `ignore` (already consumed), `no_pdf` (nothing rendered
 * yet: hint for explicit requests, drop otherwise) or `run`.
 */
export function planSyncRequest(
  seq: number,
  lastSeq: number,
  pdfReady: boolean
): "ignore" | "no_pdf" | "run" {
  if (seq === lastSeq) return "ignore";
  return pdfReady ? "run" : "no_pdf";
}

/**
 * User-facing hint for a failed SyncTeX request, or `null` to stay silent.
 * `no_match` is silent (Overleaf-like); `no_synctex` is only shown for explicit requests.
 */
export function syncErrorHint(err: unknown, explicit: boolean): string | null {
  if (err instanceof ApiError) {
    if (err.code === "no_synctex") {
      return explicit ? "Keine SyncTeX-Daten: erst kompilieren." : null;
    }
    if (err.code === "no_match") return null;
  }
  return err instanceof Error && err.message ? err.message : "SyncTeX-Anfrage fehlgeschlagen.";
}
