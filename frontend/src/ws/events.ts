import { type ServerEvent, projectWsPath, wsBaseUrl } from "../api";

export type EventsConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type EventListener = (event: ServerEvent) => void;
export type StateListener = (state: EventsConnectionState) => void;

const KNOWN_TYPES = new Set([
  "tree_changed",
  "doc_reloaded",
  "doc_deleted",
  "moved",
  "compile",
  "git_changed",
  "comments",
  "chat",
  "chat_resync",
  "presence",
]);

export interface EventsClientOptions {
  url?: string;
  onUnauthorized?: () => void;
  /** Close code 4404: the project was deleted or access was revoked. No reconnect. */
  onProjectGone?: () => void;
  /**
   * Controls whether this client participates in user presence focus reporting
   * (`{"type":"focus",...}` frames). Popout windows set `false` so opening a
   * detached PDF view never alters the user's project presence (#47).
   */
  reportFocus?: boolean;
  minDelayMs?: number;
  maxDelayMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

/**
 * WebSocket client for `/ws/projects/{pid}/events` (server -> client JSON events)
 * with exponential-backoff reconnect and tolerance for unknown event types.
 */
export class EventsClient {
  readonly reportFocus: boolean;
  private readonly url: string;
  private readonly onUnauthorized?: () => void;
  private readonly onProjectGone?: () => void;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly WebSocketImpl: typeof WebSocket;

  private ws: WebSocket | null = null;
  private disposed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private state: EventsConnectionState = "disconnected";
  /** file in focus, re-sent after every (re)connect */
  private focus: string | null = null;

  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();

  constructor(options: EventsClientOptions = {}) {
    this.reportFocus = options.reportFocus ?? true;
    this.url = options.url ?? `${wsBaseUrl()}${projectWsPath()}/events`;
    this.onUnauthorized = options.onUnauthorized;
    this.onProjectGone = options.onProjectGone;
    this.minDelayMs = options.minDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 15_000;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  getState(): EventsConnectionState {
    return this.state;
  }

  subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  connect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");

    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.disposed) {
        ws.close();
        return;
      }
      this.attempt = 0;
      this.setState("connected");
      this.sendFocus();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      this.handleRawMessage(ev.data);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      if (this.disposed) {
        this.setState("disconnected");
        return;
      }
      if (ev.code === 4401) {
        this.setState("disconnected");
        this.onUnauthorized?.();
        return;
      }
      if (ev.code === 4404) {
        this.setState("disconnected");
        this.onProjectGone?.();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose handles reconnect
    };
  }

  /** Reports the file the user has in focus (null = none / window hidden) for presence. */
  setFocus(path: string | null): void {
    if (!this.reportFocus) return;
    if (path === this.focus) return;
    this.focus = path;
    this.sendFocus();
  }

  private sendFocus(): void {
    if (!this.reportFocus) return;
    if (this.ws?.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify({ type: "focus", path: this.focus }));
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // ignore close errors during teardown
      }
      this.ws = null;
    }
    this.setState("disconnected");
    this.eventListeners.clear();
    this.stateListeners.clear();
  }

  private setState(next: EventsConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const maybeEvent = parsed as { type?: unknown };
    if (typeof maybeEvent.type !== "string" || !KNOWN_TYPES.has(maybeEvent.type)) {
      // Contract: client must tolerate & ignore unknown event types.
      return;
    }
    const event = parsed as ServerEvent;
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(this.maxDelayMs, this.minDelayMs * 2 ** this.attempt);
    this.attempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
