-- compiler "auto" (docs/API.md → Projects): engine detected per root on every compile; `compiler`
-- then only keeps the last fixed engine
ALTER TABLE projects ADD COLUMN compiler_auto INTEGER NOT NULL DEFAULT 0;
