-- comment threads anchored to a text range of a file (docs/API.md → Comments); not in the git repo
CREATE TABLE comment_threads (
    id           INTEGER PRIMARY KEY,
    project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    path         TEXT    NOT NULL,                     -- workspace-relative file
    start_pos    INTEGER NOT NULL,                     -- UTF-16 offsets as of the last flush
    end_pos      INTEGER NOT NULL,
    quote        TEXT    NOT NULL,                     -- the commented text, at most 1000 chars
    detached     INTEGER NOT NULL DEFAULT 0,           -- the text is gone
    resolved     INTEGER NOT NULL DEFAULT 0,
    resolved_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX comment_threads_path ON comment_threads (project_id, path);

CREATE TABLE comment_messages (
    id          INTEGER PRIMARY KEY,
    thread_id   INTEGER NOT NULL REFERENCES comment_threads (id) ON DELETE CASCADE,
    author      INTEGER REFERENCES users (id) ON DELETE SET NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at   TEXT
);
CREATE INDEX comment_messages_thread ON comment_messages (thread_id);
