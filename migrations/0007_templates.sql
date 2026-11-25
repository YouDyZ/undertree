-- project templates uploaded by admins (docs/API.md → Templates); files in $DATA/templates/{id}/,
-- built-ins are compiled into the binary and not stored here
CREATE TABLE templates (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    compiler    TEXT    NOT NULL CHECK (compiler IN ('pdflatex', 'xelatex', 'lualatex')),
    main_file   TEXT    NOT NULL,                      -- path in the template, e.g. "main.tex"
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
