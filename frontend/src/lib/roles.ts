import { ApiError, type MemberRole, type Project, type ProjectMember, errorText } from "../api";

export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "editor", "commenter", "viewer"];

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Eigentümer",
  editor: "Bearbeiter",
  commenter: "Kommentator",
  viewer: "Betrachter",
};

export const MEMBER_ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: "Eigentümer — voller Zugriff inkl. Mitglieder, Rollen und Projekt-Einstellungen",
  editor: "Bearbeiter — Dateien, Git und Zotero bearbeiten",
  commenter: "Kommentator — Nur Lesen im Editor, darf kommentieren und kompilieren",
  viewer: "Betrachter — Nur Lesen (Dateien, Kommentare und Git lesen, kompilieren)",
};

const ROLE_RANK: Record<MemberRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};

/** Returns true if `role` has at least the privileges of `min`. */
export function hasMinRole(role: MemberRole, min: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function canManageProject(role: MemberRole): boolean {
  return role === "owner";
}

export function canEditProject(role: MemberRole): boolean {
  return hasMinRole(role, "editor");
}

export function canCommentInProject(role: MemberRole): boolean {
  return hasMinRole(role, "commenter");
}

export function isReadOnlyRole(role: MemberRole): boolean {
  return !canEditProject(role);
}

/**
 * Returns true if `username` can remove themselves from the project without violating `last_owner`.
 * When `members` is not yet loaded, falls back to the coarse `project.role === "member"` flag.
 */
export function canLeaveProject(
  project: Pick<Project, "role" | "my_role">,
  members: readonly ProjectMember[] | null,
  username: string
): boolean {
  if (!members) {
    return project.role === "member";
  }
  const self = members.find((m) => m.username === username);
  if (!self) return false;
  if (self.role !== "owner") return true;
  const ownerCount = members.filter((m) => m.role === "owner").length;
  return ownerCount > 1;
}

/**
 * Owners may remove other members as long as at least one owner remains (`last_owner`).
 */
export function canRemoveMember(
  canManage: boolean,
  target: ProjectMember,
  selfUsername: string,
  members: readonly ProjectMember[]
): boolean {
  if (!canManage || target.username === selfUsername) return false;
  if (target.role !== "owner") return true;
  const ownerCount = members.filter((m) => m.role === "owner").length;
  return ownerCount > 1;
}

/**
 * Only `editor` members (below `owner`, who already owns the repo) can be invited to the remote.
 * Matches backend `invite_remote` which rejects roles below `editor` with `400 invite_role_too_low`.
 */
export function canInviteMemberToRemote(
  canManage: boolean,
  projectHasAccount: boolean,
  member: ProjectMember
): boolean {
  return canManage && projectHasAccount && member.role !== "owner" && hasMinRole(member.role, "editor");
}

/** Formats role-related API errors (`last_owner`, `insufficient_role`, `invite_role_too_low`) cleanly in German. */
export function formatRoleError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "last_owner") {
      return "Es muss mindestens ein Eigentümer bleiben.";
    }
    if (err.code === "insufficient_role") {
      return "Deine Projektrolle reicht für diese Aktion nicht aus.";
    }
    if (err.code === "invite_role_too_low") {
      return "Nur Bearbeiter oder Eigentümer können ins Remote-Repository eingeladen werden.";
    }
  }
  return errorText(err, fallback);
}
