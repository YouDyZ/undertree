//! `WS /ws/projects/{pid}/events`: server → client JSON events (docs/API.md → Events).

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket},
        WebSocketUpgrade,
    },
    response::Response,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::{self, error::RecvError};

use crate::{
    auth::{AuthSession, User},
    compile::{CompileResult, CompileState},
    docs::CLOSE_NOT_FOUND,
    projects::{gone, Project, ProjectCtx},
};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    TreeChanged,
    DocReloaded {
        path: String,
    },
    DocDeleted {
        path: String,
    },
    /// file or directory renamed/moved; its open docs were closed (docs/API.md → Move)
    Moved {
        from: String,
        to: String,
    },
    /// `result` is set exactly for the final states `success` / `failed`
    Compile {
        root: String,
        state: CompileState,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<CompileResult>,
    },
    GitChanged {
        repo: String,
    },
    /// comment threads of `path` changed (docs/API.md → Comments)
    Comments {
        path: String,
    },
    /// chat message created, edited or deleted (docs/API.md → Chat)
    Chat {
        message: crate::chat::ChatMessage,
    },
    /// sent after missed events (slow client): refetch the newest chat messages
    ChatResync,
    /// everybody connected to the project; sent on connect and whenever it changes
    Presence {
        users: Vec<PresenceUser>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PresenceUser {
    pub username: String,
    pub display_name: String,
    /// workspace-relative path the user has in focus (latest focus report over all their
    /// windows); `None` = no editor focused / window in the background
    pub file: Option<String>,
}

/// Live events-socket connections of one project and what each has in focus, in memory only.
#[derive(Default)]
pub struct Presence(Mutex<PresenceState>);

#[derive(Default)]
struct PresenceState {
    next_id: u64,
    /// orders focus reports across connections: the user's latest one wins
    focus_seq: u64,
    conns: HashMap<u64, Conn>,
    /// last aggregated view; broadcast only when it changes
    view: Vec<PresenceUser>,
}

struct Conn {
    uid: i64,
    username: String,
    display_name: String,
    focus: Option<String>,
    focus_seq: u64,
}

/// One entry per user over all their connections (file = their latest focus report), sorted
/// by display name.
fn aggregate<'a>(conns: impl Iterator<Item = &'a Conn>) -> Vec<PresenceUser> {
    let mut users: HashMap<i64, &Conn> = HashMap::new();
    for c in conns {
        let latest = users.entry(c.uid).or_insert(c);
        if c.focus_seq > latest.focus_seq {
            *latest = c;
        }
    }
    let mut view: Vec<_> = (users.into_values())
        .map(|c| PresenceUser {
            username: c.username.clone(),
            display_name: c.display_name.clone(),
            file: c.focus.clone(),
        })
        .collect();
    view.sort_by(|a, b| (&a.display_name, &a.username).cmp(&(&b.display_name, &b.username)));
    view
}

impl Presence {
    pub fn users(&self) -> Vec<PresenceUser> {
        self.0.lock().unwrap().view.clone()
    }

    /// Applies `f`, then broadcasts the view if it changed (under the lock, so in order).
    fn update<T>(&self, events: &Events, f: impl FnOnce(&mut PresenceState) -> T) -> T {
        // no unwrap: `leave` runs in a drop guard, possibly while unwinding
        let mut s = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let out = f(&mut s);
        let view = aggregate(s.conns.values());
        if view != s.view {
            s.view = view.clone();
            let _ = events.send(Event::Presence { users: view });
        }
        out
    }

    fn join(&self, events: &Events, uid: i64, username: &str, display_name: &str) -> u64 {
        self.update(events, |s| {
            s.next_id += 1;
            let conn = Conn {
                uid,
                username: username.into(),
                display_name: display_name.into(),
                focus: None,
                focus_seq: 0,
            };
            s.conns.insert(s.next_id, conn);
            s.next_id
        })
    }

    fn leave(&self, events: &Events, id: u64) {
        self.update(events, |s| s.conns.remove(&id));
    }

    fn focus(&self, events: &Events, id: u64, path: Option<String>) {
        self.update(events, |s| {
            s.focus_seq += 1;
            let seq = s.focus_seq;
            if let Some(c) = s.conns.get_mut(&id) {
                c.focus = path;
                c.focus_seq = seq;
            }
        });
    }
}

/// A focus path as reported by a client: workspace-relative, normalized, bounded. It is only a
/// label shown to project members, but must not smuggle odd strings into other users' UIs.
fn valid_focus(path: &str) -> bool {
    path.len() <= 1024
        && !path.starts_with('/')
        && !path.chars().any(|c| c.is_control() || c == '\\')
        && path
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// Client → server frame on the events socket.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Focus { path: Option<String> },
}

/// Registers an events connection of `user` until the guard drops.
fn present(app: &Arc<Project>, user: &User) -> PresenceGuard {
    let id = (app.presence).join(&app.events, user.id, &user.username, &user.display_name);
    PresenceGuard {
        app: app.clone(),
        id,
    }
}

struct PresenceGuard {
    app: Arc<Project>,
    id: u64,
}

impl PresenceGuard {
    fn focus(&self, path: Option<String>) {
        (self.app.presence).focus(&self.app.events, self.id, path);
    }
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.app.presence.leave(&self.app.events, self.id);
    }
}

pub type Events = broadcast::Sender<Event>;

pub fn channel() -> Events {
    broadcast::channel(256).0
}

pub async fn ws(
    ProjectCtx(app, _): ProjectCtx,
    auth: AuthSession,
    upgrade: WebSocketUpgrade,
) -> Response {
    let rx = app.events.subscribe();
    let user = auth.user().await;
    upgrade.on_upgrade(move |socket| async move {
        let presence = user.as_ref().map(|u| present(&app, u));
        forward(socket, rx, &app, presence.as_ref(), user.as_ref()).await
    })
}

/// Member of the project, or a site admin (who acts as owner everywhere).
async fn still_member(app: &Project, user: &User) -> bool {
    user.is_admin
        || sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .bind(app.id)
        .bind(user.id)
        .fetch_one(&app.db)
        .await
        // DB trouble: fail closed
        .is_ok_and(|n| n > 0)
}

async fn send(socket: &mut WebSocket, ev: &Event) -> Result<(), axum::Error> {
    let json = serde_json::to_string(ev).expect("events serialize");
    socket.send(Message::Text(json.into())).await
}

async fn forward(
    mut socket: WebSocket,
    mut rx: broadcast::Receiver<Event>,
    app: &Project,
    presence: Option<&PresenceGuard>,
    user: Option<&User>,
) {
    let mut deleted = app.deleted.subscribe();
    let mut changed = app.member_changed.subscribe();
    // `rx` is older than this snapshot: presence events queued in it may be stale, but the last
    // one queued is the current view again, so the client always ends up up to date
    let snapshot = Event::Presence {
        users: app.presence.users(),
    };
    if send(&mut socket, &snapshot).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            _ = gone(&mut deleted) => {
                let frame = CloseFrame { code: CLOSE_NOT_FOUND, reason: "".into() };
                let _ = socket.send(Message::Close(Some(frame))).await;
                return;
            }
            // chat messages carry content: a removed member must not keep receiving them. Role
            // changes keep the socket (viewers read the chat).
            who = changed.recv() => {
                let relevant = match (&who, user) {
                    (Ok(name), Some(u)) => *name == u.username,
                    (Ok(_), None) => false,
                    _ => true, // lagged: re-check to be safe
                };
                let removed = match user {
                    Some(u) if relevant => !still_member(app, u).await,
                    _ => false,
                };
                if removed {
                    let frame = CloseFrame { code: CLOSE_NOT_FOUND, reason: "".into() };
                    let _ = socket.send(Message::Close(Some(frame))).await;
                    return;
                }
                if matches!(who, Err(RecvError::Closed)) {
                    return;
                }
            }
            ev = rx.recv() => match ev {
                Ok(ev) => {
                    if send(&mut socket, &ev).await.is_err() {
                        return;
                    }
                }
                // slow client missed events: a tree refresh and the presence are the catch-all
                Err(RecvError::Lagged(_)) => {
                    let users = app.presence.users();
                    for ev in [Event::TreeChanged, Event::ChatResync, Event::Presence { users }] {
                        if send(&mut socket, &ev).await.is_err() {
                            return;
                        }
                    }
                }
                Err(RecvError::Closed) => return,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    // unknown or malformed frames are ignored (forward compatible)
                    if let (Some(p), Ok(ClientMessage::Focus { path })) =
                        (presence, serde_json::from_str(&text))
                    {
                        // an invalid path counts as no focus
                        p.focus(path.filter(|p| valid_focus(p)));
                    }
                }
                Some(Ok(_)) => {}
                // None/Err = client went away
                _ => return,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn presence_shows_the_latest_focus_per_user() {
        let events = channel();
        let mut rx = events.subscribe();
        let p = Presence::default();
        let b1 = p.join(&events, 2, "bob", "Bob");
        p.join(&events, 1, "alice", "Alice");
        let b2 = p.join(&events, 2, "bob", "Bob"); // second window
        assert_eq!(std::iter::from_fn(|| rx.try_recv().ok()).count(), 2);
        p.focus(&events, b1, Some("z.tex".into()));
        p.focus(&events, b2, Some("a.tex".into()));
        assert_eq!(
            serde_json::to_value(Event::Presence { users: p.users() }).unwrap(),
            json!({ "type": "presence", "users": [
                { "username": "alice", "display_name": "Alice", "file": null },
                { "username": "bob", "display_name": "Bob", "file": "a.tex" },
            ]})
        );
        assert_eq!(std::iter::from_fn(|| rx.try_recv().ok()).count(), 2);
        // the other window reports focus again: it is the latest now
        p.focus(&events, b1, Some("z.tex".into()));
        assert!(
            matches!(rx.try_recv(), Ok(Event::Presence { users }) if users[1].file.as_deref() == Some("z.tex"))
        );
        // closing the window that is not the latest changes nothing: no broadcast
        p.leave(&events, b2);
        assert!(rx.try_recv().is_err());
        p.focus(&events, b1, None);
        assert!(matches!(rx.try_recv(), Ok(Event::Presence { users }) if users[1].file.is_none()));
    }

    #[test]
    fn focus_paths_are_validated() {
        for ok in ["main.tex", "papers/a/main.tex", "a b/ä.tex"] {
            assert!(valid_focus(ok), "{ok}");
        }
        let long = "a".repeat(1025);
        for bad in [
            "",
            "/etc/passwd",
            "a/../b",
            "./a",
            "a//b",
            "a\\b",
            "a\nb",
            long.as_str(),
        ] {
            assert!(!valid_focus(bad), "{bad:?}");
        }
    }

    #[test]
    fn compile_event_shapes() {
        let ev = |state, result| {
            serde_json::to_value(Event::Compile {
                root: "p/main.tex".into(),
                state,
                result,
            })
            .unwrap()
        };
        assert_eq!(
            ev(CompileState::Running, None),
            json!({ "type": "compile", "root": "p/main.tex", "state": "running" })
        );
        let result = CompileResult {
            root: "p/main.tex".into(),
            state: CompileState::Failed,
            started_at: "2026-01-01T00:00:00Z".into(),
            duration_ms: 5,
            pdf_url: None,
            diagnostics: vec![],
            engine: crate::compile::Engine::Xelatex,
            engine_reason: "package:fontspec".into(),
        };
        assert_eq!(
            ev(CompileState::Failed, Some(result)),
            json!({ "type": "compile", "root": "p/main.tex", "state": "failed", "result": {
                "root": "p/main.tex", "state": "failed", "started_at": "2026-01-01T00:00:00Z",
                "duration_ms": 5, "pdf_url": null, "diagnostics": [],
                "engine": "xelatex", "engine_reason": "package:fontspec"
            }})
        );
    }
}
