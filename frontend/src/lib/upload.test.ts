import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Repo } from "../api";
import {
  buildUploadTargetPath,
  extractDroppedFiles,
  findCollisions,
  formatIncludeGraphicsSnippet,
  formatUploadError,
  isIncludeGraphicsAsset,
  isInsideUninitializedSubmodule,
  processDroppedTransfer,
  resolveEffectiveCompileRoot,
  resolveIncludeGraphicsPath,
  sanitizeUploadSegment,
} from "./upload";

const sampleRepos: Repo[] = [
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
];

describe("upload path sanitizing", () => {
  it("accepts clean filenames and rejects unsafe segments", () => {
    expect(sanitizeUploadSegment("plot.png")).toBe("plot.png");
    expect(sanitizeUploadSegment("figure 1 (final).pdf")).toBe("figure 1 (final).pdf");
    expect(sanitizeUploadSegment("  trimmed.png  ")).toBe("trimmed.png");

    expect(sanitizeUploadSegment("")).toBeNull();
    expect(sanitizeUploadSegment("   ")).toBeNull();
    expect(sanitizeUploadSegment(".")).toBeNull();
    expect(sanitizeUploadSegment("..")).toBeNull();
    expect(sanitizeUploadSegment(".git")).toBeNull();
    expect(sanitizeUploadSegment(".GIT")).toBeNull();
    expect(sanitizeUploadSegment("a\\b.png")).toBeNull();
    expect(sanitizeUploadSegment("a/b.png")).toBeNull();
    expect(sanitizeUploadSegment("bad\0name.png")).toBeNull();
  });

  it("builds normalized workspace paths and rejects traversal or invalid segments", () => {
    expect(buildUploadTargetPath("", "plot.png")).toBe("plot.png");
    expect(buildUploadTargetPath("figs", "plot.png")).toBe("figs/plot.png");
    expect(buildUploadTargetPath("/papers//icml/", "//figs//ch1/plot.png")).toBe(
      "papers/icml/figs/ch1/plot.png"
    );
    expect(buildUploadTargetPath("", "nested/dir/image.jpg")).toBe("nested/dir/image.jpg");

    expect(buildUploadTargetPath("figs", "../secret.tex")).toBeNull();
    expect(buildUploadTargetPath("figs", "./plot.png")).toBeNull();
    expect(buildUploadTargetPath("figs", ".git/config")).toBeNull();
    expect(buildUploadTargetPath(".git", "HEAD")).toBeNull();
    expect(buildUploadTargetPath("figs", "sub\\plot.png")).toBeNull();
    expect(buildUploadTargetPath("figs\\sub", "plot.png")).toBeNull();
    expect(buildUploadTargetPath("figs", "plot\0.png")).toBeNull();
    expect(buildUploadTargetPath("figs", "")).toBeNull();
    expect(buildUploadTargetPath("figs", "subdir/")).toBeNull();
  });
});

describe("uninitialized submodule detection", () => {
  it("detects target paths equal to or inside uninitialized submodules", () => {
    expect(isInsideUninitializedSubmodule("papers/neurips", sampleRepos)?.path).toBe(
      "papers/neurips"
    );
    expect(isInsideUninitializedSubmodule("papers/neurips/figs/plot.png", sampleRepos)?.path).toBe(
      "papers/neurips"
    );
    expect(isInsideUninitializedSubmodule("/papers/neurips/main.tex", sampleRepos)?.path).toBe(
      "papers/neurips"
    );
  });

  it("allows parent repo, initialized submodules, and sibling prefix names", () => {
    expect(isInsideUninitializedSubmodule("", sampleRepos)).toBeNull();
    expect(isInsideUninitializedSubmodule("figs/plot.png", sampleRepos)).toBeNull();
    expect(isInsideUninitializedSubmodule("papers/icml/figs/plot.png", sampleRepos)).toBeNull();
    expect(isInsideUninitializedSubmodule("papers/neurips-extra/plot.png", sampleRepos)).toBeNull();
  });
});

describe("collision detection", () => {
  it("returns deduplicated colliding target paths in order", () => {
    const existing = new Set(["README.md", "figs/plot.png", "papers/icml/main.tex"]);
    const collisions = findCollisions(
      [
        { targetPath: "figs/new.png" },
        { targetPath: "figs/plot.png" },
        { targetPath: "papers/icml/main.tex" },
        { targetPath: "figs/plot.png" },
      ],
      existing
    );
    expect(collisions).toEqual(["figs/plot.png", "papers/icml/main.tex"]);
  });
});

describe("includegraphics snippet formatting", () => {
  it("detects supported graphics extensions", () => {
    expect(isIncludeGraphicsAsset("figs/plot.PNG")).toBe(true);
    expect(isIncludeGraphicsAsset("figs/photo.jpeg")).toBe(true);
    expect(isIncludeGraphicsAsset("figs/diagram.pdf")).toBe(true);
    expect(isIncludeGraphicsAsset("figs/vector.eps")).toBe(true);
    expect(isIncludeGraphicsAsset("figs/chart.svg")).toBe(true);
    expect(isIncludeGraphicsAsset("figs/shot.webp")).toBe(true);
    expect(isIncludeGraphicsAsset("main.tex")).toBe(false);
    expect(isIncludeGraphicsAsset("refs.bib")).toBe(false);
  });

  it("resolves paths within the active TeX file compile snapshot directory", () => {
    expect(
      formatIncludeGraphicsSnippet("papers/icml/figs/plot.png", "papers/icml/main.tex", sampleRepos)
    ).toBe("\\includegraphics[width=\\linewidth]{figs/plot.png}");

    expect(formatIncludeGraphicsSnippet("figs/plot.png", "main.tex")).toBe(
      "\\includegraphics[width=\\linewidth]{figs/plot.png}"
    );

    expect(
      formatIncludeGraphicsSnippet("papers/icml/figs/plot.png", "main.tex", sampleRepos)
    ).toBe("\\includegraphics[width=\\linewidth]{papers/icml/figs/plot.png}");
  });

  it("returns null for assets outside the active TeX file compile snapshot", () => {
    expect(
      formatIncludeGraphicsSnippet("img.png", "papers/icml/main.tex", sampleRepos)
    ).toBeNull();

    expect(
      formatIncludeGraphicsSnippet("shared/logo.png", "papers/icml/main.tex", sampleRepos)
    ).toBeNull();

    expect(
      formatIncludeGraphicsSnippet("papers/neurips/figs/plot.png", "papers/icml/main.tex", sampleRepos)
    ).toBeNull();

    expect(
      formatIncludeGraphicsSnippet(
        "papers/icml/figs/plot.png",
        "papers/icml/sections/intro.tex",
        sampleRepos
      )
    ).toBeNull();
  });

  it("formats relative to repo root or workspace root when no active tex file is open", () => {
    expect(formatIncludeGraphicsSnippet("papers/icml/figs/plot.png", null, sampleRepos)).toBe(
      "\\includegraphics[width=\\linewidth]{figs/plot.png}"
    );

    expect(formatIncludeGraphicsSnippet("shared/logo.png", null, sampleRepos)).toBe(
      "\\includegraphics[width=\\linewidth]{shared/logo.png}"
    );

    expect(formatIncludeGraphicsSnippet("papers/icml/figs/plot.png", null)).toBe(
      "\\includegraphics[width=\\linewidth]{papers/icml/figs/plot.png}"
    );
  });

  it("matches the backend compile snapshot layout on disk across workspace and submodules", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "undertree-snapshot-"));
    try {
      const wsDir = path.join(tmp, "ws");
      fs.mkdirSync(path.join(wsDir, "papers", "icml", "figs"), { recursive: true });
      fs.mkdirSync(path.join(wsDir, "papers", "neurips", "figs"), { recursive: true });
      fs.writeFileSync(path.join(wsDir, "img.png"), "root-img");
      fs.writeFileSync(path.join(wsDir, "main.tex"), "\\documentclass{article}");
      fs.writeFileSync(path.join(wsDir, "papers", "icml", "main.tex"), "\\documentclass{article}");
      fs.writeFileSync(path.join(wsDir, "papers", "icml", "figs", "plot.png"), "sub-img");
      fs.writeFileSync(path.join(wsDir, "papers", "neurips", "figs", "other.png"), "other-img");

      const copySnapshotForRoot = (texRoot: string, dest: string) => {
        const parentRel = path.posix.dirname(texRoot);
        const src = parentRel === "." ? wsDir : path.join(wsDir, parentRel);
        fs.cpSync(src, dest, { recursive: true });
      };

      const subSnapshot = path.join(tmp, "snap-sub");
      copySnapshotForRoot("papers/icml/main.tex", subSnapshot);
      const insideRel = resolveIncludeGraphicsPath(
        "papers/icml/figs/plot.png",
        "papers/icml/main.tex",
        sampleRepos
      );
      expect(insideRel).toBe("figs/plot.png");
      expect(fs.existsSync(path.join(subSnapshot, insideRel!))).toBe(true);
      expect(
        resolveIncludeGraphicsPath("img.png", "papers/icml/main.tex", sampleRepos)
      ).toBeNull();
      expect(
        resolveIncludeGraphicsPath("papers/neurips/figs/other.png", "papers/icml/main.tex", sampleRepos)
      ).toBeNull();

      const rootSnapshot = path.join(tmp, "snap-root");
      copySnapshotForRoot("main.tex", rootSnapshot);
      const fromRootRel = resolveIncludeGraphicsPath("papers/icml/figs/plot.png", "main.tex", sampleRepos);
      expect(fromRootRel).toBe("papers/icml/figs/plot.png");
      expect(fs.existsSync(path.join(rootSnapshot, fromRootRel!))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers PdfPanel selectedRoot over a nested active editor TeX file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "undertree-nested-root-"));
    try {
      const wsDir = path.join(tmp, "ws");
      fs.mkdirSync(path.join(wsDir, "papers", "icml", "figs"), { recursive: true });
      fs.mkdirSync(path.join(wsDir, "papers", "icml", "sections"), { recursive: true });
      fs.writeFileSync(
        path.join(wsDir, "papers", "icml", "main.tex"),
        "\\documentclass{article}\\input{sections/intro}"
      );
      fs.writeFileSync(
        path.join(wsDir, "papers", "icml", "sections", "intro.tex"),
        "\\section{Intro}"
      );
      fs.writeFileSync(path.join(wsDir, "papers", "icml", "figs", "plot.png"), "plot");

      const effectiveRoot = resolveEffectiveCompileRoot(
        "papers/icml/main.tex",
        "papers/icml/sections/intro.tex"
      );
      expect(effectiveRoot).toBe("papers/icml/main.tex");

      const rel = resolveIncludeGraphicsPath("papers/icml/figs/plot.png", effectiveRoot, sampleRepos);
      expect(rel).toBe("figs/plot.png");
      expect(
        formatIncludeGraphicsSnippet("papers/icml/figs/plot.png", effectiveRoot, sampleRepos)
      ).toBe("\\includegraphics[width=\\linewidth]{figs/plot.png}");

      const snapshot = path.join(tmp, "snap-sub");
      fs.cpSync(path.join(wsDir, "papers", "icml"), snapshot, { recursive: true });
      expect(fs.existsSync(path.join(snapshot, rel!))).toBe(true);

      expect(resolveEffectiveCompileRoot(null, "papers/icml/sections/intro.tex")).toBe(
        "papers/icml/sections/intro.tex"
      );
      expect(resolveEffectiveCompileRoot(null, "README.md")).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("upload error formatting", () => {
  it("formats HTTP 413, 400, network, and generic errors in German", () => {
    expect(
      formatUploadError(new ApiError(413, "payload_too_large", "Too large"), "big.png")
    ).toContain("zu groß");

    expect(formatUploadError(new ApiError(400, "invalid_path", "Bad path"), "bad.png")).toContain(
      "Ungültiger Dateipfad"
    );

    expect(formatUploadError(new TypeError("Failed to fetch"), "plot.png")).toContain(
      "Netzwerkfehler"
    );

    expect(formatUploadError(new ApiError(500, "internal", "Oops"), "plot.png")).toContain(
      "Serverfehler (500)"
    );
  });
});

describe("extractDroppedFiles", () => {
  it("falls back to DataTransfer.files when webkitGetAsEntry is unavailable", async () => {
    const fileA = new File(["a"], "a.png", { type: "image/png" });
    const fileB = new File(["b"], "b.tex", { type: "text/plain" });
    const dt = {
      items: [],
      files: [fileA, fileB],
    } as unknown as DataTransfer;

    const result = await extractDroppedFiles(dt);
    expect(result).toEqual([
      { file: fileA, relativePath: "a.png" },
      { file: fileB, relativePath: "b.tex" },
    ]);
  });

  it("recursively reads dropped directories via webkitGetAsEntry", async () => {
    const plotFile = new File(["png"], "plot.png", { type: "image/png" });
    const nestedFileEntry = {
      isFile: true,
      isDirectory: false,
      name: "plot.png",
      file: (cb: (f: File) => void) => cb(plotFile),
    };

    let readCount = 0;
    const dirEntry = {
      isFile: false,
      isDirectory: true,
      name: "figs",
      createReader: () => ({
        readEntries: (cb: (entries: unknown[]) => void) => {
          readCount++;
          cb(readCount === 1 ? [nestedFileEntry] : []);
        },
      }),
    };

    const dt = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => dirEntry,
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const result = await extractDroppedFiles(dt);
    expect(result).toEqual([{ file: plotFile, relativePath: "figs/plot.png" }]);
  });

  it("surfaces errors from failing dropped file entries without unhandled rejection", async () => {
    const failingFileEntry = {
      isFile: true,
      isDirectory: false,
      name: "secret.png",
      file: (_ok: (f: File) => void, err?: (e: unknown) => void) => {
        err?.(new Error("Permission denied"));
      },
    };

    const dt = {
      items: [{ kind: "file", webkitGetAsEntry: () => failingFileEntry }],
      files: [],
    } as unknown as DataTransfer;

    const onCandidates = vi.fn();
    const onError = vi.fn();

    await expect(processDroppedTransfer(dt, onCandidates, onError)).resolves.toBeUndefined();
    expect(onCandidates).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain("Permission denied");
  });

  it("surfaces errors from failing dropped directory entries without unhandled rejection", async () => {
    const failingDirEntry = {
      isFile: false,
      isDirectory: true,
      name: "broken-dir",
      createReader: () => ({
        readEntries: (_ok: (entries: unknown[]) => void, err?: (e: unknown) => void) => {
          err?.(new Error("Directory unreadable"));
        },
      }),
    };

    const dt = {
      items: [{ kind: "file", webkitGetAsEntry: () => failingDirEntry }],
      files: [],
    } as unknown as DataTransfer;

    const onCandidates = vi.fn();
    const onError = vi.fn();

    await expect(processDroppedTransfer(dt, onCandidates, onError)).resolves.toBeUndefined();
    expect(onCandidates).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain("Directory unreadable");
  });
});
