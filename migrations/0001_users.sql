CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL,
    email         TEXT    UNIQUE COLLATE NOCASE,
    github_id     INTEGER UNIQUE,                      -- linked on first GitHub login (#3)
    github_login  TEXT    UNIQUE COLLATE NOCASE,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
