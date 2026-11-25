-- per-user override of the commit author e-mail (docs/API.md → Auth, Git)
ALTER TABLE users ADD COLUMN commit_email TEXT;
