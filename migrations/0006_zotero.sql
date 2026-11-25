-- no-transaction
-- Zotero accounts and linked .bib files (docs/API.md → Zotero).
-- user_accounts is rebuilt to widen its provider CHECK (SQLite can't alter constraints). Foreign
-- keys must be off meanwhile: dropping the old table would otherwise null projects.account_id.
PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE user_accounts_new (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider    TEXT    NOT NULL CHECK (provider IN ('github', 'gitlab', 'zotero')),
    base_url    TEXT    NOT NULL,                      -- https://github.com, the GitLab server, https://api.zotero.org
    login       TEXT    NOT NULL,                      -- username on that server
    token_enc   BLOB    NOT NULL,                      -- nonce || ChaCha20-Poly1305 ciphertext
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    remote_id   TEXT,                                  -- Zotero: numeric userID of the key
    UNIQUE (user_id, provider, base_url)
);
INSERT INTO user_accounts_new (id, user_id, provider, base_url, login, token_enc, created_at)
    SELECT id, user_id, provider, base_url, login, token_enc, created_at FROM user_accounts;
DROP TABLE user_accounts;
ALTER TABLE user_accounts_new RENAME TO user_accounts;

-- a .bib file in a project kept in sync with a Zotero library or collection
CREATE TABLE IF NOT EXISTS zotero_links (
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    path        TEXT    NOT NULL,                      -- workspace-relative .bib path
    account_id  INTEGER REFERENCES user_accounts (id) ON DELETE SET NULL,  -- NULL: disconnected
    library     TEXT    NOT NULL,                      -- user:<id> | group:<id>
    collection  TEXT,                                  -- collection key, NULL = whole library
    format      TEXT    NOT NULL CHECK (format IN ('biblatex', 'bibtex')),
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, path)
);

COMMIT;
PRAGMA foreign_keys = ON;
