import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ChatMessage,
  type PresenceUser,
  type Project,
  type ServerEvent,
  type User,
  errorText,
  getMe,
  getProject,
  setActiveProject,
} from "./api";
import { AdminPage } from "./components/AdminPage";
import { AppShell } from "./components/AppShell";
import { AlertIcon } from "./components/Icons";
import { LoginPage } from "./components/LoginPage";
import { PdfPopoutPage } from "./components/PdfPopoutPage";
import { ProjectListPage } from "./components/ProjectListPage";
import { TemplatesPage } from "./components/TemplatesPage";
import { linkClick, parseRoute } from "./lib/route";
import { EventsClient, type EventsConnectionState } from "./ws/events";

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: User };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const route = parseRoute(pathname);

  const redirectToLogin = useCallback(() => {
    setAuth({ status: "unauthenticated" });
    if (window.location.pathname !== "/login") {
      const current = `${window.location.pathname}${window.location.search}`;
      const target =
        current && current !== "/"
          ? `/login?next=${encodeURIComponent(current)}`
          : "/login";
      window.history.replaceState(null, "", target);
      setPathname("/login");
    }
  }, []);

  useEffect(() => {
    let active = true;
    getMe()
      .then((user) => {
        if (!active) return;
        setAuth({ status: "authenticated", user });
        if (window.location.pathname === "/login") {
          window.history.replaceState(null, "", "/");
          setPathname("/");
        }
      })
      .catch(() => {
        if (active) setAuth({ status: "unauthenticated" });
      });
    return () => {
      active = false;
    };
  }, []);

  if (auth.status === "loading" && route.name !== "login") {
    return (
      <div class="boot-screen">
        <div class="boot-spinner" />
        <span>Verbinde mit undertree…</span>
      </div>
    );
  }

  if (auth.status !== "authenticated") {
    return (
      <LoginPage
        onAuthenticated={(user) => {
          setAuth({ status: "authenticated", user });
          setPathname(window.location.pathname);
        }}
      />
    );
  }

  const user = auth.user;
  switch (route.name) {
    case "project":
      return <ProjectView key={route.pid} pid={route.pid} user={user} onLoggedOut={redirectToLogin} />;
    case "project_pdf":
      return <PdfPopoutPage key={route.pid} pid={route.pid} onLoggedOut={redirectToLogin} />;
    case "templates":
      return <TemplatesPage user={user} onLoggedOut={redirectToLogin} />;
    case "admin":
      return <AdminPage user={user} onLoggedOut={redirectToLogin} />;
    case "not_found":
      return <NotFound message="Diese Seite gibt es nicht." />;
    default:
      return <ProjectListPage user={user} onLoggedOut={redirectToLogin} />;
  }
}

function NotFound({ message }: { message: string }) {
  return (
    <div class="boot-screen">
      <AlertIcon size={20} />
      <span>{message}</span>
      <a href="/" class="btn-ghost btn-sm" onClick={linkClick}>
        Zur Projektliste
      </a>
    </div>
  );
}

interface ProjectViewProps {
  pid: number;
  user: User;
  onLoggedOut: () => void;
}

/** Loads the project, points all workspace API/WS calls at it and owns its event stream. */
function ProjectView({ pid, user, onLoggedOut }: ProjectViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wsState, setWsState] = useState<EventsConnectionState>("disconnected");
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, [pid]);

  const refreshProject = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const next = await getProject(pid);
      if (!mountedRef.current) return;
      setActiveProject(next.id);
      setProject(next);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) {
        onLoggedOut();
      } else if (err instanceof ApiError && err.status === 404) {
        setLoadError("Projekt wurde gelöscht oder dein Zugriff entzogen.");
      }
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [pid, onLoggedOut]);

  // chat messages are delivered one by one: as `lastEvent` they could overwrite each other
  const [chatResync, setChatResync] = useState(0);
  const chatListeners = useRef(new Set<(m: ChatMessage) => void>());
  const subscribeChat = useCallback((fn: (m: ChatMessage) => void) => {
    chatListeners.current.add(fn);
    return () => {
      chatListeners.current.delete(fn);
    };
  }, []);

  useEffect(() => {
    let active = true;
    getProject(pid)
      .then((p) => {
        if (!active) return;
        setActiveProject(p.id);
        setProject(p);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          onLoggedOut();
          return;
        }
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? "Projekt nicht gefunden oder kein Zugriff."
            : errorText(err, "Projekt konnte nicht geladen werden.")
        );
      });
    return () => {
      active = false;
      setActiveProject(null);
    };
  }, [pid, onLoggedOut]);

  const loaded = project !== null;
  const eventsRef = useRef<EventsClient | null>(null);
  const reportFocus = useCallback((path: string | null) => eventsRef.current?.setFocus(path), []);
  useEffect(() => {
    if (!loaded) return;
    const client = new EventsClient({
      onUnauthorized: onLoggedOut,
      onProjectGone: () => setLoadError("Projekt wurde gelöscht oder dein Zugriff entzogen."),
    });
    const unsubState = client.onStateChange((state) => {
      setWsState(state);
      // a (re)connect starts with a fresh snapshot; until then the old list is stale
      if (state !== "connected") setPresence([]);
    });
    // presence has its own state: as `lastEvent` it could overwrite another event in one render
    const unsubEvents = client.subscribe((ev) => {
      if (ev.type === "presence") setPresence(ev.users);
      else if (ev.type === "chat_resync") setChatResync((n) => n + 1);
      else if (ev.type === "chat") chatListeners.current.forEach((fn) => fn(ev.message));
      else setLastEvent(ev);
    });
    eventsRef.current = client;
    client.connect();
    return () => {
      eventsRef.current = null;
      unsubState();
      unsubEvents();
      client.dispose();
    };
  }, [loaded, onLoggedOut]);

  if (loadError) return <NotFound message={loadError} />;
  if (!project) {
    return (
      <div class="boot-screen">
        <div class="boot-spinner" />
        <span>Lade Projekt…</span>
      </div>
    );
  }

  return (
    <AppShell
      user={user}
      project={project}
      onProjectChanged={setProject}
      onRefreshProject={refreshProject}
      wsState={wsState}
      presence={presence}
      onFocusChange={reportFocus}
      lastEvent={lastEvent}
      subscribeChat={subscribeChat}
      chatResync={chatResync}
      onLoggedOut={onLoggedOut}
    />
  );
}
