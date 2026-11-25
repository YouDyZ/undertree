import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

const STORAGE_KEY = "undertree.spellcheck.browser-extensions";
const CHANGE_EVENT = "undertree:spellcheck-browser-extensions";

let memoryValue: boolean | null = null;

/** Test helper to clear the in-memory fallback between isolated tests. */
export function resetBrowserSpellcheckMemoryForTests(): void {
  memoryValue = null;
}

/** Whether the user enabled browser spell/grammar extensions (e.g. LanguageTool) in this browser. */
export function getBrowserSpellcheckEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // storage blocked: fall back to in-memory setting
  }
  return memoryValue ?? false;
}

/** Persists the browser-extension toggle for this browser and notifies open CodeMirror views. */
export function setBrowserSpellcheckEnabled(enabled: boolean): void {
  memoryValue = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // storage blocked: applies in memory until reload
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** DOM attributes overriding CodeMirror's defaults so browser extensions (LanguageTool) attach. */
export const BROWSER_SPELLCHECK_ATTRS: Readonly<Record<string, string>> = {
  spellcheck: "true",
  autocorrect: "on",
  autocapitalize: "on",
  writingsuggestions: "true",
  "data-lt-active": "true",
};

const NO_ATTRS: Readonly<Record<string, string>> = {};

const setBrowserSpellcheck = StateEffect.define<boolean>();

const browserSpellcheckField = StateField.define<boolean>({
  create: () => getBrowserSpellcheckEnabled(),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setBrowserSpellcheck)) value = e.value;
    }
    return value;
  },
});

/**
 * Exposes `.cm-content` to browser spelling/grammar extensions when opted in and editable,
 * updating live without remounting the editor.
 */
export function browserSpellcheckExtension(): Extension {
  return [
    browserSpellcheckField,
    EditorView.contentAttributes.compute([browserSpellcheckField, EditorView.editable], (state) =>
      state.field(browserSpellcheckField) && state.facet(EditorView.editable)
        ? BROWSER_SPELLCHECK_ATTRS
        : NO_ATTRS
    ),
    ViewPlugin.define((view) => {
      const sync = () => {
        const next = getBrowserSpellcheckEnabled();
        if (view.state.field(browserSpellcheckField) !== next) {
          view.dispatch({ effects: setBrowserSpellcheck.of(next) });
        }
      };
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === STORAGE_KEY) sync();
      };
      window.addEventListener(CHANGE_EVENT, sync);
      window.addEventListener("storage", onStorage);
      return {
        destroy() {
          window.removeEventListener(CHANGE_EVENT, sync);
          window.removeEventListener("storage", onStorage);
        },
      };
    }),
  ];
}
