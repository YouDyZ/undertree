-- Zotero auto-sync (docs/API.md → Zotero): a background task keeps linked .bib files current.
ALTER TABLE zotero_links ADD COLUMN auto_sync INTEGER NOT NULL DEFAULT 1;
ALTER TABLE zotero_links ADD COLUMN library_version INTEGER;   -- Last-Modified-Version of the last export
ALTER TABLE zotero_links ADD COLUMN last_synced_at TEXT;       -- last successful check or import
ALTER TABLE zotero_links ADD COLUMN last_error TEXT;           -- of the last failed sync, NULL = ok
-- opt-in for links that exist already: hand-edited .bib files must not be overwritten after deploy
UPDATE zotero_links SET auto_sync = 0;
