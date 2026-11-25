-- Periodic conflict-free auto-commit & auto-push per project (docs/API.md → Git).
ALTER TABLE projects ADD COLUMN auto_push_interval_secs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN auto_push_message TEXT NOT NULL DEFAULT 'Auto-save: {files}';
ALTER TABLE projects ADD COLUMN auto_push_last_at TEXT;
ALTER TABLE projects ADD COLUMN auto_push_last_error TEXT;
