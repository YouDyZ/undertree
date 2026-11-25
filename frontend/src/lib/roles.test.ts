import { describe, expect, it } from "vitest";
import { ApiError, type ProjectMember } from "../api";
import {
  MEMBER_ROLE_LABELS,
  MEMBER_ROLES,
  canCommentInProject,
  canEditProject,
  canInviteMemberToRemote,
  canLeaveProject,
  canManageProject,
  canRemoveMember,
  formatRoleError,
  hasMinRole,
  isReadOnlyRole,
} from "./roles";

const members: ProjectMember[] = [
  { username: "alice", display_name: "Alice", role: "owner" },
  { username: "bob", display_name: "Bob", role: "editor" },
  { username: "carol", display_name: "Carol", role: "commenter" },
  { username: "dave", display_name: "Dave", role: "viewer" },
];

describe("project roles helpers", () => {
  it("enforces role hierarchy accurately", () => {
    expect(MEMBER_ROLES).toEqual(["owner", "editor", "commenter", "viewer"]);
    expect(Object.keys(MEMBER_ROLE_LABELS)).toHaveLength(4);

    expect(hasMinRole("owner", "editor")).toBe(true);
    expect(hasMinRole("editor", "editor")).toBe(true);
    expect(hasMinRole("commenter", "editor")).toBe(false);
    expect(hasMinRole("viewer", "commenter")).toBe(false);

    expect(canManageProject("owner")).toBe(true);
    expect(canManageProject("editor")).toBe(false);

    expect(canEditProject("owner")).toBe(true);
    expect(canEditProject("editor")).toBe(true);
    expect(canEditProject("commenter")).toBe(false);
    expect(canEditProject("viewer")).toBe(false);

    expect(isReadOnlyRole("viewer")).toBe(true);
    expect(isReadOnlyRole("commenter")).toBe(true);
    expect(isReadOnlyRole("editor")).toBe(false);

    expect(canCommentInProject("commenter")).toBe(true);
    expect(canCommentInProject("viewer")).toBe(false);
  });

  it("protects the last owner when leaving or removing members", () => {
    expect(canLeaveProject({ role: "owner", my_role: "owner" }, members, "alice")).toBe(false);
    expect(canLeaveProject({ role: "member", my_role: "viewer" }, members, "dave")).toBe(true);
    // Admin who is not a member cannot "leave"
    expect(canLeaveProject({ role: "admin", my_role: "owner" }, members, "root")).toBe(false);

    const twoOwners: ProjectMember[] = [
      { username: "alice", display_name: "Alice", role: "owner" },
      { username: "bob", display_name: "Bob", role: "owner" },
    ];
    expect(canLeaveProject({ role: "owner", my_role: "owner" }, twoOwners, "alice")).toBe(true);
    expect(canRemoveMember(true, twoOwners[1]!, "alice", twoOwners)).toBe(true);
    expect(canRemoveMember(true, members[0]!, "root", members)).toBe(false);
    expect(canRemoveMember(true, members[3]!, "alice", members)).toBe(true);
    expect(canRemoveMember(false, members[3]!, "alice", members)).toBe(false);
  });

  it("formats last_owner and insufficient_role errors in German", () => {
    expect(
      formatRoleError(new ApiError(400, "last_owner", "needs owner"), "Fallback")
    ).toBe("Es muss mindestens ein Eigentümer bleiben.");
    expect(
      formatRoleError(new ApiError(403, "insufficient_role", "denied"), "Fallback")
    ).toBe("Deine Projektrolle reicht für diese Aktion nicht aus.");
    expect(
      formatRoleError(new ApiError(400, "invite_role_too_low", "too low"), "Fallback")
    ).toBe("Nur Bearbeiter oder Eigentümer können ins Remote-Repository eingeladen werden.");
    expect(formatRoleError(new ApiError(500, "internal", "boom"), "Fallback")).toBe("boom");
  });

  it("allows remote invites only for editor members when owner manages a remote-backed project", () => {
    expect(canInviteMemberToRemote(true, true, members[0]!)).toBe(false); // owner
    expect(canInviteMemberToRemote(true, true, members[1]!)).toBe(true); // editor
    expect(canInviteMemberToRemote(true, true, members[2]!)).toBe(false); // commenter
    expect(canInviteMemberToRemote(true, true, members[3]!)).toBe(false); // viewer
    expect(canInviteMemberToRemote(false, true, members[1]!)).toBe(false);
    expect(canInviteMemberToRemote(true, false, members[1]!)).toBe(false);
  });
});
