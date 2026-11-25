// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getReadOnlyExtension } from "./readOnly";

describe("CodeMirror read-only mode with yCollab", () => {
  it("blocks user input edits while keeping remote Yjs updates, selection, and awareness active", () => {
    const ydoc = new Y.Doc();
    ydoc.clientID = 1;
    const ytext = ydoc.getText("content");
    ytext.insert(0, "Hallo Welt");

    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField("user", { name: "Viewer", color: "#38bdf8" });

    const readOnlyCompartment = new Compartment();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [readOnlyCompartment.of(getReadOnlyExtension(true)), yCollab(ytext, awareness)],
      }),
      parent: host,
    });

    try {
      expect(view.state.readOnly).toBe(true);
      expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
      expect(view.contentDOM.getAttribute("tabindex")).toBe("0");

      // Interactive user edit transaction must be rejected by readOnly
      view.dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
      expect(view.state.doc.toString()).toBe("Hallo Welt");
      expect(ytext.toString()).toBe("Hallo Welt");

      // Remote Yjs updates still flow into the view
      const remoteDoc = new Y.Doc();
      remoteDoc.clientID = 2;
      Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(ydoc));
      remoteDoc.getText("content").insert(10, "!");
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));
      expect(view.state.doc.toString()).toBe("Hallo Welt!");

      // Cursor selection & awareness remain active
      view.dispatch({ selection: { anchor: 2, head: 5 } });
      expect(view.state.selection.main.from).toBe(2);
      expect(view.state.selection.main.to).toBe(5);
      expect(awareness.getLocalState()?.user).toEqual({ name: "Viewer", color: "#38bdf8" });

      // Live Compartment toggle switches back to editable without remounting
      view.dispatch({ effects: readOnlyCompartment.reconfigure(getReadOnlyExtension(false)) });
      expect(view.state.readOnly).toBe(false);
      expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
      expect(view.contentDOM.getAttribute("tabindex")).toBeNull();
    } finally {
      view.destroy();
      awareness.destroy();
      host.remove();
    }
  });
});
