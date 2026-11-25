import type { GitAccount } from "../api";

/** Repo name suggested for a project name: "ICML 2027: Über X" → "icml-2027-uber-x". */
export function repoNameFromTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 100);
}

/** "GitHub · alice" / "GitLab git.uni.de · alice" / "Zotero · alice" (gitlab.com without host). */
export function accountLabel(a: GitAccount): string {
  if (a.provider === "github") return `GitHub · ${a.login}`;
  if (a.provider === "zotero") return `Zotero · ${a.login}`;
  const host = a.base_url.replace(/^https?:\/\//, "");
  return host === "gitlab.com" ? `GitLab · ${a.login}` : `GitLab ${host} · ${a.login}`;
}

export const NEW_GITLAB = "new-gitlab";
export const NEW_GITHUB = "new-github";

/** Options of the account select: connected accounts, then "connect …" entries (GitHub only when OAuth is configured). */
export function accountOptions(accounts: GitAccount[], githubAvailable: boolean): { value: string; label: string }[] {
  const opts = accounts.map((a) => ({ value: String(a.id), label: accountLabel(a) }));
  const has = (p: GitAccount["provider"]) => accounts.some((a) => a.provider === p);
  opts.push({ value: NEW_GITLAB, label: has("gitlab") ? "+ Weiteres GitLab verbinden…" : "+ Eigenes GitLab verbinden…" });
  if (githubAvailable && !has("github")) opts.push({ value: NEW_GITHUB, label: "+ GitHub verbinden…" });
  return opts;
}
