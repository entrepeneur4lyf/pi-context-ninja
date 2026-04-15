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

export interface AnalyticsSnapshot {
  generatedAt: number;
  sessionId: string | null;
  projectPath: string | null;
  totalTurns: number;
  totals: AnalyticsTotals;
  context: AnalyticsContextSnapshot;
  latestTurn: AnalyticsTurnRecord | null;
  recentTurns: AnalyticsTurnRecord[];
}

export interface AnalyticsStoreOptions {
  dbPath: string;
  retentionDays?: number;
}

export interface AnalyticsStore {
  recordTurn(turn: AnalyticsTurnRecord): AnalyticsSnapshot;
  getSnapshot(sessionId: string, limit?: number): AnalyticsSnapshot;
  close(): void;
}
