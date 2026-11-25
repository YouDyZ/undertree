import { type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type * as Y from "yjs";
import {
  type CommentAnchor,
  type ResolvedCommentRange,
  resolveCommentHighlights,
} from "../lib/comments";

export interface CommentHighlightItem {
  threadId: number;
  from: number;
  to: number;
  active: boolean;
}

export const setCommentHighlights = StateEffect.define<CommentHighlightItem[]>();

export const commentHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setCommentHighlights)) continue;
      if (effect.value.length === 0) {
        next = Decoration.none;
        continue;
      }
      const docLen = tr.state.doc.length;
      const decos: Array<Range<Decoration>> = [];
      for (const item of effect.value) {
        const from = Math.max(0, Math.min(item.from, docLen));
        const to = Math.max(from, Math.min(item.to, docLen));
        if (from >= to) continue;
        decos.push(
          Decoration.mark({
            class: item.active ? "cm-comment-highlight is-active" : "cm-comment-highlight",
            attributes: { "data-comment-id": String(item.threadId) },
          }).range(from, to)
        );
      }
      next = Decoration.set(decos, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface YjsCommentHighlightBinding {
  schedule: () => void;
  flush: () => void;
  dispose: () => void;
}

/**
 * Synchronizes CodeMirror comment highlight decorations with Yjs updates asynchronously via
 * `queueMicrotask` so `view.dispatch(...)` is never called synchronously inside `y-codemirror`'s
 * `YSyncPluginValue.update()` transaction cycle.
 */
export function attachYjsCommentHighlights(
  ydoc: Y.Doc,
  getAnchors: () => readonly CommentAnchor[],
  getActiveCommentId: () => number | null,
  getView: () => EditorView | null,
  onResolved: (resolved: ResolvedCommentRange[]) => void
): YjsCommentHighlightBinding {
  let cancelled = false;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (cancelled) return;
    const resolved = resolveCommentHighlights(getAnchors(), ydoc);
    onResolved(resolved);
    const view = getView();
    if (!view) return;
    const activeId = getActiveCommentId();
    view.dispatch({
      effects: setCommentHighlights.of(
        resolved.map((item) => ({
          ...item,
          active: item.threadId === activeId,
        }))
      ),
    });
  };

  const schedule = () => {
    if (cancelled || scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  ydoc.on("update", schedule);
  return {
    schedule,
    flush,
    dispose: () => {
      cancelled = true;
      ydoc.off("update", schedule);
    },
  };
}
