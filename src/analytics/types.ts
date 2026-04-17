export interface AnalyticsTurnRecord {
  sessionId: string;
  projectPath: string;
  turnIndex: number;
  toolCount: number;
  messageCountAfterTurn: number;
  timestamp: number;
  contextTokens: number | null;
  contextPercent: number | null;
  contextWindow: number | null;
  tokensSavedApprox: number;
  tokensKeptOutApprox: number;
}

export interface AnalyticsTotals {
  tokensSavedApprox: number;
  tokensKeptOutApprox: number;
}

export interface AnalyticsContextSnapshot {
  tokens: number | null;
  percent: number | null;
  window: number | null;
}

export interface AnalyticsScopeSummary {
  scope: "session" | "project" | "lifetime";
  tokensSavedApprox: number;
  tokensKeptOutApprox: number;
  turnCount: number;
}

export interface DashboardImpactEvent {
  timestamp: number;
  sessionId: string;
  projectPath: string;
  source: string;
  toolName: string | null;
  strategy: string;
  tokensSavedApprox: number;
  tokensKeptOutApprox: number;
  contextPercent: number | null;
  summary: string;
}

export interface StrategyImpactTotals {
  tokensSavedApprox: number;
  tokensKeptOutApprox: number;
}

export interface DashboardLiveSnapshot {
  turnCount: number;
  toolCallCount: number;
}

export interface AnalyticsTurnWrite extends AnalyticsTurnRecord {
  impactEvents?: DashboardImpactEvent[];
}

export interface DashboardSnapshot {
  generatedAt: number;
  sessionId: string | null;
  projectPath: string | null;
  context: AnalyticsContextSnapshot;
  scopes: {
    session: AnalyticsScopeSummary;
    project: AnalyticsScopeSummary;
    lifetime: AnalyticsScopeSummary;
  };
  live: DashboardLiveSnapshot;
  strategyTotals: Record<string, number>;
  recentImpactEvents: DashboardImpactEvent[];
}

export interface LegacyAnalyticsSnapshot {
  generatedAt: number;
  sessionId: string | null;
  projectPath: string | null;
  totalTurns: number;
  totals: AnalyticsTotals;
  context: AnalyticsContextSnapshot;
  latestTurn: AnalyticsTurnRecord | null;
  recentTurns: AnalyticsTurnRecord[];
}

export type AnalyticsSnapshot = DashboardSnapshot | LegacyAnalyticsSnapshot;

export interface AnalyticsStoreOptions {
  dbPath: string;
  retentionDays?: number;
}

export interface AnalyticsStore {
  recordTurn(turn: AnalyticsTurnWrite): DashboardSnapshot;
  getDashboardSnapshot(sessionId: string, projectPath: string, limit?: number): DashboardSnapshot;
  getStrategyImpactTotals(sessionId: string): Record<string, StrategyImpactTotals>;
  getSnapshot(sessionId: string, limit?: number): LegacyAnalyticsSnapshot;
  close(): void;
}
