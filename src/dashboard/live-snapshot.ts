import type { AnalyticsScopeSummary, DashboardSnapshot } from "../analytics/types.js";
import type { SessionState } from "../types.js";

function emptyScope(scope: AnalyticsScopeSummary["scope"]): AnalyticsScopeSummary {
  return { scope, tokensSavedApprox: 0, tokensKeptOutApprox: 0, turnCount: 0 };
}

/**
 * A dashboard snapshot from session state alone, for the overlay when
 * the analytics store is disabled or broken (04-analytics-and-dashboard.md
 * UX flow, error path). Project and lifetime scopes are unknown here and
 * stay zero; the renderer shows them as n/a.
 */
export function buildLiveSnapshot(sessionId: string, state: SessionState, now = Date.now()): DashboardSnapshot {
  const total = state.tokensKeptOutTotal;
  return {
    generatedAt: now,
    sessionId,
    projectPath: state.projectPath,
    context: {
      tokens: state.lastContextTokens,
      percent: state.lastContextPercent,
      window: state.lastContextWindow,
    },
    scopes: {
      session: {
        scope: "session",
        tokensSavedApprox: total,
        tokensKeptOutApprox: total,
        turnCount: state.turnHistory.length,
      },
      project: emptyScope("project"),
      lifetime: emptyScope("lifetime"),
    },
    live: {
      turnCount: state.turnHistory.length,
      toolCallCount: state.turnHistory.reduce((sum, turn) => sum + turn.toolCount, 0),
    },
    strategyTotals: { ...state.tokensKeptOutByType },
    recentImpactEvents: [],
  };
}
