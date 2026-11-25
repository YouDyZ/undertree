// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  browserSpellcheckExtension,
  getBrowserSpellcheckEnabled,
  resetBrowserSpellcheckMemoryForTests,
  setBrowserSpellcheckEnabled,
} from "./browserSpellcheck";

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("browserSpellcheckExtension", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBrowserSpellcheckMemoryForTests();
  });

  afterEach(() => {
    localStorage.clear();
    resetBrowserSpellcheckMemoryForTests();
  });

  it("keeps CodeMirror defaults when disabled and toggles attributes live without remounting", () => {
    const host = createHost();
    const view = new EditorView({
      state: EditorState.create({
        doc: "Hallo Welt",
        extensions: [browserSpellcheckExtension()],
      }),
      parent: host,
    });

    try {
      expect(getBrowserSpellcheckEnabled()).toBe(false);
      expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
      expect(view.contentDOM.getAttribute("autocorrect")).toBe("off");
      expect(view.contentDOM.getAttribute("autocapitalize")).toBe("off");
      expect(view.contentDOM.getAttribute("writingsuggestions")).toBe("false");
      expect(view.contentDOM.getAttribute("data-lt-active")).toBeNull();

      // Enable live: existing EditorView updates in place
      const contentNode = view.contentDOM;
      setBrowserSpellcheckEnabled(true);
      expect(getBrowserSpellcheckEnabled()).toBe(true);
      expect(view.contentDOM).toBe(contentNode);
      expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
      expect(view.contentDOM.getAttribute("autocorrect")).toBe("on");
      expect(view.contentDOM.getAttribute("autocapitalize")).toBe("on");
      expect(view.contentDOM.getAttribute("writingsuggestions")).toBe("true");
      expect(view.contentDOM.getAttribute("data-lt-active")).toBe("true");

      // Disable live again: CodeMirror defaults are restored and data-lt-active is removed
      setBrowserSpellcheckEnabled(false);
      expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
      expect(view.contentDOM.getAttribute("autocorrect")).toBe("off");
      expect(view.contentDOM.getAttribute("autocapitalize")).toBe("off");
      expect(view.contentDOM.getAttribute("writingsuggestions")).toBe("false");
      expect(view.contentDOM.getAttribute("data-lt-active")).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("does not enable browser spellcheck attributes when the editor is read-only", () => {
    setBrowserSpellcheckEnabled(true);
    const editableCompartment = new Compartment();
    const host = createHost();
    const view = new EditorView({
      state: EditorState.create({
        doc: "Nur lesen",
        extensions: [editableCompartment.of(EditorView.editable.of(false)), browserSpellcheckExtension()],
      }),
      parent: host,
    });

    try {
      expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
      expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
      expect(view.contentDOM.getAttribute("data-lt-active")).toBeNull();

      // Turning editable back on exposes the opted-in attributes immediately
      view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(true)) });
      expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
      expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
      expect(view.contentDOM.getAttribute("data-lt-active")).toBe("true");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("propagates extension-style text replacements through yCollab to peers and supports undo", () => {
    setBrowserSpellcheckEnabled(true);

    const docA = new Y.Doc();
    docA.clientID = 1;
    const docB = new Y.Doc();
    docB.clientID = 2;

    const ytextA = docA.getText("content");
    const ytextB = docB.getText("content");
    ytextA.insert(0, "Das ist ein Fehlr im Text.");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Keep two Y.Docs synced like WebSocket peers
    docA.on("update", (u: Uint8Array) => Y.applyUpdate(docB, u));
    docB.on("update", (u: Uint8Array) => Y.applyUpdate(docA, u));

    const awareness = new Awareness(docA);
    const undoManager = new Y.UndoManager(ytextA);
    const host = createHost();
    const view = new EditorView({
      state: EditorState.create({
        doc: ytextA.toString(),
        extensions: [browserSpellcheckExtension(), yCollab(ytextA, awareness, { undoManager })],
      }),
      parent: host,
    });

    try {
      expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
      expect(view.contentDOM.getAttribute("data-lt-active")).toBe("true");

      // Simulate an extension replacing "Fehlr" via DOM text mutation flushed by CM6's DOMObserver
      const lineEl = view.contentDOM.querySelector(".cm-line");
      expect(lineEl).not.toBeNull();
      const textNode = lineEl!.firstChild;
      expect(textNode).not.toBeNull();
      textNode!.textContent = "Das ist ein Fehler im Text.";
      (view as unknown as { observer: { flush: () => void } }).observer.flush();

      expect(view.state.doc.toString()).toBe("Das ist ein Fehler im Text.");
      expect(ytextA.toString()).toBe("Das ist ein Fehler im Text.");
      expect(ytextB.toString()).toBe("Das ist ein Fehler im Text.");

      undoManager.undo();
      expect(view.state.doc.toString()).toBe("Das ist ein Fehlr im Text.");
      expect(ytextB.toString()).toBe("Das ist ein Fehlr im Text.");
    } finally {
      view.destroy();
      awareness.destroy();
      host.remove();
    }
  });
});
