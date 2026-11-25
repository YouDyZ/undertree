import { describe, expect, it } from "vitest";
import type { PresenceUser } from "../api";
import { getUserColor } from "../editor/userColor";
import {
  ancestorDirs,
  initials,
  presenceColor,
  presenceLabel,
  splitOverflow,
  usersByFile,
} from "./presence";

const alice: PresenceUser = { username: "alice", display_name: "Alice Liddell", file: "a/main.tex" };
const bob: PresenceUser = { username: "bob", display_name: "Bob", file: "b.tex" };
const carol: PresenceUser = { username: "carol", display_name: "Carol", file: null };

describe("presence helpers", () => {
  it("derives initials", () => {
    expect(initials("Alice Liddell")).toBe("AL");
    expect(initials("  bob  ")).toBe("BO");
    expect(initials("Jean Paul Sartre")).toBe("JS");
    expect(initials("Ölaf")).toBe("ÖL");
    expect(initials("")).toBe("?");
  });

  it("colors avatars like the user's cursor", () => {
    expect(presenceColor("alice")).toBe(getUserColor("alice").color);
    expect(presenceColor("alice")).toBe(presenceColor("alice"));
  });

  it("groups users by their focused file and hides yourself in your focused file", () => {
    const all = usersByFile([alice, bob, carol]);
    expect([...all.keys()].sort()).toEqual(["a/main.tex", "b.tex"]);
    expect(all.get("a/main.tex")).toEqual([alice]);
    expect(all.get("b.tex")).toEqual([bob]);
    const hidden = usersByFile([alice, bob, carol], { username: "bob", path: "b.tex" });
    expect(hidden.has("b.tex")).toBe(false);
    expect(hidden.get("a/main.tex")).toEqual([alice]);
  });

  it("lists ancestor directories", () => {
    expect([...ancestorDirs(["a/b/c.tex", "a/d.tex", "top.tex"])].sort()).toEqual(["a", "a/b"]);
  });

  it("splits overflow", () => {
    expect(splitOverflow([1, 2, 3, 4], 3)).toEqual({ shown: [1, 2, 3], rest: [4] });
    expect(splitOverflow([1], 3)).toEqual({ shown: [1], rest: [] });
  });

  it("labels users", () => {
    expect(presenceLabel(bob, "bob")).toBe("Bob (du): b.tex");
    expect(presenceLabel(carol, "bob")).toBe("Carol: im Projekt");
  });
});
