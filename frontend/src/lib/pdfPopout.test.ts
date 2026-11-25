import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BroadcastChannelFactory,
  type BroadcastChannelLike,
  PdfPopoutHostBridge,
  PdfPopoutWindowBridge,
  pdfPopoutChannelName,
} from "./pdfPopout";

function createFakeChannelHub(): BroadcastChannelFactory {
  const rooms = new Map<string, Set<FakeChannel>>();

  class FakeChannel implements BroadcastChannelLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    private closed = false;

    constructor(private readonly name: string) {
      let set = rooms.get(name);
      if (!set) {
        set = new Set();
        rooms.set(name, set);
      }
      set.add(this);
    }

    postMessage(msg: unknown): void {
      if (this.closed) return;
      const peers = rooms.get(this.name);
      if (!peers) return;
      for (const peer of peers) {
        if (peer !== this && !peer.closed) {
          peer.onmessage?.({ data: msg });
        }
      }
    }

    close(): void {
      this.closed = true;
      this.onmessage = null;
      rooms.get(this.name)?.delete(this);
    }
  }

  return (name) => new FakeChannel(name);
}

describe("pdfPopout BroadcastChannel bridges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scopes channel names by project id and isolates different projects", () => {
    expect(pdfPopoutChannelName(42)).toBe("undertree:pdf-popout:42");
    const factory = createFakeChannelHub();
    const onPoppedOut1 = vi.fn();
    const onPoppedOut2 = vi.fn();

    const host1 = new PdfPopoutHostBridge(1, { onPoppedOutChange: onPoppedOut1 }, factory);
    const host2 = new PdfPopoutHostBridge(2, { onPoppedOutChange: onPoppedOut2 }, factory);

    const popout1 = new PdfPopoutWindowBridge(
      1,
      "main.tex",
      { onDockRequest: () => {} },
      factory,
      "win-1"
    );

    expect(onPoppedOut1).toHaveBeenCalledWith(true);
    expect(host1.isPoppedOut()).toBe(true);
    expect(onPoppedOut2).not.toHaveBeenCalled();
    expect(host2.isPoppedOut()).toBe(false);

    popout1.close();
    expect(onPoppedOut1).toHaveBeenLastCalledWith(false);
    expect(host1.isPoppedOut()).toBe(false);

    host1.dispose();
    host2.dispose();
  });

  it("discovers an already-open popout when host mounts later (reload)", () => {
    const factory = createFakeChannelHub();
    const popout = new PdfPopoutWindowBridge(
      7,
      "papers/icml/main.tex",
      { onDockRequest: () => {} },
      factory,
      "win-existing"
    );

    const onPoppedOut = vi.fn();
    const onRoot = vi.fn();
    const host = new PdfPopoutHostBridge(
      7,
      { onPoppedOutChange: onPoppedOut, onRootChange: onRoot },
      factory
    );

    expect(host.isPoppedOut()).toBe(true);
    expect(onPoppedOut).toHaveBeenCalledWith(true);
    expect(onRoot).toHaveBeenCalledWith("papers/icml/main.tex");

    popout.close();
    host.dispose();
  });

  it("keeps panel collapsed until all tracked popouts close and forwards root/jump events", () => {
    const factory = createFakeChannelHub();
    const onPoppedOut = vi.fn();
    const onRoot = vi.fn();
    const onJump = vi.fn();
    const host = new PdfPopoutHostBridge(
      3,
      { onPoppedOutChange: onPoppedOut, onRootChange: onRoot, onJumpToLine: onJump },
      factory
    );

    const p1 = new PdfPopoutWindowBridge(3, "a.tex", { onDockRequest: () => {} }, factory, "p1");
    const p2 = new PdfPopoutWindowBridge(3, "b.tex", { onDockRequest: () => {} }, factory, "p2");

    expect(onPoppedOut).toHaveBeenCalledTimes(1);
    expect(onPoppedOut).toHaveBeenCalledWith(true);

    p1.notifyRootChanged("papers/sub/main.tex");
    p1.notifyJumpToLine("papers/sub/intro.tex", 42);
    expect(onRoot).toHaveBeenLastCalledWith("papers/sub/main.tex");
    expect(onJump).toHaveBeenCalledWith("papers/sub/intro.tex", 42);

    // Closing only p1 keeps host collapsed because p2 is still open
    p1.close();
    p1.close(); // idempotent second close
    expect(host.isPoppedOut()).toBe(true);
    expect(onPoppedOut).toHaveBeenCalledTimes(1);

    p2.close();
    expect(host.isPoppedOut()).toBe(false);
    expect(onPoppedOut).toHaveBeenLastCalledWith(false);

    host.dispose();
  });

  it("notifies popout on dock request and immediately restores host panel", () => {
    const factory = createFakeChannelHub();
    const onPoppedOut = vi.fn();
    const onDock = vi.fn();
    const host = new PdfPopoutHostBridge(9, { onPoppedOutChange: onPoppedOut }, factory);
    const popout = new PdfPopoutWindowBridge(
      9,
      "main.tex",
      { onDockRequest: onDock },
      factory,
      "p-dock"
    );

    expect(host.isPoppedOut()).toBe(true);
    host.requestDock();

    expect(onDock).toHaveBeenCalledTimes(1);
    expect(host.isPoppedOut()).toBe(false);
    expect(onPoppedOut).toHaveBeenLastCalledWith(false);

    popout.close();
    host.dispose();
  });

  it("propagates null when popout clears or invalidates its selected root", () => {
    const factory = createFakeChannelHub();
    let hostCompileRoot: string | null = "stale.tex";
    const onRootChange = vi.fn((root: string | null) => {
      hostCompileRoot = root;
    });

    const host = new PdfPopoutHostBridge(
      11,
      { onPoppedOutChange: () => {}, onRootChange },
      factory
    );
    const popout = new PdfPopoutWindowBridge(
      11,
      "papers/icml/main.tex",
      { onDockRequest: () => {} },
      factory,
      "p-clear"
    );
    expect(hostCompileRoot).toBe("papers/icml/main.tex");

    popout.notifyRootChanged(null);
    expect(hostCompileRoot).toBeNull();
    expect(onRootChange).toHaveBeenLastCalledWith(null);

    popout.close();

    // Reopening a popout with root: null must also clear any stale host root
    hostCompileRoot = "stale.tex";
    const popoutNull = new PdfPopoutWindowBridge(
      11,
      null,
      { onDockRequest: () => {} },
      factory,
      "p-null-open"
    );
    expect(hostCompileRoot).toBeNull();
    expect(onRootChange).toHaveBeenLastCalledWith(null);

    popoutNull.close();
    host.dispose();
  });

  it("forwards roots_changed notifications from host to popout windows", () => {
    const factory = createFakeChannelHub();
    const onRootsChanged = vi.fn();

    const host = new PdfPopoutHostBridge(12, { onPoppedOutChange: () => {} }, factory);
    const popout = new PdfPopoutWindowBridge(
      12,
      "main.tex",
      { onDockRequest: () => {}, onRootsChanged },
      factory,
      "p-roots"
    );

    host.notifyRootsChanged();
    expect(onRootsChanged).toHaveBeenCalledTimes(1);

    popout.close();
    host.dispose();
  });

  it("forwards SyncTeX source -> PDF requests from host to popout windows", () => {
    const factory = createFakeChannelHub();
    const onSyncToPdf = vi.fn();

    const host = new PdfPopoutHostBridge(13, { onPoppedOutChange: () => {} }, factory);
    const popout = new PdfPopoutWindowBridge(
      13,
      "main.tex",
      { onDockRequest: () => {}, onSyncToPdf },
      factory,
      "p-sync"
    );

    host.notifySyncToPdf("sections/intro.tex", 12, 3, true);
    expect(onSyncToPdf).toHaveBeenCalledWith("sections/intro.tex", 12, 3, true);

    // malformed payloads are dropped
    onSyncToPdf.mockClear();
    const raw = factory(pdfPopoutChannelName(13))!;
    for (const bad of [
      { file: 1, line: 1, column: 0, explicit: true },
      { file: "a.tex", line: 0, column: 0, explicit: true },
      { file: "a.tex", line: 1.5, column: 0, explicit: true },
      { file: "a.tex", line: 1, column: -1, explicit: true },
      { file: "a.tex", line: 1, column: 0, explicit: "yes" },
      { file: "a.tex", line: 1, column: 0 },
    ]) {
      raw.postMessage({ type: "sync_to_pdf", ...bad });
    }
    expect(onSyncToPdf).not.toHaveBeenCalled();
    raw.close();

    popout.close();
    host.dispose();
  });
});
