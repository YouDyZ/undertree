// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserSpellcheckMemoryForTests } from "../editor/browserSpellcheck";
import { SpellcheckSettings } from "./SpellcheckSettings";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getDictionary: () => Promise.resolve({ words: [], disabled_rules: [] }),
}));

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("SpellcheckSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    resetBrowserSpellcheckMemoryForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
    localStorage.clear();
    resetBrowserSpellcheckMemoryForTests();
  });

  it("toggles browser extensions option, persists it, shows privacy warning and double-underline helper", async () => {
    render(h(SpellcheckSettings, { projectId: 1 }), container);
    await flushUi();

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
    expect(container.textContent).toContain("LanguageTool-Server");
    expect(container.textContent).not.toContain("doppelten Unterstreichungen");

    const onEvent = vi.fn();
    window.addEventListener("undertree:spellcheck-browser-extensions", onEvent);

    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushUi();

    window.removeEventListener("undertree:spellcheck-browser-extensions", onEvent);
    expect(localStorage.getItem("undertree.spellcheck.browser-extensions")).toBe("true");
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("doppelten Unterstreichungen");

    const disableBuiltinBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Eingebaute Prüfung ausschalten")
    );
    expect(disableBuiltinBtn).toBeDefined();
    disableBuiltinBtn!.click();
    await flushUi();

    expect(localStorage.getItem("undertree.spellcheck.provider")).toBe("off");
    expect(container.textContent).not.toContain("doppelten Unterstreichungen");
  });
});
