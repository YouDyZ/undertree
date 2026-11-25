import { describe, expect, it } from "vitest";
import type { ChatMessage, ProjectMember } from "../api";
import {
  applyMention,
  groupMessages,
  locationLabel,
  mentionQuery,
  mergeMessages,
  splitMentions,
  suggestMembers,
  unreadStats,
  validateChatBody,
} from "./chat";

function msg(id: number, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    author: "alice",
    display_name: "Alice",
    body: `m${id}`,
    file: null,
    line: null,
    created_at: "2026-01-01T10:00:00Z",
    edited_at: null,
    deleted: false,
    mentions: [],
    ...over,
  };
}

const member = (username: string, display_name = username): ProjectMember => ({
  username,
  display_name,
  role: "editor",
});

describe("splitMentions", () => {
  it("marks members named in `mentions`, longest and case-insensitive, not inside words", () => {
    expect(splitMentions("hi @Bob, see @bob-x!", ["bob", "bob-x"])).toEqual([
      { text: "hi " },
      { text: "@Bob", mention: "bob" },
      { text: ", see " },
      { text: "@bob-x", mention: "bob-x" },
      { text: "!" },
    ]);
    expect(splitMentions("mail@bob.de @bobby @nobody", ["bob"])).toEqual([
      { text: "mail@bob.de @bobby @nobody" },
    ]);
  });

  it("returns plain text without mentions and handles empty input", () => {
    expect(splitMentions("<b>x</b>", [])).toEqual([{ text: "<b>x</b>" }]);
    expect(splitMentions("", ["bob"])).toEqual([]);
    expect(splitMentions("@bob", ["bob"])).toEqual([{ text: "@bob", mention: "bob" }]);
  });
});

describe("validateChatBody", () => {
  it("trims and bounds by characters", () => {
    expect(validateChatBody("  hi ")).toEqual({ ok: true, body: "hi" });
    expect(validateChatBody("  ").ok).toBe(false);
    expect(validateChatBody("😀".repeat(4000)).ok).toBe(true);
    expect(validateChatBody("x".repeat(4001)).ok).toBe(false);
  });
});

describe("mergeMessages", () => {
  it("upserts by id and sorts", () => {
    const merged = mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { body: "", deleted: true })]);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(merged[2]?.deleted).toBe(true);
  });
});

describe("mergeMessages versions", () => {
  it("keeps the newer version of a message, whatever the arrival order", () => {
    const live = msg(1);
    const edited = msg(1, { body: "edit", edited_at: "2026-01-01T10:01:00Z" });
    const tombstone = msg(1, { body: "", deleted: true });
    expect(mergeMessages([tombstone], [live])[0]?.deleted).toBe(true);
    expect(mergeMessages([tombstone], [edited])[0]?.deleted).toBe(true);
    expect(mergeMessages([edited], [live])[0]?.body).toBe("edit");
    expect(mergeMessages([live], [edited])[0]?.body).toBe("edit");
  });
});

describe("groupMessages", () => {
  it("groups consecutive messages of one author within five minutes", () => {
    const groups = groupMessages([
      msg(1, { created_at: "2026-01-01T10:00:00Z" }),
      msg(2, { created_at: "2026-01-01T10:04:00Z" }),
      msg(3, { author: "bob", created_at: "2026-01-01T10:04:30Z" }),
      msg(4, { created_at: "2026-01-01T10:05:00Z" }),
      msg(5, { created_at: "2026-01-01T10:30:00Z" }),
    ]);
    expect(groups.map((g) => g.messages.map((m) => m.id))).toEqual([[1, 2], [3], [4], [5]]);
    expect(groups[0]?.author).toBe("alice");
    expect(groupMessages([])).toEqual([]);
  });
});

describe("unreadStats", () => {
  it("counts only newer messages of others and flags mentions", () => {
    const list = [
      msg(1),
      msg(2, { author: "bob" }),
      msg(3, { author: "bob", mentions: ["alice"] }),
      msg(4, { author: "alice" }),
      msg(5, { author: "bob", deleted: true, body: "", mentions: [] }),
    ];
    expect(unreadStats(list, 0, "alice")).toEqual({ count: 2, mentioned: true });
    expect(unreadStats(list, 2, "alice")).toEqual({ count: 1, mentioned: true });
    expect(unreadStats(list, 3, "alice")).toEqual({ count: 0, mentioned: false });
  });
});

describe("mention autocomplete", () => {
  it("finds the @word before the caret", () => {
    expect(mentionQuery("hi @al", 6)).toEqual({ start: 3, query: "al" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("hi @al rest", 6)).toEqual({ start: 3, query: "al" });
    expect(mentionQuery("mail@al", 7)).toBeNull();
    expect(mentionQuery("hi @al ", 7)).toBeNull();
  });

  it("suggests prefix matches first, on username and display name", () => {
    const ms = [member("zed", "Alina"), member("bal"), member("alex"), member("bob")];
    expect(suggestMembers(ms, "al").map((m) => m.username)).toEqual(["alex", "zed", "bal"]);
    expect(suggestMembers(ms, "").length).toBe(4);
    expect(suggestMembers(ms, "al", 1).length).toBe(1);
    expect(suggestMembers(ms, "xyz")).toEqual([]);
  });

  it("inserts the chosen username", () => {
    const q = mentionQuery("hi @al rest", 6);
    expect(q).not.toBeNull();
    expect(applyMention("hi @al rest", 6, q!, "alex")).toEqual({
      text: "hi @alex  rest",
      caret: 9,
    });
  });
});

describe("locationLabel", () => {
  it("shows file and line", () => {
    expect(locationLabel("a/main.tex", 42)).toBe("a/main.tex:42");
    expect(locationLabel("a/main.tex", null)).toBe("a/main.tex");
  });
});
