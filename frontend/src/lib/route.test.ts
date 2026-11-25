import { describe, expect, it } from "vitest";
import { buildPdfPopoutUrl, parsePdfRootParam, parseRoute } from "./route";

describe("parseRoute", () => {
  it("maps known paths", () => {
    expect(parseRoute("/")).toEqual({ name: "projects" });
    expect(parseRoute("")).toEqual({ name: "projects" });
    expect(parseRoute("/templates")).toEqual({ name: "templates" });
    expect(parseRoute("/templates/")).toEqual({ name: "templates" });
    expect(parseRoute("/admin")).toEqual({ name: "admin" });
    expect(parseRoute("/admin/")).toEqual({ name: "admin" });
    expect(parseRoute("/login")).toEqual({ name: "login" });
  });

  it("rejects unknown template subpaths", () => {
    expect(parseRoute("/templates/extra")).toEqual({ name: "not_found" });
  });

  it("parses project ids and standalone pdf popout routes", () => {
    expect(parseRoute("/p/12")).toEqual({ name: "project", pid: 12 });
    expect(parseRoute("/p/12/")).toEqual({ name: "project", pid: 12 });
    expect(parseRoute("/p/3/papers/main.tex")).toEqual({ name: "project", pid: 3 });
    expect(parseRoute("/p/12/pdf")).toEqual({ name: "project_pdf", pid: 12 });
    expect(parseRoute("/p/12/pdf/")).toEqual({ name: "project_pdf", pid: 12 });
    expect(parseRoute("/p/12/papers/pdf.tex")).toEqual({ name: "project", pid: 12 });
    expect(parseRoute("/p/12/pdf/extra")).toEqual({ name: "project", pid: 12 });
  });

  it("builds and parses PDF popout root query params", () => {
    expect(buildPdfPopoutUrl(4)).toBe("/p/4/pdf");
    expect(buildPdfPopoutUrl(4, null)).toBe("/p/4/pdf");
    expect(buildPdfPopoutUrl(4, "papers/icml/main.tex")).toBe(
      "/p/4/pdf?root=papers%2Ficml%2Fmain.tex"
    );
    expect(parsePdfRootParam("?root=papers%2Ficml%2Fmain.tex")).toBe("papers/icml/main.tex");
    expect(parsePdfRootParam("?root=   ")).toBeNull();
    expect(parsePdfRootParam("")).toBeNull();
  });

  it("rejects malformed project paths", () => {
    expect(parseRoute("/p/")).toEqual({ name: "not_found" });
    expect(parseRoute("/p/0")).toEqual({ name: "not_found" });
    expect(parseRoute("/p/0/pdf")).toEqual({ name: "not_found" });
    expect(parseRoute("/p/abc")).toEqual({ name: "not_found" });
    expect(parseRoute("/p/12abc")).toEqual({ name: "not_found" });
    expect(parseRoute("/projects")).toEqual({ name: "not_found" });
  });
});
