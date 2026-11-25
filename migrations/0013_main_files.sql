-- main file(s) of the project (docs/API.md → Projects): JSON array of workspace-relative
-- paths, empty = automatic root resolution
ALTER TABLE projects ADD COLUMN main_files TEXT NOT NULL DEFAULT '[]';
