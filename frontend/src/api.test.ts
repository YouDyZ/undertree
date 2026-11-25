import { describe, expect, it } from "vitest";
import {
  ApiError,
  encodeWorkspacePath,
  fileApiUrl,
  oauthStartUrl,
  pdfApiUrl,
  projectApiBase,
  projectWsPath,
  sanitizeNextPath,
  setActiveProject,
} from "./api";

describe("api path helpers", () => {
  it("encodes workspace path segments while preserving slashes", () => {
    expect(encodeWorkspacePath("papers/icml/main.tex")).toBe("papers/icml/main.tex");
    expect(encodeWorkspacePath("papers/my paper/fig #1.tex")).toBe(
      "papers/my%20paper/fig%20%231.tex"
    );
  });

  it("rejects empty or traversal segments", () => {
    expect(() => encodeWorkspacePath("")).toThrow(ApiError);
    expect(() => encodeWorkspacePath("../secret.tex")).toThrow(ApiError);
    expect(() => encodeWorkspacePath("papers/../secret.tex")).toThrow(ApiError);
    expect(() => encodeWorkspacePath("papers//main.tex")).toThrow(ApiError);
  });

  it("sanitizes post-login next redirect paths against open redirects", () => {
    expect(sanitizeNextPath(null)).toBe("/");
    expect(sanitizeNextPath("/")).toBe("/");
    expect(sanitizeNextPath("/papers/icml/main.tex")).toBe("/papers/icml/main.tex");
    expect(sanitizeNextPath("https://evil.example/steal")).toBe("/");
    expect(sanitizeNextPath("//evil.example/steal")).toBe("/");
    expect(sanitizeNextPath("/\\evil.example")).toBe("/");
    expect(sanitizeNextPath("/login?error=foo")).toBe("/");
  });

  it("builds OAuth start URLs cleanly", () => {
    expect(oauthStartUrl("github")).toBe("/api/auth/oauth/github/start");
    expect(oauthStartUrl("google", "/")).toBe("/api/auth/oauth/google/start");
    expect(oauthStartUrl("google", "/?file=main.tex")).toBe(
      "/api/auth/oauth/google/start?next=%2F%3Ffile%3Dmain.tex"
    );
  });

  it("builds project-scoped REST and WS prefixes", () => {
    setActiveProject(null);
    expect(() => projectApiBase()).toThrow(ApiError);
    expect(projectApiBase(4)).toBe("/api/projects/4");
    setActiveProject(9);
    expect(projectApiBase()).toBe("/api/projects/9");
    expect(projectWsPath()).toBe("/ws/projects/9");
    expect(fileApiUrl("papers/a b.tex")).toBe("/api/projects/9/files/papers/a%20b.tex");
    expect(pdfApiUrl("main.tex", 5)).toBe("/api/projects/9/pdf/main.tex?v=5");
    setActiveProject(null);
  });
});
