// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, User } from "../api";
import { ProjectSettings } from "./ProjectSettings";

const updateProjectCommitIdentityMock = vi.fn();

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  listMembers: () => Promise.resolve([]),
  listProjectRoots: () => Promise.resolve([]),
  getDictionary: () => Promise.resolve({ words: [], disabled_rules: [] }),
  updateProjectCommitIdentity: (...args: unknown[]) => updateProjectCommitIdentityMock(...args),
}));

const sampleUser: User = {
  id: 2,
  username: "bob",
  display_name: "Bob",
  email: "bob@example.org",
  is_admin: false,
  commit_email: null,
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "Paper",
    remote_url: "https://git.example.org/me/paper.git",
    branch: "main",
    owner: "alice",
    role: "member",
    my_role: "editor",
    has_token: false,
    compiler: "auto",
    main_files: [],
    account_id: null,
    commit_name: null,
    commit_email: null,
    created_at: "2026-11-25T12:00:00Z",
    ...overrides,
  };
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  await Promise.resolve();
}

describe("ProjectSettings Git author per project", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
    }
    if (!HTMLDialogElement.prototype.close) {
      HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
    }
    updateProjectCommitIdentityMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
  });

  it("shows per-project commit identity form for editors and hides it for viewers", async () => {
    render(
      h(ProjectSettings, {
        project: makeProject({ my_role: "viewer" }),
        user: sampleUser,
        onClose: () => undefined,
        onProjectChanged: () => undefined,
      }),
      container
    );
    await flushUi();
    expect(container.textContent).not.toContain("Git-Autor (dieses Projekt)");

    render(
      h(ProjectSettings, {
        project: makeProject({ my_role: "editor" }),
        user: sampleUser,
        onClose: () => undefined,
        onProjectChanged: () => undefined,
      }),
      container
    );
    await flushUi();
    expect(container.textContent).toContain("Git-Autor (dieses Projekt)");
    expect(container.textContent).toContain("Commit-Name (optional)");
    expect(container.textContent).toContain("Commit-E-Mail (optional)");
  });

  it("saves trimmed per-project name/email and resets back to null", async () => {
    const onProjectChanged = vi.fn();
    updateProjectCommitIdentityMock.mockResolvedValue({
      commit_name: "Dr. Bob",
      commit_email: "bob@uni.edu",
    });

    const initial = makeProject();
    render(
      h(ProjectSettings, {
        project: initial,
        user: sampleUser,
        onClose: () => undefined,
        onProjectChanged,
      }),
      container
    );
    await flushUi();

    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="Bob"]');
    const emailInput = container.querySelector<HTMLInputElement>('input[type="email"]');
    expect(nameInput).not.toBeNull();
    expect(emailInput).not.toBeNull();

    nameInput!.value = " Dr. Bob ";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    emailInput!.value = " bob@uni.edu ";
    emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const form = nameInput!.closest("form")!;
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submitBtn.disabled).toBe(false);
    submitBtn.click();
    await flushUi();

    expect(updateProjectCommitIdentityMock).toHaveBeenCalledWith(1, {
      commit_name: "Dr. Bob",
      commit_email: "bob@uni.edu",
    });
    expect(onProjectChanged).toHaveBeenCalledWith({
      ...initial,
      commit_name: "Dr. Bob",
      commit_email: "bob@uni.edu",
    });

    // Re-render with updated project and test reset button
    const updated = makeProject({ commit_name: "Dr. Bob", commit_email: "bob@uni.edu" });
    updateProjectCommitIdentityMock.mockResolvedValue({
      commit_name: null,
      commit_email: null,
    });
    render(
      h(ProjectSettings, {
        project: updated,
        user: sampleUser,
        onClose: () => undefined,
        onProjectChanged,
      }),
      container
    );
    await flushUi();

    const resetBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Zurücksetzen"
    );
    expect(resetBtn).toBeDefined();
    resetBtn!.click();
    await flushUi();

    expect(updateProjectCommitIdentityMock).toHaveBeenLastCalledWith(1, {
      commit_name: null,
      commit_email: null,
    });
    expect(onProjectChanged).toHaveBeenLastCalledWith({
      ...updated,
      commit_name: null,
      commit_email: null,
    });
  });
});
