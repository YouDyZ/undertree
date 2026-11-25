import { ApiError, type ZoteroCollection } from "../api";

export interface ZoteroCollectionNode {
  key: string;
  name: string;
  parent: string | null;
  children: ZoteroCollectionNode[];
}

export interface FlattenedZoteroCollection {
  key: string;
  name: string;
  depth: number;
  label: string;
}

export type BibTargetPathValidation =
  | { ok: true; path: string }
  | { ok: false; error: string };

export type ZoteroErrorContext = "connect" | "import" | "refresh" | "default";

function compareCollections(a: { name: string; key: string }, b: { name: string; key: string }): number {
  const byName = a.name.localeCompare(b.name, "de", { sensitivity: "base" });
  return byName !== 0 ? byName : a.key.localeCompare(b.key);
}

/**
 * Builds a deterministic hierarchical tree of Zotero collections from the flat API list.
 * Missing parents and cyclic parent references are safely promoted to root level.
 */
export function buildCollectionTree(collections: readonly ZoteroCollection[]): ZoteroCollectionNode[] {
  const byKey = new Map<string, ZoteroCollectionNode>();
  for (const item of collections) {
    if (!item.key || byKey.has(item.key)) continue;
    byKey.set(item.key, {
      key: item.key,
      name: item.name,
      parent: item.parent,
      children: [],
    });
  }

  const ordered = Array.from(byKey.values()).sort(compareCollections);
  const assignedParent = new Map<string, string | null>();
  const roots: ZoteroCollectionNode[] = [];

  const wouldCreateCycle = (nodeKey: string, candidateParentKey: string): boolean => {
    const visited = new Set<string>([nodeKey]);
    let curr: string | null | undefined = candidateParentKey;
    while (curr) {
      if (visited.has(curr)) return true;
      visited.add(curr);
      curr = assignedParent.get(curr);
    }
    return false;
  };

  for (const node of ordered) {
    const parentKey = node.parent;
    const parentNode = parentKey && parentKey !== node.key ? byKey.get(parentKey) : undefined;
    if (parentNode && !wouldCreateCycle(node.key, parentNode.key)) {
      assignedParent.set(node.key, parentNode.key);
      parentNode.children.push(node);
    } else {
      assignedParent.set(node.key, null);
      roots.push(node);
    }
  }

  const sortSubtree = (nodes: ZoteroCollectionNode[]): void => {
    nodes.sort(compareCollections);
    for (const n of nodes) {
      if (n.children.length > 0) sortSubtree(n.children);
    }
  };
  sortSubtree(roots);

  return roots;
}

/**
 * Flattens a collection tree in pre-order with indentation suitable for `<select>` options.
 */
export function flattenCollectionTree(
  nodes: readonly ZoteroCollectionNode[],
  depth = 0
): FlattenedZoteroCollection[] {
  const result: FlattenedZoteroCollection[] = [];
  for (const node of nodes) {
    const indent = "\u00A0\u00A0".repeat(depth);
    const prefix = depth > 0 ? "└ " : "";
    result.push({
      key: node.key,
      name: node.name,
      depth,
      label: `${indent}${prefix}${node.name}`,
    });
    if (node.children.length > 0) {
      result.push(...flattenCollectionTree(node.children, depth + 1));
    }
  }
  return result;
}

/**
 * Validates and normalizes a workspace-relative `.bib` target path.
 * Trims whitespace, requires `.bib` suffix, and rejects empty paths, leading `/`,
 * backslashes, NUL bytes, empty segments, `.`, and `..`.
 */
export function validateBibTargetPath(raw: string): BibTargetPathValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Bitte einen Zielpfad angeben (z. B. references.bib)." };
  }
  if (trimmed.startsWith("/")) {
    return {
      ok: false,
      error: "Der Zielpfad muss relativ zum Workspace sein (kein führendes „/“).",
    };
  }
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    return { ok: false, error: "Der Zielpfad enthält unzulässige Zeichen." };
  }
  const segments = trimmed.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === ".." || seg.toLowerCase() === ".git")) {
    return {
      ok: false,
      error: "Der Zielpfad darf keine leeren Segmente, „.“ oder „..“ enthalten.",
    };
  }
  if (!trimmed.toLowerCase().endsWith(".bib")) {
    return { ok: false, error: "Der Zielpfad muss auf „.bib“ enden." };
  }
  return { ok: true, path: trimmed };
}

/**
 * Translates Zotero API errors into clear German user-facing messages.
 */
export function formatZoteroError(
  err: unknown,
  fallback: string,
  context: ZoteroErrorContext = "default"
): string {
  if (err instanceof ApiError) {
    if (err.code === "zotero_forbidden") {
      return "Der Zotero-API-Key hat keine Berechtigung für diese Bibliothek oder Gruppe.";
    }
    if (err.code === "invalid_path") {
      return "Ungültiger Zielpfad im Workspace (kein führendes „/“ und kein „..“).";
    }
    if (err.status === 400 && err.code === "invalid_request") {
      if (context === "connect") {
        return "Der Zotero-API-Key ist ungültig oder wurde abgelehnt. Bitte Schlüssel auf zotero.org/settings/keys prüfen.";
      }
      return "Ungültiger Zotero-API-Key oder fehlerhafte Eingabe. Bitte Angaben prüfen.";
    }
    if (err.status === 413 || err.code === "too_large") {
      return "Die Zotero-Auswahl ist zu groß (maximal 20.000 Einträge oder 8 MiB erlaubt).";
    }
    if (err.status === 409 || err.code === "conflict") {
      return "Das verknüpfte Zotero-Konto wurde getrennt. Bitte die Datei über „Aus Zotero importieren“ neu verknüpfen.";
    }
    if (err.status === 502 || err.code === "remote_failed") {
      return "Zotero ist aktuell nicht erreichbar oder das Rate-Limit wurde erreicht. Bitte kurz warten und erneut versuchen.";
    }
    if (err.status === 404 || err.code === "not_found") {
      return "Zotero-Konto, Bibliothek, Sammlung oder Verknüpfung wurde nicht gefunden.";
    }
    if (err.status === 401) {
      return "Sitzung abgelaufen — bitte erneut anmelden.";
    }
    if (err.status === 403) {
      return "Keine Berechtigung für diese Zotero-Aktion.";
    }
    return err.message || fallback;
  }

  if (err instanceof TypeError) {
    return "Netzwerkfehler bei der Verbindung zu Zotero — bitte Internetverbindung prüfen.";
  }

  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    if (
      lower.includes("failed to fetch") ||
      lower.includes("networkerror") ||
      lower.includes("load failed") ||
      lower.includes("network")
    ) {
      return "Netzwerkfehler bei der Verbindung zu Zotero — bitte Internetverbindung prüfen.";
    }
    if (err.message) {
      return err.message;
    }
  }

  return fallback;
}

/**
 * Returns true only if the project-scoped response still matches the active
 * project ID and request generation.
 */
export function shouldApplyProjectScopedResult(
  requestProjectId: number,
  currentProjectId: number,
  requestGen: number,
  currentGen: number
): boolean {
  return requestProjectId === currentProjectId && requestGen === currentGen;
}

/**
 * Disables row-level Zotero refresh/unlink actions whenever any Zotero row
 * mutation is active globally, or when the row's account is disconnected.
 */
export function isZoteroRowControlDisabled(opts: {
  refreshingPath: string | null;
  unlinkingPath: string | null;
  disconnected?: boolean;
}): boolean {
  return Boolean(opts.refreshingPath || opts.unlinkingPath || opts.disconnected);
}

/**
 * Tooltip text for the Zotero badge: format, time of the last sync and the last sync error.
 */
export function zoteroLinkTitle(link: {
  format: string;
  last_synced_at: string | null;
  last_error: string | null;
}): string {
  const parts = [`Mit Zotero verknüpft (${link.format === "bibtex" ? "BibTeX" : "BibLaTeX"})`];
  if (link.last_synced_at) {
    const t = new Date(link.last_synced_at);
    if (!Number.isNaN(t.getTime())) parts.push(`zuletzt: ${t.toLocaleString("de-DE")}`);
  }
  if (link.last_error) parts.push(`Fehler: ${link.last_error}`);
  return parts.join(" — ");
}
