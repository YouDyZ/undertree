import { describe, expect, it } from "vitest";
import { computePopoverPosition, resolveAvailableSteps } from "./positioning";
import { EDITOR_TOUR_STEPS } from "./steps";
import {
  TOUR_STORAGE_KEY,
  applyTourAction,
  hasCompletedTour,
  markTourCompleted,
  resetTourCompletion,
  shouldStartTourFromUrl,
} from "./storage";

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("guided tour positioning", () => {
  const popover = { width: 340, height: 200 };
  const viewport = { width: 1280, height: 800 };

  it("centers welcome step when targetRect is null", () => {
    const pos = computePopoverPosition(null, popover, viewport, "auto");
    expect(pos).toEqual({
      top: 300,
      left: 470,
      placement: "center",
    });
  });

  it("places popover to the right when space allows", () => {
    const pos = computePopoverPosition(
      { top: 100, left: 10, width: 260, height: 500 },
      popover,
      viewport,
      "right"
    );
    expect(pos.placement).toBe("right");
    expect(pos.left).toBe(284);
    expect(pos.top).toBe(250);
  });

  it("flips to left when preferred right overflows viewport", () => {
    const pos = computePopoverPosition(
      { top: 100, left: 1000, width: 260, height: 400 },
      popover,
      viewport,
      "right"
    );
    expect(pos.placement).toBe("left");
    expect(pos.left).toBe(1000 - 340 - 14);
  });

  it("clamps coordinates inside narrow viewports", () => {
    const pos = computePopoverPosition(
      { top: 10, left: 300, width: 80, height: 30 },
      { width: 340, height: 220 },
      { width: 380, height: 500 },
      "bottom"
    );
    expect(pos.left).toBeGreaterThanOrEqual(12);
    expect(pos.left + 340).toBeLessThanOrEqual(380 - 12);
    expect(pos.top).toBeGreaterThanOrEqual(12);
  });

  it("filters out steps whose DOM targets are absent while preserving modal steps", () => {
    const available = resolveAvailableSteps(EDITOR_TOUR_STEPS, (sel) => sel === '[data-tour="file-tree"]');
    expect(available.map((s) => s.id)).toEqual(["welcome", "file-tree"]);
  });
});

describe("guided tour persistence and URL trigger", () => {
  it("tracks completion in storage cleanly", () => {
    const storage = createMemoryStorage();
    expect(hasCompletedTour(storage)).toBe(false);

    markTourCompleted(storage);
    expect(storage.getItem(TOUR_STORAGE_KEY)).toBe("1");
    expect(hasCompletedTour(storage)).toBe(true);

    resetTourCompletion(storage);
    expect(hasCompletedTour(storage)).toBe(false);
  });

  it("recognizes ?tour=1 and ?tour=true query params", () => {
    expect(shouldStartTourFromUrl("?tour=1")).toBe(true);
    expect(shouldStartTourFromUrl("?foo=bar&tour=true")).toBe(true);
    expect(shouldStartTourFromUrl("?tour=0")).toBe(false);
    expect(shouldStartTourFromUrl("")).toBe(false);
  });

  it("does not persist completion when dismissed, only when finished (#29 review)", () => {
    const storage = createMemoryStorage();
    const afterDismiss = applyTourAction({ open: true, completed: false }, "dismiss", storage);
    expect(afterDismiss).toEqual({ open: false, completed: false });
    expect(hasCompletedTour(storage)).toBe(false);

    const afterFinish = applyTourAction({ open: true, completed: false }, "finish", storage);
    expect(afterFinish).toEqual({ open: false, completed: true });
    expect(hasCompletedTour(storage)).toBe(true);
  });
});
