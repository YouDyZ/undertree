-- AUTOINCREMENT: ids of deleted projects are never reused (stale URLs/sockets can't hit a new project)
CREATE TABLE projects (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    remote_url    TEXT    NOT NULL,
    branch        TEXT    NOT NULL,
    owner_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    git_username  TEXT    NOT NULL DEFAULT 'oauth2',
    token_enc     BLOB,                                -- nonce || ChaCha20-Poly1305 ciphertext
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE project_members (
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, user_id)
);
