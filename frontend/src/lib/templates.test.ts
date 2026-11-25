import { describe, expect, it } from "vitest";
import { ApiError, type Template, type User } from "../api";
import {
  MAX_TEMPLATE_UPLOAD_BYTES,
  canManageTemplate,
  compilerBadgeLabel,
  formatBytes,
  formatTemplateUploadError,
  hasPendingPreviews,
  pickDefaultTemplateId,
  previewStatusLabel,
  shouldApplyTemplatePoll,
  sortTemplates,
  upsertTemplate,
  validateTemplateUploadForm,
} from "./templates";

const makeUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  username: "alice",
  display_name: "Alice",
  email: "alice@example.com",
  is_admin: false,
  commit_email: null,
  ...overrides,
});

const makeTemplate = (overrides: Partial<Template> = {}): Template => ({
  id: "tpl-1",
  name: "Paper",
  description: "Test template",
  compiler: "pdflatex",
  main_file: "main.tex",
  builtin: false,
  owner: "alice",
  preview: "ready",
  public: false,
  ...overrides,
});

describe("canManageTemplate", () => {
  it("allows owner and admin on non-builtin templates, rejects others and builtins", () => {
    const alice = makeUser({ username: "alice", is_admin: false });
    const bob = makeUser({ id: 2, username: "bob", is_admin: false });
    const admin = makeUser({ id: 3, username: "root", is_admin: true });

    const owned = makeTemplate({ owner: "alice", builtin: false });
    expect(canManageTemplate(owned, alice)).toBe(true);
    expect(canManageTemplate(owned, bob)).toBe(false);
    expect(canManageTemplate(owned, admin)).toBe(true);

    const deletedOwner = makeTemplate({ owner: null, builtin: false });
    expect(canManageTemplate(deletedOwner, alice)).toBe(false);
    expect(canManageTemplate(deletedOwner, admin)).toBe(true);

    const builtin = makeTemplate({ id: "builtin:article", builtin: true, owner: null, public: true });
    expect(canManageTemplate(builtin, alice)).toBe(false);
    expect(canManageTemplate(builtin, admin)).toBe(false);
  });
});

describe("hasPendingPreviews", () => {
  it("detects pending previews across the list", () => {
    expect(hasPendingPreviews([])).toBe(false);
    expect(hasPendingPreviews([makeTemplate({ preview: "ready" }), makeTemplate({ preview: "failed" })])).toBe(
      false
    );
    expect(
      hasPendingPreviews([makeTemplate({ preview: "ready" }), makeTemplate({ id: "2", preview: "pending" })])
    ).toBe(true);
  });
});

describe("pickDefaultTemplateId", () => {
  it("prefers builtin:article and falls back cleanly", () => {
    expect(
      pickDefaultTemplateId([
        makeTemplate({ id: "custom" }),
        makeTemplate({ id: "builtin:article", builtin: true }),
      ])
    ).toBe("builtin:article");
    expect(pickDefaultTemplateId([makeTemplate({ id: "builtin:report", builtin: true })])).toBe(
      "builtin:report"
    );
    expect(pickDefaultTemplateId([])).toBe("builtin:article");
  });
});

describe("formatTemplateUploadError", () => {
  it("formats all template upload error codes in German", () => {
    expect(formatTemplateUploadError(new ApiError(400, "invalid_zip", "bad zip"))).toMatch(/ZIP-Archiv/i);
    expect(formatTemplateUploadError(new ApiError(400, "too_large", "too big"))).toMatch(/25 MB/);
    expect(formatTemplateUploadError(new ApiError(413, "internal", "Payload Too Large"))).toMatch(/25 MB/);
    expect(formatTemplateUploadError(new ApiError(400, "no_main_file", "missing"))).toMatch(/\\begin\{document\}/);
    expect(formatTemplateUploadError(new ApiError(400, "unsafe_path", "bad path"))).toMatch(/Unsicherer Pfad/);
    expect(formatTemplateUploadError(new ApiError(400, "invalid_request", "name fehlt"))).toBe(
      "Ungültige Anfrage: name fehlt"
    );
    expect(formatTemplateUploadError(new Error("Netzwerkfehler"))).toBe("Netzwerkfehler");
    expect(formatTemplateUploadError(null)).toBe("Template konnte nicht hochgeladen werden.");
  });
});

describe("validateTemplateUploadForm", () => {
  it("validates name, file presence, extension, empty and max size", () => {
    expect(validateTemplateUploadForm({ name: "  ", file: { name: "a.zip", size: 100 } })).toMatch(
      /Namen/
    );
    expect(validateTemplateUploadForm({ name: "Paper", file: null })).toMatch(/\.zip-Datei/);
    expect(validateTemplateUploadForm({ name: "Paper", file: { name: "paper.tar.gz", size: 100 } })).toMatch(
      /Nur \.zip-Archive/
    );
    expect(validateTemplateUploadForm({ name: "Paper", file: { name: "PAPER.ZIP", size: 0 } })).toMatch(
      /leer/
    );
    expect(
      validateTemplateUploadForm({
        name: "Paper",
        file: { name: "paper.zip", size: MAX_TEMPLATE_UPLOAD_BYTES + 1 },
      })
    ).toMatch(/25 MB/);
    expect(
      validateTemplateUploadForm({
        name: "Paper",
        file: { name: "paper.ZIP", size: MAX_TEMPLATE_UPLOAD_BYTES },
      })
    ).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("formats byte sizes cleanly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("formats compiler and preview labels", () => {
    expect(compilerBadgeLabel("pdflatex")).toBe("pdfLaTeX");
    expect(compilerBadgeLabel("xelatex")).toBe("XeLaTeX");
    expect(compilerBadgeLabel("lualatex")).toBe("LuaLaTeX");
    expect(compilerBadgeLabel("auto")).toBe("Automatisch");

    expect(previewStatusLabel("pending")).toBe("Wird erstellt…");
    expect(previewStatusLabel("ready")).toBe("Vorschau bereit");
    expect(previewStatusLabel("failed")).toBe("Vorschau fehlgeschlagen");
  });
});

describe("sortTemplates, upsertTemplate, and shouldApplyTemplatePoll", () => {
  it("keeps built-ins first in original order and sorts uploaded templates by SQLite code units (name, then id)", () => {
    const input = [
      makeTemplate({ id: "u-lower", name: "alpha Notes", builtin: false }),
      makeTemplate({ id: "u-same-a", name: "Beta", builtin: false }),
      makeTemplate({ id: "u-upper", name: "Zebra Paper", builtin: false }),
      makeTemplate({ id: "builtin:article", name: "Leer (article)", builtin: true, owner: null, public: true }),
      makeTemplate({ id: "u-same-B", name: "Beta", builtin: false }),
      makeTemplate({ id: "builtin:report", name: "Bericht", builtin: true, owner: null, public: true }),
    ];

    expect(sortTemplates(input).map((t) => t.id)).toEqual([
      "builtin:article",
      "builtin:report",
      "u-same-B",
      "u-same-a",
      "u-upper",
      "u-lower",
    ]);
  });

  it("inserts uploaded templates in contract sort order and updates existing ids without duplicates", () => {
    const initial = [
      makeTemplate({ id: "builtin:article", name: "Leer (article)", builtin: true, owner: null, public: true }),
      makeTemplate({ id: "u-c", name: "Conference", builtin: false }),
    ];

    const withNew = upsertTemplate(
      initial,
      makeTemplate({ id: "u-a", name: "Annual Review", builtin: false, preview: "pending" })
    );
    expect(withNew.map((t) => t.id)).toEqual(["builtin:article", "u-a", "u-c"]);

    const updated = upsertTemplate(
      withNew,
      makeTemplate({ id: "u-a", name: "Annual Review", builtin: false, preview: "ready", public: true })
    );
    expect(updated.map((t) => t.id)).toEqual(["builtin:article", "u-a", "u-c"]);
    expect(updated[1]).toMatchObject({ preview: "ready", public: true });
  });

  it("rejects stale preview polls when a mutation ran or is still active", () => {
    expect(shouldApplyTemplatePoll(2, 2, 0)).toBe(true);
    expect(shouldApplyTemplatePoll(2, 3, 0)).toBe(false);
    expect(shouldApplyTemplatePoll(2, 2, 1)).toBe(false);
  });
});
