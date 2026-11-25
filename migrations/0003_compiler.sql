-- TeX engine per project (docs/API.md → Projects): latexmk -pdf | -xelatex | -lualatex
ALTER TABLE projects ADD COLUMN compiler TEXT NOT NULL DEFAULT 'pdflatex'
    CHECK (compiler IN ('pdflatex', 'xelatex', 'lualatex'));
