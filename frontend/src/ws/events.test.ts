import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../api";
import { EventsClient } from "./events";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  readonly url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitClose(code = 1006): void {
    this.onclose?.({ code } as CloseEvent);
  }
}

describe("EventsClient", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.useRealTimers();
  });

  it("dispatches known events and ignores unknown event types", () => {
    const received: ServerEvent[] = [];
    const client = new EventsClient({
      url: "ws://localhost:3000/ws/projects/7/events",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.subscribe((e) => received.push(e));
    client.connect();

    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    expect(client.getState()).toBe("connected");

    ws.emitMessage(JSON.stringify({ type: "tree_changed" }));
    ws.emitMessage(JSON.stringify({ type: "future_unknown_event", foo: 123 }));
    ws.emitMessage("not-json");
    ws.emitMessage(JSON.stringify({ type: "git_changed", repo: "papers/icml" }));
    ws.emitMessage(JSON.stringify({ type: "comments", path: "main.tex" }));
    ws.emitMessage(JSON.stringify({ type: "chat", message: { id: 1, body: "hi" } }));

    expect(received).toEqual([
      { type: "tree_changed" },
      { type: "git_changed", repo: "papers/icml" },
      { type: "comments", path: "main.tex" },
      { type: "chat", message: { id: 1, body: "hi" } },
    ]);
    client.dispose();
  });

  it("reports the focused file and re-sends it after a reconnect", () => {
    vi.useFakeTimers();
    const client = new EventsClient({
      url: "ws://x/ws/projects/1/events",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      minDelayMs: 10,
    });
    client.connect();
    client.setFocus("a/main.tex"); // before open: sent on open
    const first = FakeWebSocket.instances[0]!;
    expect(first.sent).toEqual([]);
    first.emitOpen();
    client.setFocus("a/main.tex"); // unchanged: not sent again
    client.setFocus(null);
    expect(first.sent.map((d) => JSON.parse(d))).toEqual([
      { type: "focus", path: "a/main.tex" },
      { type: "focus", path: null },
    ]);

    client.setFocus("b.tex");
    first.emitClose();
    vi.advanceTimersByTime(50);
    const second = FakeWebSocket.instances[1]!;
    second.emitOpen();
    expect(second.sent.map((d) => JSON.parse(d))).toEqual([{ type: "focus", path: "b.tex" }]);
    client.dispose();
  });

  it("stops reconnecting and fires onUnauthorized on close code 4401", () => {
    vi.useFakeTimers();
    const onUnauthorized = vi.fn();
    const client = new EventsClient({
      url: "ws://localhost:3000/ws/projects/7/events",
      onUnauthorized,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    FakeWebSocket.instances[0]!.emitClose(4401);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(client.getState()).toBe("disconnected");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.dispose();
  });

  it("stops reconnecting and fires onProjectGone on close code 4404", () => {
    vi.useFakeTimers();
    const onProjectGone = vi.fn();
    const client = new EventsClient({
      url: "ws://localhost:3000/ws/projects/7/events",
      onProjectGone,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    FakeWebSocket.instances[0]!.emitClose(4404);

    expect(onProjectGone).toHaveBeenCalledTimes(1);
    expect(client.getState()).toBe("disconnected");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.dispose();
  });

  it("reconnects with exponential backoff on transient disconnect", () => {
    vi.useFakeTimers();
    const client = new EventsClient({
      url: "ws://localhost:3000/ws/projects/7/events",
      minDelayMs: 500,
      maxDelayMs: 4000,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]!.emitClose(1006);
    expect(client.getState()).toBe("reconnecting");

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]!.emitClose(1006);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    client.dispose();
  });

  it("never emits focus frames when reportFocus is false (popout window)", () => {
    vi.useFakeTimers();
    const client = new EventsClient({
      url: "ws://localhost:3000/ws/projects/7/events",
      reportFocus: false,
      minDelayMs: 50,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(client.reportFocus).toBe(false);
    client.setFocus("before-open.tex");
    client.connect();

    const first = FakeWebSocket.instances[0]!;
    first.emitOpen();
    client.setFocus("main.tex");
    first.emitMessage(JSON.stringify({ type: "compile", root: "main.tex", state: "success" }));
    expect(first.sent).toEqual([]);

    first.emitClose(1006);
    vi.advanceTimersByTime(50);
    const second = FakeWebSocket.instances[1]!;
    second.emitOpen();
    expect(second.sent).toEqual([]);

    client.dispose();
  });
});
