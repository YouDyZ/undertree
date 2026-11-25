import { afterEach, describe, expect, it, vi } from "vitest";
import { type User, setActiveProject } from "../api";
import { DocSession, describeDocCloseCode, extractRemotePeers } from "./docSession";
import { getUserColor } from "./userColor";

class FakeDocWebSocket {
  static readonly OPEN = 1;
  static instances: FakeDocWebSocket[] = [];
  readonly url: string;
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeDocWebSocket.instances.push(this);
  }

  send(): void {
    // no-op
  }

  close(): void {
    this.readyState = 3;
  }

  emitClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const sampleUser: User = {
  id: 7,
  username: "alice",
  display_name: "Alice Researcher",
  email: "alice@example.org",
  is_admin: false,
  commit_email: null,
};

describe("editor collaborative session helpers", () => {
  afterEach(() => {
    FakeDocWebSocket.instances = [];
  });

  it("assigns deterministic hex colors with matching alpha highlight", () => {
    const first = getUserColor("7:alice");
    const second = getUserColor("7:alice");
    expect(first).toEqual(second);
    expect(first.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(first.colorLight).toBe(`${first.color}33`);
  });

  it("extracts remote peers while excluding local client", () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { name: "Local", color: "#38bdf8", colorLight: "#38bdf833" } }],
      [2, { user: { name: "Bob", username: "bob", color: "#34d399", colorLight: "#34d39933" } }],
      [3, { user: { name: "Ada", color: "#a78bfa" } }],
      [4, {}],
    ]);
    expect(extractRemotePeers(states, 1)).toEqual([
      { clientId: 3, name: "Ada", color: "#a78bfa", colorLight: "#a78bfa33" },
      { clientId: 2, name: "Bob", username: "bob", color: "#34d399", colorLight: "#34d39933" },
    ]);
  });

  it("connects to /ws/projects/{pid}/doc/{encodedPath} and handles close codes 4401/4404/4415", () => {
    setActiveProject(7);
    const onUnauthorized = vi.fn();
    const session = new DocSession({
      path: "papers/my paper/main.tex",
      repo: "papers/my paper",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      onUnauthorized,
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });

    expect(FakeDocWebSocket.instances).toHaveLength(1);
    expect(FakeDocWebSocket.instances[0]?.url).toBe(
      "ws://localhost:3000/ws/projects/7/doc/papers/my%20paper/main.tex"
    );

    const localState = session.provider.awareness.getLocalState() as {
      user?: { username?: string; name: string; color: string; colorLight: string };
    };
    expect(localState.user?.username).toBe("alice");
    expect(localState.user?.name).toBe("Alice Researcher");

    FakeDocWebSocket.instances[0]?.emitClose(4415, "not text");
    expect(session.getSnapshot().status).toBe("error");
    expect(session.getSnapshot().errorCode).toBe(4415);
    expect(onUnauthorized).not.toHaveBeenCalled();
    session.destroy();

    const unauthSession = new DocSession({
      path: "main.tex",
      repo: "",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      onUnauthorized,
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });
    FakeDocWebSocket.instances[1]?.emitClose(4401, "unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(unauthSession.getSnapshot().errorCode).toBe(4401);
    unauthSession.destroy();
  });

  it("triggers onRoleChanged on close code 4403 without marking the session errored", () => {
    setActiveProject(7);
    const onRoleChanged = vi.fn();
    const session = new DocSession({
      path: "main.tex",
      repo: "",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      onRoleChanged,
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });

    FakeDocWebSocket.instances[0]?.emitClose(4403, "role changed");
    expect(onRoleChanged).toHaveBeenCalledTimes(1);
    expect(session.provider.shouldConnect).toBe(true);
    expect(session.getSnapshot().errorCode).toBeNull();
    expect(session.getSnapshot().status).not.toBe("error");
    session.destroy();
  });

  it("provides human-readable German messages for documented close codes", () => {
    expect(describeDocCloseCode(4401)).toContain("Sitzung");
    expect(describeDocCloseCode(4404)).toContain("nicht gefunden");
    expect(describeDocCloseCode(4415)).toContain("Binärformat");
  });
});
