import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { type User, setActiveProject } from "../api";
import {
  clearPeerJumpTargetForPath,
  consumePeerJumpTarget,
  findPeerCursorOffset,
  type PeerJumpTarget,
  runPeerJump,
  waitForPeerCursorOffset,
} from "./awarenessJump";
import { DocSession } from "./docSession";
import { getUserColor } from "./userColor";

class FakeDocWebSocket {
  static readonly OPEN = 1;
  readonly url: string;
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(): void {
    // no-op
  }

  close(): void {
    this.readyState = 3;
  }
}

const sampleUser: User = {
  id: 1,
  username: "alice",
  display_name: "Alice",
  email: "alice@example.org",
  is_admin: false,
  commit_email: null,
};

function syncDocs(source: Y.Doc, target: Y.Doc): void {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
}

describe("awarenessJump", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves plain-JSON relative positions and Y.RelativePosition instances", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "\\section{Intro}\nHello world");

    const anchorRel = Y.createRelativePositionFromTypeIndex(ytext, 16);
    const headRel = Y.createRelativePositionFromTypeIndex(ytext, 21);
    const jsonCursor = {
      anchor: JSON.parse(JSON.stringify(Y.relativePositionToJSON(anchorRel))),
      head: JSON.parse(JSON.stringify(Y.relativePositionToJSON(headRel))),
    };

    const states = new Map<number, Record<string, unknown>>([
      [
        doc.clientID,
        { user: { username: "bob", name: "Local" }, cursor: { anchor: anchorRel, head: headRel } },
      ],
      [
        42,
        {
          user: { username: "bob", name: "Bob", color: "#34d399" },
          cursor: jsonCursor,
        },
      ],
      [
        43,
        {
          user: { username: "carol", name: "Carol" },
          cursor: { head: headRel },
        },
      ],
    ]);

    expect(findPeerCursorOffset(states, doc.clientID, "bob", doc)).toEqual({
      anchor: 16,
      head: 21,
      color: "#34d399",
      name: "Bob",
    });

    // Missing anchor defaults to head, missing color falls back to getUserColor
    expect(findPeerCursorOffset(states, doc.clientID, "carol", doc)).toEqual({
      anchor: 21,
      head: 21,
      color: getUserColor("carol").color,
      name: "Carol",
    });
  });

  it("tracks shifted cursor offsets across real Y.Doc edits", () => {
    const remoteDoc = new Y.Doc();
    remoteDoc.clientID = 100;
    const remoteText = remoteDoc.getText("content");
    remoteText.insert(0, "Alpha Beta Gamma");

    const localDoc = new Y.Doc();
    localDoc.clientID = 200;
    syncDocs(remoteDoc, localDoc);

    // Remote places cursor at start of "Gamma" (offset 11..16)
    const anchorRel = Y.createRelativePositionFromTypeIndex(remoteText, 11);
    const headRel = Y.createRelativePositionFromTypeIndex(remoteText, 16);
    const serializedCursor = {
      anchor: Y.relativePositionToJSON(anchorRel),
      head: Y.relativePositionToJSON(headRel),
    };

    // Local inserts 6 chars before "Gamma"
    localDoc.getText("content").insert(0, "Start ");

    const states = new Map<number, Record<string, unknown>>([
      [
        100,
        {
          user: { username: "bob", name: "Bob", color: "#fbbf24" },
          cursor: serializedCursor,
        },
      ],
    ]);

    expect(findPeerCursorOffset(states, localDoc.clientID, "bob", localDoc)).toEqual({
      anchor: 17,
      head: 22,
      color: "#fbbf24",
      name: "Bob",
    });
  });

  it("prefers a client with a valid resolvable cursor when multiple clients share a username", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    const otherText = doc.getText("other");
    ytext.insert(0, "Hello");
    otherText.insert(0, "World");

    const wrongTypeRel = Y.createRelativePositionFromTypeIndex(otherText, 2);
    const validRel = Y.createRelativePositionFromTypeIndex(ytext, 4);

    const states = new Map<number, Record<string, unknown>>([
      [10, { user: { username: "bob", name: "Bob (no cursor)" } }],
      [11, { user: { username: "bob", name: "Bob (wrong type)" }, cursor: { head: wrongTypeRel } }],
      [
        12,
        {
          user: { username: "bob", name: "Bob (active)", color: "#a78bfa" },
          cursor: { anchor: validRel, head: validRel },
        },
      ],
    ]);

    expect(findPeerCursorOffset(states, doc.clientID, "bob", doc)).toEqual({
      anchor: 4,
      head: 4,
      color: "#a78bfa",
      name: "Bob (active)",
    });
  });

  it("returns null when cursor is missing or user is absent", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "abc");
    const states = new Map<number, Record<string, unknown>>([
      [2, { user: { username: "bob", name: "Bob" } }],
      [3, { user: { username: "carol", name: "Carol" }, cursor: null }],
    ]);

    expect(findPeerCursorOffset(states, doc.clientID, "bob", doc)).toBeNull();
    expect(findPeerCursorOffset(states, doc.clientID, "carol", doc)).toBeNull();
    expect(findPeerCursorOffset(states, doc.clientID, "nobody", doc)).toBeNull();
  });

  it("waitForPeerCursorOffset resolves on late awareness arrival and cleans up listeners", async () => {
    setActiveProject(1);
    const session = new DocSession({
      path: "main.tex",
      repo: "",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });
    session.ytext.insert(0, "Line 1\nLine 2");

    const promise = waitForPeerCursorOffset(session, "bob", { timeoutMs: 2000 });

    const rel = Y.createRelativePositionFromTypeIndex(session.ytext, 9);
    const awarenessStates = session.provider.awareness.getStates() as Map<
      number,
      Record<string, unknown>
    >;
    awarenessStates.set(999, {
      user: { username: "bob", name: "Bob", color: "#34d399" },
      cursor: { anchor: Y.relativePositionToJSON(rel), head: Y.relativePositionToJSON(rel) },
    });
    session.provider.awareness.emit("change", [
      { added: [999], updated: [], removed: [] },
      "remote",
    ]);

    await expect(promise).resolves.toEqual({
      anchor: 9,
      head: 9,
      color: "#34d399",
      name: "Bob",
    });

    session.destroy();
  });

  it("waitForPeerCursorOffset resolves to null on timeout and on abort", async () => {
    vi.useFakeTimers();
    setActiveProject(1);
    const session = new DocSession({
      path: "main.tex",
      repo: "",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });

    const timeoutPromise = waitForPeerCursorOffset(session, "bob", { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(timeoutPromise).resolves.toBeNull();

    const controller = new AbortController();
    const abortPromise = waitForPeerCursorOffset(session, "bob", {
      timeoutMs: 3000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(abortPromise).resolves.toBeNull();

    session.destroy();
  });

  it("consumes peerJumpTarget on completion so closing and reopening does not replay", async () => {
    setActiveProject(1);
    const session = new DocSession({
      path: "main.tex",
      repo: "",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });
    session.ytext.insert(0, "Line 1\nLine 2");

    const rel = Y.createRelativePositionFromTypeIndex(session.ytext, 4);
    const states = session.provider.awareness.getStates() as Map<number, Record<string, unknown>>;
    states.set(999, {
      user: { username: "bob", name: "Bob", color: "#34d399" },
      cursor: { anchor: Y.relativePositionToJSON(rel), head: Y.relativePositionToJSON(rel) },
    });

    let currentTarget: PeerJumpTarget | null = { path: "main.tex", username: "bob", seq: 1 };
    const applied: number[] = [];

    await runPeerJump(session, currentTarget, {
      onApply: (pos) => applied.push(pos.head),
      onConsumed: (seq) => {
        currentTarget = consumePeerJumpTarget(currentTarget, seq);
      },
    });

    expect(applied).toEqual([4]);
    expect(currentTarget).toBeNull();

    // Closing and reopening main.tex sees currentTarget === null and does not replay
    currentTarget = clearPeerJumpTargetForPath(currentTarget, "main.tex");
    expect(currentTarget).toBeNull();

    session.destroy();
  });

  it("consumes pending peerJumpTarget when aborted before awareness arrives and clears on tab switch/close", async () => {
    setActiveProject(1);
    const session = new DocSession({
      path: "a.tex",
      repo: "",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });

    let currentTarget: PeerJumpTarget | null = { path: "a.tex", username: "bob", seq: 7 };
    const controller = new AbortController();
    const applied: number[] = [];

    const jumpPromise = runPeerJump(session, currentTarget, {
      signal: controller.signal,
      timeoutMs: 3000,
      onApply: (pos) => applied.push(pos.head),
      onConsumed: (seq) => {
        currentTarget = consumePeerJumpTarget(currentTarget, seq);
      },
    });

    // User switches files or closes tab before awareness arrives
    controller.abort();
    await jumpPromise;

    expect(applied).toEqual([]);
    expect(currentTarget).toBeNull();

    // Switching back to a.tex has no stale target; closing another tab doesn't affect others
    const otherTarget: PeerJumpTarget = { path: "b.tex", username: "carol", seq: 8 };
    expect(clearPeerJumpTargetForPath(otherTarget, "a.tex")).toEqual(otherTarget);
    expect(clearPeerJumpTargetForPath(otherTarget, "b.tex")).toBeNull();

    session.destroy();
  });

  it("preserves a newer peerJumpTarget (seq=2) when an older in-flight jump (seq=1) is aborted", async () => {
    setActiveProject(1);
    const session = new DocSession({
      path: "main.tex",
      repo: "",
      user: sampleUser,
      wsBase: "ws://localhost:3000",
      WebSocketPolyfill: FakeDocWebSocket as unknown as typeof WebSocket,
    });
    session.ytext.insert(0, "Alpha Beta Gamma");

    let currentTarget: PeerJumpTarget | null = { path: "main.tex", username: "bob", seq: 1 };
    const firstController = new AbortController();
    const applied: Array<{ username: string; head: number }> = [];

    const firstJump = runPeerJump(session, currentTarget, {
      signal: firstController.signal,
      timeoutMs: 3000,
      onApply: (pos) => applied.push({ username: "bob", head: pos.head }),
      onConsumed: (seq) => {
        currentTarget = consumePeerJumpTarget(currentTarget, seq);
      },
    });

    // User clicks Carol before Bob's awareness arrives -> seq=2 replaces seq=1
    const secondTarget: PeerJumpTarget = { path: "main.tex", username: "carol", seq: 2 };
    currentTarget = secondTarget;
    firstController.abort();
    await firstJump;

    // Consuming seq=1 must NOT clear seq=2
    expect(currentTarget).toEqual(secondTarget);

    const carolRel = Y.createRelativePositionFromTypeIndex(session.ytext, 11);
    const states = session.provider.awareness.getStates() as Map<number, Record<string, unknown>>;
    states.set(888, {
      user: { username: "carol", name: "Carol", color: "#fbbf24" },
      cursor: { anchor: Y.relativePositionToJSON(carolRel), head: Y.relativePositionToJSON(carolRel) },
    });

    await runPeerJump(session, currentTarget!, {
      onApply: (pos) => applied.push({ username: "carol", head: pos.head }),
      onConsumed: (seq) => {
        currentTarget = consumePeerJumpTarget(currentTarget, seq);
      },
    });

    expect(applied).toEqual([{ username: "carol", head: 11 }]);
    expect(currentTarget).toBeNull();

    session.destroy();
  });
});
