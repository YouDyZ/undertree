import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ApiError, type CommentMessage, type CommentThread, type User } from "../api";
import {
  MAX_COMMENT_BODY_CHARS,
  canDeleteThread,
  canEditOrDeleteMessage,
  clampValidSelectionRange,
  clearCommentJumpTargetForPath,
  consumeCommentJumpTarget,
  countOpenCommentsByFile,
  countUnicodeChars,
  createCommentAnchors,
  findCommentAtPosition,
  formatCommentError,
  getFileSidebarThreads,
  getOverviewThreads,
  mergeFileThreadsIntoProject,
  resolveCommentAnchorRange,
  resolveCommentHighlights,
  shouldApplyCommentsLoad,
  syncCommentAnchors,
  validateCommentBody,
} from "./comments";

const alice: User = {
  id: 1,
  username: "alice",
  display_name: "Alice",
  email: "alice@example.org",
  is_admin: false,
  commit_email: null,
};

const adminUser: User = {
  ...alice,
  id: 2,
  username: "root",
  display_name: "Admin",
  is_admin: true,
};

function makeThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 1,
    path: "main.tex",
    start: 6,
    end: 11,
    quote: "world",
    detached: false,
    resolved: false,
    resolved_by: null,
    created_by: "alice",
    created_at: "2026-11-24T12:00:00Z",
    messages: [
      {
        id: 10,
        author: "alice",
        display_name: "Alice",
        body: "Cite this?",
        created_at: "2026-11-24T12:00:00Z",
        edited_at: null,
      },
    ],
    ...overrides,
  };
}

describe("Y.RelativePosition comment anchoring", () => {
  it("tracks local and remote edits and keeps edge typing outside the highlighted range", () => {
    const localDoc = new Y.Doc();
    localDoc.clientID = 1;
    const remoteDoc = new Y.Doc();
    remoteDoc.clientID = 2;

    const ytext = localDoc.getText("content");
    ytext.insert(0, "Hello world!");
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));

    const openThread = makeThread({ id: 1, start: 6, end: 11, quote: "world" });
    const resolvedThread = makeThread({ id: 2, start: 0, end: 5, quote: "Hello", resolved: true });
    const detachedThread = makeThread({ id: 3, start: 0, end: 0, quote: "gone", detached: true });

    const anchors = createCommentAnchors([openThread, resolvedThread, detachedThread], localDoc);
    expect(anchors.map((a) => a.threadId)).toEqual([1, 2]);
    expect(resolveCommentHighlights(anchors, localDoc)).toEqual([{ threadId: 1, from: 6, to: 11 }]);

    // Edge typing right before `start` (index 6) and right at `end` (index 11) stays outside
    localDoc.transact(() => {
      ytext.insert(11, "!");
      ytext.insert(6, "big ");
    });
    expect(ytext.toString()).toBe("Hello big world!!");
    expect(resolveCommentHighlights(anchors, localDoc)).toEqual([{ threadId: 1, from: 10, to: 15 }]);
    expect(ytext.toString().slice(10, 15)).toBe("world");

    // Remote insertion before the highlighted range shifts both open and resolved anchors
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));
    remoteDoc.getText("content").insert(0, "Intro: ");
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(remoteDoc));

    expect(resolveCommentHighlights(anchors, localDoc)).toEqual([{ threadId: 1, from: 17, to: 22 }]);
    expect(ytext.toString().slice(17, 22)).toBe("world");

    // Resolved anchor is excluded from highlights, but still resolves for jump-to-thread
    const resolvedAnchor = anchors.find((a) => a.threadId === 2)!;
    expect(resolveCommentAnchorRange(resolvedAnchor, localDoc)).toEqual({
      threadId: 2,
      from: 7,
      to: 12,
    });
  });

  it("drops highlight once the anchored text is deleted entirely", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "Hello world!");

    const anchors = createCommentAnchors([makeThread({ start: 6, end: 11 })], doc);
    ytext.delete(6, 5);
    expect(resolveCommentHighlights(anchors, doc)).toEqual([]);
  });

  it("syncCommentAnchors preserves shifted anchors across unrelated updates and defers until doc sync", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    const serverThread = makeThread({ id: 1, start: 6, end: 11, quote: "world" });

    // Before initial sync (doc is still empty), non-empty comment ranges wait instead of pinning at 0..0
    let anchors = syncCommentAnchors([], [serverThread], doc);
    expect(anchors).toEqual([]);

    // Once content arrives, initial anchor resolves to 6..11
    ytext.insert(0, "Hello world!");
    anchors = syncCommentAnchors(anchors, [serverThread], doc);
    expect(resolveCommentHighlights(anchors, doc)).toEqual([{ threadId: 1, from: 6, to: 11 }]);

    // User inserts 5 chars before the comment locally -> shifts to 11..16
    ytext.insert(0, "12345");
    expect(resolveCommentHighlights(anchors, doc)).toEqual([{ threadId: 1, from: 11, to: 16 }]);

    // Unrelated project reload / resolve toggle with unchanged server offsets keeps live 11..16 range
    const reloaded = makeThread({ id: 1, start: 6, end: 11, resolved: false });
    anchors = syncCommentAnchors(anchors, [reloaded], doc);
    expect(resolveCommentHighlights(anchors, doc)).toEqual([{ threadId: 1, from: 11, to: 16 }]);

    // Resolving updates resolved status without resetting the live Y.RelativePosition
    anchors = syncCommentAnchors(anchors, [{ ...reloaded, resolved: true }], doc);
    expect(resolveCommentHighlights(anchors, doc)).toEqual([]);
    expect(resolveCommentAnchorRange(anchors[0]!, doc)).toEqual({ threadId: 1, from: 11, to: 16 });

    // If the server sends updated offsets (e.g. thread relocated), the anchor rebuilds from them
    anchors = syncCommentAnchors(anchors, [makeThread({ id: 1, start: 0, end: 5, resolved: false })], doc);
    expect(resolveCommentHighlights(anchors, doc)).toEqual([{ threadId: 1, from: 0, to: 5 }]);
  });
});

describe("selection clamping & overlapping hit-testing", () => {
  it("clamps selections cleanly without splitting UTF-16 surrogate pairs", () => {
    const text = "A😀B"; // indices: A=0, 😀=1..2, B=3
    expect(clampValidSelectionRange(text, 2, 4)).toEqual({
      start: 1,
      end: 4,
      quote: "😀B",
    });
    expect(clampValidSelectionRange(text, 0, 2)).toEqual({
      start: 0,
      end: 3,
      quote: "A😀",
    });
    expect(clampValidSelectionRange(text, 2, 2)).toBeNull();
  });

  it("picks the narrowest comment highlight when ranges overlap", () => {
    const ranges = [
      { threadId: 1, from: 0, to: 40 },
      { threadId: 2, from: 10, to: 18 },
    ];
    expect(findCommentAtPosition(ranges, 14)).toBe(2);
    expect(findCommentAtPosition(ranges, 5)).toBe(1);
    expect(findCommentAtPosition(ranges, 50)).toBeNull();
  });
});

describe("filtering, sorting, counts, merging & guards", () => {
  it("counts only open threads per file and separates detached threads to overview only", () => {
    const threads: CommentThread[] = [
      makeThread({ id: 1, path: "b.tex", start: 20, resolved: false }),
      makeThread({ id: 2, path: "a.tex", start: 30, resolved: false }),
      makeThread({ id: 3, path: "a.tex", start: 5, resolved: true }),
      makeThread({ id: 4, path: "a.tex", start: 10, detached: true, resolved: false }),
    ];

    const counts = countOpenCommentsByFile(threads);
    expect(counts.get("a.tex")).toBe(2);
    expect(counts.get("b.tex")).toBe(1);

    // File sidebar excludes detached threads and respects showResolved + live start order
    expect(getFileSidebarThreads(threads, "a.tex", false).map((t) => t.id)).toEqual([2]);
    expect(
      getFileSidebarThreads(threads, "a.tex", true, new Map([[2, 1]])).map((t) => t.id)
    ).toEqual([2, 3]);

    // Project overview includes detached threads, sorted by path then start
    expect(getOverviewThreads(threads, false).map((t) => t.id)).toEqual([4, 2, 1]);
    expect(getOverviewThreads(threads, true).map((t) => t.id)).toEqual([3, 4, 2, 1]);
  });

  it("merges per-file comment reloads deterministically and guards stale project loads", () => {
    const existing = [
      makeThread({ id: 1, path: "a.tex", start: 5 }),
      makeThread({ id: 2, path: "b.tex", start: 10 }),
    ];
    const nextA = [makeThread({ id: 9, path: "a.tex", start: 2 })];
    expect(mergeFileThreadsIntoProject(existing, "a.tex", nextA).map((t) => t.id)).toEqual([9, 2]);

    expect(shouldApplyCommentsLoad(1, 1, 4, 4)).toBe(true);
    expect(shouldApplyCommentsLoad(1, 2, 4, 4)).toBe(false);
    expect(shouldApplyCommentsLoad(1, 1, 3, 4)).toBe(false);

    const target = { path: "main.tex", threadId: 5, start: 1, end: 4, seq: 3 };
    expect(consumeCommentJumpTarget(target, 2)).toEqual(target);
    expect(consumeCommentJumpTarget(target, 3)).toBeNull();
    expect(clearCommentJumpTargetForPath(target, "other.tex")).toEqual(target);
    expect(clearCommentJumpTargetForPath(target, "main.tex")).toBeNull();
  });
});

describe("permissions, validation, and German error messages", () => {
  it("checks author and admin permissions plus body length bounds", () => {
    const aliceMsg: CommentMessage = {
      id: 1,
      author: "alice",
      display_name: "Alice",
      body: "Hi",
      created_at: "2026-11-24T12:00:00Z",
      edited_at: null,
    };
    const deletedAuthorMsg: CommentMessage = { ...aliceMsg, id: 2, author: null, display_name: null };

    expect(canEditOrDeleteMessage(aliceMsg, alice)).toBe(true);
    expect(canEditOrDeleteMessage(aliceMsg, { ...alice, username: "bob" })).toBe(false);
    expect(canEditOrDeleteMessage(deletedAuthorMsg, adminUser)).toBe(false);

    const bobThread = makeThread({ created_by: "bob" });
    expect(canDeleteThread(bobThread, alice)).toBe(false);
    expect(canDeleteThread(bobThread, alice, true)).toBe(true);
    expect(canDeleteThread(bobThread, adminUser)).toBe(true);
    expect(canDeleteThread(makeThread({ created_by: "alice" }), alice)).toBe(true);

    expect(validateCommentBody("   \n\t ")).toMatchObject({ ok: false });
    expect(validateCommentBody("  Hallo  ")).toEqual({ ok: true, body: "Hallo" });
    expect(validateCommentBody("x".repeat(MAX_COMMENT_BODY_CHARS + 1))).toMatchObject({ ok: false });
    expect(countUnicodeChars("A😀B")).toBe(3);
    expect(validateCommentBody("😀".repeat(6000)).ok).toBe(true);
    expect(validateCommentBody("😀".repeat(MAX_COMMENT_BODY_CHARS + 1))).toMatchObject({
      ok: false,
    });

    expect(formatCommentError(new ApiError(403, "forbidden", "nope"), "Fallback")).toContain(
      "Berechtigung"
    );
    expect(formatCommentError(new ApiError(403, "insufficient_role", "viewer"), "Fallback")).toContain(
      "Berechtigung"
    );
    expect(formatCommentError(new ApiError(413, "too_large", "big"), "Fallback")).toContain("8-MiB");
  });
});
