//! Project templates (docs/API.md → Templates): built-ins compiled into the binary, plus ZIPs
//! uploaded by users, anonymized (`anonymize.rs`) and extracted into `$DATA/templates/{id}/`
//! with a row in `templates`. The preview PDF lives next to it in `$DATA/templates/{id}.pdf`
//! (built-ins: `$DATA/templates/builtin-preview/`), outside the files copied into new repos.
//!
//! Invariants of an extracted template: only regular files and directories, every path relative
//! and inside the template, no `.git`, limits on entries, size and compression ratio.
//! Visibility: built-ins and public templates for everyone, private ones for their owner and
//! admins; an invisible template is indistinguishable from a missing one.

use std::{
    collections::HashSet,
    ffi::OsStr,
    io::{self, Cursor, ErrorKind, Read, Write},
    path::{Component, Path as FsPath, PathBuf},
    sync::Arc,
};

use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};

use axum::{
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{AuthSession, User},
    compile::Engine,
    error::ApiError,
    AppState,
};

/// Request body limit of the upload route.
pub const MAX_UPLOAD: usize = 25 << 20;
const MAX_ENTRIES: usize = 2000;
const MAX_TOTAL: u64 = 50 << 20;
/// entries bigger than this may not be compressed more than `MAX_RATIO`:1
const RATIO_MIN_SIZE: u64 = 1 << 20;
const MAX_RATIO: u64 = 100;
/// build output dropped from uploads (plus the main file's PDF)
const ARTIFACTS: &[&str] = &[
    ".aux",
    ".log",
    ".synctex.gz",
    ".fdb_latexmk",
    ".fls",
    ".out",
    ".toc",
    ".bbl",
    ".blg",
];

/// Keeps the log tail of a failed preview build (`$DATA/templates/{id}.log`).
const LOG_TAIL: usize = 8 << 10;
/// One preview build at a time: uploads can't pile up parallel TeX runs.
static BUILDS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Preview {
    Pending,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub compiler: Engine,
    pub main_file: String,
    pub builtin: bool,
    /// username of the uploader, `None` for built-ins (or a deleted user)
    pub owner: Option<String>,
    /// built-ins: always `ready` (built on the first preview request)
    pub preview: Preview,
    pub public: bool,
    #[serde(skip)]
    pub created_by: Option<i64>,
}

struct Builtin {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    files: &'static [(&'static str, &'static str)],
}

const BIB: &str = r"@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984},
}
";

const REPORT_MAIN: &str = r"\documentclass[11pt,a4paper]{report}

\usepackage[T1]{fontenc}
\usepackage[ngerman]{babel}
\usepackage{lmodern}
\usepackage{csquotes}
\usepackage{graphicx}
\usepackage[backend=biber,style=numeric]{biblatex}
\addbibresource{references.bib}
\usepackage{hyperref}

\title{Titel des Berichts}
\author{Autor}
\date{\today}

\begin{document}
\maketitle
\tableofcontents

\include{chapters/einleitung}

\printbibliography
\end{document}
";

const REPORT_INTRO: &str = r"\chapter{Einleitung}

Hier beginnt der Bericht \cite{knuth1984}.
";

const THESIS_MAIN: &str = r"\documentclass[12pt,a4paper,oneside,titlepage,bibliography=totoc]{scrreprt}

\usepackage[T1]{fontenc}
\usepackage[ngerman]{babel}
\usepackage{lmodern}
\usepackage{csquotes}
\usepackage{graphicx}
\graphicspath{{abbildungen/}}
\usepackage[backend=biber,style=authoryear]{biblatex}
\addbibresource{references.bib}
\usepackage{hyperref}

\begin{document}

\begin{titlepage}
  \centering
  {\Large Hochschule\par}
  \vspace{3cm}
  {\huge\bfseries Titel der Arbeit\par}
  \vspace{1cm}
  {\Large Bachelorarbeit\par}
  \vfill
  {\large Vorname Nachname\par}
  \vspace{0.5cm}
  {\large Betreuer: Prof.~Dr.~Name\par}
  \vspace{0.5cm}
  {\large \today\par}
\end{titlepage}

\tableofcontents

\include{kapitel/einleitung}
\include{kapitel/grundlagen}

\printbibliography
\end{document}
";

const THESIS_INTRO: &str = r"\chapter{Einleitung}

Motivation und Ziel der Arbeit.
";

const THESIS_BASICS: &str = r"\chapter{Grundlagen}

Grundlagen mit Literaturverweis \parencite{knuth1984}.
Abbildungen liegen in \texttt{abbildungen/} und werden mit
\verb|\includegraphics{name}| eingebunden.
";

const BUILTINS: &[Builtin] = &[
    Builtin {
        id: "builtin:article",
        name: "Leer (article)",
        description: "Leeres Dokument mit der Klasse article.",
        files: &[("main.tex", crate::ci::MAIN_TEX)],
    },
    Builtin {
        id: "builtin:report",
        name: "Bericht",
        description: "Klasse report mit Kapiteln in chapters/ und biblatex (references.bib).",
        files: &[
            ("main.tex", REPORT_MAIN),
            ("chapters/einleitung.tex", REPORT_INTRO),
            ("references.bib", BIB),
        ],
    },
    Builtin {
        id: "builtin:thesis",
        name: "Abschlussarbeit",
        description: "KOMA-Script scrreprt mit Titelseite, Kapiteln in kapitel/, \
                      biblatex/biber (references.bib) und Ordner abbildungen/.",
        files: &[
            ("main.tex", THESIS_MAIN),
            ("kapitel/einleitung.tex", THESIS_INTRO),
            ("kapitel/grundlagen.tex", THESIS_BASICS),
            ("references.bib", BIB),
            ("abbildungen/.gitkeep", ""),
        ],
    },
];

pub const DEFAULT: &str = "builtin:article";

impl Builtin {
    fn template(&self) -> Template {
        Template {
            id: self.id.into(),
            name: self.name.into(),
            description: self.description.into(),
            compiler: Engine::Pdflatex,
            main_file: "main.tex".into(),
            builtin: true,
            owner: None,
            preview: Preview::Ready,
            public: true,
            created_by: None,
        }
    }
}

fn dir(app: &AppState, id: &str) -> PathBuf {
    app.data.join("templates").join(id)
}

/// The preview PDF of `id`; its build log has the extension `.log`.
fn preview_path(app: &AppState, id: &str) -> PathBuf {
    let root = app.data.join("templates");
    match id.strip_prefix("builtin:") {
        Some(name) => root.join("builtin-preview").join(format!("{name}.pdf")),
        None => root.join(format!("{id}.pdf")),
    }
}

macro_rules! select {
    ($tail:literal) => {
        concat!(
            "SELECT t.id, t.name, t.description, t.compiler, t.main_file, 0 AS builtin,
                    u.username AS owner, t.preview, t.public, t.created_by
             FROM templates t LEFT JOIN users u ON u.id = t.created_by ",
            $tail
        )
    };
}

/// The template `id` if `user` may see it, else `None`.
pub async fn find(app: &AppState, id: &str, user: &User) -> Result<Option<Template>, ApiError> {
    if let Some(b) = BUILTINS.iter().find(|b| b.id == id) {
        return Ok(Some(b.template()));
    }
    sqlx::query_as(select!(
        "WHERE t.id = ? AND (t.public OR t.created_by = ? OR ?)"
    ))
    .bind(id)
    .bind(user.id)
    .bind(user.is_admin)
    .fetch_optional(&app.db)
    .await
    .map_err(ApiError::internal)
}

/// `find`, but missing → `404`.
async fn visible(app: &AppState, id: &str, user: &User) -> Result<Template, ApiError> {
    find(app, id, user)
        .await?
        .ok_or_else(|| ApiError::not_found("no such template"))
}

/// Changing or deleting `t`: its owner or an admin; built-ins nobody.
fn may_manage(t: &Template, user: &User) -> Result<(), ApiError> {
    if t.builtin {
        return Err(ApiError::bad_request(
            "built-in templates cannot be changed or deleted",
        ));
    }
    if t.created_by != Some(user.id) && !user.is_admin {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only its owner or an admin may change this template",
        ));
    }
    Ok(())
}

/// Writes the files of `t` into the directory `to`.
pub async fn copy_files(app: &AppState, t: &Template, to: &FsPath) -> Result<(), ApiError> {
    copy_files_with(app, t, to, true).await
}

/// Writes the files of `t` into `to` without overwriting any file that already exists, and
/// refuses any symlinks or `.git` path components inside `to`.
pub async fn copy_files_no_overwrite(
    app: &AppState,
    t: &Template,
    to: &FsPath,
) -> Result<(), ApiError> {
    copy_files_with(app, t, to, false).await
}

/// Writes `data` at `root/rel` without following or replacing symlinks, creating missing parent
/// directories inside `root`, and without overwriting an existing regular entry.
pub(crate) fn write_confined_no_overwrite(
    root: &FsPath,
    rel: &FsPath,
    data: &[u8],
) -> io::Result<()> {
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(seg) if seg != OsStr::new(".git") => parts.push(seg),
            _ => return Err(io::Error::new(ErrorKind::PermissionDenied, "unsafe path")),
        }
    }
    let Some((file, parents)) = parts.split_last() else {
        return Err(io::Error::new(ErrorKind::InvalidInput, "empty path"));
    };
    match std::fs::symlink_metadata(root) {
        Ok(m) if m.is_symlink() => {
            return Err(io::Error::new(ErrorKind::PermissionDenied, "symlink root"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => std::fs::create_dir_all(root)?,
        Err(e) => return Err(e),
    }
    let mut cur = Dir::open_ambient_dir(root, ambient_authority())?;
    for part in parents {
        match cur.symlink_metadata(part) {
            Ok(m) if m.is_symlink() => {
                return Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "symlink in path",
                ))
            }
            Ok(m) if m.is_dir() => {}
            Ok(_) => {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    "parent is not a directory",
                ))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => cur.create_dir(part)?,
            Err(e) => return Err(e),
        }
        cur = cur.open_dir(part)?;
    }
    match cur.symlink_metadata(file) {
        Ok(m) if m.is_symlink() => Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "symlink target",
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let mut f = cur.open_with(file, OpenOptions::new().write(true).create_new(true))?;
            f.write_all(data)
        }
        Err(e) => Err(e),
    }
}

fn map_confined_io(e: io::Error) -> ApiError {
    if e.kind() == ErrorKind::PermissionDenied || e.kind() == ErrorKind::AlreadyExists {
        ApiError::bad_request("repository contains unsafe symlinks or colliding paths")
    } else {
        ApiError::internal(e)
    }
}

async fn copy_files_with(
    app: &AppState,
    t: &Template,
    to: &FsPath,
    overwrite: bool,
) -> Result<(), ApiError> {
    if let Some(b) = BUILTINS.iter().find(|b| b.id == t.id) {
        let to_root = to.to_owned();
        if overwrite {
            for (path, content) in b.files {
                write(&to_root.join(path), content.as_bytes()).map_err(ApiError::internal)?;
            }
        } else {
            for (path, content) in b.files {
                write_confined_no_overwrite(&to_root, FsPath::new(path), content.as_bytes())
                    .map_err(map_confined_io)?;
            }
        }
        return Ok(());
    }
    let (from, to) = (dir(app, &t.id), to.to_owned());
    tokio::task::spawn_blocking(move || copy_tree_with(&from, &to, overwrite))
        .await
        .map_err(ApiError::internal)?
        .map_err(map_confined_io)
}

fn write(path: &FsPath, data: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(path.parent().expect("has parent"))?;
    std::fs::write(path, data)
}

fn copy_tree_with(from: &FsPath, to: &FsPath, overwrite: bool) -> std::io::Result<()> {
    fn walk(
        base_from: &FsPath,
        cur_from: &FsPath,
        to_root: &FsPath,
        overwrite: bool,
    ) -> io::Result<()> {
        for e in std::fs::read_dir(cur_from)? {
            let e = e?;
            let src = e.path();
            if e.file_type()?.is_dir() {
                walk(base_from, &src, to_root, overwrite)?;
            } else if overwrite {
                let rel = src.strip_prefix(base_from).map_err(io::Error::other)?;
                write(&to_root.join(rel), &std::fs::read(&src)?)?;
            } else {
                let rel = src.strip_prefix(base_from).map_err(io::Error::other)?;
                let data = std::fs::read(&src)?;
                write_confined_no_overwrite(to_root, rel, &data)?;
            }
        }
        Ok(())
    }
    if overwrite {
        std::fs::create_dir_all(to)?;
    }
    walk(from, from, to, overwrite)
}

pub async fn list(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
) -> Result<Json<Vec<Template>>, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let uploaded: Vec<Template> = sqlx::query_as(select!(
        "WHERE t.public OR t.created_by = ? OR ? ORDER BY t.name, t.id"
    ))
    .bind(user.id)
    .bind(user.is_admin)
    .fetch_all(&app.db)
    .await
    .map_err(ApiError::internal)?;
    let all = BUILTINS.iter().map(Builtin::template).chain(uploaded);
    Ok(Json(all.collect()))
}

fn bad(code: &'static str, msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, code, msg)
}

pub async fn upload(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    mut form: Multipart,
) -> Result<(StatusCode, Json<Template>), ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let (mut zip, mut name, mut description, mut compiler) = (None, None, String::new(), None);
    let read_err = |e: axum::extract::multipart::MultipartError| match e.status() {
        StatusCode::PAYLOAD_TOO_LARGE => bad(
            "too_large",
            format!("upload larger than {MAX_UPLOAD} bytes"),
        ),
        _ => ApiError::bad_request(e.body_text()),
    };
    while let Some(field) = form.next_field().await.map_err(read_err)? {
        match field.name().unwrap_or("") {
            "file" => zip = Some(field.bytes().await.map_err(read_err)?),
            "name" => name = Some(field.text().await.map_err(read_err)?),
            "description" => description = field.text().await.map_err(read_err)?,
            "compiler" => {
                let text = field.text().await.map_err(read_err)?;
                if !text.is_empty() {
                    let e = serde_json::from_value(serde_json::Value::String(text))
                        .map_err(|_| ApiError::bad_request("unknown compiler"))?;
                    compiler = Some(e);
                }
            }
            _ => {}
        }
    }
    let name = name.map(|n| n.trim().to_owned()).unwrap_or_default();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is empty"));
    }
    let zip = zip.ok_or_else(|| ApiError::bad_request("file is missing"))?;

    let id = crate::projects::random_hex();
    let root = app.data.join("templates");
    let tmp = root.join(format!(".upload-{id}"));
    let tree = {
        let tmp = tmp.clone();
        tokio::task::spawn_blocking(move || -> Result<Tree, ApiError> {
            let mut tree = extract(&zip)?;
            let files = std::mem::take(&mut tree.files);
            tree.files = crate::anonymize::anonymize(files, &tree.main_file);
            for (path, data) in &tree.files {
                write(&tmp.join(path), data).map_err(ApiError::internal)?;
            }
            Ok(tree)
        })
        .await
        .map_err(ApiError::internal)?
    };
    let installed = match tree {
        Ok(tree) => (tokio::fs::rename(&tmp, dir(&app, &id)).await)
            .map(|()| tree)
            .map_err(ApiError::internal),
        Err(e) => Err(e),
    };
    let tree = match installed {
        Ok(tree) => tree,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
            return Err(e);
        }
    };
    let t = Template {
        id,
        name,
        description: description.trim().to_owned(),
        compiler: compiler.unwrap_or(tree.compiler),
        main_file: tree.main_file,
        builtin: false,
        owner: Some(user.username.clone()),
        preview: Preview::Pending,
        public: false,
        created_by: Some(user.id),
    };
    let inserted = sqlx::query(
        "INSERT INTO templates (id, name, description, compiler, main_file, created_by)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&t.id)
    .bind(&t.name)
    .bind(&t.description)
    .bind(t.compiler)
    .bind(&t.main_file)
    .bind(user.id)
    .execute(&app.db)
    .await;
    if let Err(e) = inserted {
        // never listed without its row, so a failed cleanup only leaves unused files
        let _ = tokio::fs::remove_dir_all(dir(&app, &t.id)).await;
        return Err(ApiError::internal(e));
    }
    spawn_preview(app.clone(), t.clone());
    Ok((StatusCode::CREATED, Json(t)))
}

pub async fn delete(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    may_manage(&visible(&app, &id, &user).await?, &user)?;
    let deleted = sqlx::query("DELETE FROM templates WHERE id = ?")
        .bind(&id)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::not_found("no such template"));
    }
    if let Err(e) = tokio::fs::remove_dir_all(dir(&app, &id)).await {
        tracing::warn!("template {id}: removing its files: {e}");
    }
    remove_preview(&app, &id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_preview(app: &AppState, id: &str) {
    let pdf = preview_path(app, id);
    let _ = tokio::fs::remove_file(&pdf).await;
    let _ = tokio::fs::remove_file(pdf.with_extension("log")).await;
}

#[derive(Deserialize)]
pub struct PatchTemplate {
    public: Option<bool>,
    name: Option<String>,
    description: Option<String>,
}

pub async fn patch(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<String>,
    Json(b): Json<PatchTemplate>,
) -> Result<Json<Template>, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let mut t = visible(&app, &id, &user).await?;
    may_manage(&t, &user)?;
    if let Some(name) = b.name {
        t.name = name.trim().to_owned();
        if t.name.is_empty() {
            return Err(ApiError::bad_request("name is empty"));
        }
    }
    if let Some(d) = b.description {
        t.description = d.trim().to_owned();
    }
    t.public = b.public.unwrap_or(t.public);
    sqlx::query("UPDATE templates SET name = ?, description = ?, public = ? WHERE id = ?")
        .bind(&t.name)
        .bind(&t.description)
        .bind(t.public)
        .bind(&id)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(t))
}

fn preview_error(state: Preview) -> ApiError {
    match state {
        Preview::Pending => ApiError::new(
            StatusCode::NOT_FOUND,
            "preview_pending",
            "the preview is being built",
        ),
        _ => ApiError::new(
            StatusCode::NOT_FOUND,
            "preview_failed",
            "the preview could not be compiled",
        ),
    }
}

pub async fn preview_pdf(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let t = visible(&app, &id, &user).await?;
    let path = preview_path(&app, &id);
    if t.builtin {
        // built lazily, then cached; a failure is retried on the next request
        if let Err(log) = build_preview(&app, &t).await {
            keep_log(&path, &id, &log).await;
            return Err(preview_error(Preview::Failed));
        }
    } else if t.preview != Preview::Ready {
        return Err(preview_error(t.preview));
    }
    let pdf = tokio::fs::read(&path)
        .await
        .map_err(|_| preview_error(Preview::Failed))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/pdf"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        pdf,
    ))
}

#[derive(Serialize)]
pub struct FileInfo {
    path: String,
    size: u64,
}

pub async fn files(
    State(app): State<Arc<AppState>>,
    auth: AuthSession,
    Path(id): Path<String>,
) -> Result<Json<Vec<FileInfo>>, ApiError> {
    let user = auth.user().await.ok_or_else(ApiError::unauthorized)?;
    let t = visible(&app, &id, &user).await?;
    let mut files = match BUILTINS.iter().find(|b| b.id == t.id) {
        Some(b) => (b.files.iter())
            .map(|(path, content)| FileInfo {
                path: (*path).into(),
                size: content.len() as u64,
            })
            .collect(),
        None => {
            let root = dir(&app, &t.id);
            tokio::task::spawn_blocking(move || {
                let mut out = Vec::new();
                list_tree(&root, "", &mut out).map(|()| out)
            })
            .await
            .map_err(ApiError::internal)?
            .map_err(ApiError::internal)?
        }
    };
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Json(files))
}

fn list_tree(dir: &FsPath, rel: &str, out: &mut Vec<FileInfo>) -> std::io::Result<()> {
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        let path = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if e.file_type()?.is_dir() {
            list_tree(&e.path(), &path, out)?;
        } else {
            out.push(FileInfo {
                path,
                size: e.metadata()?.len(),
            });
        }
    }
    Ok(())
}

async fn keep_log(pdf: &FsPath, id: &str, log: &str) {
    let mut start = log.len().saturating_sub(LOG_TAIL);
    while !log.is_char_boundary(start) {
        start += 1;
    }
    let tail = &log[start..];
    tracing::warn!("template {id}: preview failed, log in {}", pdf.display());
    if let Err(e) = crate::workspace::write_atomic(&pdf.with_extension("log"), tail.as_bytes()) {
        tracing::warn!("template {id}: keeping the preview log: {e}");
    }
}

/// Compiles `t` with its engine in the compile sandbox into its preview PDF (a built-in only
/// once); `Err(log)` if no PDF came out. Like a project compile, errors don't matter as long as
/// there is a PDF.
async fn build_preview(app: &AppState, t: &Template) -> Result<(), String> {
    let _one = BUILDS.acquire().await.map_err(|e| e.to_string())?;
    let pdf = preview_path(app, &t.id);
    if t.builtin && pdf.is_file() {
        return Ok(());
    }
    let out =
        (app.data.join("templates")).join(format!(".preview-{}", crate::projects::random_hex()));
    let result = async {
        // the sandbox may only touch `out`, so the sources live inside it (like compile.rs)
        let source = out.join("source");
        copy_files(app, t, &source).await.map_err(|e| e.message)?;
        let main = FsPath::new(&t.main_file);
        let cwd = source.join(main.parent().unwrap_or(FsPath::new("")));
        let (from, to) = (cwd.clone(), out.clone());
        tokio::task::spawn_blocking(move || crate::compile::mirror_dirs(&from, &from, &to))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let file = main.file_name().ok_or("main file has no name")?;
        let (_, log) = crate::compile::latexmk(&cwd, file, &out, t.compiler).await?;
        let stem = main.file_stem().unwrap_or(file).to_string_lossy();
        match tokio::fs::read(out.join(format!("{stem}.pdf"))).await {
            Ok(data) if !data.is_empty() => {
                crate::workspace::write_atomic(&pdf, &data).map_err(|e| e.to_string())
            }
            _ => {
                let tex_log = tokio::fs::read(out.join(format!("{stem}.log")))
                    .await
                    .unwrap_or_default();
                Err(format!("{log}\n{}", String::from_utf8_lossy(&tex_log)))
            }
        }
    }
    .await;
    if let Err(e) = tokio::fs::remove_dir_all(&out).await {
        tracing::warn!("template {}: removing {}: {e}", t.id, out.display());
    }
    result
}

/// Builds the preview of the uploaded `t` in the background and records the outcome.
pub fn spawn_preview(app: Arc<AppState>, t: Template) {
    tokio::spawn(async move {
        let result = build_preview(&app, &t).await;
        let state = match &result {
            Ok(()) => Preview::Ready,
            Err(log) => {
                keep_log(&preview_path(&app, &t.id), &t.id, log).await;
                Preview::Failed
            }
        };
        let updated = sqlx::query("UPDATE templates SET preview = ? WHERE id = ?")
            .bind(state)
            .bind(&t.id)
            .execute(&app.db)
            .await;
        // deleted meanwhile: don't leave its preview behind
        if !matches!(updated, Ok(r) if r.rows_affected() > 0) {
            remove_preview(&app, &t.id).await;
        }
    });
}

/// Server start: builds the previews a restart interrupted (and of templates uploaded before
/// previews existed).
pub async fn resume_previews(app: Arc<AppState>) {
    let pending: Vec<Template> = match sqlx::query_as(select!("WHERE t.preview = 'pending'"))
        .fetch_all(&app.db)
        .await
    {
        Ok(p) => p,
        Err(e) => return tracing::warn!("pending template previews: {e}"),
    };
    for t in pending {
        spawn_preview(app.clone(), t);
    }
}

/// An uploaded ZIP after validation: files by relative path (`/`-separated).
#[derive(Debug)]
pub(crate) struct Tree {
    pub files: Vec<(String, Vec<u8>)>,
    pub main_file: String,
    pub compiler: Engine,
}

/// Relative path of entry `name` (trailing `/` of directories removed); unsafe → `Err`.
fn safe_path(name: &str) -> Result<String, ApiError> {
    let unsafe_path = || bad("unsafe_path", format!("unsafe path in ZIP: {name:?}"));
    let path = name.strip_suffix('/').unwrap_or(name);
    if path.starts_with('/') || path.contains('\\') || path.chars().any(char::is_control) {
        return Err(unsafe_path());
    }
    if path.split('/').any(|c| matches!(c, "" | "." | "..")) {
        return Err(unsafe_path());
    }
    Ok(path.to_owned())
}

/// Never extracted: macOS metadata and `.git` (would be the new repo's git dir).
fn ignored(path: &str) -> bool {
    path.split('/')
        .any(|c| c == "__MACOSX" || c == ".DS_Store" || c.eq_ignore_ascii_case(".git"))
        || ARTIFACTS.iter().any(|ext| path.ends_with(ext))
}

/// Characters that are pattern syntax where the main file's PDF path ends up (`.gitignore`, CI
/// artifact paths): rejected instead of escaped per syntax.
fn check_main_name(main: &str) -> Result<(), ApiError> {
    if main.contains(['*', '?', '[', ']', '!']) || main.starts_with('#') || main.trim() != main {
        return Err(bad(
            "unsafe_path",
            format!(
                "main file {main:?}: rename it without * ? [ ] !, a leading # \
                 or leading/trailing spaces"
            ),
        ));
    }
    Ok(())
}

pub(crate) fn extract(zip: &[u8]) -> Result<Tree, ApiError> {
    let invalid = |e: zip::result::ZipError| bad("invalid_zip", format!("not a valid ZIP: {e}"));
    let too_large = |what: &str| bad("too_large", format!("ZIP too large: {what}"));
    let mut ar = zip::ZipArchive::new(Cursor::new(zip)).map_err(invalid)?;
    if ar.len() > MAX_ENTRIES {
        return Err(too_large(&format!("more than {MAX_ENTRIES} entries")));
    }
    let (mut files, mut total) = (Vec::new(), 0u64);
    for i in 0..ar.len() {
        let mut f = ar.by_index(i).map_err(invalid)?;
        let name = f.name().map_err(invalid)?.into_owned();
        let path = safe_path(&name)?;
        // only regular files and directories (no symlinks, devices, FIFOs …)
        let kind = f.unix_mode().unwrap_or(0) & 0o170000;
        if f.is_symlink() || !matches!(kind, 0 | 0o100000 | 0o040000) {
            return Err(bad("unsafe_path", format!("not a regular file: {name:?}")));
        }
        if f.is_dir() || ignored(&path) {
            continue;
        }
        if f.size() > MAX_TOTAL - total {
            return Err(too_large(&format!(
                "more than {MAX_TOTAL} bytes uncompressed"
            )));
        }
        // the header's size is not trusted: read at most what is left of the budget
        let mut data = Vec::new();
        (&mut f)
            .take(MAX_TOTAL - total + 1)
            .read_to_end(&mut data)
            .map_err(|e| bad("invalid_zip", format!("{name}: {e}")))?;
        let size = data.len() as u64;
        total += size;
        if total > MAX_TOTAL {
            return Err(too_large(&format!(
                "more than {MAX_TOTAL} bytes uncompressed"
            )));
        }
        if size > RATIO_MIN_SIZE && size / f.compressed_size().max(1) > MAX_RATIO {
            return Err(too_large(&format!(
                "{name} is compressed more than {MAX_RATIO}:1"
            )));
        }
        files.push((path, data));
    }

    // a single top-level folder around everything is a wrapper
    let top = |p: &str| p.split_once('/').map(|(t, _)| t.to_owned());
    if let Some(Some(wrapper)) = files.first().map(|(p, _)| top(p)) {
        if files.iter().all(|(p, _)| top(p).as_ref() == Some(&wrapper)) {
            for (p, _) in &mut files {
                *p = p[wrapper.len() + 1..].to_owned();
            }
        }
    }
    let mut seen = HashSet::new();
    for (p, _) in &files {
        if !seen.insert(p.as_str()) {
            return Err(bad("invalid_zip", format!("duplicate entry {p:?}")));
        }
    }
    for (p, _) in &files {
        let mut parent = p.as_str();
        while let Some((dir, _)) = parent.rsplit_once('/') {
            if seen.contains(dir) {
                return Err(bad(
                    "invalid_zip",
                    format!("{dir:?} is a file and a folder"),
                ));
            }
            parent = dir;
        }
    }

    // main file: a root (detect.rs); shallowest, then main.tex, then alphabetic
    let sources = crate::detect::Sources::new(
        (files.iter())
            .filter(|(p, _)| p.ends_with(".tex"))
            .map(|(p, d)| (p.clone(), String::from_utf8_lossy(d).into_owned())),
    );
    let main_file = (sources.roots().into_iter())
        .min_by_key(|p| {
            let not_main = p.rsplit('/').next() != Some("main.tex");
            (p.matches('/').count(), not_main, *p)
        })
        .ok_or_else(|| {
            bad(
                "no_main_file",
                r"no .tex file with \begin{document} in the ZIP",
            )
        })?
        .to_owned();
    let (compiler, _) = sources.engine(&main_file);
    check_main_name(&main_file)?;
    let main_pdf = crate::ci::pdf_of(&main_file);
    files.retain(|(p, _)| *p != main_pdf);
    Ok(Tree {
        files,
        main_file,
        compiler,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// A ZIP of `(name, content)`; a name ending in `/` is a directory.
    pub fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            if name.ends_with('/') {
                w.add_directory(*name, SimpleFileOptions::default())
                    .unwrap();
            } else {
                w.start_file(*name, SimpleFileOptions::default()).unwrap();
                w.write_all(data).unwrap();
            }
        }
        w.finish().unwrap().into_inner()
    }

    const DOC: &[u8] = b"\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";

    fn code(r: Result<Tree, ApiError>) -> &'static str {
        r.map(|t| panic!("accepted: {t:?}")).unwrap_err().code
    }

    fn paths(t: &Tree) -> Vec<&str> {
        let mut p: Vec<_> = t.files.iter().map(|(p, _)| p.as_str()).collect();
        p.sort();
        p
    }

    #[test]
    fn rejects_unsafe_zips() {
        for name in [
            "../x.tex",
            "/etc/x.tex",
            "a/../../x",
            "a\\b.tex",
            "a\nb.tex",
            "./a.tex",
            "a//b",
        ] {
            let zip = zip_of(&[("main.tex", DOC), (name, b"x")]);
            assert_eq!(code(extract(&zip)), "unsafe_path", "{name:?}");
        }
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("main.tex", SimpleFileOptions::default())
            .unwrap();
        w.write_all(DOC).unwrap();
        w.add_symlink("link.tex", "/etc/passwd", SimpleFileOptions::default())
            .unwrap();
        assert_eq!(
            code(extract(&w.finish().unwrap().into_inner())),
            "unsafe_path"
        );
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let fifo = SimpleFileOptions::default().external_attributes(0o010644 << 16);
        w.start_file("fifo", fifo).unwrap();
        assert_eq!(
            code(extract(&w.finish().unwrap().into_inner())),
            "unsafe_path"
        );

        assert_eq!(code(extract(b"not a zip")), "invalid_zip");
        let zeros = vec![0u8; 2 << 20];
        let bomb = zip_of(&[("main.tex", DOC), ("zeros.bin", &zeros)]);
        assert_eq!(code(extract(&bomb)), "too_large");
        let many: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("f{i}.txt")).collect();
        let many: Vec<(&str, &[u8])> = many.iter().map(|n| (n.as_str(), &b"x"[..])).collect();
        assert_eq!(code(extract(&zip_of(&many))), "too_large");
        let clash = zip_of(&[("main.tex", DOC), ("a", b"x"), ("a/b", b"y")]);
        assert_eq!(code(extract(&clash)), "invalid_zip");
        assert_eq!(
            code(extract(&zip_of(&[("a.tex", b"\\documentclass{article}")]))),
            "no_main_file"
        );
        // \begin{document} only in a comment
        let commented = zip_of(&[("a.tex", b"% \\begin{document}\n")]);
        assert_eq!(code(extract(&commented)), "no_main_file");
        // pattern syntax in the main file's name (ends up in .gitignore / CI artifact paths)
        for main in ["a*.tex", "a?.tex", "[a].tex", "a!.tex", "#a.tex", " a.tex"] {
            let zip = zip_of(&[(main, DOC), ("x/b.bib", b"")]);
            let err = extract(&zip).unwrap_err();
            assert_eq!(err.code, "unsafe_path", "{main:?}");
            assert!(err.message.contains("main file"), "{}", err.message);
        }
    }

    #[test]
    fn comment_scanner() {
        let main = |doc: &[u8]| extract(&zip_of(&[("a.tex", doc)])).map(|t| t.main_file);
        let err = main(b"\\\\% \\begin{document}").unwrap_err();
        assert_eq!(err.code, "no_main_file");
        assert_eq!(main(b"\\verb|%|\\begin{document}").unwrap(), "a.tex");
    }

    #[test]
    fn strips_wrapper_and_junk() {
        let zip = zip_of(&[
            ("paper/", b""),
            ("paper/main.tex", DOC),
            ("paper/main.pdf", b"%PDF"),
            ("paper/main.aux", b""),
            ("paper/fig/a.pdf", b"%PDF"),
            ("paper/.git/config", b"[core]"),
            ("paper/.DS_Store", b""),
            ("__MACOSX/paper/._main.tex", b""),
        ]);
        let t = extract(&zip).unwrap();
        assert_eq!(paths(&t), ["fig/a.pdf", "main.tex"]);
        assert_eq!(t.main_file, "main.tex");
        // the PDF of main.tex.tex is main.tex.pdf, not main.pdf
        let zip = zip_of(&[
            ("main.tex.tex", DOC),
            ("main.pdf", b"%PDF"),
            ("main.tex.pdf", b"%PDF"),
        ]);
        assert_eq!(paths(&extract(&zip).unwrap()), ["main.pdf", "main.tex.tex"]);
        // two top-level folders: nothing stripped
        let zip = zip_of(&[("a/main.tex", DOC), ("b/x.tex", b"")]);
        assert_eq!(extract(&zip).unwrap().main_file, "a/main.tex");
        // a top-level file: nothing stripped
        let zip = zip_of(&[("a/main.tex", DOC), ("x.bib", b"")]);
        assert_eq!(paths(&extract(&zip).unwrap()), ["a/main.tex", "x.bib"]);
    }

    #[test]
    fn detects_main_file_and_compiler() {
        let main = |entries: &[(&str, &[u8])]| extract(&zip_of(entries)).unwrap().main_file;
        // preamble in an include has \documentclass but no \begin{document}
        let pre = b"\\documentclass{book}\n" as &[u8];
        let root = b"\\input{Header/Header}\n\\begin{document}\n\\end{document}" as &[u8];
        assert_eq!(
            main(&[("Arbeit.tex", root), ("Header/Header.tex", pre)]),
            "Arbeit.tex"
        );
        assert_eq!(
            main(&[("b.tex", DOC), ("main.tex", DOC), ("a.tex", DOC)]),
            "main.tex"
        );
        assert_eq!(main(&[("b.tex", DOC), ("a.tex", DOC)]), "a.tex");
        assert_eq!(
            main(&[("sub/main.tex", DOC), ("thesis.tex", DOC)]),
            "thesis.tex"
        );
        assert_eq!(
            main(&[("x/main.tex", DOC), ("x/a.tex", DOC), ("y/b.tex", DOC)]),
            "x/main.tex"
        );
        assert_eq!(main(&[("notmain.tex", DOC), ("z.tex", DOC)]), "notmain.tex");

        let engine = |pre: &str| {
            let doc = format!("{pre}\n{}", String::from_utf8_lossy(DOC));
            extract(&zip_of(&[("main.tex", doc.as_bytes())]))
                .unwrap()
                .compiler
        };
        assert_eq!(engine(""), Engine::Pdflatex);
        assert_eq!(engine(r"\usepackage{fontspec}"), Engine::Xelatex);
        assert_eq!(engine(r"\usepackage{polyglossia}"), Engine::Xelatex);
        assert_eq!(
            engine(r"\usepackage[math-style=ISO]{unicode-math}"),
            Engine::Xelatex
        );
        assert_eq!(engine(r"\usepackage{fontspec,luacode}"), Engine::Lualatex);
        assert_eq!(engine(r"\directlua{tex.print(1)}"), Engine::Lualatex);
        assert_eq!(engine(r"% \usepackage{fontspec}"), Engine::Pdflatex);
        assert_eq!(engine("% !TEX program = lualatex"), Engine::Lualatex);
        assert_eq!(
            engine("\\ifXeTeX\\usepackage{fontspec}\\fi"),
            Engine::Pdflatex
        );
        // packages loaded from an included preamble count too, other files don't
        let doc = b"\\input{pre}\n\\begin{document}\n\\end{document}\n";
        let zip = zip_of(&[("main.tex", doc), ("pre.tex", b"\\usepackage{fontspec}")]);
        assert_eq!(extract(&zip).unwrap().compiler, Engine::Xelatex);
        let zip = zip_of(&[("main.tex", DOC), ("pre.tex", b"\\usepackage{fontspec}")]);
        assert_eq!(extract(&zip).unwrap().compiler, Engine::Pdflatex);
    }

    /// The owner's real Overleaf exports; local only: `cargo test -- --ignored real_templates`.
    #[test]
    #[ignore]
    fn real_templates() {
        let downloads = FsPath::new("/home/blauer/Downloads");
        // engine conditionals only: fontspec/luacode in `\ifPDFTeX … \else … \fi` don't count
        let pdf = Some((Engine::Pdflatex, "default"));
        let want = [
            ("Bachelorarbeit_Lukas.zip", "Arbeit.tex", pdf),
            ("Vorlage_für_Belegarbeit", "vorlage.tex", None),
        ];
        for (prefix, main, engine) in want {
            let Some(zip) = std::fs::read_dir(downloads)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .find(|p| {
                    let n = p.file_name().unwrap().to_string_lossy();
                    n.starts_with(prefix) && n.ends_with(".zip")
                })
            else {
                eprintln!("skipping {prefix}: not present");
                continue;
            };
            let t = extract(&std::fs::read(&zip).unwrap()).unwrap();
            let sources = crate::detect::Sources::new(
                (t.files.iter())
                    .filter(|(p, _)| p.ends_with(".tex"))
                    .map(|(p, d)| (p.clone(), String::from_utf8_lossy(d).into_owned())),
            );
            let (detected, reason) = sources.engine(&t.main_file);
            eprintln!(
                "{}: main {} compiler {:?} ({reason}), {} files",
                zip.display(),
                t.main_file,
                t.compiler,
                t.files.len()
            );
            assert_eq!(t.main_file, main);
            assert_eq!(detected, t.compiler);
            if let Some((e, why)) = engine {
                assert_eq!((detected, reason.as_str()), (e, why));
            }
        }
    }
}
