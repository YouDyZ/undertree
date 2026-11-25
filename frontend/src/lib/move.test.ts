import { describe, expect, it } from "vitest";
import {
  baseName,
  dropTargetPath,
  formatRefQuestion,
  mapMovedPath,
  parentDir,
  validateMoveTarget,
} from "./move";

describe("mapMovedPath", () => {
  it("maps the moved path and everything below it", () => {
    expect(mapMovedPath("a/sec", "a/sec", "a/chap")).toBe("a/chap");
    expect(mapMovedPath("a/sec/x.tex", "a/sec", "a/chap")).toBe("a/chap/x.tex");
    expect(mapMovedPath("a/section/x.tex", "a/sec", "a/chap")).toBe("a/section/x.tex");
    expect(mapMovedPath("b.tex", "a", "c")).toBe("b.tex");
  });
});

describe("paths", () => {
  it("splits parent and name", () => {
    expect(parentDir("a/b/c.tex")).toBe("a/b");
    expect(parentDir("c.tex")).toBe("");
    expect(baseName("a/b/c.tex")).toBe("c.tex");
    expect(baseName("c.tex")).toBe("c.tex");
  });
});

describe("validateMoveTarget", () => {
  it("accepts a new path", () => {
    expect(validateMoveTarget("a.tex", " sec/a.tex ")).toBeNull();
  });
  it("rejects empty, unchanged, malformed and self-nested targets", () => {
    expect(validateMoveTarget("a.tex", " ")).not.toBeNull();
    expect(validateMoveTarget("a.tex", "a.tex")).not.toBeNull();
    expect(validateMoveTarget("a.tex", "/x.tex")).not.toBeNull();
    expect(validateMoveTarget("a.tex", "x//y.tex")).not.toBeNull();
    expect(validateMoveTarget("a.tex", "../y.tex")).not.toBeNull();
    expect(validateMoveTarget("sec", "sec/in/side")).not.toBeNull();
  });
});

describe("dropTargetPath", () => {
  it("builds the new path below the directory", () => {
    expect(dropTargetPath("a/x.tex", "b")).toBe("b/x.tex");
    expect(dropTargetPath("a/x.tex", "")).toBe("x.tex");
  });
  it("ignores no-op and illegal drops", () => {
    expect(dropTargetPath("a/x.tex", "a")).toBeNull();
    expect(dropTargetPath("x.tex", "")).toBeNull();
    expect(dropTargetPath("a", "a")).toBeNull();
    expect(dropTargetPath("a", "a/b")).toBeNull();
  });
});

describe("formatRefQuestion", () => {
  const ref = (path: string) => ({ path, line: 1, old: "a", new: "b" });
  it("counts references and files", () => {
    expect(formatRefQuestion([ref("m.tex"), ref("m.tex"), ref("n.tex")])).toBe(
      "3 Verweise in 2 Dateien mitändern?"
    );
    expect(formatRefQuestion([ref("m.tex")])).toBe("1 Verweis in 1 Datei mitändern?");
  });
});
