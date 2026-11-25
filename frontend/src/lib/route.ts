export type Route =
  | { name: "projects" }
  | { name: "templates" }
  | { name: "project"; pid: number }
  | { name: "project_pdf"; pid: number }
  | { name: "admin" }
  | { name: "login" }
  | { name: "not_found" };

/** `/` → projects, `/templates`, `/p/{pid}/pdf` → popout PDF, `/p/{pid}` (+ optional `/…`) → project, `/admin`, `/login`. */
export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "projects" };
  if (path === "/templates") return { name: "templates" };
  if (path === "/admin") return { name: "admin" };
  if (path === "/login") return { name: "login" };
  const pdfMatch = /^\/p\/([1-9]\d*)\/pdf$/.exec(path);
  if (pdfMatch) return { name: "project_pdf", pid: Number(pdfMatch[1]) };
  const m = /^\/p\/([1-9]\d*)(?:\/.*)?$/.exec(path);
  if (m) return { name: "project", pid: Number(m[1]) };
  return { name: "not_found" };
}

/** Builds the URL for the standalone PDF popout window (`/p/{pid}/pdf?root=...`). */
export function buildPdfPopoutUrl(pid: number, root?: string | null): string {
  const base = `/p/${pid}/pdf`;
  if (!root) return base;
  return `${base}?root=${encodeURIComponent(root)}`;
}

/** Extracts the non-empty `?root=` query parameter from a popout URL search string. */
export function parsePdfRootParam(search: string): string | null {
  const params = new URLSearchParams(search);
  const root = params.get("root")?.trim();
  return root ? root : null;
}

export function navigate(path: string, replace = false): void {
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** onClick for same-origin `<a href>`: client-side navigation unless the user wants a new tab. */
export function linkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  const href = (e.currentTarget as HTMLAnchorElement).getAttribute("href");
  if (!href) return;
  e.preventDefault();
  navigate(href);
}
