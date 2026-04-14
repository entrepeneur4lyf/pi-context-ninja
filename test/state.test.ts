import { describe, it, expect } from "vitest";
import { createSessionState, getOrCreateToolRecord, creditSavings } from "../src/state";

describe("session state", () => {
  it("creates fresh state", () => {
    const s = createSessionState("/tmp/p");
    expect(s.tokensKeptOutTotal).toBe(0);
    expect(s.currentTurn).toBe(0);
  });
  it("creates and retrieves tool records", () => {
    const s = createSessionState("/tmp");
    const r = getOrCreateToolRecord(s, "c1", "read", { path: "a.ts" }, false, 0);
    expect(r.toolCallId).toBe("c1");
    expect(s.toolCalls.size).toBe(1);
    const r2 = getOrCreateToolRecord(s, "c1", "read", { path: "a.ts" }, false, 0);
    expect(r2).toBe(r);
  });
  it("credits savings with gating", () => {
    const s = createSessionState("/tmp");
    expect(creditSavings(s, "c1", "dedup", 500, 500)).toBe(true);
    expect(s.tokensSaved).toBe(500);
    expect(creditSavings(s, "c1", "dedup", 500, 500)).toBe(false);
    expect(creditSavings(s, "c1", "code_filter", 300, 300)).toBe(true);
    expect(s.tokensSaved).toBe(800);
  });
});
