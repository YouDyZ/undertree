import { describe, expect, it } from "vitest";
import type { GitAccount } from "../api";
import { NEW_GITHUB, NEW_GITLAB, accountLabel, accountOptions, repoNameFromTitle } from "./accounts";

describe("repoNameFromTitle", () => {
  it("makes a valid repo name", () => {
    expect(repoNameFromTitle("ICML 2027: Über X")).toBe("icml-2027-uber-x");
    expect(repoNameFromTitle("  --.paper_v2.  ")).toBe("paper_v2.");
    expect(repoNameFromTitle("???")).toBe("");
    expect(repoNameFromTitle("a".repeat(120))).toHaveLength(100);
  });
});

describe("accountLabel", () => {
  const acc = (id: number, provider: GitAccount["provider"], base_url: string): GitAccount => ({
    id,
    provider,
    base_url,
    login: "al",
    ssh_host_key_fingerprint: null,
  });
  it("names provider, host and login", () => {
    expect(accountLabel(acc(1, "github", "https://github.com"))).toBe("GitHub · al");
    expect(accountLabel(acc(2, "gitlab", "https://gitlab.com"))).toBe("GitLab · al");
    expect(accountLabel(acc(3, "gitlab", "https://git.uni.de/gitlab"))).toBe("GitLab git.uni.de/gitlab · al");
    expect(accountLabel(acc(4, "zotero", "https://api.zotero.org"))).toBe("Zotero · al");
  });
});

describe("accountOptions", () => {
  const acc = (id: number, provider: GitAccount["provider"]): GitAccount => ({
    id,
    provider,
    base_url: provider === "github" ? "https://github.com" : "https://gitlab.com",
    login: "al",
    ssh_host_key_fingerprint: null,
  });
  it("offers both connect entries without accounts", () => {
    expect(accountOptions([], true).map((o) => o.value)).toEqual([NEW_GITLAB, NEW_GITHUB]);
  });
  it("lists accounts first and only the missing provider", () => {
    const o = accountOptions([acc(1, "github")], true);
    expect(o.map((x) => x.value)).toEqual(["1", NEW_GITLAB]);
    expect(o[1]?.label).toBe("+ Eigenes GitLab verbinden…");
  });
  it("offers another GitLab when one exists, no GitHub if unavailable", () => {
    const o = accountOptions([acc(2, "gitlab")], false);
    expect(o.map((x) => x.value)).toEqual(["2", NEW_GITLAB]);
    expect(o[1]?.label).toBe("+ Weiteres GitLab verbinden…");
  });
});
