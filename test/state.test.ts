import { describe, it, expect } from "bun:test";
import { createSessionState, getOrCreateToolRecord, creditKeptOut, serializeSessionState, hydrateSessionState } from "../src/state";

describe("session state", () => {
  it("creates fresh state", () => {
    const s = createSessionState("/tmp/p");
    expect(s.tokensKeptOutTotal).toBe(0);
    expect(s.currentTurn).toBe(-1);
    expect(s.hasObservedTurnBoundary).toBe(false);
  });
  it("creates and retrieves tool records", () => {
    const s = createSessionState("/tmp");
    const r = getOrCreateToolRecord(s, "c1", "read", { path: "a.ts" }, false, 0);
    expect(r.toolCallId).toBe("c1");
    expect(s.toolCalls.size).toBe(1);
    const r2 = getOrCreateToolRecord(s, "c1", "read", { path: "a.ts" }, false, 0);
    expect(r2).toBe(r);
  });
  it("credits kept-out tokens only once per toolCallId and strategy", () => {
    const s = createSessionState("/tmp");
    expect(creditKeptOut(s, "c1", "dedup", 500)).toBe(true);
    expect(s.tokensKeptOutTotal).toBe(500);
    expect(s.tokensKeptOutByType.dedup).toBe(500);
    expect(creditKeptOut(s, "c1", "dedup", 500)).toBe(false);
    expect(s.tokensKeptOutTotal).toBe(500);
    expect(creditKeptOut(s, "c1", "code_filter", 300)).toBe(true);
    expect(s.tokensKeptOutTotal).toBe(800);
    expect("tokensSaved" in s).toBe(false);
  });

  it("serializes and hydrates maps, sets, and turn snapshots", () => {
    const s = createSessionState("/tmp/project");
    s.toolCalls.set("call-1", {
      toolCallId: "call-1",
      toolName: "read",
      inputArgs: { path: "a.ts" },
      inputFingerprint: "{\"path\":\"a.ts\"}",
      isError: false,
      turnIndex: 4,
      timestamp: 123,
      tokenEstimate: 42,
      inferredFromContext: true,
      awaitingAuthoritativeTurn: true,
    });
    s.countedSavingsIds.add("call-1:dedup");
    s.turnHistory.push({
      turnIndex: 4,
      toolCount: 1,
      messageCountAfterTurn: 9,
      tokensKeptOutDelta: 120,
      timestamp: 456,
    });
    s.lastContextTokens = 1000;
    s.lastContextPercent = 0.5;
    s.lastContextWindow = 2000;

    const persisted = serializeSessionState(s);
    expect(persisted.toolCalls).toEqual([
      [
        "call-1",
        expect.objectContaining({
          toolCallId: "call-1",
          toolName: "read",
          inferredFromContext: true,
          awaitingAuthoritativeTurn: true,
        }),
      ],
    ]);
    expect(persisted.countedSavingsIds).toEqual(["call-1:dedup"]);
    expect(persisted.turnHistory[0]).toMatchObject({
      turnIndex: 4,
      messageCountAfterTurn: 9,
    });

    const hydrated = hydrateSessionState(persisted);
    expect(hydrated.toolCalls.get("call-1")).toMatchObject({
      toolCallId: "call-1",
      toolName: "read",
      inferredFromContext: true,
      awaitingAuthoritativeTurn: true,
    });
    expect(hydrated.countedSavingsIds.has("call-1:dedup")).toBe(true);
    expect(hydrated.turnHistory[0].messageCountAfterTurn).toBe(9);
    expect(hydrated.lastContextTokens).toBe(1000);
    expect(hydrated.lastContextPercent).toBe(0.5);
    expect(hydrated.lastContextWindow).toBe(2000);
    expect(hydrated.hasObservedTurnBoundary).toBe(false);
  });

  it("serializes and hydrates persisted system hint state", () => {
    const s = createSessionState("/tmp/project");
    s.systemHintState.appliedOnce = true;
    s.systemHintState.lastAppliedText = "Keep the context small.";

    const persisted = serializeSessionState(s);
    expect(persisted.systemHintState).toEqual({
      appliedOnce: true,
      lastAppliedText: "Keep the context small.",
    });

    const hydrated = hydrateSessionState(persisted);
    expect(hydrated.systemHintState).toEqual({
      appliedOnce: true,
      lastAppliedText: "Keep the context small.",
    });
  });

  it("persists tool records without their input arguments", () => {
    const s = createSessionState("/tmp");
    getOrCreateToolRecord(s, "c1", "read", { path: "a.ts", big: "x".repeat(10_000) }, false, 0);
    const persisted = serializeSessionState(s);
    expect("inputArgs" in persisted.toolCalls[0][1]).toBe(false);
    expect(persisted.toolCalls[0][1].inputFingerprint).toContain("a.ts");
    expect(hydrateSessionState(persisted).toolCalls.get("c1")?.inputFingerprint).toContain("a.ts");
  });
});
