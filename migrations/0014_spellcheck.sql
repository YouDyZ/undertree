-- spell check (docs/API.md → Spell check): words every member accepts, and LanguageTool rules the
-- project ignores (JSON array of rule ids)
CREATE TABLE project_dictionary (
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    word        TEXT    NOT NULL,
    added_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, word)
);
ALTER TABLE projects ADD COLUMN spellcheck_disabled_rules TEXT NOT NULL DEFAULT '[]';
