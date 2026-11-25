import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";

/**
 * Returns CodeMirror read-only extensions that block local edits (including non-Yjs commands and
 * snippets) while keeping selection, remote Yjs updates (`ySyncAnnotation`), and awareness active.
 */
export function getReadOnlyExtension(readOnly: boolean): Extension {
  if (!readOnly) {
    return [EditorState.readOnly.of(false), EditorView.editable.of(true)];
  }
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // Keep contentDOM keyboard-focusable so commenter shortcuts (Ctrl-Alt-m) still trigger.
    EditorView.contentAttributes.of({ tabindex: "0" }),
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged) return tr;
      return tr.annotation(ySyncAnnotation) ? tr : [];
    }),
  ];
}
