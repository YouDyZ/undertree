// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CommentThread } from "../api";
import { type ResolvedCommentRange, syncCommentAnchors } from "../lib/comments";
import { attachYjsCommentHighlights, commentHighlightField } from "./commentHighlights";

function makeThread(): CommentThread {
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
        body: "Check word",
        created_at: "2026-11-24T12:00:00Z",
        edited_at: null,
      },
    ],
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function collectDecorations(view: EditorView): Array<{ from: number; to: number; className: string }> {
  const out: Array<{ from: number; to: number; className: string }> = [];
  const iter = view.state.field(commentHighlightField).iter();
  while (iter.value) {
    const spec = iter.value.spec as { class?: string };
    out.push({ from: iter.from, to: iter.to, className: spec.class ?? "" });
    iter.next();
  }
  return out;
}

describe("attachYjsCommentHighlights with CodeMirror + yCollab", () => {
  it("survives consecutive local edits without crashing ySync and preserves shifted highlight across active changes", async () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "hello world");

    const awareness = new Awareness(ydoc);
    let anchors = syncCommentAnchors([], [makeThread()], ydoc);
    let activeCommentId: number | null = null;
    let resolvedRanges: ResolvedCommentRange[] = [];
    let view: EditorView | null = null;

    const binding = attachYjsCommentHighlights(
      ydoc,
      () => anchors,
      () => activeCommentId,
      () => view,
      (resolved) => {
        resolvedRanges = resolved;
      }
    );

    const host = document.createElement("div");
    document.body.appendChild(host);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [commentHighlightField, yCollab(ytext, awareness)],
    });
    view = new EditorView({ state, parent: host });

    try {
      binding.schedule();
      await flushMicrotasks();

      expect(collectDecorations(view)).toEqual([
        { from: 6, to: 11, className: "cm-comment-highlight" },
      ]);

      // Two consecutive local inserts: yCollab fires ydoc updates inside CM6 transactions;
      // async microtask dispatch must NOT throw "Calls to EditorView.update are not allowed"
      view.dispatch({ changes: { from: 0, insert: "A" } });
      view.dispatch({ changes: { from: 1, insert: "B" } });
      await flushMicrotasks();

      expect(view.state.doc.toString()).toBe("ABhello world");
      expect(ytext.toString()).toBe("ABhello world");
      expect(resolvedRanges).toEqual([{ threadId: 1, from: 8, to: 13 }]);
      expect(collectDecorations(view)).toEqual([
        { from: 8, to: 13, className: "cm-comment-highlight" },
      ]);

      // Switching activeCommentId must NOT rebuild anchors from stale server offsets (6..11)
      anchors = syncCommentAnchors(anchors, [makeThread()], ydoc);
      activeCommentId = 1;
      binding.schedule();
      await flushMicrotasks();

      expect(collectDecorations(view)).toEqual([
        { from: 8, to: 13, className: "cm-comment-highlight is-active" },
      ]);
    } finally {
      binding.dispose();
      view.destroy();
      awareness.destroy();
      host.remove();
    }
  });
});
