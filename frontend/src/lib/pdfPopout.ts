export interface BroadcastChannelLike {
  postMessage: (msg: unknown) => void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close: () => void;
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike | null;

export type PdfPopoutMessage =
  | { type: "popout_open"; popoutId: string; root: string | null }
  | { type: "popout_close"; popoutId: string }
  | { type: "host_ping" }
  | { type: "dock_request" }
  | { type: "root_changed"; root: string | null }
  | { type: "roots_changed" }
  | { type: "jump_to_line"; file: string; line: number }
  | { type: "sync_to_pdf"; file: string; line: number; column: number; explicit: boolean };

export function pdfPopoutChannelName(pid: number): string {
  return `undertree:pdf-popout:${pid}`;
}

export function defaultBroadcastChannelFactory(name: string): BroadcastChannelLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(name) as unknown as BroadcastChannelLike;
}

function isPdfPopoutMessage(data: unknown): data is PdfPopoutMessage {
  if (!data || typeof data !== "object") return false;
  const msg = data as { type?: unknown };
  if (msg.type === "sync_to_pdf") {
    const m = data as Record<string, unknown>;
    return (
      typeof m.file === "string" &&
      Number.isInteger(m.line) &&
      (m.line as number) >= 1 &&
      Number.isInteger(m.column) &&
      (m.column as number) >= 0 &&
      typeof m.explicit === "boolean"
    );
  }
  return (
    msg.type === "popout_open" ||
    msg.type === "popout_close" ||
    msg.type === "host_ping" ||
    msg.type === "dock_request" ||
    msg.type === "root_changed" ||
    msg.type === "roots_changed" ||
    msg.type === "jump_to_line" ||
    msg.type === "sync_to_pdf"
  );
}

export interface PdfPopoutHostCallbacks {
  onPoppedOutChange: (poppedOut: boolean) => void;
  onRootChange?: (root: string | null) => void;
  onJumpToLine?: (file: string, line: number) => void;
}

/**
 * Coordinates the main project workspace with detached PDF popout window(s) for
 * the same project ID via `BroadcastChannel`. Collapses the inline PDF pane while
 * at least one popout is open and restores it when all popouts close or dock.
 */
export class PdfPopoutHostBridge {
  private readonly channel: BroadcastChannelLike | null;
  private readonly activePopouts = new Set<string>();
  private readonly callbacks: PdfPopoutHostCallbacks;
  private disposed = false;

  constructor(
    pid: number,
    callbacks: PdfPopoutHostCallbacks,
    createChannel: BroadcastChannelFactory = defaultBroadcastChannelFactory
  ) {
    this.callbacks = callbacks;
    this.channel = createChannel(pdfPopoutChannelName(pid));
    if (this.channel) {
      this.channel.onmessage = (ev) => {
        if (!isPdfPopoutMessage(ev.data)) return;
        this.handleMessage(ev.data);
      };
      // Discover any popout window that survived a reload of the main tab
      this.channel.postMessage({ type: "host_ping" } satisfies PdfPopoutMessage);
    }
  }

  isPoppedOut(): boolean {
    return this.activePopouts.size > 0;
  }

  requestDock(): void {
    if (this.disposed) return;
    this.channel?.postMessage({ type: "dock_request" } satisfies PdfPopoutMessage);
    this.clearTrackedPopouts();
  }

  forceCloseTrackedPopouts(): void {
    if (this.disposed) return;
    this.clearTrackedPopouts();
  }

  /** SyncTeX source -> PDF: asks the popout window(s) to scroll to the position. */
  notifySyncToPdf(file: string, line: number, column: number, explicit: boolean): void {
    if (this.disposed) return;
    this.channel?.postMessage({
      type: "sync_to_pdf",
      file,
      line,
      column,
      explicit,
    } satisfies PdfPopoutMessage);
  }

  notifyRootsChanged(): void {
    if (this.disposed) return;
    this.channel?.postMessage({ type: "roots_changed" } satisfies PdfPopoutMessage);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activePopouts.clear();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  private clearTrackedPopouts(): void {
    if (this.activePopouts.size === 0) return;
    this.activePopouts.clear();
    this.callbacks.onPoppedOutChange(false);
  }

  private handleMessage(msg: PdfPopoutMessage): void {
    if (this.disposed) return;
    switch (msg.type) {
      case "popout_open": {
        const wasPoppedOut = this.isPoppedOut();
        this.activePopouts.add(msg.popoutId);
        if (!wasPoppedOut) {
          this.callbacks.onPoppedOutChange(true);
        }
        this.callbacks.onRootChange?.(msg.root);
        break;
      }
      case "popout_close": {
        if (this.activePopouts.delete(msg.popoutId) && !this.isPoppedOut()) {
          this.callbacks.onPoppedOutChange(false);
        }
        break;
      }
      case "root_changed":
        this.callbacks.onRootChange?.(msg.root);
        break;
      case "jump_to_line":
        this.callbacks.onJumpToLine?.(msg.file, msg.line);
        break;
      default:
        break;
    }
  }
}

export interface PdfPopoutWindowCallbacks {
  onDockRequest: () => void;
  onRootsChanged?: () => void;
  onSyncToPdf?: (file: string, line: number, column: number, explicit: boolean) => void;
}

/**
 * BroadcastChannel endpoint inside a standalone `/p/{pid}/pdf` popout window.
 */
export class PdfPopoutWindowBridge {
  readonly popoutId: string;
  private currentRoot: string | null;
  private readonly channel: BroadcastChannelLike | null;
  private readonly callbacks: PdfPopoutWindowCallbacks;
  private closed = false;

  constructor(
    pid: number,
    initialRoot: string | null,
    callbacks: PdfPopoutWindowCallbacks,
    createChannel: BroadcastChannelFactory = defaultBroadcastChannelFactory,
    popoutId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  ) {
    this.popoutId = popoutId;
    this.currentRoot = initialRoot;
    this.callbacks = callbacks;
    this.channel = createChannel(pdfPopoutChannelName(pid));

    if (this.channel) {
      this.channel.onmessage = (ev) => {
        if (!isPdfPopoutMessage(ev.data)) return;
        this.handleMessage(ev.data);
      };
      this.announceOpen();
    }
  }

  notifyRootChanged(root: string | null): void {
    if (this.closed) return;
    this.currentRoot = root;
    this.channel?.postMessage({ type: "root_changed", root } satisfies PdfPopoutMessage);
  }

  notifyJumpToLine(file: string, line: number): void {
    if (this.closed) return;
    this.channel?.postMessage({ type: "jump_to_line", file, line } satisfies PdfPopoutMessage);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.channel) {
      this.channel.postMessage({
        type: "popout_close",
        popoutId: this.popoutId,
      } satisfies PdfPopoutMessage);
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  private announceOpen(): void {
    this.channel?.postMessage({
      type: "popout_open",
      popoutId: this.popoutId,
      root: this.currentRoot,
    } satisfies PdfPopoutMessage);
  }

  private handleMessage(msg: PdfPopoutMessage): void {
    if (this.closed) return;
    switch (msg.type) {
      case "host_ping":
        this.announceOpen();
        break;
      case "dock_request":
        this.callbacks.onDockRequest();
        break;
      case "roots_changed":
        this.callbacks.onRootsChanged?.();
        break;
      case "sync_to_pdf":
        this.callbacks.onSyncToPdf?.(msg.file, msg.line, msg.column, msg.explicit);
        break;
      default:
        break;
    }
  }
}
