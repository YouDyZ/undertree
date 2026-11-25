//! LaTeX compile via `latexmk`, auto-recompile and log parsing (docs/API.md → LaTeX compile).
//!
//! Invariants:
//! - at most one run per root; requests during a run queue exactly one follow-up run
//! - build output lives in `$UNDERTREE_DATA/projects/{pid}/build/<root>/`, never in the working tree, so our own
//!   runs don't trigger the workspace watcher
//! - `GET /api/projects/{pid}/pdf` serves a copy taken after the last *successful* run (a failed run may leave a
//!   truncated PDF in the output dir)

use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    io::{self, ErrorKind, Read},
    path::{Component, Path as FsPath, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query,
    },
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;
use tower_sessions::cookie::time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{
    detect::{self, Sources},
    error::ApiError,
    events::Event,
    projects::{Project, ProjectCtx},
    workspace::{self, write_atomic, Workspace},
};

const TIMEOUT: Duration = Duration::from_secs(120);
const LAST_PDF: &str = "undertree-last.pdf";
/// Bounds of a scan for `.tex` sources (roots, root resolution, engine detection).
const SCAN_FILES: usize = 500;
const SCAN_BYTES: u64 = 20 << 20;
/// Directory entries the scan looks at (any kind), and how deep it descends.
const SCAN_ENTRIES: usize = 20_000;
const SCAN_DEPTH: usize = 16;

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CompileState {
    Queued,
    Running,
    Success,
    Failed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Badbox,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Diagnostic {
    pub severity: Severity,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompileResult {
    pub root: String,
    pub state: CompileState,
    pub started_at: String,
    pub duration_ms: u64,
    pub pdf_url: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    /// engine this run used, and why (`fixed` or a detection reason, see `detect`)
    pub engine: Engine,
    pub engine_reason: String,
}

struct Root {
    /// repo containing the root; changes anywhere in it trigger a recompile
    repo: String,
    running: bool,
    again: bool,
    /// the next run starts from an empty output dir (`POST …/compile` with `clean: true`)
    clean: bool,
    result: Option<CompileResult>,
    log: String,
    /// moved away while running: `run` drops the entry when it is done (see `roots_moved`)
    gone: bool,
}

pub struct Compiler {
    /// canonical `$UNDERTREE_DATA/projects/{pid}/build` (latexmk runs elsewhere, so it must be absolute)
    build: PathBuf,
    /// private scratch dir (word count snapshots), outside `build/` so no root can collide with
    /// it; emptied on load, which removes snapshots a crash left behind
    tmp: PathBuf,
    // ponytail: in-memory, a restart forgets results and known roots (PDFs on disk survive)
    roots: Mutex<HashMap<String, Root>>,
    /// project setting, kept in sync with `projects.compiler(_auto)` on load and PATCH
    pub setting: Mutex<Setting>,
    /// `projects.main_files`, kept in sync on load and PATCH
    pub main_files: Mutex<Vec<String>>,
    /// bounds the concurrent runs of one project (many main files recompile on every save)
    slots: tokio::sync::Semaphore,
}

const MAX_PARALLEL_RUNS: usize = 2;

impl Compiler {
    pub fn new(project_dir: &FsPath) -> std::io::Result<Self> {
        let build = project_dir.join("build");
        std::fs::create_dir_all(&build)?;
        let tmp = project_dir.join("tmp");
        match std::fs::remove_dir_all(&tmp) {
            Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        std::fs::create_dir_all(&tmp)?;
        Ok(Self {
            build: build.canonicalize()?,
            tmp: tmp.canonicalize()?,
            roots: Mutex::default(),
            setting: Mutex::default(),
            main_files: Mutex::default(),
            slots: tokio::sync::Semaphore::new(MAX_PARALLEL_RUNS),
        })
    }

    /// Build layout of (validated) `root`: output dir (a run's snapshot is its `source/`), the
    /// workspace dir that snapshot copies, and the root's file stem.
    fn layout(&self, root: &str) -> (PathBuf, String, String) {
        let path = FsPath::new(root);
        let source_rel = (path.parent().unwrap_or_else(|| FsPath::new("")))
            .to_string_lossy()
            .replace('\\', "/");
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        (self.build.join(root), source_rel, stem.into_owned())
    }
}

/// Creates every directory below `dir` (relative to `base`) inside `out`.
pub fn mirror_dirs(base: &FsPath, dir: &FsPath, out: &FsPath) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let path = entry.path();
            let rel = path.strip_prefix(base).map_err(io::Error::other)?;
            std::fs::create_dir_all(out.join(rel))?;
            mirror_dirs(base, &path, out)?;
        }
    }
    Ok(())
}

fn copy_source_tree(source: &Dir, destination: &FsPath) -> io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("compile snapshot has no parent"))?;
    let name = destination
        .file_name()
        .ok_or_else(|| io::Error::other("compile snapshot has no name"))?;
    std::fs::create_dir_all(parent)?;
    let parent = Dir::open_ambient_dir(parent, ambient_authority())?;
    match parent.symlink_metadata(name) {
        Ok(metadata) if metadata.is_dir() => parent.remove_dir_all(name)?,
        Ok(_) => parent.remove_file(name)?,
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    parent.create_dir(name)?;
    let destination = parent.open_dir(name)?;
    copy_directory_contents(source, &destination)
}

fn copy_directory_contents(source: &Dir, destination: &Dir) -> io::Result<()> {
    for entry in source.read_dir(".")? {
        let entry = entry?;
        let name = entry.file_name();
        if name == OsStr::new(".git") {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                format!("source tree contains a symlink: {}", name.to_string_lossy()),
            ));
        }
        if kind.is_dir() {
            destination.create_dir(&name)?;
            let source_child = entry.open_dir()?;
            let destination_child = destination.open_dir(&name)?;
            copy_directory_contents(&source_child, &destination_child)?;
        } else if kind.is_file() {
            let mut input = entry.open()?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let mut output = destination.open_with(&name, &options)?;
            io::copy(&mut input, &mut output)?;
            output.sync_all()?;
        } else {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                format!("unsupported source entry: {}", name.to_string_lossy()),
            ));
        }
    }
    Ok(())
}

/// Queues a run of the (validated) `root`; `clean` empties its output dir first.
fn request(app: &Arc<Project>, root: &str, repo: &str, clean: bool) {
    {
        let mut roots = app.compiler.roots.lock().unwrap();
        let r = roots.entry(root.to_owned()).or_insert_with(|| Root {
            repo: repo.to_owned(),
            running: false,
            again: false,
            clean: false,
            result: None,
            log: String::new(),
            gone: false,
        });
        r.clean |= clean;
        if !r.running {
            r.running = true;
            tokio::spawn(run(app.clone(), root.to_owned()));
        } else if !r.again {
            r.again = true;
        } else {
            return; // follow-up already queued
        }
    }
    let _ = app.events.send(Event::Compile {
        root: root.to_owned(),
        state: CompileState::Queued,
        result: None,
    });
}

/// Makes the main files known roots (without compiling), so `changed` recompiles them after a
/// flush even if they were never compiled in this server run.
pub async fn seed_main_files(app: Arc<Project>) {
    let mains = app.compiler.main_files.lock().unwrap().clone();
    if mains.is_empty() {
        return;
    }
    let repos = app.workspace.repos().await;
    let mut roots = app.compiler.roots.lock().unwrap();
    for m in mains {
        let repo = workspace::repo_of(&repos, &m);
        roots.entry(m).or_insert_with(|| Root {
            repo,
            running: false,
            again: false,
            clean: false,
            result: None,
            log: String::new(),
            gone: false,
        });
    }
}

/// `from` was moved to `to`: known roots at or below it follow. A running compile keeps its old
/// name until it is done (then `run` drops it), the new name starts fresh.
pub fn roots_moved(app: &Project, from: &str, to: &str) {
    moved_in(&mut app.compiler.roots.lock().unwrap(), from, to);
}

fn moved_in(roots: &mut HashMap<String, Root>, from: &str, to: &str) {
    let moved: Vec<String> = (roots.iter())
        .filter(|(p, r)| !r.gone && workspace::is_within(p, from))
        .map(|(p, _)| p.clone())
        .collect();
    for old in moved {
        let Some(r) = roots.get_mut(&old) else {
            continue;
        };
        let fresh = Root {
            repo: r.repo.clone(),
            running: false,
            again: false,
            clean: false,
            result: None,
            log: String::new(),
            gone: false,
        };
        if r.running {
            r.gone = true;
            r.again = false;
        } else {
            roots.remove(&old);
        }
        let target = crate::moves::map_path(&old, from, to);
        match roots.get_mut(&target) {
            // a moved-back name whose old compile still runs: keep that entry (`run` owns it),
            // queue a follow-up run for the new content instead of replacing it
            Some(t) if t.running => {
                t.gone = false;
                t.again = true;
            }
            _ => {
                roots.insert(target, fresh);
            }
        }
    }
}

/// Workspace file `rel` changed on disk: recompile every known root in the same repo.
pub fn changed(app: &Arc<Project>, rel: &str) {
    let hits: Vec<(String, String)> = {
        let roots = app.compiler.roots.lock().unwrap();
        roots
            .iter()
            .filter(|(_, r)| !r.gone && workspace::is_within(rel, &r.repo))
            .map(|(root, r)| (root.clone(), r.repo.clone()))
            .collect()
    };
    for (root, repo) in hits {
        request(app, &root, &repo, false);
    }
}

async fn run(app: Arc<Project>, root: String) {
    loop {
        // held until the run is over; never closed
        let _slot = app
            .compiler
            .slots
            .acquire()
            .await
            .expect("semaphore is open");
        let _ = app.events.send(Event::Compile {
            root: root.clone(),
            state: CompileState::Running,
            result: None,
        });
        let clean = {
            let mut roots = app.compiler.roots.lock().unwrap();
            let r = roots
                .get_mut(&root)
                .expect("only `run` removes a running root");
            std::mem::take(&mut r.clean)
        };
        let (result, log) = compile(&app, &root, clean).await;
        let again = finish(
            &mut app.compiler.roots.lock().unwrap(),
            &root,
            result.clone(),
            log,
        );
        let _ = app.events.send(Event::Compile {
            root: root.clone(),
            state: result.state,
            result: Some(result),
        });
        if !again {
            return;
        }
    }
}

/// A run of `root` is over: stores the result; `true` = run again. A root that was moved away
/// meanwhile (`gone`) is dropped and never runs again, even if a request queued a follow-up.
fn finish(
    roots: &mut HashMap<String, Root>,
    root: &str,
    result: CompileResult,
    log: String,
) -> bool {
    let r = roots
        .get_mut(root)
        .expect("only `finish` removes a running root");
    r.result = Some(result);
    r.log = log;
    r.running = r.again;
    let again = std::mem::take(&mut r.again);
    if r.gone {
        roots.remove(root);
        return false;
    }
    again
}

fn unix_ms(t: SystemTime) -> u128 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

async fn compile(app: &Project, root: &str, clean: bool) -> (CompileResult, String) {
    let started = SystemTime::now();
    let t0 = Instant::now();
    let name = FsPath::new(root).file_name().expect("root is a file");
    let (out, source_rel, stem) = app.compiler.layout(root);
    let snapshot = out.join("source");
    let log_path = out.join(format!("{stem}.log"));

    // "recompile from scratch": nothing of earlier runs (aux, bbl, fdb, last PDF) survives
    if clean {
        if let Err(e) = tokio::fs::remove_dir_all(&out).await {
            if e.kind() != ErrorKind::NotFound {
                tracing::warn!("{root}: could not clean build dir: {e}");
            }
        }
    }
    // a run that fails before writing them must not leave the previous run's log or SyncTeX data
    for old in [log_path.clone(), out.join(format!("{stem}.synctex.gz"))] {
        if let Err(e) = tokio::fs::remove_file(&old).await {
            if e.kind() != ErrorKind::NotFound {
                tracing::warn!("{root}: could not remove {}: {e}", old.display());
            }
        }
    }

    let setting = *app.compiler.setting.lock().unwrap();
    let (mut engine, mut engine_reason) = match setting {
        Setting::Fixed(e) => (e, "fixed".to_owned()),
        Setting::Auto => (Engine::Pdflatex, "default".to_owned()),
    };
    let run = match app.workspace.open_dir(&source_rel) {
        Ok(source) => {
            let destination = snapshot.clone();
            let out_dirs = out.clone();
            let file = name.to_string_lossy().into_owned();
            let prepare = move || -> io::Result<Option<(Engine, String)>> {
                copy_source_tree(&source, &destination)?;
                // `\include{chapters/a}` writes `chapters/a.aux` into -outdir; TeX can't create dirs
                mirror_dirs(&destination, &destination, &out_dirs)?;
                if setting != Setting::Auto {
                    return Ok(None);
                }
                // on the snapshot: exactly what latexmk gets to see
                let snapshot = Dir::open_ambient_dir(&destination, ambient_authority())?;
                let sources = Sources::new(scan_tex(&snapshot, "", &|_| false));
                Ok(Some(sources.engine(&file)))
            };
            match tokio::task::spawn_blocking(prepare).await {
                Ok(Ok(detected)) => {
                    if let Some(d) = detected {
                        (engine, engine_reason) = d;
                    }
                    latexmk(&snapshot, name, &out, engine).await
                }
                Ok(Err(e)) => Err(format!("compile source rejected: {e}")),
                Err(e) => Err(format!("compile source snapshot failed: {e}")),
            }
        }
        Err(e) => Err(format!("compile source unavailable: {e}")),
    };
    let tex_log = tokio::fs::read(&log_path)
        .await
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let mut diagnostics = parse_log(&tex_log, &snapshot, &snapshot);
    for diagnostic in &mut diagnostics {
        if let Some(file) = &diagnostic.file {
            diagnostic.file = Some(workspace_path(&source_rel, file));
        }
    }
    let (ok, output) = match run {
        Ok(r) => r,
        Err(msg) => {
            diagnostics.insert(0, error(&msg));
            (false, msg)
        }
    };
    if !ok && !diagnostics.iter().any(|d| d.severity == Severity::Error) {
        diagnostics.insert(0, error("latexmk failed, see the log"));
    }

    // like Overleaf: a run with errors still shows the PDF it produced (only if written by this run)
    let mut pdf_url = None;
    let pdf_path = out.join(format!("{stem}.pdf"));
    let fresh = tokio::fs::metadata(&pdf_path)
        .await
        .and_then(|m| m.modified())
        .is_ok_and(|t| t >= started);
    if fresh {
        let copied = match tokio::fs::read(&pdf_path).await {
            Ok(pdf) => write_atomic(&out.join(LAST_PDF), &pdf),
            Err(e) => Err(e),
        };
        match copied {
            // ponytail: root paths with `#`/`?` would need percent-encoding here
            Ok(()) => {
                pdf_url = Some(format!(
                    "/api/projects/{}/pdf/{root}?v={}",
                    app.id,
                    unix_ms(SystemTime::now())
                ))
            }
            Err(e) => tracing::warn!("{root}: could not publish PDF: {e}"),
        }
    } else if ok {
        tracing::warn!("{root}: no PDF after successful run");
    }

    if let Err(e) = tokio::fs::remove_dir_all(&snapshot).await {
        if e.kind() != ErrorKind::NotFound {
            tracing::warn!("{root}: could not remove compile source snapshot: {e}");
        }
    }

    let result = CompileResult {
        root: root.to_owned(),
        state: if ok {
            CompileState::Success
        } else {
            CompileState::Failed
        },
        started_at: OffsetDateTime::from(started)
            .format(&Rfc3339)
            .unwrap_or_default(),
        duration_ms: t0.elapsed().as_millis() as u64,
        pdf_url,
        diagnostics,
        engine,
        engine_reason,
    };
    (
        result,
        format!("{output}\n===== {stem}.log =====\n{tex_log}"),
    )
}

fn error(msg: &str) -> Diagnostic {
    Diagnostic {
        severity: Severity::Error,
        file: None,
        line: None,
        message: msg.to_owned(),
    }
}

/// TeX engine of a project (docs/API.md → Projects, `compiler`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Pdflatex,
    Xelatex,
    Lualatex,
}

/// A project's `compiler`: `auto` (detected per root and run, see `detect`) or a fixed engine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Setting {
    #[default]
    Auto,
    #[serde(untagged)]
    Fixed(Engine),
}

impl Setting {
    pub fn fixed(self) -> Option<Engine> {
        match self {
            Setting::Auto => None,
            Setting::Fixed(e) => Some(e),
        }
    }

    /// From the columns `projects.compiler`, `projects.compiler_auto`.
    pub fn of(engine: Engine, auto: bool) -> Self {
        if auto {
            Setting::Auto
        } else {
            Setting::Fixed(engine)
        }
    }
}

/// `"auto"` or an engine name (for `#[sqlx(try_from = "String")]`).
impl TryFrom<String> for Setting {
    type Error = serde_json::Error;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        serde_json::from_value(Value::String(s))
    }
}

impl Engine {
    pub fn latexmk_flag(self) -> &'static str {
        match self {
            Engine::Pdflatex => "-pdf",
            Engine::Xelatex => "-xelatex",
            Engine::Lualatex => "-lualatex",
        }
    }
}

/// `.tex` files below `dir` as `(prefix/path, text)`, skipping hidden entries, symlinks, build
/// folders and directories for which `skip(path)` holds; reads at most `SCAN_FILES` files and
/// `SCAN_BYTES` bytes, looks at most at `SCAN_ENTRIES` entries and `SCAN_DEPTH` levels deep.
// ponytail: beyond the caps the scan is partial (roots may be missing), raise them if real repos
// hit them
fn scan_tex(dir: &Dir, prefix: &str, skip: &dyn Fn(&str) -> bool) -> Vec<(String, String)> {
    scan_tex_limited(dir, prefix, skip, SCAN_ENTRIES, SCAN_DEPTH)
}

fn scan_tex_limited(
    dir: &Dir,
    prefix: &str,
    skip: &dyn Fn(&str) -> bool,
    entries: usize,
    depth: usize,
) -> Vec<(String, String)> {
    struct Budget {
        bytes: u64,
        entries: usize,
    }
    fn walk(
        dir: &Dir,
        rel: &str,
        depth: usize,
        skip: &dyn Fn(&str) -> bool,
        out: &mut Vec<(String, String)>,
        budget: &mut Budget,
    ) {
        let Ok(list) = dir.entries() else { return };
        for e in list.flatten() {
            if out.len() >= SCAN_FILES || budget.bytes == 0 || budget.entries == 0 {
                return;
            }
            budget.entries -= 1;
            let Ok(name) = e.file_name().into_string() else {
                continue;
            };
            let Ok(kind) = e.file_type() else { continue };
            if name.starts_with('.') || matches!(name.as_str(), "build" | "out" | "node_modules") {
                continue;
            }
            let path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if kind.is_dir() && depth > 0 && !skip(&path) {
                if let Ok(sub) = e.open_dir() {
                    walk(&sub, &path, depth - 1, skip, out, budget);
                }
            } else if kind.is_file() && name.ends_with(".tex") {
                let mut data = Vec::new();
                let Ok(f) = e.open() else { continue };
                if f.take(budget.bytes).read_to_end(&mut data).is_ok() {
                    budget.bytes -= data.len() as u64;
                    out.push((path, String::from_utf8_lossy(&data).into_owned()));
                }
            }
        }
    }
    let mut out = Vec::new();
    let mut budget = Budget {
        bytes: SCAN_BYTES,
        entries,
    };
    walk(dir, prefix, depth, skip, &mut out, &mut budget);
    out
}

/// `Ok((success, stdout+stderr))`, `Err(message)` if latexmk couldn't run or timed out.
pub async fn latexmk(
    cwd: &FsPath,
    file: &std::ffi::OsStr,
    out: &FsPath,
    engine: Engine,
) -> Result<(bool, String), String> {
    use std::os::unix::process::CommandExt;

    let mut outdir = OsString::from("-outdir=");
    outdir.push(out);
    let mut cmd = std::process::Command::new("latexmk");
    cmd.args([
        // a latexmkrc is Perl from the repo: reading it would defeat -no-shell-escape
        "-norc",
        "-g",
        engine.latexmk_flag(),
        "-interaction=nonstopmode",
        // like Overleaf: keep going past errors so a PDF is still produced; errors are
        // reported as diagnostics and the result is `failed`
        "-f",
        "-file-line-error",
        "-no-shell-escape",
        // `<stem>.synctex.gz` next to the PDF, for `GET …/synctex/*`
        "-synctex=1",
    ])
    .arg(outdir)
    .arg(file)
    .current_dir(cwd)
    // nothing of the server's environment (OAuth secrets, keys) reaches TeX
    .env_clear()
    .env("PATH", std::env::var_os("PATH").unwrap_or_default())
    .env("HOME", out)
    .env("TMPDIR", out)
    .env("LANG", "C.UTF-8")
    // luaotfload font cache: writable per build dir, system cache is read-only
    .env("TEXMFVAR", out.join("texmf-var"))
    // kpathsea: don't wrap log lines at 79 chars, keeps paths and messages parseable
    .env("max_print_line", "10000")
    .env("TEXMFOUTPUT", out)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    // own process group, so a timeout also kills the engine latexmk spawned
    .process_group(0);
    if engine != Engine::Lualatex {
        // defense in depth on top of the sandbox: no absolute paths or `..` in \input.
        // (LuaTeX's own font loader reads absolute paths, so it relies on the sandbox alone.)
        cmd.env("openin_any", "p").env("openout_any", "p");
    }
    match sandboxed(cmd, out, true, TIMEOUT).await? {
        Some(o) => Ok((
            o.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
        )),
        None => Err(format!(
            "compilation timed out after {} s",
            TIMEOUT.as_secs()
        )),
    }
}

/// Runs `cmd` (spawned with `process_group(0)`) in the sandbox with access to `dir`;
/// `Ok(None)` if it timed out (its process group is killed).
async fn sandboxed(
    cmd: std::process::Command,
    dir: &FsPath,
    writable: bool,
    timeout: Duration,
) -> Result<Option<std::process::Output>, String> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let (pid, rx) = crate::sandbox::spawn(cmd, dir.to_owned(), writable)?;
    let wait = tokio::task::spawn_blocking(move || rx.recv());
    match tokio::time::timeout(timeout, wait).await {
        Ok(Ok(Ok(Ok(o)))) => Ok(Some(o)),
        Ok(Ok(Ok(Err(e)))) => Err(format!("{program} failed: {e}")),
        Ok(_) => Err(format!("{program} failed: sandbox thread died")),
        Err(_) => {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .status()
                .await;
            Ok(None)
        }
    }
}

/// Lexically normalized `p` relative to the workspace, `None` if outside.
fn workspace_rel(ws_root: &FsPath, p: &FsPath) -> Option<String> {
    let mut norm = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                norm.pop();
            }
            c => norm.push(c),
        }
    }
    let rel = norm.strip_prefix(ws_root).ok()?.to_str()?;
    (!rel.is_empty()).then(|| rel.to_owned())
}

/// Leading decimal number of `s`.
fn number(s: &str) -> Option<u32> {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    s[..end].parse().ok()
}

fn number_after(s: &str, needle: &str) -> Option<u32> {
    s.rfind(needle).and_then(|i| number(&s[i + needle.len()..]))
}

fn is_path(s: &str) -> bool {
    s.starts_with("./") || s.starts_with("../") || s.starts_with('/')
}

/// `-file-line-error` line: `./sec/intro.tex:12: Undefined control sequence.`
fn file_line_error(line: &str) -> Option<(&str, u32, &str)> {
    if !is_path(line) {
        return None;
    }
    line.match_indices(':').find_map(|(i, _)| {
        let rest = &line[i + 1..];
        let digits = rest.find(|c: char| !c.is_ascii_digit())?;
        let msg = rest[digits..].strip_prefix(':')?;
        Some((&line[..i], rest[..digits].parse().ok()?, msg.trim()))
    })
}

/// Continuation of a multi-line warning: `(hyperref)                removing ...`
fn is_continuation(line: &str) -> bool {
    line.strip_prefix('(')
        .and_then(|l| l.split_once(')'))
        .is_some_and(|(name, rest)| {
            !name.is_empty() && !name.contains([' ', '/']) && rest.starts_with(' ')
        })
}

/// Tracks TeX's `(file … )` nesting; `None` entries are plain parentheses in messages.
fn track_files<'a>(line: &'a str, files: &mut Vec<Option<&'a str>>) {
    let mut rest = line;
    while let Some(i) = rest.find(['(', ')']) {
        if rest[i..].starts_with(')') {
            files.pop();
            rest = &rest[i + 1..];
            continue;
        }
        let after = &rest[i + 1..];
        let (name, tail) = match after.strip_prefix('"') {
            Some(q) => q.split_once('"').unwrap_or((q, "")),
            None => after.split_at(after.find([' ', '(', ')']).unwrap_or(after.len())),
        };
        if is_path(name) {
            files.push(Some(name));
            rest = tail;
        } else {
            files.push(None);
            rest = after;
        }
    }
}

/// Extracts errors, warnings and bad boxes from a pdflatex `.log` written with `-file-line-error`
/// and unwrapped lines. Relative file names are resolved against `cwd` (latexmk's working dir).
// ponytail: the `(file` stack is the usual heuristic, unbalanced parens in odd places can
// misattribute warnings/bad boxes to the enclosing file
pub fn parse_log(log: &str, cwd: &FsPath, ws_root: &FsPath) -> Vec<Diagnostic> {
    let rel = |f: Option<&str>| f.and_then(|f| workspace_rel(ws_root, &cwd.join(f)));
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut files: Vec<Option<&str>> = Vec::new();
    // classic `! msg` error waiting for its `l.<n>` line
    let mut pending: Option<usize> = None;
    // inside a bad box's content dump (ends with an empty line), which echoes document text
    let mut in_box = false;
    let mut lines = log.lines().peekable();
    while let Some(line) = lines.next() {
        let current = files.iter().rev().find_map(|f| *f);
        if in_box {
            in_box = !line.trim().is_empty();
        } else if let Some((file, n, msg)) = file_line_error(line) {
            // `==> Fatal error occurred` just repeats the halt-on-error stop
            if !msg.starts_with("==>") {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    file: rel(Some(file)),
                    line: Some(n),
                    message: msg.to_owned(),
                });
            }
        } else if let Some(msg) = line.strip_prefix("! ") {
            if !msg.trim_start().starts_with("==>") {
                pending = Some(out.len());
                out.push(Diagnostic {
                    severity: Severity::Error,
                    file: rel(current),
                    line: None,
                    message: msg.trim().to_owned(),
                });
            }
        } else if let (Some(i), Some(rest)) = (pending, line.strip_prefix("l.")) {
            out[i].line = number(rest);
            pending = None;
        } else if ["LaTeX ", "Package ", "Class "]
            .iter()
            .any(|p| line.starts_with(p))
            && line.contains("Warning: ")
        {
            let mut msg = line
                .strip_prefix("LaTeX Warning: ")
                .unwrap_or(line)
                .to_owned();
            while let Some(next) = lines.next_if(|l| is_continuation(l)) {
                let text = next.split_once(')').map_or(next, |(_, t)| t);
                msg.push(' ');
                msg.push_str(text.trim());
            }
            out.push(Diagnostic {
                severity: Severity::Warning,
                file: rel(current),
                line: number_after(&msg, "on input line "),
                message: msg,
            });
        } else if line.starts_with("Overfull \\") || line.starts_with("Underfull \\") {
            out.push(Diagnostic {
                severity: Severity::Badbox,
                file: rel(current),
                line: number_after(line, "at lines ").or_else(|| number_after(line, "at line ")),
                message: line.trim().to_owned(),
            });
            in_box = true;
        } else {
            track_files(line, &mut files);
        }
    }
    out
}

#[derive(Deserialize)]
pub struct RootParam {
    root: String,
}

#[derive(Deserialize)]
pub struct CompileBody {
    root: Option<String>,
    #[serde(default)]
    clean: bool,
}

const MAX_MAIN_FILES: usize = 20;

/// Validated `main_files` for PATCH: every path an existing root `.tex` in an initialized repo
/// (else `400 no_root` / 400 / 404), deduplicated, in order. Entries of the stored list that no
/// longer exist (404) or are no longer roots (`no_root`) are dropped instead of failing the request; those in a currently
/// uninitialized submodule are kept.
pub async fn check_main_files(app: &Project, files: Vec<String>) -> Result<Vec<String>, ApiError> {
    if files.len() > MAX_MAIN_FILES {
        return Err(ApiError::bad_request(format!(
            "at most {MAX_MAIN_FILES} main files"
        )));
    }
    let repos = app.workspace.repos().await;
    let stored = app.compiler.main_files.lock().unwrap().clone();
    let mut out: Vec<String> = Vec::new();
    for file in files {
        match check_main_file(app, &repos, &file).await {
            Ok(file) if out.contains(&file) => {}
            Ok(file) => out.push(file),
            // a stored entry in a currently uninitialized submodule is kept (it is not gone, the
            // submodule just is not checked out)
            Err(_)
                if stored.contains(&file)
                    && detect::normalize(&file)
                        .is_some_and(|f| Workspace::in_uninitialized(&repos, &f)) =>
            {
                if !out.contains(&file) {
                    out.push(file);
                }
            }
            // a stored entry that no longer exists or stopped being a root is dropped, so it
            // cannot block saving the rest of the list
            Err(e)
                if stored.contains(&file)
                    && (e.status == StatusCode::NOT_FOUND || e.code == "no_root") => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

async fn check_main_file(
    app: &Project,
    repos: &[workspace::Repo],
    file: &str,
) -> Result<String, ApiError> {
    validate(&app.workspace, file)?;
    let file = detect::normalize(file).ok_or_else(|| ApiError::invalid_path(file))?;
    if Workspace::in_uninitialized(repos, &file) {
        return Err(ApiError::invalid_path(&file));
    }
    app.docs.flush_repo(
        &app.workspace,
        &workspace::repo_of(repos, &file),
        &app.events,
    );
    let text = app.workspace.read(&file).map_err(ApiError::internal)?;
    if !detect::is_root(&String::from_utf8_lossy(&text)) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "no_root",
            format!(r"{file} has no \begin{{document}}"),
        ));
    }
    Ok(file)
}

/// `root` must be an existing `.tex` file inside the workspace.
fn validate(ws: &Workspace, root: &str) -> Result<(), ApiError> {
    let abs = ws.resolve(root)?;
    let name = abs.file_name().and_then(|n| n.to_str()).unwrap_or("");
    // a leading `-` would be read as a latexmk option
    if !name.ends_with(".tex") || name.starts_with('-') {
        return Err(ApiError::bad_request(format!("{root} is not a .tex file")));
    }
    if !abs.is_file() {
        return Err(ApiError::not_found(format!("{root} not found")));
    }
    Ok(())
}

/// The `.tex` files of `repo` (from disk), without nested repos (they are compiled on their own).
async fn repo_sources(
    app: &Project,
    repos: &[workspace::Repo],
    repo: &str,
) -> Result<Sources, ApiError> {
    let dir = app.workspace.open_dir(repo).map_err(ApiError::internal)?;
    let nested: Vec<String> = (repos.iter())
        .filter(|r| r.path != repo && workspace::is_within(&r.path, repo))
        .map(|r| r.path.clone())
        .collect();
    let repo = repo.to_owned();
    tokio::task::spawn_blocking(move || {
        Sources::new(scan_tex(&dir, &repo, &|p| nested.iter().any(|n| n == p)))
    })
    .await
    .map_err(ApiError::internal)
}

/// Spell-check language of the root `file` belongs to (`Sources::language`), `auto` if none.
// ponytail: scans the repo on every call (a spell-check request); cache per repo if it shows up
pub async fn language_of(app: &Project, file: &str) -> Result<String, ApiError> {
    let repos = app.workspace.repos().await;
    let repo = workspace::repo_of(&repos, file);
    let sources = repo_sources(app, &repos, &repo).await?;
    let roots = sources.roots();
    let root = roots.contains(&file).then_some(file);
    Ok((root.or_else(|| sources.root_for(file, &roots)))
        .map_or_else(|| "auto".into(), |r| sources.language(r)))
}

/// `file` if it is a root, else the root of its repo it belongs to (`Sources::root_for`).
async fn resolve_root(
    app: &Project,
    repos: &[workspace::Repo],
    repo: &str,
    file: String,
) -> Result<String, ApiError> {
    let text = app.workspace.read(&file).map_err(ApiError::internal)?;
    if detect::is_root(&String::from_utf8_lossy(&text)) {
        return Ok(file);
    }
    let mains: Vec<String> = (app.compiler.main_files.lock().unwrap().iter())
        .filter(|m| workspace::repo_of(repos, m) == repo)
        .cloned()
        .collect();
    let sources = repo_sources(app, repos, repo).await?;
    let roots = sources.roots();
    // a main file of this repo wins: the first including `file`, else the first (stale ones skipped)
    let mains: Vec<&str> = (mains.iter())
        .map(String::as_str)
        .filter(|m| roots.contains(m))
        .collect();
    let root = (mains.iter().copied())
        .find(|m| sources.including(&file, &[m]).is_some())
        .or(mains.first().copied())
        .or_else(|| sources.root_for(&file, &roots))
        .map(str::to_owned);
    root.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "no_root",
            format!(r"{file} has no \begin{{document}} and no root file of its repo includes it"),
        )
    })
}

/// `(root, repo)` of a requested `root` (validated, resolved like `POST …/compile`), after
/// flushing the repo's live edits to disk.
async fn flushed_root(app: &Project, root: String) -> Result<(String, String), ApiError> {
    validate(&app.workspace, &root)?;
    let repos = app.workspace.repos().await;
    if Workspace::in_uninitialized(&repos, &root) {
        return Err(ApiError::invalid_path(&root));
    }
    let repo = workspace::repo_of(&repos, &root);
    // explicit compile (Ctrl+S) must see the latest edits, not wait for the debounced flush
    app.docs.flush_repo(&app.workspace, &repo, &app.events);
    let root = resolve_root(app, &repos, &repo, root).await?;
    validate(&app.workspace, &root)?;
    Ok((root, repo))
}

pub async fn post(
    ProjectCtx(app, _): ProjectCtx,
    body: Result<Json<CompileBody>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let Json(CompileBody { root, clean }) =
        body.map_err(|e| ApiError::bad_request(e.body_text()))?;
    // no `root`: the project's first main file that still exists and is a root
    let mains = app.compiler.main_files.lock().unwrap().clone();
    let first = (mains.into_iter()).find(|m| {
        validate(&app.workspace, m).is_ok()
            && (app.workspace.read(m)).is_ok_and(|t| detect::is_root(&String::from_utf8_lossy(&t)))
    });
    let root = root.or(first).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "no_root",
            "no root given and the project has no main file",
        )
    })?;
    let (root, repo) = flushed_root(&app, root).await?;
    request(&app, &root, &repo, clean);
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "root": root, "state": "queued" })),
    ))
}

#[derive(Serialize)]
pub struct RootInfo {
    path: String,
    repo: String,
    /// detected, i.e. what `compiler: "auto"` uses
    engine: Engine,
    reason: String,
    /// spell-check language (LanguageTool code or `auto`), see `Sources::language`
    language: String,
}

pub async fn roots(ProjectCtx(app, _): ProjectCtx) -> Result<Json<Vec<RootInfo>>, ApiError> {
    let repos = app.workspace.repos().await;
    let dir = app.workspace.open_dir("").map_err(ApiError::internal)?;
    tokio::task::spawn_blocking(move || {
        let skip = |p: &str| Workspace::in_uninitialized(&repos, p);
        let sources = Sources::new(scan_tex(&dir, "", &skip));
        let roots = sources.roots().into_iter().map(|path| {
            let (engine, reason) = sources.engine(path);
            RootInfo {
                path: path.to_owned(),
                repo: workspace::repo_of(&repos, path),
                engine,
                reason,
                language: sources.language(path),
            }
        });
        Json(roots.collect())
    })
    .await
    .map_err(ApiError::internal)
}

fn last<T>(
    app: &Project,
    q: Result<Query<RootParam>, QueryRejection>,
    pick: impl FnOnce(&Root) -> Option<T>,
) -> Result<T, ApiError> {
    let Query(RootParam { root }) = q.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let roots = app.compiler.roots.lock().unwrap();
    roots
        .get(&root)
        .and_then(pick)
        .ok_or_else(|| ApiError::not_found(format!("{root} was never compiled")))
}

pub async fn get(
    ProjectCtx(app, _): ProjectCtx,
    q: Result<Query<RootParam>, QueryRejection>,
) -> Result<Json<CompileResult>, ApiError> {
    last(&app, q, |r| r.result.clone()).map(Json)
}

pub async fn log(
    ProjectCtx(app, _): ProjectCtx,
    q: Result<Query<RootParam>, QueryRejection>,
) -> Result<String, ApiError> {
    last(&app, q, |r| r.result.as_ref().map(|_| r.log.clone()))
}

pub async fn pdf(
    ProjectCtx(app, _): ProjectCtx,
    Path((_, root)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    app.workspace.resolve(&root)?; // confines the build path too
    let pdf = tokio::fs::read(app.compiler.build.join(&root).join(LAST_PDF))
        .await
        .map_err(|_| ApiError::not_found(format!("no PDF for {root}")))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/pdf"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        pdf,
    ))
}

const SYNCTEX_TIMEOUT: Duration = Duration::from_secs(5);
/// Bound for PDF coordinates in requests (points; real pages are below 15000).
const MAX_COORD: f64 = 100_000.0;

#[derive(Deserialize)]
pub struct ForwardQuery {
    root: String,
    file: String,
    line: u32,
    #[serde(default)]
    column: u32,
}

#[derive(Deserialize)]
pub struct InverseQuery {
    root: String,
    page: u32,
    x: f64,
    y: f64,
}

/// A box in the PDF: points, origin top left, `page` from 1.
#[derive(Debug, Serialize, PartialEq)]
pub struct SyncBox {
    page: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SyncPos {
    file: String,
    line: u32,
    column: u32,
}

/// `(output dir, snapshot dir, workspace dir of the snapshot, PDF path)` of a compiled `root`.
async fn synctex_target(
    app: &Project,
    root: &str,
    file: Option<&str>,
) -> Result<(PathBuf, PathBuf, String, PathBuf), ApiError> {
    validate(&app.workspace, root)?;
    if let Some(file) = file {
        app.workspace.resolve(file)?;
    }
    let repos = app.workspace.repos().await;
    for p in [Some(root), file].into_iter().flatten() {
        if Workspace::in_uninitialized(&repos, p) {
            return Err(ApiError::invalid_path(p));
        }
    }
    // like `POST …/compile`: an included file stands for its root, no root at all → `no_root`
    let repo = workspace::repo_of(&repos, root);
    let root = &resolve_root(app, &repos, &repo, root.to_owned()).await?;
    let (out, source_rel, stem) = app.compiler.layout(root);
    if !out.join(format!("{stem}.synctex.gz")).is_file() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no_synctex",
            format!("{root} has no SyncTeX data, compile it first"),
        ));
    }
    let pdf = out.join(format!("{stem}.pdf"));
    Ok((out.clone(), out.join("source"), source_rel, pdf))
}

/// `synctex <args>` in the sandbox (read-only `out`), its stdout.
async fn synctex(out: &FsPath, args: &[OsString]) -> Result<String, ApiError> {
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new("synctex");
    cmd.args(args)
        .current_dir(out)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    match sandboxed(cmd, out, false, SYNCTEX_TIMEOUT).await {
        Ok(Some(o)) => Ok(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(None) => Err(ApiError::internal("synctex timed out")),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// Boxes of `synctex view` output (`v` is the baseline, the box spans `H` above it), deduplicated.
fn parse_view(stdout: &str) -> Vec<SyncBox> {
    let mut raw: Vec<(u32, [f64; 4])> = Vec::new();
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key == "Page" {
            if let Ok(page) = value.parse() {
                raw.push((page, [f64::NAN; 4]));
            }
        } else if let (Some((_, b)), Some(i)) = (
            raw.last_mut(),
            ["h", "v", "W", "H"].iter().position(|k| *k == key),
        ) {
            b[i] = value.parse().unwrap_or(f64::NAN);
        }
    }
    let mut out: Vec<SyncBox> = Vec::new();
    for (page, [h, v, w, height]) in raw {
        let b = SyncBox {
            page,
            x: h,
            y: v - height,
            w,
            h: height,
        };
        if [b.x, b.y, b.w, b.h].iter().all(|f| f.is_finite()) && !out.contains(&b) {
            out.push(b);
        }
    }
    out
}

/// First hit of `synctex edit` output: `(path relative to snapshot, line, column)`, `None` if
/// there is none or its file is outside `snapshot` (TeX Live classes, the `.aux`).
fn parse_edit(stdout: &str, snapshot: &FsPath) -> Option<(String, u32, u32)> {
    let field = |key: &str| {
        stdout
            .lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
    };
    let file = workspace_rel(snapshot, FsPath::new(field("Input")?))?;
    let line = field("Line")?.parse().ok()?;
    // synctex reports -1 (or 0) for "unknown"
    let column = field("Column")?.parse::<i64>().ok()?;
    Some((file, line, u32::try_from(column).unwrap_or(0)))
}

fn workspace_path(source_rel: &str, rel: &str) -> String {
    if source_rel.is_empty() {
        rel.to_owned()
    } else {
        format!("{source_rel}/{rel}")
    }
}

pub async fn synctex_forward(
    ProjectCtx(app, _): ProjectCtx,
    q: Result<Query<ForwardQuery>, QueryRejection>,
) -> Result<Json<Vec<SyncBox>>, ApiError> {
    let Query(q) = q.map_err(|e| ApiError::bad_request(e.body_text()))?;
    if q.line == 0 {
        return Err(ApiError::bad_request("line starts at 1"));
    }
    let (out, snapshot, source_rel, pdf) = synctex_target(&app, &q.root, Some(&q.file)).await?;
    // only files of the snapshot can be in the PDF
    let rel = if source_rel.is_empty() {
        Some(q.file.as_str())
    } else {
        q.file.strip_prefix(&format!("{source_rel}/"))
    };
    let Some(rel) = rel else {
        return Ok(Json(Vec::new()));
    };
    let mut input = OsString::from(format!("{}:{}:", q.line, q.column));
    input.push(snapshot.join(rel));
    let stdout = synctex(
        &out,
        &["view".into(), "-i".into(), input, "-o".into(), pdf.into()],
    )
    .await?;
    Ok(Json(parse_view(&stdout)))
}

pub async fn synctex_inverse(
    ProjectCtx(app, _): ProjectCtx,
    q: Result<Query<InverseQuery>, QueryRejection>,
) -> Result<Json<SyncPos>, ApiError> {
    let Query(q) = q.map_err(|e| ApiError::bad_request(e.body_text()))?;
    if q.page == 0 {
        return Err(ApiError::bad_request("page starts at 1"));
    }
    // also rejects NaN and infinities
    if ![q.x, q.y].iter().all(|c| (0.0..=MAX_COORD).contains(c)) {
        return Err(ApiError::bad_request(format!(
            "x and y must be within 0..={MAX_COORD}"
        )));
    }
    let (out, snapshot, source_rel, pdf) = synctex_target(&app, &q.root, None).await?;
    let mut target = OsString::from(format!("{}:{}:{}:", q.page, q.x, q.y));
    target.push(pdf);
    let stdout = synctex(&out, &["edit".into(), "-o".into(), target]).await?;
    let (rel, line, column) = parse_edit(&stdout, &snapshot).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "no_match",
            "no source position there",
        )
    })?;
    Ok(Json(SyncPos {
        file: workspace_path(&source_rel, &rel),
        line,
        column,
    }))
}

const WORDCOUNT_TIMEOUT: Duration = Duration::from_secs(10);
/// Names the private snapshots of concurrent word counts apart.
static WORDCOUNT_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct WordCount {
    words: u32,
    headers: u32,
    captions: u32,
    math_inline: u32,
    math_display: u32,
    per_file: Vec<FileWords>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct FileWords {
    path: String,
    words: u32,
}

/// Sums the per-file lines of `texcount -inc -brief` (`5+2+3 (1/1/1/1) File: main.tex`,
/// `… Included file: ./sec/a.tex`; text+headers+captions (headers/floats/inline/display)).
/// Only files inside `snapshot` count (texcount also follows absolute `\input` paths);
/// `None` if there is no such line.
fn parse_texcount(stdout: &str, snapshot: &FsPath) -> Option<WordCount> {
    let mut wc = WordCount::default();
    let mut any = false;
    for line in stdout.lines() {
        let Some((counts, file)) = line.split_once(") ") else {
            continue;
        };
        let Some(file) =
            (file.strip_prefix("File: ")).or_else(|| file.strip_prefix("Included file: "))
        else {
            continue;
        };
        let Some((words, rest)) = counts.split_once(" (") else {
            continue;
        };
        let n: Vec<u32> = (words.split('+').chain(rest.split('/')))
            .map_while(|n| n.parse().ok())
            .collect();
        let [text, headers, captions, _, _, inline, display] = n[..] else {
            continue;
        };
        let Some(path) = workspace_rel(snapshot, &snapshot.join(file)) else {
            continue;
        };
        any = true;
        wc.words += text;
        wc.headers += headers;
        wc.captions += captions;
        wc.math_inline += inline;
        wc.math_display += display;
        wc.per_file.push(FileWords { path, words: text });
    }
    any.then_some(wc)
}

pub async fn wordcount(
    ProjectCtx(app, _): ProjectCtx,
    q: Result<Query<RootParam>, QueryRejection>,
) -> Result<Json<WordCount>, ApiError> {
    use std::os::unix::process::CommandExt;
    let Query(RootParam { root }) = q.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let (root, _) = flushed_root(&app, root).await?;
    let (_, source_rel, _) = app.compiler.layout(&root);
    let name = FsPath::new(&root).file_name().expect("root is a file");
    let n = WORDCOUNT_RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let snapshot = app.compiler.tmp.join(format!("wordcount-{n}"));
    let source = app
        .workspace
        .open_dir(&source_rel)
        .map_err(ApiError::internal)?;
    let destination = snapshot.clone();
    let name = name.to_owned();
    // a spawned task, so a client that hangs up cannot skip the snapshot cleanup
    let work = tokio::spawn(async move {
        let run = match tokio::task::spawn_blocking(move || copy_source_tree(&source, &destination))
            .await
        {
            Ok(Ok(())) => {
                let mut cmd = std::process::Command::new("texcount");
                cmd.args(["-inc", "-utf8", "-brief"])
                    .arg(name)
                    .current_dir(&snapshot)
                    .env_clear()
                    .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                    .env("LANG", "C.UTF-8")
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .process_group(0);
                match sandboxed(cmd, &snapshot, false, WORDCOUNT_TIMEOUT).await {
                    Ok(Some(o)) if o.status.success() => {
                        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
                    }
                    Ok(Some(o)) => Err(format!("texcount failed: {}", o.status)),
                    Ok(None) => Err(format!(
                        "texcount timed out after {} s",
                        WORDCOUNT_TIMEOUT.as_secs()
                    )),
                    Err(e) => Err(e),
                }
            }
            Ok(Err(e)) => Err(format!("source rejected: {e}")),
            Err(e) => Err(format!("source snapshot failed: {e}")),
        };
        if let Err(e) = tokio::fs::remove_dir_all(&snapshot).await {
            if e.kind() != ErrorKind::NotFound {
                tracing::warn!("could not remove word count snapshot: {e}");
            }
        }
        (run, snapshot)
    });
    let (run, snapshot) = work.await.map_err(ApiError::internal)?;
    let failed = |m: String| ApiError::new(StatusCode::BAD_GATEWAY, "wordcount_failed", m);
    let mut wc = parse_texcount(&run.map_err(failed)?, &snapshot)
        .ok_or_else(|| failed("texcount reported no counts".into()))?;
    for f in &mut wc.per_file {
        f.path = workspace_path(&source_rel, &f.path);
    }
    Ok(Json(wc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(running: bool) -> Root {
        Root {
            repo: String::new(),
            running,
            again: false,
            clean: false,
            result: None,
            log: String::new(),
            gone: false,
        }
    }

    fn result() -> CompileResult {
        CompileResult {
            root: "a.tex".into(),
            state: CompileState::Success,
            started_at: String::new(),
            duration_ms: 0,
            pdf_url: None,
            diagnostics: vec![],
            engine: Engine::Pdflatex,
            engine_reason: String::new(),
        }
    }

    #[test]
    fn gone_root_is_dropped_without_a_follow_up_run() {
        let mut roots = HashMap::from([("a.tex".to_owned(), root(true))]);
        moved_in(&mut roots, "a.tex", "b.tex");
        assert!(roots["a.tex"].gone && !roots["b.tex"].running);
        // a request queued a follow-up on the gone root while it was running
        roots.get_mut("a.tex").unwrap().again = true;
        assert!(!finish(&mut roots, "a.tex", result(), String::new()));
        assert!(!roots.contains_key("a.tex"));
    }

    #[test]
    fn moving_back_keeps_the_running_entry() {
        let mut roots = HashMap::from([("a.tex".to_owned(), root(true))]);
        moved_in(&mut roots, "a.tex", "b.tex");
        moved_in(&mut roots, "b.tex", "a.tex");
        let a = &roots["a.tex"];
        assert!(a.running && a.again && !a.gone);
        // the old run ends and the queued one follows
        assert!(finish(&mut roots, "a.tex", result(), String::new()));
        assert!(roots.contains_key("a.tex"));
    }

    #[test]
    fn loading_a_project_removes_stale_wordcount_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("tmp/wordcount-3")).unwrap();
        let c = Compiler::new(dir.path()).unwrap();
        assert_eq!(std::fs::read_dir(&c.tmp).unwrap().count(), 0);
    }

    #[test]
    fn runs_per_project_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let c = Compiler::new(dir.path()).unwrap();
        let _held = c.slots.try_acquire_many(MAX_PARALLEL_RUNS as u32).unwrap();
        assert!(c.slots.try_acquire().is_err());
    }

    #[test]
    fn texcount_brief_output_is_summed_per_file() {
        // real `texcount -inc -utf8 -brief main.tex` (TeX Live 2025): main.tex has a section,
        // a caption, inline and display math and `\input{sections/intro}`; bad.tex's
        // `\input{/etc/hostname}` line is appended to check that outside files are dropped
        let out = "5+2+3 (1/1/1/1) File: main.tex\n\
                   5+2+0 (1/0/0/0) Included file: ./sections/intro.tex\n\
                   Sum of files: main.tex\n\
                   10+4+3 (2/1/1/1) File(s) total: main.tex\n\
                   !!! File nope not found in path [./]. !!!\n\
                   1+0+0 (0/0/0/0) Included file: /etc/hostname\n";
        let wc = parse_texcount(out, FsPath::new("/data/tmp/wordcount-0")).unwrap();
        assert_eq!(
            wc,
            WordCount {
                words: 10,
                headers: 4,
                captions: 3,
                math_inline: 1,
                math_display: 1,
                per_file: vec![
                    FileWords {
                        path: "main.tex".into(),
                        words: 5
                    },
                    FileWords {
                        path: "sections/intro.tex".into(),
                        words: 5
                    },
                ],
            }
        );
        assert_eq!(
            parse_texcount(
                "!!! File not found or not readable: x.tex !!!\n(errors:1)\n",
                FsPath::new("/s")
            ),
            None
        );
    }

    #[test]
    fn tex_scan_is_bounded_by_entries_and_depth() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..10 {
            std::fs::write(root.path().join(format!("{i}.txt")), "x").unwrap();
        }
        let mut deep = root.path().to_path_buf();
        for i in 0..5 {
            deep.push(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("deep.tex"), "\\begin{document}").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        let none = |_: &str| false;
        // non-TeX entries use up the entry budget too
        assert!(scan_tex_limited(&dir, "", &none, 5, 10).is_empty());
        let all = scan_tex_limited(&dir, "", &none, 100, 10);
        assert_eq!(all.len(), 1, "{all:?}");
        assert_eq!(all[0].0, "d0/d1/d2/d3/d4/deep.tex");
        // too deep: d0 is level 0, deep.tex sits below d4 (5 levels of descent)
        assert!(scan_tex_limited(&dir, "", &none, 100, 4).is_empty());
        assert_eq!(scan_tex_limited(&dir, "", &none, 100, 5).len(), 1);
    }

    #[test]
    fn source_snapshot_rejects_external_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let paper = root.path().join("paper");
        let outside = root.path().join("secret.tex");
        let snapshot = root.path().join("build/source");
        std::fs::create_dir(&paper).unwrap();
        std::fs::write(paper.join("main.tex"), "ordinary source").unwrap();
        std::fs::write(&outside, "host secret").unwrap();
        std::os::unix::fs::symlink(&outside, paper.join("secret.tex")).unwrap();
        let source = Dir::open_ambient_dir(&paper, ambient_authority()).unwrap();

        let error = copy_source_tree(&source, &snapshot).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "host secret");
        assert!(!snapshot.join("secret.tex").exists());
    }

    #[test]
    fn source_snapshot_copies_regular_tex_inputs() {
        let root = tempfile::tempdir().unwrap();
        let paper = root.path().join("paper");
        let snapshot = root.path().join("build/source");
        std::fs::create_dir_all(paper.join("sections")).unwrap();
        std::fs::write(paper.join("main.tex"), "main").unwrap();
        std::fs::write(paper.join("sections/intro.tex"), "intro").unwrap();
        let source = Dir::open_ambient_dir(&paper, ambient_authority()).unwrap();

        copy_source_tree(&source, &snapshot).unwrap();
        assert_eq!(
            std::fs::read_to_string(snapshot.join("main.tex")).unwrap(),
            "main"
        );
        assert_eq!(
            std::fs::read_to_string(snapshot.join("sections/intro.tex")).unwrap(),
            "intro"
        );
    }

    #[test]
    fn source_snapshot_confines_submodule_compile_inputs() {
        const TINY_PNG: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];

        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let sub = workspace.join("papers/icml");
        let snapshot = root.path().join("build/papers/icml/main.tex/source");
        let out = root.path().join("build/papers/icml/main.tex");

        std::fs::create_dir_all(sub.join("figs")).unwrap();
        std::fs::create_dir_all(sub.join("sections")).unwrap();
        std::fs::write(workspace.join("img.png"), TINY_PNG).unwrap();
        std::fs::write(sub.join("figs/plot.png"), TINY_PNG).unwrap();
        std::fs::write(
            sub.join("sections/intro.tex"),
            "\\includegraphics{figs/plot.png}\n",
        )
        .unwrap();
        std::fs::write(
            sub.join("main.tex"),
            "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n",
        )
        .unwrap();

        let source = Dir::open_ambient_dir(&sub, ambient_authority()).unwrap();
        copy_source_tree(&source, &snapshot).unwrap();

        assert!(snapshot.join("figs/plot.png").is_file());
        assert!(!snapshot.join("../../img.png").exists());

        if std::process::Command::new("pdflatex")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
        {
            let ok = std::process::Command::new("pdflatex")
                .current_dir(&snapshot)
                .args([
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-no-shell-escape",
                ])
                .arg(format!("-output-directory={}", out.display()))
                .arg("main.tex")
                .output()
                .unwrap();
            assert!(
                ok.status.success(),
                "expected snapshot asset to compile: {}",
                String::from_utf8_lossy(&ok.stdout)
            );

            std::fs::write(
                snapshot.join("main.tex"),
                "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\includegraphics{../../img.png}\n\\end{document}\n",
            )
            .unwrap();
            let err = std::process::Command::new("pdflatex")
                .current_dir(&snapshot)
                .args([
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-no-shell-escape",
                ])
                .arg(format!("-output-directory={}", out.display()))
                .arg("main.tex")
                .output()
                .unwrap();
            assert!(
                !err.status.success(),
                "outside-snapshot path ../../img.png must not compile"
            );
        }
    }

    fn parse(log: &str) -> Vec<(Severity, Option<String>, Option<u32>, String)> {
        parse_log(log, FsPath::new("/w/papers/a"), FsPath::new("/w"))
            .into_iter()
            .map(|d| (d.severity, d.file, d.line, d.message))
            .collect()
    }

    fn d(
        sev: Severity,
        file: Option<&str>,
        line: Option<u32>,
        msg: &str,
    ) -> (Severity, Option<String>, Option<u32>, String) {
        (sev, file.map(Into::into), line, msg.into())
    }

    /// Real pdflatex 2025 output (latexmk -file-line-error, max_print_line=10000), shortened.
    const FAILED: &str = r#"This is pdfTeX, Version 3.141592653-2.6-1.40.28 (TeX Live 2025) (preloaded format=pdflatex 2025.11.15)  23 NOV 2026 15:28
entering extended mode
 file:line:error style messages enabled.
**main.tex
(./main.tex
LaTeX2e <2025-11-01>
(/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls
Document Class: article 2025/01/22 v1.4n Standard LaTeX document class
(/usr/local/texlive/2025/texmf-dist/tex/latex/base/size10.clo
File: size10.clo 2025/01/22 v1.4n Standard LaTeX file (size option)
)
\c@part=\count275
) (/usr/local/texlive/2025/texmf-dist/tex/latex/l3backend/l3backend-pdftex.def
File: l3backend-pdftex.def 2025-10-09 L3 backend support: PDF output (pdfTeX)
) (/data/build/papers/a/main.tex/main.aux)
\openout1 = `main.aux'.

LaTeX Font Info:    Checking defaults for OML/cmm/m/it on input line 2.


LaTeX Warning: Reference `nope' on page 1 undefined on input line 3.

(./sec/intro.tex
Overfull \hbox (204.60347pt too wide) detected at line 3
\OT1/cmr/m/n/10 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb (unbalanced
 []

Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing `math shift' on input line 7.

./sec/intro.tex:4: Undefined control sequence.
l.4 \foo

The control sequence at the end of the top line
of your error message was never \def'ed. If you have
misspelled it (e.g., `\hobx'), type `I' and the correct
spelling (e.g., `I\hbox'). Otherwise just continue,
and I'll forget about whatever was undefined.

./sec/intro.tex:4:  ==> Fatal error occurred, no output PDF file produced!
"#;

    #[test]
    fn parses_real_log() {
        use Severity::*;
        assert_eq!(
            parse(FAILED),
            [
                d(Warning, Some("papers/a/main.tex"), Some(3), "Reference `nope' on page 1 undefined on input line 3."),
                d(Badbox, Some("papers/a/sec/intro.tex"), Some(3), r"Overfull \hbox (204.60347pt too wide) detected at line 3"),
                d(Warning, Some("papers/a/sec/intro.tex"), Some(7), "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing `math shift' on input line 7."),
                d(Error, Some("papers/a/sec/intro.tex"), Some(4), "Undefined control sequence."),
            ]
        );
    }

    #[test]
    fn parses_classic_errors_and_badboxes() {
        use Severity::*;
        let log = r#"(./main.tex (../shared/macros.tex
Underfull \hbox (badness 10000) in paragraph at lines 12--13
[]\OT1/cmr/m/n/10 text

) (/usr/local/texlive/2025/texmf-dist/tex/latex/base/x.sty
/usr/local/texlive/2025/texmf-dist/tex/latex/base/x.sty:9: LaTeX Error: Oops.
)
! Missing $ inserted.
<inserted text>
                $
l.21 a^
       b
Overfull \vbox (3.0pt too high) has occurred while \output is active []

LaTeX Font Warning: Font shape `OT1/cmr/bx/sc' undefined
(Font)              using `OT1/cmr/bx/n' instead on input line 30.
"#;
        assert_eq!(
            parse(log),
            [
                d(Badbox, Some("papers/shared/macros.tex"), Some(12), r"Underfull \hbox (badness 10000) in paragraph at lines 12--13"),
                d(Error, None, Some(9), "LaTeX Error: Oops."),
                d(Error, Some("papers/a/main.tex"), Some(21), "Missing $ inserted."),
                d(Badbox, Some("papers/a/main.tex"), None, r"Overfull \vbox (3.0pt too high) has occurred while \output is active []"),
                d(Warning, Some("papers/a/main.tex"), Some(30), "LaTeX Font Warning: Font shape `OT1/cmr/bx/sc' undefined using `OT1/cmr/bx/n' instead on input line 30."),
            ]
        );
    }

    /// Real `synctex view` / `synctex edit` output (TeX Live 2025, SyncTeX 1.5).
    #[test]
    fn parses_synctex_output() {
        let hit = "Page:2\nx:171.128296\ny:134.764618\nh:133.768356\nv:134.764618\nW:343.711060\nH:6.918498\nbefore:\noffset:-1\n";
        let view = format!(
            "This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\n\
             Output:/b/main.pdf\n{hit}{hit}Page:x\nSyncTeX result end\n"
        );
        assert_eq!(
            parse_view(&view),
            [SyncBox {
                page: 2,
                x: 133.768356,
                y: 134.764618 - 6.918498,
                w: 343.71106,
                h: 6.918498
            }]
        );
        assert_eq!(parse_view("SyncTeX Warning: No tag for nope.tex\n"), []);

        let edit = |input: &str| {
            format!("SyncTeX result begin\nOutput:main.pdf\nInput:{input}\nLine:12\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n")
        };
        let snap = FsPath::new("/b/main.tex/source");
        assert_eq!(
            parse_edit(&edit("/b/main.tex/source/./sec/intro.tex"), snap),
            Some(("sec/intro.tex".into(), 12, 0))
        );
        for outside in [
            "/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls",
            "/b/main.tex/main.aux",
            "/b/main.tex/source/../main.aux",
        ] {
            assert_eq!(parse_edit(&edit(outside), snap), None, "{outside}");
        }
        assert_eq!(parse_edit("This is SyncTeX\n", snap), None);
    }

    #[test]
    fn workspace_rel_normalizes() {
        let ws = FsPath::new("/w");
        let rel = |p: &str| workspace_rel(ws, FsPath::new(p));
        assert_eq!(
            rel("/w/papers/a/./sec/x.tex").as_deref(),
            Some("papers/a/sec/x.tex")
        );
        assert_eq!(rel("/w/papers/a/../../top.tex").as_deref(), Some("top.tex"));
        assert_eq!(rel("/w/../etc/passwd"), None);
        assert_eq!(rel("/usr/share/x.sty"), None);
    }
}
