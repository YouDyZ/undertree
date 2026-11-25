import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { formatWordCount, formatWordCountError, groupThousands } from "./wordcount";

describe("wordcount formatting", () => {
  it("groups thousands with nbsp", () => {
    expect(groupThousands(1234567)).toBe("1 234 567");
    expect(groupThousands(999)).toBe("999");
  });

  it("pluralizes", () => {
    expect(formatWordCount(1)).toBe("1 Wort");
    expect(formatWordCount(1234)).toBe("1 234 Wörter");
    expect(formatWordCount(0)).toBe("0 Wörter");
  });

  it("maps API errors", () => {
    expect(formatWordCountError(new ApiError(400, "no_root", "x"))).toMatch(/Root/);
    expect(formatWordCountError(new ApiError(502, "wordcount_failed", "texcount timeout"))).toBe(
      "Wortzählung fehlgeschlagen: texcount timeout"
    );
  });
});
