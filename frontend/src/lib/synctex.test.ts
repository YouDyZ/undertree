import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import {
  displayToPagePoint,
  pageBoxToCssRect,
  planSyncRequest,
  syncErrorHint,
  type PageGeometry,
} from "./synctex";

const base: PageGeometry = { scale: 2, rotation: 0, width: 600, height: 800 };

describe("displayToPagePoint", () => {
  it("divides by the scale (origin top left)", () => {
    expect(displayToPagePoint(401, 262, base)).toEqual({ x: 200.5, y: 131 });
  });

  it("inverts pageBoxToCssRect for every rotation", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const landscape = rotation === 90 || rotation === 270;
      const g: PageGeometry = {
        scale: 1.5,
        rotation,
        // displayed size: width/height swap for 90/270
        width: landscape ? 800 : 600,
        height: landscape ? 600 : 800,
      };
      const r = pageBoxToCssRect({ x: 100, y: 200, w: 0, h: 0 }, g);
      const p = displayToPagePoint(r.left, r.top, g);
      expect(p.x).toBeCloseTo(100);
      expect(p.y).toBeCloseTo(200);
    }
  });
});

describe("pageBoxToCssRect", () => {
  it("scales an unrotated box", () => {
    expect(pageBoxToCssRect({ x: 10, y: 20, w: 30, h: 5 }, base)).toEqual({
      left: 20,
      top: 40,
      width: 60,
      height: 10,
    });
  });

  it("rotates 90 degrees clockwise (page top-left corner ends up top-right)", () => {
    const g: PageGeometry = { scale: 1, rotation: 90, width: 800, height: 600 };
    expect(pageBoxToCssRect({ x: 0, y: 0, w: 10, h: 20 }, g)).toEqual({
      left: 780,
      top: 0,
      width: 20,
      height: 10,
    });
  });
});

describe("planSyncRequest", () => {
  it("consumes each request once and never waits for a later render", () => {
    expect(planSyncRequest(3, 3, true)).toBe("ignore");
    expect(planSyncRequest(4, 3, true)).toBe("run");
    expect(planSyncRequest(4, 3, false)).toBe("no_pdf");
  });
});

describe("syncErrorHint", () => {
  it("hints only on explicit no_synctex", () => {
    const err = new ApiError(404, "no_synctex", "x");
    expect(syncErrorHint(err, true)).toMatch(/kompilieren/);
    expect(syncErrorHint(err, false)).toBeNull();
  });

  it("is silent on no_match and reports other errors", () => {
    expect(syncErrorHint(new ApiError(404, "no_match", "x"), true)).toBeNull();
    expect(syncErrorHint(new ApiError(500, "internal", "kaputt"), false)).toBe("kaputt");
  });
});
