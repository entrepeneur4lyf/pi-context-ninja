import { describe, expect, it } from "bun:test";
import { buildLiveSnapshot } from "../src/dashboard/live-snapshot";
import { createSessionState } from "../src/state";

describe("buildLiveSnapshot", () => {
  it("builds a session-only snapshot from session state", () => {
    const state = createSessionState("/tmp/project");
    state.tokensKeptOutTotal = 500;
    state.tokensKeptOutByType = { truncation: 300, error_purge: 200 };
    state.turnHistory.push(
      { turnIndex: 0, toolCount: 1, messageCountAfterTurn: 2, tokensKeptOutDelta: 300, timestamp: 1 },
      { turnIndex: 1, toolCount: 2, messageCountAfterTurn: 5, tokensKeptOutDelta: 200, timestamp: 2 },
    );
    state.lastContextTokens = 420;
    state.lastContextPercent = 42;
    state.lastContextWindow = 1000;

    const snapshot = buildLiveSnapshot("session-live", state, 12_345);

    expect(snapshot.generatedAt).toBe(12_345);
    expect(snapshot.sessionId).toBe("session-live");
    expect(snapshot.projectPath).toBe("/tmp/project");
    expect(snapshot.context).toEqual({ tokens: 420, percent: 42, window: 1000 });
    expect(snapshot.scopes.session).toEqual({
      scope: "session",
      tokensSavedApprox: 500,
      tokensKeptOutApprox: 500,
      turnCount: 2,
    });
    expect(snapshot.scopes.project).toEqual({ scope: "project", tokensSavedApprox: 0, tokensKeptOutApprox: 0, turnCount: 0 });
    expect(snapshot.scopes.lifetime).toEqual({ scope: "lifetime", tokensSavedApprox: 0, tokensKeptOutApprox: 0, turnCount: 0 });
    expect(snapshot.live).toEqual({ turnCount: 2, toolCallCount: 3 });
    expect(snapshot.strategyTotals).toEqual({ truncation: 300, error_purge: 200 });
    expect(snapshot.recentImpactEvents).toEqual([]);
  });

  it("copies strategy totals so later credits do not leak into an older snapshot", () => {
    const state = createSessionState("/tmp/project");
    state.tokensKeptOutByType = { dedup: 10 };
    const snapshot = buildLiveSnapshot("session-live", state);
    state.tokensKeptOutByType.dedup = 99;

    expect(snapshot.strategyTotals).toEqual({ dedup: 10 });
  });
});
