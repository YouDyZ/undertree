import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";

const FLASH_MS = 1600;

const setFlash = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setFlash)) continue;
      if (e.value === null || e.value > tr.state.doc.length) return Decoration.none;
      return Decoration.set([Decoration.line({ class: "cm-synctex-flash" }).range(e.value)]);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashTimers = new WeakMap<EditorView, number>();

/** Briefly highlights the line containing `pos`. Needs `synctexExtension` in the editor. */
export function flashLine(view: EditorView, pos: number): void {
  const from = view.state.doc.lineAt(pos).from;
  view.dispatch({ effects: setFlash.of(from) });
  const prev = flashTimers.get(view);
  if (prev !== undefined) window.clearTimeout(prev);
  flashTimers.set(
    view,
    window.setTimeout(() => {
      flashTimers.delete(view);
      try {
        view.dispatch({ effects: setFlash.of(null) });
      } catch {
        // view destroyed meanwhile
      }
    }, FLASH_MS)
  );
}

/** 1-based line and 0-based column of the main cursor. */
export function cursorSyncPosition(view: EditorView): { line: number; column: number } {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, column: head - line.from };
}

/**
 * SyncTeX source -> PDF triggers: double-click (default word selection stays; `explicit` false)
 * and Ctrl+Alt+J (`explicit` true).
 */
export function synctexExtension(
  onSync: (line: number, column: number, explicit: boolean) => void
): Extension {
  return [
    flashField,
    EditorView.domEventHandlers({
      dblclick(ev, view) {
        const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        onSync(line.number, pos - line.from, false);
        return false;
      },
    }),
    keymap.of([
      {
        key: "Ctrl-Alt-j",
        run(view) {
          const { line, column } = cursorSyncPosition(view);
          onSync(line, column, true);
          return true;
        },
      },
    ]),
  ];
}
