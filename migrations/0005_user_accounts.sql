-- connected GitHub/GitLab accounts per user (docs/API.md → Accounts)
CREATE TABLE user_accounts (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider    TEXT    NOT NULL CHECK (provider IN ('github', 'gitlab')),
    base_url    TEXT    NOT NULL,                      -- https://github.com or the GitLab server
    login       TEXT    NOT NULL,                      -- username on that server
    token_enc   BLOB    NOT NULL,                      -- nonce || ChaCha20-Poly1305 ciphertext
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, provider, base_url)
);

-- projects whose remote repo undertree created: account used for API calls (invite) and the
-- provider's repo id ("owner/name" on GitHub, numeric project id on GitLab)
ALTER TABLE projects ADD COLUMN account_id INTEGER REFERENCES user_accounts (id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN remote_repo TEXT;
