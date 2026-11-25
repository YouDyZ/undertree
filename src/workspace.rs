//! Workspace = parent repo + (recursive) submodules. Path confinement, tree, files REST
//! (docs/API.md → Workspace).

use std::{
    io::{ErrorKind, Read, Write},
    path::{Path as FsPath, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use axum::{
    body::Bytes,
    extract::Path,
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use cap_std::{
    ambient_authority,
    fs::{Dir, File, OpenOptions},
};
use serde::Serialize;

use crate::{
    auth::AuthSession,
    docs::MAX_DOC_BYTES,
    error::ApiError,
    events::Event,
    git,
    projects::{Project, ProjectCtx, Role},
};

pub struct Workspace {
    /// canonical, so `starts_with` checks are meaningful
    root: PathBuf,
    dir: Dir,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RepoKind {
    Parent,
    Submodule,
}

#[derive(Clone, Debug, Serialize)]
pub struct Repo {
    pub path: String,
    pub name: String,
    pub kind: RepoKind,
    pub initialized: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Serialize)]
pub struct Entry {
    pub path: String,
    pub kind: EntryKind,
    pub repo: String,
}

#[derive(Serialize)]
pub struct Tree {
    pub repos: Vec<Repo>,
    pub entries: Vec<Entry>,
}

/// `rel` is `repo` itself or below it (`""` = parent contains everything).
pub fn is_within(rel: &str, repo: &str) -> bool {
    repo.is_empty()
        || rel == repo
        || rel
            .strip_prefix(repo)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Path of the innermost repo containing `rel`.
pub fn repo_of(repos: &[Repo], rel: &str) -> String {
    repos
        .iter()
        .filter(|r| is_within(rel, &r.path))
        .max_by_key(|r| r.path.len())
        .map(|r| r.path.clone())
        .unwrap_or_default()
}

impl Workspace {
    pub fn open(path: &FsPath) -> std::io::Result<Self> {
        let root = std::fs::canonicalize(path)?;
        if !root.is_dir() {
            return Err(std::io::Error::other(format!(
                "{} is not a directory",
                root.display()
            )));
        }
        let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
        Ok(Self { root, dir })
    }

    pub fn root(&self) -> &FsPath {
        &self.root
    }

    /// Maps a workspace-relative path to an absolute one that is guaranteed to stay inside the
    /// workspace: no absolute paths, `.`/`..`/empty segments, `.git`, backslashes or NUL, and
    /// no symlink (incl. dangling ones) that leads outside or into a `.git` directory.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, ApiError> {
        let bad = || ApiError::invalid_path(rel);
        if rel.is_empty() || rel.starts_with('/') || rel.contains(['\\', '\0']) {
            return Err(bad());
        }
        let mut path = self.root.clone();
        for seg in rel.split('/') {
            if seg.is_empty() || seg == "." || seg == ".." || seg.eq_ignore_ascii_case(".git") {
                return Err(bad());
            }
            path.push(seg);
        }
        // Canonicalize the deepest existing component, including internal symlinks. Dangling
        // links count as existing, so canonicalize rejects them instead of following them later.
        let mut existing = path.as_path();
        while std::fs::symlink_metadata(existing).is_err() {
            existing = existing.parent().ok_or_else(bad)?;
        }
        let canonical = existing.canonicalize().map_err(|_| bad())?;
        // No `.git` anywhere in the real location: a symlink must not reach git metadata (config,
        // hooks, `.git/modules/*` of submodules), neither for writes nor for reads (tokens).
        let real = canonical.strip_prefix(&self.root).map_err(|_| bad())?;
        if real
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
        {
            return Err(bad());
        }
        let remaining = path.strip_prefix(existing).map_err(|_| bad())?;
        if remaining.as_os_str().is_empty() {
            Ok(canonical)
        } else {
            Ok(canonical.join(remaining))
        }
    }

    fn parent(&self, rel: &str, create: bool) -> std::io::Result<SafeParent> {
        self.resolve(rel).map_err(|_| {
            std::io::Error::new(ErrorKind::PermissionDenied, "invalid workspace path")
        })?;
        let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
        if create && !parent.is_empty() {
            self.dir.create_dir_all(parent)?;
        }
        let dir = if parent.is_empty() {
            self.dir.try_clone()?
        } else {
            self.dir.open_dir(parent)?
        };
        Ok(SafeParent {
            dir,
            name: name.to_owned(),
        })
    }

    pub fn open_file(&self, rel: &str) -> std::io::Result<File> {
        self.resolve(rel).map_err(|_| {
            std::io::Error::new(ErrorKind::PermissionDenied, "invalid workspace path")
        })?;
        self.dir.open(rel)
    }

    pub fn open_dir(&self, rel: &str) -> std::io::Result<Dir> {
        if rel.is_empty() {
            return self.dir.try_clone();
        }
        self.resolve(rel).map_err(|_| {
            std::io::Error::new(ErrorKind::PermissionDenied, "invalid workspace path")
        })?;
        self.dir.open_dir(rel)
    }

    pub fn read(&self, rel: &str) -> std::io::Result<Vec<u8>> {
        let mut file = self.open_file(rel)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub fn write(&self, rel: &str, data: &[u8]) -> std::io::Result<()> {
        self.parent(rel, true)?.write_atomic(data)
    }

    pub fn exists(&self, rel: &str) -> std::io::Result<bool> {
        let parent = self.parent(rel, false)?;
        match parent.dir.symlink_metadata(&parent.name) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Renames `from` to `to` (creating its parent dirs); fails with `AlreadyExists` instead of
    /// replacing whatever is at `to` (atomic `RENAME_NOREPLACE`).
    pub fn rename(&self, from: &str, to: &str) -> std::io::Result<()> {
        use rustix::fs::{renameat_with, RenameFlags};
        use rustix::io::Errno;
        let src = self.parent(from, false)?;
        let dst = self.parent(to, true)?;
        match renameat_with(
            &src.dir,
            &src.name,
            &dst.dir,
            &dst.name,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => Ok(()),
            // filesystem without NOREPLACE: the caller's exists-check has to do
            Err(Errno::INVAL | Errno::NOSYS) => src.dir.rename(&src.name, &dst.dir, &dst.name),
            Err(e) => Err(e.into()),
        }
    }

    pub fn remove(&self, rel: &str) -> std::io::Result<()> {
        let parent = self.parent(rel, false)?;
        let metadata = parent.dir.symlink_metadata(&parent.name)?;
        if metadata.is_dir() {
            parent.dir.remove_dir(&parent.name)
        } else {
            parent.dir.remove_file(&parent.name)
        }
    }

    /// Parent repo first, then all submodules (recursive) sorted by path.
    pub async fn repos(&self) -> Vec<Repo> {
        let mut subs = Vec::new();
        let mut queue = vec![String::new()];
        while let Some(base) = queue.pop() {
            let dir = self.root.join(&base);
            let args = [
                "config",
                "-z",
                "-f",
                ".gitmodules",
                "--get-regexp",
                r"^submodule\..*\.path$",
            ];
            let Some(list) = git::stdout(&dir, &args).await else {
                continue;
            };
            for item in list.split('\0') {
                let Some((_, path)) = item.split_once('\n') else {
                    continue;
                };
                let rel = if base.is_empty() {
                    path.to_owned()
                } else {
                    format!("{base}/{path}")
                };
                // .gitmodules is repo content: never let it point outside the workspace
                if self.resolve(&rel).is_err() {
                    tracing::warn!("ignoring submodule with invalid path {rel:?}");
                    continue;
                }
                let initialized = self.root.join(&rel).join(".git").exists();
                subs.push(self.repo_info(&rel, RepoKind::Submodule, initialized).await);
                if initialized {
                    queue.push(rel);
                }
            }
        }
        subs.sort_by(|a, b| a.path.cmp(&b.path));
        let mut repos = vec![self.repo_info("", RepoKind::Parent, true).await];
        repos.extend(subs);
        repos
    }

    async fn repo_info(&self, rel: &str, kind: RepoKind, initialized: bool) -> Repo {
        let dir = self.root.join(rel);
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (branch, head) = if initialized {
            (
                git::stdout(&dir, &["symbolic-ref", "--short", "-q", "HEAD"]).await,
                git::stdout(&dir, &["rev-parse", "--short", "HEAD"]).await,
            )
        } else {
            (None, None)
        };
        Repo {
            path: rel.to_owned(),
            name,
            kind,
            initialized,
            branch,
            head,
        }
    }

    /// Writes must not land in a submodule that isn't checked out (would break `submodule update --init`).
    pub(crate) fn in_uninitialized(repos: &[Repo], rel: &str) -> bool {
        repos
            .iter()
            .any(|r| !r.initialized && is_within(rel, &r.path))
    }
}

struct SafeParent {
    dir: Dir,
    name: String,
}

impl SafeParent {
    fn exists(&self) -> std::io::Result<bool> {
        match self.dir.symlink_metadata(&self.name) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn write_atomic(self, data: &[u8]) -> std::io::Result<()> {
        static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

        for _ in 0..100 {
            let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let tmp = format!(".undertree-{}-{id}.undertree-tmp", std::process::id());
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = match self.dir.open_with(&tmp, &options) {
                Ok(file) => file,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            };
            if let Err(e) = file.write_all(data).and_then(|()| file.sync_all()) {
                let _ = self.dir.remove_file(&tmp);
                return Err(e);
            }
            if let Err(e) = self.dir.rename(&tmp, &self.dir, &self.name) {
                let _ = self.dir.remove_file(&tmp);
                return Err(e);
            }
            return Ok(());
        }
        Err(std::io::Error::new(
            ErrorKind::AlreadyExists,
            "unable to allocate temporary workspace file",
        ))
    }
}

/// Blocking: recursive listing, skips `.git`, symlinks, non-UTF-8 names and uninitialized submodules.
// ponytail: symlinks are hidden from the tree, list them if papers start relying on them
pub(crate) fn entries(root: &FsPath, repos: &[Repo]) -> Vec<Entry> {
    fn walk(root: &FsPath, rel_dir: &str, repos: &[Repo], out: &mut Vec<Entry>) {
        let Ok(dir) = std::fs::read_dir(root.join(rel_dir)) else {
            return;
        };
        for entry in dir.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let Ok(ft) = entry.file_type() else { continue };
            if name == ".git" || ft.is_symlink() {
                continue;
            }
            let rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            let repo = repo_of(repos, &rel);
            if ft.is_dir() {
                if Workspace::in_uninitialized(repos, &rel) {
                    continue;
                }
                walk(root, &rel, repos, out);
                out.push(Entry {
                    path: rel,
                    kind: EntryKind::Dir,
                    repo,
                });
            } else {
                out.push(Entry {
                    path: rel,
                    kind: EntryKind::File,
                    repo,
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", repos, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

pub async fn tree(ProjectCtx(app, _): ProjectCtx) -> Result<Json<Tree>, ApiError> {
    let repos = app.workspace.repos().await;
    let root = app.workspace.root.clone();
    let r = repos.clone();
    let entries = tokio::task::spawn_blocking(move || entries(&root, &r))
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(Tree { repos, entries }))
}

fn content_type(path: &FsPath) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "tex" | "bib" | "sty" | "cls" | "bst" | "txt" | "md" | "latexmkrc" | "csv" | "tikz" => {
            "text/plain; charset=utf-8"
        }
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        // scripts inside SVGs are blocked by the CSP set in `get_file`
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Temp file + rename in the same dir: readers (latexmk, git) never see a half-written file.
pub fn write_atomic(path: &FsPath, data: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().expect("absolute file path");
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .expect("absolute file path")
        .to_string_lossy();
    let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
    SafeParent {
        dir,
        name: name.into_owned(),
    }
    .write_atomic(data)
}

fn io_error(e: std::io::Error, rel: &str) -> ApiError {
    match e.kind() {
        ErrorKind::NotFound => ApiError::not_found(format!("{rel} not found")),
        ErrorKind::IsADirectory => ApiError::bad_request(format!("{rel} is a directory")),
        ErrorKind::DirectoryNotEmpty => ApiError::conflict(format!("{rel} is not empty")),
        _ => ApiError::internal(e),
    }
}

pub async fn get_file(
    ProjectCtx(app, _): ProjectCtx,
    Path((_, rel)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    app.workspace.resolve(&rel)?;
    if Workspace::in_uninitialized(&app.workspace.repos().await, &rel) {
        return Err(ApiError::invalid_path(&rel));
    }
    let file = app
        .workspace
        .open_file(&rel)
        .map_err(|e| io_error(e, &rel))?;
    let bytes = tokio::task::spawn_blocking(move || {
        let mut file = file;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(|e| io_error(e, &rel))?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type(FsPath::new(&rel))),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    ))
}

async fn uid(auth: &AuthSession) -> Result<i64, ApiError> {
    Ok(auth.user().await.ok_or_else(ApiError::unauthorized)?.id)
}

pub async fn put_file(
    ProjectCtx(app, role): ProjectCtx,
    auth: AuthSession,
    Path((_, rel)): Path<(String, String)>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    role.require(Role::Editor)?;
    write_file(&app, uid(&auth).await?, rel, body).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Writes `rel` as user `uid` like `PUT …/files`: through the CRDT if the doc is open.
pub async fn write_file(app: &Project, uid: i64, rel: String, body: Bytes) -> Result<(), ApiError> {
    app.workspace.resolve(&rel)?;
    if Workspace::in_uninitialized(&app.workspace.repos().await, &rel) {
        return Err(ApiError::invalid_path(&rel));
    }
    // open doc: the CRDT is the truth, route the change through it (flush writes the file)
    if let Some(room) = app.docs.get(&rel) {
        // same rules as opening a doc (`Room::load`), else it could never be reopened
        if body.len() > MAX_DOC_BYTES {
            return Err(ApiError::too_large(format!(
                "{rel} is open in the editor, which holds at most {} MiB",
                MAX_DOC_BYTES >> 20
            )));
        }
        let text = std::str::from_utf8(&body)
            .ok()
            .filter(|t| !t.contains('\0'))
            .ok_or_else(|| ApiError::bad_request("open documents only accept UTF-8 text"))?;
        room.replace(text);
        app.contributions.touch(&rel, uid);
        return Ok(());
    }
    let parent = app
        .workspace
        .parent(&rel, true)
        .map_err(|e| io_error(e, &rel))?;
    if parent.dir.open_dir(&parent.name).is_ok() {
        return Err(ApiError::bad_request(format!("{rel} is a directory")));
    }
    let existed = parent.exists().map_err(|e| io_error(e, &rel))?;
    tokio::task::spawn_blocking(move || parent.write_atomic(&body))
        .await
        .map_err(ApiError::internal)?
        .map_err(|e| io_error(e, &rel))?;
    app.contributions.touch(&rel, uid);
    if !existed {
        let _ = app.events.send(Event::TreeChanged);
    }
    Ok(())
}

pub async fn delete_file(
    ProjectCtx(app, role): ProjectCtx,
    auth: AuthSession,
    Path((_, rel)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    role.require(Role::Editor)?;
    let uid = uid(&auth).await?;
    app.workspace.resolve(&rel)?;
    if Workspace::in_uninitialized(&app.workspace.repos().await, &rel) {
        return Err(ApiError::invalid_path(&rel));
    }
    let parent = app
        .workspace
        .parent(&rel, false)
        .map_err(|e| io_error(e, &rel))?;
    let meta = parent
        .dir
        .symlink_metadata(&parent.name)
        .map_err(|e| io_error(e, &rel))?;
    let remove = move || {
        if meta.is_dir() {
            parent.dir.remove_dir(&parent.name)
        } else {
            parent.dir.remove_file(&parent.name)
        }
    };
    tokio::task::spawn_blocking(remove)
        .await
        .map_err(ApiError::internal)?
        .map_err(|e| io_error(e, &rel))?;
    app.contributions.touch(&rel, uid);
    app.docs.delete(&rel, &app.events);
    crate::comments::file_deleted(&app, &rel).await?;
    crate::zotero::file_deleted(&app.db, app.id, &rel).await?;
    let _ = app.events.send(Event::TreeChanged);
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::process::Command;

    pub fn git(dir: &FsPath, args: &[&str]) {
        let out = Command::new("git")
            .args(["-c", "protocol.file.allow=always"])
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repo_with(dir: &FsPath, file: &str) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join(file), "x").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "init"]);
    }

    /// `parent/` with initialized submodule `papers/a` (main.tex) and uninitialized `papers/b`.
    pub fn fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        repo_with(&t.join("a"), "main.tex");
        repo_with(&t.join("b"), "other.tex");
        let parent = t.join("parent");
        repo_with(&parent, "README.md");
        git(&parent, &["submodule", "add", "-q", "../a", "papers/a"]);
        git(&parent, &["submodule", "add", "-q", "../b", "papers/b"]);
        git(&parent, &["commit", "-qm", "subs"]);
        git(&parent, &["submodule", "deinit", "-q", "-f", "papers/b"]);
        (tmp, parent)
    }

    #[test]
    fn rename_never_replaces() {
        let (_tmp, parent) = fixture();
        let ws = Workspace::open(&parent).unwrap();
        std::fs::write(parent.join("a.txt"), "a").unwrap();
        std::fs::write(parent.join("b.txt"), "b").unwrap();
        std::fs::create_dir_all(parent.join("d/e")).unwrap();
        let err = ws.rename("a.txt", "b.txt").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(parent.join("b.txt")).unwrap(), "b");
        // also not onto an (empty) directory
        let err = ws.rename("a.txt", "d/e").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        ws.rename("a.txt", "d/new/c.txt").unwrap();
        assert_eq!(
            std::fs::read_to_string(parent.join("d/new/c.txt")).unwrap(),
            "a"
        );
        assert!(!parent.join("a.txt").exists());
    }

    #[test]
    fn resolve_confines_paths() {
        let (tmp, parent) = fixture();
        let ws = Workspace::open(&parent).unwrap();
        std::os::unix::fs::symlink(tmp.path(), parent.join("escape")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/x", parent.join("dangling")).unwrap();
        std::os::unix::fs::symlink("README.md", parent.join("inner")).unwrap();

        assert!(ws.resolve("papers/a/main.tex").is_ok());
        assert!(ws.resolve("papers/a/main.tex").unwrap().is_file());
        assert!(ws.resolve("new/dir/file.tex").is_ok());
        assert_eq!(ws.resolve("inner").unwrap(), parent.join("README.md"));
        std::os::unix::fs::symlink(".git", parent.join("gitlink")).unwrap();
        std::os::unix::fs::symlink(".git/hooks", parent.join("deep")).unwrap();
        std::os::unix::fs::symlink("../.git/config", parent.join("papers/cfg")).unwrap();
        std::os::unix::fs::symlink("../.GIT/modules/papers/a", parent.join("papers/mod")).unwrap();
        std::os::unix::fs::symlink("gitlink", parent.join("chain")).unwrap();
        std::os::unix::fs::symlink("papers", parent.join("dirlink")).unwrap();
        assert_eq!(ws.resolve("dirlink/a").unwrap(), parent.join("papers/a"));
        for bad in [
            "gitlink",
            "gitlink/config",
            "gitlink/new",
            "deep",
            "deep/pre-commit",
            "chain/config",
            "papers/cfg",
            "papers/mod/config",
        ] {
            assert!(ws.resolve(bad).is_err(), "{bad:?} must be rejected");
            assert!(ws.read(bad).is_err(), "{bad:?} must not be readable");
            assert!(ws.write(bad, b"x").is_err(), "{bad:?} must not be writable");
            assert!(ws.remove(bad).is_err(), "{bad:?} must not be removable");
        }
        assert!(parent.join(".git/config").is_file());
        assert!(!parent.join(".git/hooks/pre-commit").exists());
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "papers/../../x",
            "a//b",
            "./a",
            "a/",
            ".git/config",
            "papers/a/.GIT/HEAD",
            "a\\b",
            "a\0b",
            "escape/b/other.tex",
            "escape/new",
            "dangling",
        ] {
            assert!(ws.resolve(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[tokio::test]
    async fn tree_distinguishes_parent_and_submodules() {
        let (_tmp, parent) = fixture();
        let ws = Workspace::open(&parent).unwrap();
        let repos = ws.repos().await;
        let summary: Vec<_> = repos
            .iter()
            .map(|r| (r.path.as_str(), r.kind.clone(), r.initialized))
            .collect();
        assert_eq!(
            summary,
            [
                ("", RepoKind::Parent, true),
                ("papers/a", RepoKind::Submodule, true),
                ("papers/b", RepoKind::Submodule, false),
            ]
        );
        assert_eq!(repos[1].branch.as_deref(), Some("main"));
        assert!(repos[1].head.is_some());
        assert_eq!(repos[0].name, "parent");

        let entries = entries(&ws.root, &repos);
        let got: Vec<_> = entries
            .iter()
            .map(|e| (e.path.as_str(), e.repo.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (".gitmodules", ""),
                ("README.md", ""),
                ("papers", ""),
                ("papers/a", "papers/a"),
                ("papers/a/main.tex", "papers/a"),
            ]
        );
        assert!(Workspace::in_uninitialized(&repos, "papers/b/new.tex"));
        assert!(!Workspace::in_uninitialized(&repos, "papers/bb/new.tex"));
    }
}
