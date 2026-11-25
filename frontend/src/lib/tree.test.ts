import { describe, expect, it } from "vitest";
import type { Tree } from "../api";
import { buildTreeNodes, filterTreeNodes, isImageFile, isTexFile } from "./tree";

const sampleTree: Tree = {
  repos: [
    {
      path: "",
      name: "research",
      kind: "parent",
      initialized: true,
      branch: "main",
      head: "a1b2c3d",
    },
    {
      path: "papers/icml",
      name: "icml",
      kind: "submodule",
      initialized: true,
      branch: "main",
      head: "deadbee",
    },
    {
      path: "papers/neurips",
      name: "neurips",
      kind: "submodule",
      initialized: false,
      branch: null,
      head: null,
    },
  ],
  entries: [
    { path: "README.md", kind: "file", repo: "" },
    { path: "papers", kind: "dir", repo: "" },
    { path: "papers/icml", kind: "dir", repo: "papers/icml" },
    { path: "papers/icml/main.tex", kind: "file", repo: "papers/icml" },
    { path: "papers/icml/figs", kind: "dir", repo: "papers/icml" },
    { path: "papers/icml/figs/plot.png", kind: "file", repo: "papers/icml" },
  ],
};

describe("tree builder", () => {
  it("groups entries hierarchically and includes uninitialized submodules", () => {
    const nodes = buildTreeNodes(sampleTree);
    expect(nodes.map((n) => n.name)).toEqual(["papers", "README.md"]);

    const papers = nodes[0]!;
    expect(papers.kind).toBe("dir");
    expect(papers.children.map((n) => n.name)).toEqual(["icml", "neurips"]);

    const icml = papers.children[0]!;
    expect(icml.submodule?.initialized).toBe(true);
    expect(icml.submodule?.branch).toBe("main");
    expect(icml.children.map((n) => n.name)).toEqual(["figs", "main.tex"]);

    const neurips = papers.children[1]!;
    expect(neurips.submodule?.initialized).toBe(false);
    expect(neurips.children).toEqual([]);
  });

  it("filters tree while preserving matching ancestor folders", () => {
    const nodes = buildTreeNodes(sampleTree);
    const filtered = filterTreeNodes(nodes, "plot.png");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.path).toBe("papers");
    expect(filtered[0]?.children[0]?.path).toBe("papers/icml");
    expect(filtered[0]?.children[0]?.children[0]?.path).toBe("papers/icml/figs");
    expect(filtered[0]?.children[0]?.children[0]?.children[0]?.path).toBe(
      "papers/icml/figs/plot.png"
    );
  });

  it("detects tex and image extensions", () => {
    expect(isTexFile("papers/icml/main.tex")).toBe(true);
    expect(isTexFile("README.md")).toBe(false);
    expect(isImageFile("figs/plot.PNG")).toBe(true);
    expect(isImageFile("main.tex")).toBe(false);
  });
});
