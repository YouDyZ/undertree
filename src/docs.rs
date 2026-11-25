//! Collaborative documents: one `yrs` doc per open file, y-websocket protocol on
//! `WS /ws/projects/{pid}/doc/{*path}`, debounced disk writes and merging of external changes
//! (docs/API.md → Documents, AGENTS.md §3).
//!
//! Invariants:
//! - while a room exists, its doc is the source of truth; disk is written 1 s after the last edit
//! - `Room::disk` is what we last read from / wrote to disk: a file event whose content equals it is
//!   our own write (no feedback loop), anything else is an external change and gets 3-way merged
//! - the doc's CRDT state is persisted in `$UNDERTREE_DATA/projects/{pid}/ydocs`, so clients reconnecting after
//!   an unload or server restart merge into the same history instead of duplicating the text

use std::{
    collections::{HashMap, HashSet},
    path::{Path as FsPath, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    extract::{
        ws::{CloseFrame, Message as WsMessage, WebSocket},
        Path, WebSocketUpgrade,
    },
    response::Response,
};
use notify_debouncer_full::{
    new_debouncer,
    notify::{event::ModifyKind, EventKind, RecursiveMode},
    DebounceEventResult,
};
use similar::DiffTag;
use tokio::sync::{broadcast, Notify};
use yrs::{
    encoding::read::Cursor,
    sync::{Awareness, DefaultProtocol, Message, MessageReader, Protocol, SyncMessage},
    updates::{
        decoder::{Decode, DecoderV1},
        encoder::Encode,
    },
    ClientID, GetString, ReadTxn, StateVector, Text, TextRef, Transact, Transaction,
    TransactionMut, Update,
};

use crate::{
    auth::AuthSession,
    error::ApiError,
    events::{Event, Events},
    projects::{gone, Project, ProjectCtx, Role},
    workspace::{is_within, write_atomic, Workspace},
};

const DEBOUNCE: Duration = Duration::from_millis(1000);
/// Largest file the editor opens; writes into open docs and Zotero imports are capped to it.
pub const MAX_DOC_BYTES: usize = 8 * 1024 * 1024;

pub const CLOSE_UNAUTHORIZED: u16 = 4401;
pub const CLOSE_NOT_FOUND: u16 = 4404;
pub const CLOSE_NOT_TEXT: u16 = 4415;
/// the user's role in the project changed: reconnect (not terminal for the client)
pub const CLOSE_ROLE_CHANGED: u16 = 4403;

#[derive(Clone, Debug)]
enum Out {
    Frame(Vec<u8>),
    Close(u16),
}

pub struct Room {
    path: String,
    state_file: PathBuf,
    awareness: Mutex<Awareness>,
    text: TextRef,
    tx: broadcast::Sender<Out>,
    /// file content as we last read/wrote it (lock order: never take `awareness` → `disk`)
    disk: Mutex<String>,
    dirty: Arc<Notify>,
    /// set by the update observer: the last transaction changed the doc (read under `awareness`)
    changed: Arc<AtomicBool>,
    dead: AtomicBool,
    conns: Mutex<usize>,
    /// comment thread id → anchors in `text` (`comments.rs`; lock order: `awareness` → `comments`)
    pub comments: Mutex<HashMap<i64, crate::comments::Anchor>>,
}

/// Rewrites `old` into `new` inside `txn` with minimal char-level edits, so concurrent
/// cursors outside the changed regions stay where they are.
fn apply_diff(txn: &mut TransactionMut, text: &TextRef, old: &str, new: &str) {
    if old == new {
        return;
    }
    let offsets = |s: &str| -> Vec<u32> {
        s.char_indices()
            .map(|(i, _)| i as u32)
            .chain([s.len() as u32])
            .collect()
    };
    let (ob, nb) = (offsets(old), offsets(new));
    let diff = similar::TextDiff::configure()
        .timeout(Duration::from_millis(500))
        .diff_chars(old, new);
    // back to front: earlier byte offsets stay valid
    for op in diff.ops().iter().rev() {
        if op.tag() == DiffTag::Equal {
            continue;
        }
        let (o, n) = (op.old_range(), op.new_range());
        let start = ob[o.start];
        if o.end > o.start {
            text.remove_range(txn, start, ob[o.end] - start);
        }
        if n.end > n.start {
            text.insert(txn, start, &new[nb[n.start] as usize..nb[n.end] as usize]);
        }
    }
}

impl Room {
    fn load(path: &str, bytes: Vec<u8>, state_file: PathBuf) -> Result<Self, u16> {
        if bytes.len() > MAX_DOC_BYTES || bytes.contains(&0) {
            return Err(CLOSE_NOT_TEXT);
        }
        let disk = String::from_utf8(bytes).map_err(|_| CLOSE_NOT_TEXT)?;

        let doc = yrs::Doc::new();
        let text = doc.get_or_insert_text("content");
        {
            let mut txn = doc.transact_mut();
            if let Some(update) = std::fs::read(&state_file)
                .ok()
                .and_then(|s| Update::decode_v1(&s).ok())
            {
                if let Err(e) = txn.apply_update(update) {
                    tracing::warn!("{path}: ignoring corrupt CRDT state: {e}");
                }
            }
            let stored = text.get_string(&txn);
            apply_diff(&mut txn, &text, &stored, &disk);
        }

        let (tx, _) = broadcast::channel(1024);
        let dirty = Arc::new(Notify::new());
        let changed = Arc::new(AtomicBool::new(false));
        let (tx2, dirty2, changed2) = (tx.clone(), dirty.clone(), changed.clone());
        // yrs only fires this for transactions that changed the doc
        doc.observe_update_v1("broadcast", move |_, e| {
            let msg = Message::Sync(SyncMessage::Update(e.update.clone())).encode_v1();
            let _ = tx2.send(Out::Frame(msg));
            dirty2.notify_one();
            changed2.store(true, Ordering::SeqCst);
        })
        .expect("fresh doc has no open transaction");
        let mut awareness = Awareness::new(doc);
        let tx3 = tx.clone();
        awareness.on_update("broadcast", move |aw, e, _| {
            if let Ok(update) = aw.update_with_clients(e.all_changes()) {
                let _ = tx3.send(Out::Frame(Message::Awareness(update).encode_v1()));
            }
        });

        Ok(Self {
            path: path.to_owned(),
            state_file,
            awareness: Mutex::new(awareness),
            text,
            tx,
            disk: Mutex::new(disk),
            dirty,
            changed,
            dead: AtomicBool::new(false),
            conns: Mutex::new(0),
            comments: Mutex::default(),
        })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn text(&self) -> String {
        self.read(|txn, text| text.get_string(txn))
    }

    /// Runs `f` on a read transaction of the doc (holds the doc lock meanwhile).
    pub fn read<R>(&self, f: impl FnOnce(&Transaction, &TextRef) -> R) -> R {
        let aw = self.awareness.lock().unwrap();
        let txn = aw.doc().transact();
        f(&txn, &self.text)
    }

    /// Applies y-sync messages from one client. Returns encoded replies for that client and
    /// whether the doc changed (not just sync/awareness); records which awareness client ids it
    /// controls (removed again when it disconnects). `read_only` clients (viewer/commenter) still
    /// get the doc and awareness, their updates are dropped unapplied.
    fn handle(
        &self,
        data: &[u8],
        controlled: &mut HashSet<ClientID>,
        read_only: bool,
    ) -> Result<(Vec<Vec<u8>>, bool), yrs::sync::Error> {
        let mut aw = self.awareness.lock().unwrap();
        if self.dead.load(Ordering::SeqCst) {
            return Ok((Vec::new(), false)); // retired: the update is dropped, the close frame follows
        }
        self.changed.store(false, Ordering::SeqCst);
        let mut decoder = DecoderV1::new(Cursor::new(data));
        let mut replies = Vec::new();
        for msg in MessageReader::new(&mut decoder) {
            let msg = msg?;
            if read_only
                && matches!(
                    msg,
                    Message::Sync(SyncMessage::SyncStep2(_) | SyncMessage::Update(_))
                )
            {
                continue;
            }
            if let Message::Awareness(update) = &msg {
                controlled.extend(update.clients.keys().copied());
            }
            if let Some(reply) = DefaultProtocol.handle_message(&mut aw, msg)? {
                replies.push(reply.encode_v1());
            }
        }
        Ok((replies, self.changed.load(Ordering::SeqCst)))
    }

    /// Replaces the whole content (PUT /api/files on an open doc).
    pub fn replace(&self, new: &str) {
        let aw = self.awareness.lock().unwrap();
        let mut txn = aw.doc().transact_mut();
        let old = self.text.get_string(&txn);
        apply_diff(&mut txn, &self.text, &old, new);
    }

    /// Rewrites the text from its current state in one transaction (no edit slips in between):
    /// `f` gets the text and returns the new one.
    pub fn edit(&self, f: impl FnOnce(&str) -> Option<String>) {
        let aw = self.awareness.lock().unwrap();
        let mut txn = aw.doc().transact_mut();
        let old = self.text.get_string(&txn);
        if let Some(new) = f(&old) {
            apply_diff(&mut txn, &self.text, &old, &new);
        }
    }

    /// Merges an external change on disk into the doc. Returns whether anything changed.
    pub fn sync_from_disk(&self, workspace: &Workspace, events: &Events) -> bool {
        let bytes = match workspace.read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("{}: disk read failed: {e}", self.path);
                }
                return false;
            }
        };
        let Ok(new) = String::from_utf8(bytes) else {
            tracing::warn!("{}: ignoring non-UTF-8 disk contents", self.path);
            return false;
        };
        let mut disk = self.disk.lock().unwrap();
        if new == *disk {
            return false; // our own write echoing back
        }
        {
            let aw = self.awareness.lock().unwrap();
            let mut txn = aw.doc().transact_mut();
            let ours = self.text.get_string(&txn);
            // base = last known disk state; conflicts keep both sides with git-style markers
            let merged = diffy::merge(&disk, &ours, &new).unwrap_or_else(|conflicted| conflicted);
            apply_diff(&mut txn, &self.text, &ours, &merged);
        }
        *disk = new;
        let _ = events.send(Event::DocReloaded {
            path: self.path.clone(),
        });
        true
    }

    /// Writes the doc to disk if it differs, and persists the CRDT state.
    fn flush(&self, workspace: &Workspace, events: &Events) {
        if self.dead.load(Ordering::SeqCst) {
            return;
        }
        // pick up external edits first so we never overwrite them
        // ponytail: an external write landing between this check and our write is lost; only a
        // file lock (which git/editors don't honor) would close that window
        self.sync_from_disk(workspace, events);
        let (text, state) = {
            let aw = self.awareness.lock().unwrap();
            let txn = aw.doc().transact();
            (
                self.text.get_string(&txn),
                txn.encode_state_as_update_v1(&StateVector::default()),
            )
        };
        let mut disk = self.disk.lock().unwrap();
        // `retire` sets `dead` and then takes this lock: nothing is written after it returned
        if self.dead.load(Ordering::SeqCst) {
            return;
        }
        if *disk != text {
            match workspace.write(&self.path, text.as_bytes()) {
                Ok(()) => *disk = text,
                Err(e) => tracing::error!("{}: disk write failed: {e}", self.path),
            }
        }
        if let Err(e) = write_atomic(&self.state_file, &state) {
            tracing::warn!("{}: persisting CRDT state failed: {e}", self.path);
        }
    }

    /// The file is about to be renamed: no more edits are accepted, the final text goes to disk
    /// (`path` is still valid) and everybody is disconnected (4404).
    fn retire(&self, workspace: &Workspace) {
        let text = {
            let aw = self.awareness.lock().unwrap();
            // set under the doc lock: `handle` either applied its update before this read or
            // sees `dead` and drops it
            self.dead.store(true, Ordering::SeqCst);
            let text = self.text.get_string(&aw.doc().transact());
            text
        };
        let mut disk = self.disk.lock().unwrap();
        if *disk != text {
            match workspace.write(&self.path, text.as_bytes()) {
                Ok(()) => *disk = text,
                Err(e) => tracing::error!("{}: disk write failed: {e}", self.path),
            }
        }
        let _ = self.tx.send(Out::Close(CLOSE_NOT_FOUND));
        let _ = std::fs::remove_file(&self.state_file);
        self.dirty.notify_one();
    }

    /// File is gone: disconnect everybody and forget the CRDT state.
    fn kill(&self) {
        self.dead.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Out::Close(CLOSE_NOT_FOUND));
        let _ = std::fs::remove_file(&self.state_file);
        self.dirty.notify_one(); // lets the flush task see it was unloaded and exit
    }
}

pub struct Docs {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    state_dir: PathBuf,
}

impl Docs {
    pub fn new(state_dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&state_dir)?;
        Ok(Self {
            rooms: Mutex::default(),
            state_dir,
        })
    }

    pub fn get(&self, path: &str) -> Option<Arc<Room>> {
        self.rooms.lock().unwrap().get(path).cloned()
    }

    /// File was deleted (API or externally): close its room, notify clients.
    pub fn delete(&self, path: &str, events: &Events) {
        if let Some(room) = self.rooms.lock().unwrap().remove(path) {
            room.kill();
            let _ = events.send(Event::DocDeleted { path: path.into() });
        }
    }

    /// Project deleted: disconnect every doc socket (4404).
    pub fn close_all(&self) {
        for (_, room) in self.rooms.lock().unwrap().drain() {
            room.kill();
        }
    }

    /// Writes every open doc below `repo` to disk now, so git sees the current text. Returns them.
    pub fn flush_repo(&self, workspace: &Workspace, repo: &str, events: &Events) -> Vec<Arc<Room>> {
        let rooms: Vec<_> = (self.rooms.lock().unwrap().iter())
            .filter(|(path, _)| is_within(path, repo))
            .map(|(_, room)| room.clone())
            .collect();
        for room in &rooms {
            room.flush(workspace, events);
        }
        rooms
    }

    /// Before `from` is renamed: unregisters the rooms at or below it, writes their final text
    /// and disconnects their clients (4404). Returns them (for comment anchors).
    pub fn retire_within(&self, workspace: &Workspace, from: &str) -> Vec<Arc<Room>> {
        let gone: Vec<_> = {
            let mut rooms = self.rooms.lock().unwrap();
            let keys: Vec<_> = rooms
                .keys()
                .filter(|p| is_within(p, from))
                .cloned()
                .collect();
            keys.iter().filter_map(|k| rooms.remove(k)).collect()
        };
        for room in &gone {
            room.retire(workspace);
        }
        gone
    }

    /// `from` was renamed to `to` on disk: announce it and close what a late join opened below
    /// `from` meanwhile (clients reopen the docs by their new path).
    pub fn close_moved(&self, from: &str, to: &str, events: &Events) {
        let gone: Vec<_> = {
            let mut rooms = self.rooms.lock().unwrap();
            let keys: Vec<_> = rooms
                .keys()
                .filter(|p| is_within(p, from))
                .cloned()
                .collect();
            keys.iter().filter_map(|k| rooms.remove(k)).collect()
        };
        let _ = events.send(Event::Moved {
            from: from.into(),
            to: to.into(),
        });
        for room in gone {
            room.kill();
        }
    }

    /// Returns the room for `path` with one more connection, loading it on first use.
    /// `Ok(true)` = newly loaded (caller starts the flush task).
    async fn join(&self, ws: &Workspace, path: &str) -> Result<(Arc<Room>, bool), u16> {
        ws.resolve(path).map_err(|_| CLOSE_NOT_FOUND)?;
        if Workspace::in_uninitialized(&ws.repos().await, path) {
            return Err(CLOSE_NOT_FOUND);
        }
        let mut rooms = self.rooms.lock().unwrap();
        let (room, new) = match rooms.get(path) {
            Some(room) => (room.clone(), false),
            None => {
                // ponytail: overlong paths would exceed the 255-byte file name limit
                let name = path.replace('%', "%25").replace('/', "%2F");
                let bytes = ws.read(path).map_err(|_| CLOSE_NOT_FOUND)?;
                let room = Arc::new(Room::load(path, bytes, self.state_dir.join(name))?);
                rooms.insert(path.to_owned(), room.clone());
                (room, true)
            }
        };
        *room.conns.lock().unwrap() += 1;
        Ok((room, new))
    }

    fn leave(&self, room: &Room) {
        *room.conns.lock().unwrap() -= 1;
        room.dirty.notify_one(); // flush task flushes, then unloads if nobody is left
    }

    /// Unloads `room` if it has no connections. Returns whether its flush task should stop.
    fn try_unload(&self, room: &Arc<Room>) -> bool {
        let mut rooms = self.rooms.lock().unwrap();
        let current = rooms.get(&room.path).is_some_and(|r| Arc::ptr_eq(r, room));
        if !current {
            return true; // deleted or replaced
        }
        if *room.conns.lock().unwrap() == 0 {
            rooms.remove(&room.path);
            return true;
        }
        false
    }
}

async fn flush_loop(app: Arc<Project>, room: Arc<Room>) {
    loop {
        room.dirty.notified().await;
        while tokio::time::timeout(DEBOUNCE, room.dirty.notified())
            .await
            .is_ok()
        {}
        room.flush(&app.workspace, &app.events);
        crate::comments::persist(&app, &room).await;
        if app.docs.try_unload(&room) {
            return;
        }
    }
}

/// Routed outside `require_login`: auth/access failures become close codes after the upgrade.
pub async fn ws(
    project: Result<ProjectCtx, ApiError>,
    auth: AuthSession,
    Path((_, path)): Path<(String, String)>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let user = auth.user().await;
    upgrade.on_upgrade(move |mut socket| async move {
        // the role is read once per connection; a role change closes the socket (see session)
        let (app, user, read_only) = match (project, user) {
            (Ok(ProjectCtx(app, role)), Some(user)) => (app, user, role < Role::Editor),
            (Err(e), _) if e.status != axum::http::StatusCode::UNAUTHORIZED => {
                return close(&mut socket, CLOSE_NOT_FOUND).await
            }
            _ => return close(&mut socket, CLOSE_UNAUTHORIZED).await,
        };
        // before `join`: a member change in between must not be missed
        let changed = app.member_changed.subscribe();
        let (room, new) = match app.docs.join(&app.workspace, &path).await {
            Ok(r) => r,
            Err(code) => return close(&mut socket, code).await,
        };
        if new {
            crate::comments::attach(&app, &room).await;
            tokio::spawn(flush_loop(app.clone(), room.clone()));
        }
        session(socket, &room, read_only, (changed, &user.username), || {
            app.contributions.touch(&room.path, user.id)
        })
        .await;
        app.docs.leave(&room);
    })
}

async fn close(socket: &mut WebSocket, code: u16) {
    let frame = CloseFrame {
        code,
        reason: "".into(),
    };
    let _ = socket.send(WsMessage::Close(Some(frame))).await;
}

/// `on_edit` runs after each client message that changed the doc.
async fn session(
    mut socket: WebSocket,
    room: &Room,
    read_only: bool,
    (mut changed, me): (broadcast::Receiver<String>, &str),
    on_edit: impl Fn(),
) {
    let mut rx = room.tx.subscribe();
    // one message per frame: the browser's y-websocket decodes only the first message of a
    // frame (unlike yrs' MessageReader), so SyncStep1 and awareness must not share one (#18)
    let start = {
        let aw = room.awareness.lock().unwrap();
        let sv = aw.doc().transact().state_vector();
        let mut frames = vec![Message::Sync(SyncMessage::SyncStep1(sv)).encode_v1()];
        if aw.iter().any(|(_, s)| s.data.is_some()) {
            if let Ok(update) = aw.update() {
                frames.push(Message::Awareness(update).encode_v1());
            }
        }
        frames
    };
    for frame in start {
        if socket.send(WsMessage::Binary(frame.into())).await.is_err() {
            return;
        }
    }
    let mut controlled = HashSet::new();
    loop {
        tokio::select! {
            msg = socket.recv() => match msg {
                Some(Ok(WsMessage::Binary(data))) => match room.handle(&data, &mut controlled, read_only) {
                    Ok((replies, changed)) => {
                        if changed {
                            on_edit();
                        }
                        for r in replies {
                            if socket.send(WsMessage::Binary(r.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("{}: bad y-sync message: {e}", room.path);
                        break;
                    }
                },
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {} // text/ping/pong
            },
            who = changed.recv() => match who {
                Ok(name) if name != me => {}
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    close(&mut socket, CLOSE_ROLE_CHANGED).await;
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            out = rx.recv() => match out {
                Ok(Out::Frame(f)) => {
                    if socket.send(WsMessage::Binary(f.into())).await.is_err() {
                        break;
                    }
                }
                Ok(Out::Close(code)) => {
                    close(&mut socket, code).await;
                    break;
                }
                // missed updates: resend the full state, the client merges it idempotently
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let full = {
                        let aw = room.awareness.lock().unwrap();
                        let update = aw.doc().transact().encode_state_as_update_v1(&StateVector::default());
                        Message::Sync(SyncMessage::SyncStep2(update)).encode_v1()
                    };
                    if socket.send(WsMessage::Binary(full.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
    let mut aw = room.awareness.lock().unwrap();
    for id in controlled {
        aw.remove_state(id);
    }
}

/// Watches the workspace: external edits are merged into open docs, deletions close them,
/// structural changes emit `tree_changed`. Runs until the project is deleted.
pub fn spawn_watcher(app: Arc<Project>) -> notify_debouncer_full::notify::Result<()> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(Duration::from_millis(200), None, tx)?;
    let root = app.workspace.root().to_owned();
    debouncer.watch(&root, RecursiveMode::Recursive)?;
    let mut deleted = app.deleted.subscribe();
    tokio::spawn(async move {
        let _keep_alive = debouncer;
        loop {
            let batch = tokio::select! {
                _ = gone(&mut deleted) => return,
                batch = rx.recv() => match batch {
                    Some(batch) => batch,
                    None => return,
                },
            };
            let Ok(events) = batch else { continue };
            let mut tree_changed = false;
            for ev in events {
                let ours = ev.paths.iter().any(|p| is_tmp(p));
                let structural = matches!(
                    ev.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(ModifyKind::Name(_))
                );
                for p in &ev.paths {
                    let Some(rel) = relative(&root, p) else {
                        continue;
                    };
                    tree_changed |= structural && !ours;
                    crate::compile::changed(&app, &rel);
                    let Some(room) = app.docs.get(&rel) else {
                        continue;
                    };
                    match app.workspace.exists(&rel) {
                        Ok(true) => {
                            room.sync_from_disk(&app.workspace, &app.events);
                        }
                        Ok(false) if !ours => app.docs.delete(&rel, &app.events),
                        Ok(false) => {}
                        Err(e) => tracing::warn!("{rel}: file watcher check failed: {e}"),
                    }
                }
            }
            if tree_changed {
                let _ = app.events.send(Event::TreeChanged);
            }
        }
    });
    Ok(())
}

fn is_tmp(p: &FsPath) -> bool {
    p.file_name()
        .is_some_and(|n| n.to_string_lossy().ends_with(".undertree-tmp"))
}

/// Workspace-relative `/` path, `None` for anything inside `.git` or temp files.
fn relative(root: &FsPath, p: &FsPath) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        let s = c.as_os_str().to_str()?;
        if s == ".git" {
            return None;
        }
        parts.push(s);
    }
    (!parts.is_empty() && !is_tmp(p)).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewrite(old: &str, new: &str) -> String {
        let doc = yrs::Doc::new();
        let text = doc.get_or_insert_text("content");
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, old);
        apply_diff(&mut txn, &text, old, new);
        text.get_string(&txn)
    }

    #[test]
    fn apply_diff_reaches_target() {
        for (old, new) in [
            ("", "hello"),
            ("hello", ""),
            ("hello world", "hello brave new world"),
            ("Größe ≈ 3 €", "Größe ≈ 4,5 € 🎉"),
            ("a\nb\nc\n", "a\nc\nd\n"),
        ] {
            assert_eq!(rewrite(old, new), new);
        }
    }

    #[test]
    fn external_change_merges_with_unflushed_edit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("main.tex");
        std::fs::write(&file, "intro\nmiddle\nend\n").unwrap();
        let workspace = Workspace::open(dir.path()).unwrap();
        let room = Room::load(
            "main.tex",
            workspace.read("main.tex").unwrap(),
            dir.path().join("state"),
        )
        .unwrap();
        let events = crate::events::channel();
        let mut rx = events.subscribe();

        // own write echo: no-op
        assert!(!room.sync_from_disk(&workspace, &events));

        // user edit not yet flushed + external change elsewhere in the file
        room.replace("intro EDITED\nmiddle\nend\n");
        std::fs::write(&file, "intro\nmiddle\nend PULLED\n").unwrap();
        assert!(room.sync_from_disk(&workspace, &events));
        assert_eq!(room.text(), "intro EDITED\nmiddle\nend PULLED\n");
        assert!(matches!(rx.try_recv(), Ok(Event::DocReloaded { .. })));

        // flush writes the merge; CRDT state survives a reload without duplicating text
        room.flush(&workspace, &events);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), room.text());
        let reloaded = Room::load(
            "main.tex",
            workspace.read("main.tex").unwrap(),
            dir.path().join("state"),
        )
        .unwrap();
        assert_eq!(reloaded.text(), room.text());
    }

    #[test]
    fn rejects_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.png"), [0x89, b'P', 0, 0xff]).unwrap();
        let workspace = Workspace::open(dir.path()).unwrap();
        let r = Room::load(
            "x.png",
            workspace.read("x.png").unwrap(),
            dir.path().join("s"),
        );
        assert!(matches!(r, Err(CLOSE_NOT_TEXT)));
        assert!(workspace.read("nope").is_err());
    }

    #[test]
    fn external_symlink_cannot_escape_workspace_during_sync_or_flush() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = dir.path().join("main.tex");
        let secret = outside.path().join("secret.tex");
        std::fs::write(&file, "inside\n").unwrap();
        std::fs::write(&secret, "secret\n").unwrap();
        let workspace = Workspace::open(dir.path()).unwrap();
        let room = Room::load(
            "main.tex",
            workspace.read("main.tex").unwrap(),
            dir.path().join("state"),
        )
        .unwrap();
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&secret, &file).unwrap();

        assert!(!room.sync_from_disk(&workspace, &crate::events::channel()));
        room.replace("changed\n");
        room.flush(&workspace, &crate::events::channel());
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "secret\n");
        assert!(std::fs::symlink_metadata(&file).unwrap().is_symlink());
    }

    #[test]
    fn relative_skips_git_and_tmp() {
        let root = FsPath::new("/w");
        assert_eq!(
            relative(root, FsPath::new("/w/a/b.tex")).as_deref(),
            Some("a/b.tex")
        );
        assert_eq!(relative(root, FsPath::new("/w/.git/index")), None);
        assert_eq!(relative(root, FsPath::new("/w/p/.git")), None);
        assert_eq!(relative(root, FsPath::new("/w/.b.tex.undertree-tmp")), None);
        assert_eq!(relative(root, FsPath::new("/w")), None);
    }
}
