//! Starter content of repos created by undertree (accounts.rs): `main.tex` (the built-in article
//! template, templates.rs), `.gitignore` and a CI pipeline building the main file's PDF with the
//! project's engine.

use crate::{accounts::Forge, compile::Engine};

pub const MAIN_TEX: &str = r"\documentclass{article}

\title{Untitled}
\author{}

\begin{document}
\maketitle

Hello, undertree!

\end{document}
";

const GITIGNORE: &str = "\
*.aux
*.bbl
*.bcf
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.run.xml
*.synctex.gz
*.toc
*.xdv
";

/// `.gitignore` for LaTeX build output, including the PDF of `main` (repo-relative `.tex`).
pub fn gitignore(main: &str) -> String {
    format!("{GITIGNORE}/{}\n", pdf_of(main))
}

pub fn pdf_of(main: &str) -> String {
    format!("{}.pdf", main.strip_suffix(".tex").unwrap_or(main))
}

/// A YAML scalar holding any string (JSON strings are YAML double-quoted scalars).
fn yaml(s: &str) -> String {
    serde_json::to_string(s).expect("strings serialize")
}

const GITHUB: &str = "\
name: LaTeX
on: [push, pull_request, workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: xu-cheng/latex-action@v3
        with:
          root_file: {MAIN}
          work_in_root_file_dir: true
{ENGINE}      - uses: actions/upload-artifact@v4
        with:
          name: pdf
          path: {PDF}
";

const GITLAB: &str = "\
build-pdf:
  image: texlive/texlive:latest
  script:
    - {SCRIPT}
  artifacts:
    paths:
      - {PDF}
";

/// (path, content) of the CI file for `forge`, building `main` (repo-relative `.tex`).
pub fn pipeline(forge: Forge, engine: Engine, main: &str) -> (&'static str, String) {
    let pdf = yaml(&pdf_of(main));
    match forge {
        Forge::Github => {
            let opt = match engine {
                Engine::Pdflatex => "",
                Engine::Xelatex => "          latexmk_use_xelatex: true\n",
                Engine::Lualatex => "          latexmk_use_lualatex: true\n",
            };
            let ci = GITHUB.replace("{ENGINE}", opt).replace("{PDF}", &pdf);
            (
                ".github/workflows/latex.yml",
                ci.replace("{MAIN}", &yaml(main)),
            )
        }
        Forge::Gitlab => {
            // -cd: a main file in a subdirectory finds its \input files and gets its PDF there
            let script = format!(
                "latexmk -cd {} -interaction=nonstopmode '{}'",
                engine.latexmk_flag(),
                main.replace('\'', r"'\''")
            );
            let ci = GITLAB.replace("{PDF}", &pdf);
            (".gitlab-ci.yml", ci.replace("{SCRIPT}", &yaml(&script)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipelines_use_the_engine() {
        let (path, gh) = pipeline(Forge::Github, Engine::Xelatex, "main.tex");
        assert_eq!(path, ".github/workflows/latex.yml");
        assert!(gh.contains("          root_file: \"main.tex\"\n          work_in_root_file_dir: true\n          latexmk_use_xelatex: true\n      - uses: actions/upload-artifact@v4"), "{gh}");
        assert!(gh.contains("path: \"main.pdf\""), "{gh}");
        let (_, gh) = pipeline(Forge::Github, Engine::Pdflatex, "main.tex");
        assert!(!gh.contains("latexmk_use") && !gh.contains("{E"), "{gh}");
        let (path, gl) = pipeline(Forge::Gitlab, Engine::Lualatex, "main.tex");
        assert_eq!(path, ".gitlab-ci.yml");
        assert!(
            gl.contains("- \"latexmk -cd -lualatex -interaction=nonstopmode 'main.tex'\""),
            "{gl}"
        );
        assert!(gl.contains("- \"main.pdf\""), "{gl}");
    }

    #[test]
    fn pipelines_quote_the_main_file() {
        let (_, gl) = pipeline(Forge::Gitlab, Engine::Pdflatex, "Kap/Max's \"A\".tex");
        let script = r#"- "latexmk -cd -pdf -interaction=nonstopmode 'Kap/Max'\\''s \"A\".tex'""#;
        assert!(gl.contains(script), "{gl}");
        assert!(gl.contains(r#"- "Kap/Max's \"A\".pdf""#), "{gl}");
        let (_, gh) = pipeline(Forge::Github, Engine::Pdflatex, "a b.tex");
        assert!(gh.contains("root_file: \"a b.tex\"") && gh.contains("path: \"a b.pdf\""));
        assert!(gitignore("thesis/Arbeit.tex").ends_with("*.xdv\n/thesis/Arbeit.pdf\n"));
    }
}
