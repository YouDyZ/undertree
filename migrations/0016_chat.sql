-- project chat (docs/API.md → Chat); not in the git repo. Soft delete: `deleted` rows keep their
-- id (the history has no holes) but lose body, file and line.
-- (0015 is reserved by another open MR: renumber on merge conflicts if needed)
CREATE TABLE chat_messages (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    author_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
    body        TEXT    NOT NULL,
    file        TEXT,                                  -- workspace-relative file the message points at
    line        INTEGER,                               -- 1-based, only with `file`
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at   TEXT,
    deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chat_messages_project ON chat_messages (project_id, id);
