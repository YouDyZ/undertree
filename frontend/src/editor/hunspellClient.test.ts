import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
type Client = typeof import("./hunspellClient");
let REQUEST_TIMEOUT_MS: Client["REQUEST_TIMEOUT_MS"];
let hunspellCheck: Client["hunspellCheck"];

class FakeWorker {
  static all: FakeWorker[] = [];
  terminated = false;
  sent: { id: number; words: string[] }[] = [];
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor() {
    FakeWorker.all.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  postMessage(m: { id: number; words: string[] }) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners[type] ?? []) fn({ data });
  }
}

const req = { path: "a.tex", text: "Hallo Welt", start: 5, language: "de-DE" };

beforeEach(async () => {
  // the worker is module state: every test gets a fresh module
  vi.resetModules();
  ({ REQUEST_TIMEOUT_MS, hunspellCheck } = await import("./hunspellClient"));
  FakeWorker.all = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hunspellCheck worker handling", () => {
  it("maps the worker's answer to issues with file offsets", async () => {
    const p = hunspellCheck(req);
    const w = FakeWorker.all[0];
    expect(w?.sent[0]?.words).toEqual(["Hallo", "Welt"]);
    w?.emit("message", { id: w.sent[0]?.id, bad: { Welt: ["Wel", "Welt"] } });
    expect(await p).toEqual([
      expect.objectContaining({ start: 11, end: 15, rule: "HUNSPELL", replacements: ["Wel", "Welt"] }),
    ]);
  });

  it("rejects pending requests on a worker error and starts a new worker next time", async () => {
    const p = hunspellCheck(req);
    const first = FakeWorker.all[0];
    first?.emit("error");
    await expect(p).rejects.toThrow(/ausgefallen/);
    expect(first?.terminated).toBe(true);
    void hunspellCheck(req).catch(() => undefined);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("handles messageerror like an error", async () => {
    const p = hunspellCheck(req);
    FakeWorker.all[0]?.emit("messageerror");
    await expect(p).rejects.toThrow(/ausgefallen/);
  });

  it("terminates a worker that does not answer in time", async () => {
    const p = hunspellCheck(req);
    const assertion = expect(p).rejects.toThrow(/antwortet nicht/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await assertion;
    expect(FakeWorker.all[0]?.terminated).toBe(true);
    void hunspellCheck(req).catch(() => undefined);
    expect(FakeWorker.all).toHaveLength(2);
  });
});
