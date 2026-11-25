import { useEffect, useMemo, useState } from "preact/hooks";
import {
  type GitAccount,
  type ZoteroCollection,
  type ZoteroFormat,
  type ZoteroImportResult,
  type ZoteroLibrary,
  importZoteroBib,
  listAccounts,
  listZoteroCollections,
  listZoteroLibraries,
} from "../api";
import { accountLabel } from "../lib/accounts";
import {
  buildCollectionTree,
  flattenCollectionTree,
  formatZoteroError,
  validateBibTargetPath,
} from "../lib/zotero";
import { AlertIcon } from "./Icons";
import { Modal } from "./Modal";

interface ZoteroImportModalProps {
  existingPaths: Set<string>;
  defaultPath?: string;
  onImported: (result: ZoteroImportResult) => void | Promise<void>;
  onClose: () => void;
}

export function ZoteroImportModal({
  existingPaths,
  defaultPath = "references.bib",
  onImported,
  onClose,
}: ZoteroImportModalProps) {
  const [accounts, setAccounts] = useState<GitAccount[] | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [libraries, setLibraries] = useState<ZoteroLibrary[] | null>(null);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [library, setLibrary] = useState("");
  const [collections, setCollections] = useState<ZoteroCollection[] | null>(null);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionKey, setCollectionKey] = useState("");
  const [targetPath, setTargetPath] = useState(defaultPath);
  const [format, setFormat] = useState<ZoteroFormat>("biblatex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listAccounts()
      .then((all) => {
        if (!active) return;
        const zoteroAccounts = all.filter((a) => a.provider === "zotero");
        setAccounts(zoteroAccounts);
        setAccountId(zoteroAccounts[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setAccounts([]);
        setError(formatZoteroError(err, "Zotero-Konten konnten nicht geladen werden."));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (accountId === null) {
      setLibraries(null);
      setLibrary("");
      setCollections(null);
      setCollectionKey("");
      return;
    }
    let active = true;
    setLibrariesLoading(true);
    setLibraries(null);
    setLibrary("");
    setCollections(null);
    setCollectionKey("");
    setError(null);
    listZoteroLibraries(accountId)
      .then((libs) => {
        if (!active) return;
        setLibraries(libs);
        setLibrary(libs[0]?.library ?? "");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLibraries([]);
        setError(formatZoteroError(err, "Zotero-Bibliotheken konnten nicht geladen werden."));
      })
      .finally(() => {
        if (active) setLibrariesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId]);

  useEffect(() => {
    if (accountId === null || !library) {
      setCollections(null);
      setCollectionKey("");
      return;
    }
    let active = true;
    setCollectionsLoading(true);
    setCollections(null);
    setCollectionKey("");
    listZoteroCollections(accountId, library)
      .then((cols) => {
        if (!active) return;
        setCollections(cols);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setCollections([]);
        setError(formatZoteroError(err, "Zotero-Sammlungen konnten nicht geladen werden."));
      })
      .finally(() => {
        if (active) setCollectionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, library]);

  const flatCollections = useMemo(
    () => (collections ? flattenCollectionTree(buildCollectionTree(collections)) : []),
    [collections]
  );

  const pathValidation = useMemo(() => validateBibTargetPath(targetPath), [targetPath]);
  const willOverwrite = pathValidation.ok && existingPaths.has(pathValidation.path);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (accountId === null || !library) return;
    if (!pathValidation.ok) {
      setError(pathValidation.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await importZoteroBib({
        account_id: accountId,
        library,
        collection: collectionKey || null,
        path: pathValidation.path,
        format,
      });
      await onImported(result);
      onClose();
    } catch (err: unknown) {
      setError(formatZoteroError(err, "Import aus Zotero fehlgeschlagen."));
      setBusy(false);
    }
  };

  return (
    <Modal title="Aus Zotero importieren" onClose={onClose} busy={busy}>
      {accounts === null ? (
        <div class="muted-text">Lade Zotero-Konten…</div>
      ) : accounts.length === 0 ? (
        <div class="form-stack">
          <div class="alert alert-warn">
            <AlertIcon size={16} />
            <span>
              Noch kein Zotero-Konto verbunden. Öffne oben rechts dein <strong>Profil</strong>{" "}
              (Klick auf deinen Namen) → <strong>Verbundene Konten</strong>, um deinen
              Zotero-API-Key zu hinterlegen.
            </span>
          </div>
          {error && <div class="alert alert-error">{error}</div>}
          <div class="form-actions">
            <button type="button" class="btn-ghost btn-sm" onClick={onClose}>
              Schließen
            </button>
          </div>
        </div>
      ) : (
        <form class="form-stack" onSubmit={(e) => void submit(e)}>
          <label class="field">
            <span>Zotero-Konto</span>
            <select
              class="text-input"
              value={accountId ?? ""}
              disabled={busy || accounts.length === 1}
              onChange={(e) => setAccountId(Number((e.target as HTMLSelectElement).value))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
            </select>
          </label>

          <label class="field">
            <span>Bibliothek</span>
            <select
              class="text-input"
              required
              value={library}
              disabled={busy || librariesLoading || !libraries?.length}
              onChange={(e) => setLibrary((e.target as HTMLSelectElement).value)}
            >
              {librariesLoading ? (
                <option value="">Lade Bibliotheken…</option>
              ) : !libraries || libraries.length === 0 ? (
                <option value="">Keine Bibliotheken verfügbar</option>
              ) : (
                libraries.map((lib) => (
                  <option key={lib.library} value={lib.library}>
                    {lib.name} ({lib.library})
                  </option>
                ))
              )}
            </select>
          </label>

          <label class="field">
            <span>Sammlung</span>
            <select
              class="text-input"
              value={collectionKey}
              disabled={busy || !library || collectionsLoading}
              onChange={(e) => setCollectionKey((e.target as HTMLSelectElement).value)}
            >
              <option value="">
                {collectionsLoading ? "Lade Sammlungen…" : "Gesamte Bibliothek"}
              </option>
              {flatCollections.map((col) => (
                <option key={col.key} value={col.key}>
                  {col.label}
                </option>
              ))}
            </select>
          </label>

          <div class="field-row">
            <label class="field">
              <span>Zielpfad (.bib)</span>
              <input
                type="text"
                class="text-input"
                required
                placeholder="references.bib"
                value={targetPath}
                disabled={busy}
                onInput={(e) => {
                  setTargetPath((e.target as HTMLInputElement).value);
                  if (error) setError(null);
                }}
              />
            </label>
            <label class="field">
              <span>Format</span>
              <select
                class="text-input"
                value={format}
                disabled={busy}
                onChange={(e) => setFormat((e.target as HTMLSelectElement).value as ZoteroFormat)}
              >
                <option value="biblatex">BibLaTeX</option>
                <option value="bibtex">BibTeX</option>
              </select>
            </label>
          </div>

          {willOverwrite && (
            <span class="field-hint">
              Hinweis: <code>{pathValidation.path}</code> existiert bereits und wird durch den
              Import aktualisiert bzw. überschrieben.
            </span>
          )}

          {error && (
            <div class="alert alert-error" role="alert">
              <AlertIcon size={16} />
              <span>{error}</span>
            </div>
          )}

          <div class="form-actions">
            {busy && (
              <span class="muted-text busy-hint">
                <span class="boot-spinner spinner-sm" /> Importiere Einträge aus Zotero…
              </span>
            )}
            <button type="button" class="btn-ghost btn-sm" disabled={busy} onClick={onClose}>
              Abbrechen
            </button>
            <button
              type="submit"
              class="btn-primary btn-sm"
              disabled={busy || accountId === null || !library || librariesLoading}
            >
              {busy ? "Importiere…" : "Importieren"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
