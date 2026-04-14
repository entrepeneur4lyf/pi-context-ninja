import { describe, it, expect } from "vitest";
import { headTailTruncate } from "../src/strategies/truncation";

describe("truncation", () => {
  it("splits with gap", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = headTailTruncate(lines, { headLines: 10, tailLines: 10, minLines: 100, enabled: true, strategy: "head_tail" });
    expect(r).not.toBeNull();
    expect(r).toContain("line 1");
    expect(r).toContain("line 300");
    expect(r).not.toContain("line 150");
    expect(r).toContain("omitted");
  });
  it("no-op for short input", () => {
    expect(headTailTruncate("a\nb\nc\nd\ne", { headLines: 10, tailLines: 10, minLines: 100, enabled: true, strategy: "head_tail" })).toBeNull();
  });
});
