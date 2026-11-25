import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { type User, encodeWorkspacePath, projectWsPath, wsBaseUrl } from "../api";
import { getUserColor } from "./userColor";

export type DocSyncStatus = "connecting" | "connected" | "synced" | "disconnected" | "error";

export interface PeerUser {
  clientId: number;
  name: string;
  username?: string;
  color: string;
  colorLight: string;
}

export interface DocSessionSnapshot {
  status: DocSyncStatus;
  errorCode: number | null;
  errorMessage: string | null;
  peers: PeerUser[];
}

export interface DocSessionOptions {
  path: string;
  repo: string;
  user: User;
  wsBase?: string;
  onUnauthorized?: () => void;
  /** Called when the server closes with 4403 because the caller's project role changed. */
  onRoleChanged?: () => void;
  WebSocketPolyfill?: typeof WebSocket;
}

const CLOSE_MESSAGES: Record<number, string> = {
  4401: "Sitzung abgelaufen — bitte erneut anmelden.",
  4404: "Datei wurde auf dem Server nicht gefunden.",
  4415: "Keine Textdatei (Binärformat) — kollaboratives Bearbeiten nicht möglich.",
};

export function describeDocCloseCode(code: number, fallbackReason?: string): string {
  return CLOSE_MESSAGES[code] ?? (fallbackReason || `Verbindung geschlossen (Code ${code}).`);
}

export function extractRemotePeers(
  states: Map<number, Record<string, unknown>>,
  localClientId: number
): PeerUser[] {
  const peers: PeerUser[] = [];
  for (const [clientId, state] of states.entries()) {
    if (clientId === localClientId) continue;
    const rawUser = state?.user;
    if (!rawUser || typeof rawUser !== "object") continue;
    const u = rawUser as Partial<{
      name: unknown;
      username: unknown;
      color: unknown;
      colorLight: unknown;
    }>;
    if (typeof u.name !== "string" || !u.name.trim()) continue;
    const color = typeof u.color === "string" ? u.color : "#38bdf8";
    const colorLight = typeof u.colorLight === "string" ? u.colorLight : `${color}33`;
    const peer: PeerUser = { clientId, name: u.name, color, colorLight };
    if (typeof u.username === "string" && u.username.trim()) {
      peer.username = u.username;
    }
    peers.push(peer);
  }
  peers.sort((a, b) => a.name.localeCompare(b.name));
  return peers;
}

type SnapshotListener = (snapshot: DocSessionSnapshot) => void;

/**
 * Manages a single collaborative Yjs document session bound to `WS /ws/projects/{pid}/doc/{*path}`.
 */
export class DocSession {
  readonly path: string;
  readonly repo: string;
  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly undoManager: Y.UndoManager;
  readonly provider: WebsocketProvider;

  private snapshot: DocSessionSnapshot = {
    status: "connecting",
    errorCode: null,
    errorMessage: null,
    peers: [],
  };
  private readonly listeners = new Set<SnapshotListener>();
  private readonly onUnauthorized?: () => void;
  private readonly onRoleChanged?: () => void;
  private destroyed = false;

  constructor(options: DocSessionOptions) {
    this.path = options.path;
    this.repo = options.repo;
    this.onUnauthorized = options.onUnauthorized;
    this.onRoleChanged = options.onRoleChanged;

    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("content");
    this.undoManager = new Y.UndoManager(this.ytext);

    const encodedRoom = encodeWorkspacePath(options.path);
    const serverUrl = `${options.wsBase ?? wsBaseUrl()}${projectWsPath()}/doc`;

    this.provider = new WebsocketProvider(serverUrl, encodedRoom, this.ydoc, {
      disableBc: true,
      WebSocketPolyfill: options.WebSocketPolyfill,
      // y-websocket treats 4400-4499 as permanent; 4403 means role changed so reconnect must continue.
      shouldReconnect: (event) =>
        event.code === 4403 || !(event.code >= 4400 && event.code < 4500),
    });

    const palette = getUserColor(options.user.username);
    this.provider.awareness.setLocalStateField("user", {
      username: options.user.username,
      name: options.user.display_name,
      color: palette.color,
      colorLight: palette.colorLight,
    });

    this.provider.on("status", ({ status }: { status: "connected" | "disconnected" | "connecting" }) => {
      if (this.destroyed || this.snapshot.errorCode !== null) return;
      if (status === "connected") {
        // Request full awareness state as a dedicated frame (y-websocket reads 1 message per WS frame)
        if (this.provider.ws && this.provider.ws.readyState === WebSocket.OPEN) {
          this.provider.ws.send(new Uint8Array([3]));
        }
      }
      if (status === "connected" && this.provider.synced) {
        this.update({ status: "synced" });
      } else {
        this.update({ status });
      }
    });

    this.provider.on("sync", (isSynced: boolean) => {
      if (this.destroyed || this.snapshot.errorCode !== null) return;
      if (isSynced) {
        this.update({ status: "synced" });
      } else if (this.provider.wsconnected) {
        this.update({ status: "connected" });
      }
    });

    this.provider.on("closed", ({ code, reason }: { code: number; reason: string }) => {
      if (this.destroyed) return;
      this.handleTerminalClose(code, reason);
    });

    this.provider.on("connection-close", (event: CloseEvent | null) => {
      if (this.destroyed || !event) return;
      if (event.code === 4401 || event.code === 4404 || event.code === 4415) {
        this.handleTerminalClose(event.code, event.reason);
      } else if (event.code === 4403) {
        // Non-terminal: y-websocket reconnects and picks up the new permissions on the server.
        this.onRoleChanged?.();
      }
    });

    const handleAwareness = () => {
      if (this.destroyed) return;
      const peers = extractRemotePeers(
        this.provider.awareness.getStates() as Map<number, Record<string, unknown>>,
        this.ydoc.clientID
      );
      this.update({ peers });
    };
    this.provider.awareness.on("change", handleAwareness);
  }

  getSnapshot(): DocSessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  retry(): void {
    if (this.destroyed) return;
    this.update({
      status: "connecting",
      errorCode: null,
      errorMessage: null,
    });
    this.provider.connect();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    this.provider.destroy();
    this.undoManager.destroy();
    this.ydoc.destroy();
  }

  private handleTerminalClose(code: number, reason: string): void {
    if (this.snapshot.errorCode !== null) return;
    this.provider.disconnect();
    this.update({
      status: "error",
      errorCode: code,
      errorMessage: describeDocCloseCode(code, reason),
    });
    if (code === 4401) {
      this.onUnauthorized?.();
    }
  }

  private update(patch: Partial<DocSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
