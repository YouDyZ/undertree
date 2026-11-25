-- Per-project Git commit author name and e-mail override per user (docs/API.md → Git).
CREATE TABLE project_commit_identities (
    project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    commit_name  TEXT,
    commit_email TEXT,
    PRIMARY KEY (project_id, user_id)
);
