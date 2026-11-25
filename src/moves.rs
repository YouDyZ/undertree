//! Rename / move files and directories inside one repo, optionally rewriting the `\input`-like
//! references to them (docs/API.md → Workspace → Move).
//!
//! References are resolved like `detect.rs` does: relative to the directory of the root that
//! includes the referencing file. A reference is rewritten when, after the move, its old text no
//! longer reaches the same file: the target moved, or the root (and with it the base) did.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use axum::{extract::Query, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthSession,
    comments, compile, detect,
    docs::MAX_DOC_BYTES,
    error::ApiError,
    events::Event,
    projects::{Project, ProjectCtx, Role},
    workspace::{self, is_within, repo_of, EntryKind, Repo, Workspace},
};

/// `p` after moving `from` to `to` (`from` itself or below it).
pub fn map_path(p: &str, from: &str, to: &str) -> String {
    match p.strip_prefix(from) {
        Some("") => to.to_owned(),
        Some(rest) if rest.starts_with('/') => format!("{to}{rest}"),
        _ => p.to_owned(),
    }
}

/// `a/b/../c` → `a/c`; empty = workspace root; `None` = leaves the workspace.
fn norm(path: &str) -> Option<String> {
    let mut out = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(out.join("/"))
}

fn join(dir: &str, rel: &str) -> Option<String> {
    norm(&format!("{dir}/{rel}"))
}

/// Path from directory `from_dir` to `to`, both normalized.
fn relpath(from_dir: &str, to: &str) -> String {
    let split = |s: &'_ str| -> Vec<String> {
        (s.split('/'))
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect()
    };
    let (a, b) = (split(from_dir), split(to));
    let n = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts = vec!["..".to_owned(); a.len() - n];
    parts.extend_from_slice(&b[n..]);
    parts.join("/")
}

#[derive(Clone, Copy)]
enum Kind {
    Tex,
    Bib,
    Image,
    Pdf,
    Plain,
}

/// One reference to rewrite: `start..end` is the path text in the file.
#[derive(Debug, Clone)]
pub struct Edit {
    start: usize,
    end: usize,
    line: usize,
    old: String,
    new: String,
}

/// What a file's references are resolved against (before / after the move).
#[derive(Clone, Debug)]
pub struct FileCtx {
    path: String,
    base_old: String,
    base_new: String,
    /// directory of the including root (what `\import` is relative to)
    root_old: String,
    root_new: String,
    /// `\graphicspath` entries of the file and of its root
    dirs: Vec<String>,
}

struct Mv<'a> {
    from: &'a str,
    to: &'a str,
    /// files of the repo before the move
    files: &'a HashSet<String>,
}

impl Mv<'_> {
    fn map(&self, p: &str) -> String {
        map_path(p, self.from, self.to)
    }

    /// The file `p` stands for: with `.tex` / `.bib` / image extension completed.
    fn lookup(&self, p: &str, kind: Kind) -> Option<(String, &'static str)> {
        let exts: &[&'static str] = match kind {
            Kind::Tex => &[".tex", ""],
            Kind::Bib => &[".bib", ""],
            Kind::Image => &["", ".pdf", ".png", ".jpg", ".jpeg", ".eps"],
            Kind::Pdf => &["", ".pdf"],
            Kind::Plain => &[""],
        };
        exts.iter().find_map(|e| {
            let t = format!("{p}{e}");
            self.files.contains(&t).then_some((t, *e))
        })
    }

    /// `(file, completed extension, index into dirs + 1 or 0)` that `raw` stands for.
    fn resolve(
        &self,
        base: &str,
        raw: &str,
        kind: Kind,
        dirs: &[String],
    ) -> Option<(String, &'static str, usize)> {
        let dirs: &[String] = if matches!(kind, Kind::Image) {
            dirs
        } else {
            &[]
        };
        (std::iter::once("").chain(dirs.iter().map(String::as_str)))
            .enumerate()
            .find_map(|(k, d)| {
                let p = join(&join(base, d)?, raw)?;
                let (t, e) = self.lookup(&p, kind)?;
                Some((t, e, k))
            })
    }

    /// New text for a reference that `resolve` found, `None` = still correct.
    fn rewrite(
        &self,
        base_new: &str,
        raw: &str,
        found: &(String, &str, usize),
        dirs_new: &[String],
    ) -> Option<String> {
        let (target, added, k) = found;
        let new = self.map(target);
        let dir = if *k == 0 { "" } else { &dirs_new[k - 1] };
        let prefix = join(base_new, dir)?;
        if join(&prefix, raw).is_some_and(|p| format!("{p}{added}") == new) {
            return None;
        }
        // keep a graphicspath directory the file is still below, else write the path out
        let below = |pre: &str| match pre {
            "" => Some(new.as_str()),
            _ => new.strip_prefix(pre)?.strip_prefix('/'),
        };
        let rel = match below(&prefix) {
            Some(r) if *k > 0 => r.to_owned(),
            _ => relpath(base_new, &new),
        };
        let rel = match rel.strip_suffix(added) {
            Some(r) if !added.is_empty() => r.to_owned(),
            _ => rel,
        };
        (rel != raw).then_some(rel)
    }

    /// New text of directory reference `raw` (relative to the base), `None` = still correct.
    fn remap_dir(&self, base_old: &str, base_new: &str, raw: &str) -> Option<String> {
        let new = self.map(&join(base_old, raw)?);
        if join(base_new, raw).as_deref() == Some(new.as_str()) {
            return None;
        }
        let mut s = relpath(base_new, &new);
        if s.is_empty() {
            s.push('.');
        }
        if raw.ends_with('/') {
            s.push('/');
        }
        Some(s)
    }
}

/// `{…}` (balanced) after optional whitespace at `i`: content range.
fn group(t: &str, i: usize, open: u8, close: u8) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    let start = i + b
        .get(i..)?
        .iter()
        .take_while(|c| c.is_ascii_whitespace())
        .count();
    if b.get(start) != Some(&open) {
        return None;
    }
    let mut depth = 0;
    for (k, &c) in b[start..].iter().enumerate() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some((start + 1, start + k));
            }
        }
    }
    None
}

/// Index after an optional `[…]` at `i`.
fn skip_opt(t: &str, i: usize) -> usize {
    group(t, i, b'[', b']').map_or(i, |(_, e)| e + 1)
}

/// `\graphicspath{{a/}{b/}}` entries as `(start, end)` ranges.
fn graphicspath_entries(masked: &str) -> Vec<(usize, usize)> {
    const CMD: &str = "\\graphicspath";
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(k) = masked[from..].find(CMD) {
        from += k + CMD.len();
        let Some((s, e)) = group(masked, from, b'{', b'}') else {
            continue;
        };
        let mut i = s;
        while let Some((a, b)) = group(masked, i, b'{', b'}').filter(|(a, _)| *a <= e) {
            out.push((a, b));
            i = b + 1;
        }
    }
    out
}

fn graphicspaths(text: &str) -> Vec<String> {
    (graphicspath_entries(&detect::masked(text)).into_iter())
        .map(|(s, e)| text[s..e].trim().to_owned())
        .filter(|d| !d.is_empty())
        .collect()
}

/// Rewrites needed in `text` of the file described by `ctx`.
fn scan(mv: &Mv, ctx: &FileCtx, text: &str) -> Vec<Edit> {
    let masked = detect::masked(text);
    let t = masked.as_str();
    let (b_old, b_new) = (ctx.base_old.as_str(), ctx.base_new.as_str());
    let dirs_new: Vec<String> = (ctx.dirs.iter())
        .map(|d| mv.remap_dir(b_old, b_new, d).unwrap_or_else(|| d.clone()))
        .collect();
    // the path text inside `s..e` (trimmed), unless it is computed (`\jobname`, `#1`) or absolute
    let literal = |s: usize, e: usize| {
        let raw = &text[s..e];
        let a = s + raw.len() - raw.trim_start().len();
        let b = a + raw.trim().len();
        let computed =
            text[a..b].contains(['\\', '#', '$', '{', '}', '~']) || text[a..b].starts_with('/');
        (a < b && !computed).then_some((a, b))
    };
    let mut edits: Vec<Edit> = Vec::new();
    let mut push = |s: usize, e: usize, new: String| {
        edits.push(Edit {
            start: s,
            end: e,
            line: 1 + text[..s].matches('\n').count(),
            old: text[s..e].to_owned(),
            new,
        })
    };
    let file_ref = |s: usize, e: usize, base_old: &str, base_new: &str, kind| {
        let (s, e) = literal(s, e)?;
        let found = mv.resolve(base_old, &text[s..e], kind, &ctx.dirs)?;
        let new = mv.rewrite(base_new, &text[s..e], &found, &dirs_new)?;
        Some((s, e, new))
    };
    let mut i = 0;
    while let Some(k) = t[i..].find('\\') {
        let at = i + k + 1;
        let len = (t[at..].find(|c: char| !c.is_ascii_alphabetic())).unwrap_or(t.len() - at);
        let skip = t[at..].chars().next().map_or(0, char::len_utf8);
        i = at + if len == 0 { skip } else { len };
        let name = &t[at..at + len];
        let mut j = at + len;
        if t[j..].starts_with('*') {
            j += 1;
        }
        let kind = match name {
            "input" | "include" | "subfile" => Kind::Tex,
            "includegraphics" => Kind::Image,
            "includepdf" => Kind::Pdf,
            "lstinputlisting" | "inputminted" => Kind::Plain,
            "addbibresource" => Kind::Bib,
            "bibliography" => {
                if let Some((s, e)) = group(t, j, b'{', b'}') {
                    let mut from = s;
                    for item in text[s..e].split(',') {
                        let end = from + item.len();
                        if let Some((a, b, new)) = file_ref(from, end, b_old, b_new, Kind::Bib) {
                            push(a, b, new);
                        }
                        from = end + 1;
                    }
                }
                continue;
            }
            "import" | "subimport" | "inputfrom" | "subinputfrom" | "includefrom"
            | "subincludefrom" => {
                let Some((ds, de)) = group(t, j, b'{', b'}') else {
                    continue;
                };
                let Some((fs, fe)) = group(t, de + 1, b'{', b'}') else {
                    continue;
                };
                let Some((ds, de)) = literal(ds, de) else {
                    continue;
                };
                let dir = &text[ds..de];
                // `\import` is relative to the root, `\subimport` to the importing file's base
                let (i_old, i_new) = if name.starts_with("sub") {
                    (b_old, b_new)
                } else {
                    (ctx.root_old.as_str(), ctx.root_new.as_str())
                };
                let dir_new = mv.remap_dir(i_old, i_new, dir);
                let (Some(d_old), Some(d_new)) = (
                    join(i_old, dir),
                    join(i_new, dir_new.as_deref().unwrap_or(dir)),
                ) else {
                    continue;
                };
                if let Some(new) = dir_new {
                    push(ds, de, new);
                }
                if let Some((a, b, new)) = file_ref(fs, fe, &d_old, &d_new, Kind::Tex) {
                    push(a, b, new);
                }
                continue;
            }
            _ => continue,
        };
        if !matches!(kind, Kind::Tex) {
            j = skip_opt(t, j);
        }
        if name == "inputminted" {
            let Some((_, e)) = group(t, j, b'{', b'}') else {
                continue;
            };
            j = e + 1;
        }
        if let Some((s, e)) = group(t, j, b'{', b'}') {
            if let Some((a, b, new)) = file_ref(s, e, b_old, b_new, kind) {
                push(a, b, new);
            }
        }
    }
    for (s, e) in graphicspath_entries(t) {
        if let Some((s, e)) = literal(s, e) {
            if let Some(new) = mv.remap_dir(b_old, b_new, &text[s..e]) {
                push(s, e, new);
            }
        }
    }
    edits.sort_by_key(|e| e.start);
    edits
}

fn apply(text: &str, edits: &[Edit]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for e in edits {
        out.push_str(&text[at..e.start]);
        out.push_str(&e.new);
        at = e.end;
    }
    out.push_str(&text[at..]);
    out
}

/// Files whose references change when `from` moves to `to`. `texts`: `.tex` / `.sty` / `.cls` of
/// the repo; `files`: every file of the repo.
fn plan(
    texts: &BTreeMap<String, String>,
    files: &HashSet<String>,
    from: &str,
    to: &str,
) -> Vec<(FileCtx, Vec<Edit>)> {
    let mv = Mv { from, to, files };
    let tex =
        (texts.iter().filter(|(p, _)| p.ends_with(".tex"))).map(|(p, t)| (p.clone(), t.clone()));
    let sources = detect::Sources::new(tex);
    let roots = sources.roots();
    let mut bases: HashMap<&str, HashMap<&str, String>> = HashMap::new();
    let mut out = Vec::new();
    for (path, text) in texts {
        let Some(root) = sources.root_for(path, &roots) else {
            continue;
        };
        let mut dirs = graphicspaths(text);
        if root != path {
            dirs.extend(graphicspaths(&texts[root]));
        }
        let root_old = detect::dir_of(root).to_owned();
        let root_new = detect::dir_of(&mv.map(root)).to_owned();
        // a file included through `\import{dir}` has `dir` as its base, which follows the move
        // (the import's dir argument is rewritten to point at it)
        let base_old = (bases.entry(root).or_insert_with(|| sources.bases(root)))
            .get(path.as_str())
            .cloned()
            .unwrap_or_else(|| root_old.clone());
        let base_new = if base_old == root_old {
            root_new.clone()
        } else {
            mv.map(&base_old)
        };
        let ctx = FileCtx {
            path: path.clone(),
            base_old,
            base_new,
            root_old,
            root_new,
            dirs,
        };
        let edits = scan(&mv, &ctx, text);
        if !edits.is_empty() {
            out.push((ctx, edits));
        }
    }
    out
}

#[derive(Deserialize)]
pub struct MoveBody {
    from: String,
    to: String,
    #[serde(default)]
    update_refs: bool,
}

#[derive(Deserialize)]
pub struct PreviewQuery {
    from: String,
    to: String,
}

#[derive(Serialize)]
pub struct Moved {
    from: String,
    to: String,
}

#[derive(Serialize)]
pub struct Updated {
    file: String,
    count: usize,
}

#[derive(Serialize)]
pub struct MoveResult {
    moved: Vec<Moved>,
    updated_refs: Vec<Updated>,
}

#[derive(Serialize)]
pub struct Reference {
    path: String,
    line: usize,
    old: String,
    new: String,
}

#[derive(Serialize)]
pub struct Preview {
    references: Vec<Reference>,
}

fn cross_repo(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "cross_repo", msg)
}

/// Validates the move; returns the repos.
async fn check(app: &Project, from: &str, to: &str) -> Result<Vec<Repo>, ApiError> {
    app.workspace.resolve(from)?;
    app.workspace.resolve(to)?;
    if is_within(to, from) {
        return Err(ApiError::bad_request("cannot move a path into itself"));
    }
    let repos = app.workspace.repos().await;
    for p in [from, to] {
        if Workspace::in_uninitialized(&repos, p) {
            return Err(ApiError::invalid_path(p));
        }
    }
    match app.workspace.exists(from) {
        Ok(true) => {}
        Ok(false) => return Err(ApiError::not_found(format!("{from} not found"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found(format!("{from} not found")))
        }
        Err(e) => return Err(ApiError::internal(e)),
    }
    if repos
        .iter()
        .any(|r| !r.path.is_empty() && is_within(&r.path, from))
    {
        return Err(cross_repo("submodules cannot be moved"));
    }
    if repo_of(&repos, from) != repo_of(&repos, to) {
        return Err(cross_repo("moving across repo or submodule boundaries"));
    }
    // a missing parent directory means `to` does not exist either
    if app.workspace.exists(to).unwrap_or(false) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "exists",
            format!("{to} already exists"),
        ));
    }
    Ok(repos)
}

struct Collected {
    /// every file of the repo before the move
    files: HashSet<String>,
    /// those at or below `from`, sorted
    moved: Vec<String>,
    /// references that change (computed from the text of open docs where there is one)
    plan: Vec<(FileCtx, Vec<Edit>)>,
}

/// Looks at the repo `from` is in.
async fn collect(
    app: &Arc<Project>,
    repos: Vec<Repo>,
    from: &str,
    to: &str,
    with_refs: bool,
) -> Result<Collected, ApiError> {
    let repo = repo_of(&repos, from);
    let (app, from, to) = (app.clone(), from.to_owned(), to.to_owned());
    tokio::task::spawn_blocking(move || {
        let entries = workspace::entries(app.workspace.root(), &repos);
        let files: HashSet<String> = (entries.into_iter())
            .filter(|e| e.kind == EntryKind::File && e.repo == repo)
            .map(|e| e.path)
            .collect();
        let mut texts = BTreeMap::new();
        for path in files.iter().filter(|_| with_refs) {
            if ![".tex", ".sty", ".cls"].iter().any(|e| path.ends_with(e)) {
                continue;
            }
            let text = match app.docs.get(path) {
                Some(room) => Some(room.text()),
                None => (app.workspace.read(path).ok())
                    .filter(|b| b.len() <= MAX_DOC_BYTES)
                    .and_then(|b| String::from_utf8(b).ok()),
            };
            texts.extend(text.map(|t| (path.clone(), t)));
        }
        let plan = plan(&texts, &files, &from, &to);
        let mut moved: Vec<String> = files
            .iter()
            .filter(|p| is_within(p, &from))
            .cloned()
            .collect();
        moved.sort();
        Collected { files, moved, plan }
    })
    .await
    .map_err(ApiError::internal)
}

pub async fn preview(
    ProjectCtx(app, _): ProjectCtx,
    Query(q): Query<PreviewQuery>,
) -> Result<Json<Preview>, ApiError> {
    let repos = check(&app, &q.from, &q.to).await?;
    let plan = collect(&app, repos, &q.from, &q.to, true).await?.plan;
    let references = (plan.into_iter())
        .flat_map(|(ctx, edits)| {
            edits.into_iter().map(move |e| Reference {
                path: ctx.path.clone(),
                line: e.line,
                old: e.old,
                new: e.new,
            })
        })
        .collect();
    Ok(Json(Preview { references }))
}

pub async fn post(
    ProjectCtx(app, role): ProjectCtx,
    auth: AuthSession,
    Json(b): Json<MoveBody>,
) -> Result<Json<MoveResult>, ApiError> {
    role.require(Role::Editor)?;
    let uid = auth.user().await.ok_or_else(ApiError::unauthorized)?.id;
    let (from, to) = (b.from.as_str(), b.to.as_str());
    let repos = check(&app, from, to).await?;
    let Collected { files, moved, plan } = collect(&app, repos, from, to, b.update_refs).await?;

    // open docs: no more edits, final text to disk, clients disconnected; then the rename
    // carries that text and nothing can write to the old path anymore
    for room in app.docs.retire_within(&app.workspace, from) {
        comments::persist(&app, &room).await;
    }
    let rename = {
        let app = app.clone();
        let (from, to) = (from.to_owned(), to.to_owned());
        move || app.workspace.rename(&from, &to)
    };
    let renamed = (tokio::task::spawn_blocking(rename).await)
        .map_err(std::io::Error::other)
        .and_then(|r| r);
    if let Err(e) = renamed {
        // the docs were retired above: clients must reconnect (`moved` with from == to)
        app.docs.close_moved(from, from, &app.events);
        return Err(match e.kind() {
            std::io::ErrorKind::AlreadyExists => ApiError::new(
                StatusCode::CONFLICT,
                "exists",
                format!("{to} already exists"),
            ),
            std::io::ErrorKind::NotFound => ApiError::not_found(format!("{from} not found")),
            _ => ApiError::internal(e),
        });
    }
    app.docs.close_moved(from, to, &app.events);
    // the file is moved now: what follows is best effort, an error must not turn into a 500
    // that makes the client think nothing happened
    if let Err(e) = comments::path_moved(&app, from, to).await {
        tracing::warn!("move {from} -> {to}: comments: {}", e.message);
    }
    if let Err(e) = crate::zotero::path_moved(&app.db, app.id, from, to).await {
        tracing::warn!("move {from} -> {to}: zotero links: {}", e.message);
    }
    if let Err(e) = main_files_moved(&app, from, to).await {
        tracing::warn!("move {from} -> {to}: main files: {}", e.message);
    }
    compile::roots_moved(&app, from, to);

    let mv = Mv {
        from,
        to,
        files: &files,
    };
    let mut updated_refs = Vec::new();
    for (ctx, _) in plan {
        let path = map_path(&ctx.path, from, to);
        let count = apply_to(&app, &mv, &ctx, &path).unwrap_or_else(|e| {
            tracing::warn!("move {from} -> {to}: rewriting {path}: {}", e.message);
            0
        });
        if count > 0 {
            app.contributions.touch(&path, uid);
            updated_refs.push(Updated { file: path, count });
        }
    }
    let _ = app.events.send(Event::TreeChanged);
    let moved = (moved.iter())
        .map(|p| Moved {
            from: p.clone(),
            to: map_path(p, from, to),
        })
        .collect();
    Ok(Json(MoveResult {
        moved,
        updated_refs,
    }))
}

/// Applies the reference rewrites of `ctx` to the file now at `path`: through its doc if it is
/// open (so collaborators see them), else on disk. Returns the number of references changed.
fn apply_to(app: &Project, mv: &Mv, ctx: &FileCtx, path: &str) -> Result<usize, ApiError> {
    if let Some(room) = app.docs.get(path) {
        let mut count = 0;
        room.edit(|cur| {
            let edits = scan(mv, ctx, cur);
            count = edits.len();
            Some(apply(cur, &edits))
        });
        return Ok(count);
    }
    let Some(text) = (app.workspace.read(path).ok()).and_then(|b| String::from_utf8(b).ok()) else {
        return Ok(0);
    };
    let edits = scan(mv, ctx, &text);
    if !edits.is_empty() {
        let new = apply(&text, &edits);
        app.workspace
            .write(path, new.as_bytes())
            .map_err(ApiError::internal)?;
    }
    Ok(edits.len())
}

/// `projects.main_files` entries at or below `from` follow the move.
async fn main_files_moved(app: &Project, from: &str, to: &str) -> Result<(), ApiError> {
    let old = app.compiler.main_files.lock().unwrap().clone();
    let new: Vec<String> = old.iter().map(|m| map_path(m, from, to)).collect();
    if new == old {
        return Ok(());
    }
    sqlx::query("UPDATE projects SET main_files = ? WHERE id = ?")
        .bind(serde_json::to_string(&new).map_err(ApiError::internal)?)
        .bind(app.id)
        .execute(&app.db)
        .await
        .map_err(ApiError::internal)?;
    *app.compiler.main_files.lock().unwrap() = new;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(file, "old -> new")` of every rewrite when `from` moves to `to`.
    fn run(files: &[(&str, &str)], other: &[&str], from: &str, to: &str) -> Vec<(String, String)> {
        let texts: BTreeMap<_, _> = (files.iter())
            .map(|(p, t)| (p.to_string(), t.to_string()))
            .collect();
        let all: HashSet<String> = (files.iter().map(|(p, _)| *p))
            .chain(other.iter().copied())
            .map(String::from)
            .collect();
        (plan(&texts, &all, from, to).into_iter())
            .flat_map(|(ctx, edits)| {
                edits
                    .into_iter()
                    .map(move |e| (ctx.path.clone(), format!("{} -> {}", e.old, e.new)))
            })
            .collect()
    }

    fn want(items: &[(&str, &str)]) -> Vec<(String, String)> {
        (items.iter())
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    const MAIN: &str = "\\documentclass{article}\n\\begin{document}\n";

    #[test]
    fn helpers() {
        assert_eq!(relpath("a/b", "a/c/d.tex"), "../c/d.tex");
        assert_eq!(relpath("", "x/y"), "x/y");
        assert_eq!(relpath("a", "a/b"), "b");
        assert_eq!(map_path("a/b/c", "a/b", "x"), "x/c");
        assert_eq!(map_path("a/bc", "a/b", "x"), "a/bc");
        assert_eq!(norm("a/./b/../c").as_deref(), Some("a/c"));
        assert_eq!(norm("../a"), None);
    }

    #[test]
    fn rewrites_moved_targets() {
        let main = format!(
            "{MAIN}\\input{{sec/a}}\n\\include{{sec/b.tex}}\n% \\input{{sec/a}}\n\\bibliography{{refs,other}}\n\\includegraphics[width=1cm]{{figs/f}}\n\\addbibresource{{x/refs.bib}}\n"
        );
        let files = [
            ("main.tex", main.as_str()),
            ("sec/a.tex", ""),
            ("sec/b.tex", ""),
        ];
        let other = ["refs.bib", "figs/f.png", "x/refs.bib"];
        let got = run(&files, &other, "sec", "chap/s");
        assert_eq!(
            got,
            want(&[
                ("main.tex", "sec/a -> chap/s/a"),
                ("main.tex", "sec/b.tex -> chap/s/b.tex"),
            ])
        );
        let got = run(&files, &other, "refs.bib", "bib/refs.bib");
        assert_eq!(got, want(&[("main.tex", "refs -> bib/refs")]));
        let got = run(&files, &other, "figs", "img");
        assert_eq!(got, want(&[("main.tex", "figs/f -> img/f")]));
        // a completed extension stays off, a changed one is written out
        let got = run(&files, &other, "sec/a.tex", "sec/c.tex");
        assert_eq!(got, want(&[("main.tex", "sec/a -> sec/c")]));
        let got = run(&files, &other, "figs/f.png", "figs/g.jpg");
        assert_eq!(got, want(&[("main.tex", "figs/f -> figs/g.jpg")]));
        // nothing references it
        assert!(run(&files, &other, "unrelated.txt", "u2.txt").is_empty());
    }

    #[test]
    fn moving_the_root_rebases_references() {
        let main = format!("{MAIN}\\input{{sec/a}}\n\\input{{p/inner}}\n");
        let files = [
            ("p/main.tex", main.as_str()),
            ("p/sec/a.tex", ""),
            ("p/p/inner.tex", ""),
        ];
        // the dir moves along: nothing to rewrite
        assert!(run(&files, &[], "p", "q").is_empty());
        // the root alone moves up: its references now need the old directory
        let got = run(&files, &[], "p/main.tex", "main.tex");
        assert_eq!(
            got,
            want(&[
                ("p/main.tex", "sec/a -> p/sec/a"),
                ("p/main.tex", "p/inner -> p/p/inner"),
            ])
        );
    }

    #[test]
    fn graphicspath_and_import() {
        let main = format!(
            "{MAIN}\\graphicspath{{{{figs/}}{{more/}}}}\n\\includegraphics{{f}}\n\\import{{sec/}}{{a}}\n"
        );
        let files = [("main.tex", main.as_str()), ("sec/a.tex", "")];
        let other = ["figs/f.png"];
        let got = run(&files, &other, "figs", "img");
        assert_eq!(got, want(&[("main.tex", "figs/ -> img/")]));
        // the file leaves the graphicspath directory
        let got = run(&files, &other, "figs/f.png", "g.png");
        assert_eq!(got, want(&[("main.tex", "f -> g")]));
        let got = run(&files, &other, "sec", "chapters");
        assert_eq!(got, want(&[("main.tex", "sec/ -> chapters/")]));
        let got = run(&files, &other, "sec/a.tex", "sec/deep/a.tex");
        assert_eq!(got, want(&[("main.tex", "a -> deep/a")]));
    }

    #[test]
    fn imported_files_resolve_against_their_import_dir() {
        let main = format!("{MAIN}\\subimport{{chap/}}{{a}}\n");
        let a = "\\subimport{sub/}{b}\n\\input{x}\n";
        let files = [
            ("main.tex", main.as_str()),
            ("chap/a.tex", a),
            ("chap/sub/b.tex", ""),
            ("chap/x.tex", ""),
        ];
        let got = run(&files, &[], "chap/sub/b.tex", "chap/sub/c.tex");
        assert_eq!(got, want(&[("chap/a.tex", "b -> c")]));
        let got = run(&files, &[], "chap/x.tex", "chap/y.tex");
        assert_eq!(got, want(&[("chap/a.tex", "x -> y")]));
        // the whole import dir moves: the import's dir argument follows, a.tex stays correct
        let got = run(&files, &[], "chap", "text");
        assert_eq!(got, want(&[("main.tex", "chap/ -> text/")]));
    }

    #[test]
    fn verbatim_and_computed_paths_are_left_alone() {
        let main = format!(
            "{MAIN}\\begin{{verbatim}}\n\\input{{sec/a}}\n\\end{{verbatim}}\n\\input{{\\jobname-x}}\n"
        );
        let files = [("main.tex", main.as_str()), ("sec/a.tex", "")];
        assert!(run(&files, &[], "sec", "chap").is_empty());
    }
}
