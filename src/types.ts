export interface SystemHintState {
  lastAppliedText: string | null;
  appliedOnce: boolean;
}

export interface ToolRecord {
  toolCallId: string;
  toolName: string;
  /** Raw tool input, kept in memory only; the fingerprint is what persists. */
  inputArgs?: unknown;
  inputFingerprint: string;
  isError: boolean;
  turnIndex: number;
  timestamp: number;
  tokenEstimate: number;
  inferredFromContext?: boolean;
  awaitingAuthoritativeTurn?: boolean;
}

export interface TurnSnapshot {
  turnIndex: number;
  toolCount: number;
  messageCountAfterTurn: number;
  tokensKeptOutDelta: number;
  timestamp: number;
}

export type PersistedToolCall = [string, ToolRecord];

export interface PersistedSessionState {
  toolCalls: PersistedToolCall[];
  tokensKeptOutTotal: number;
  tokensKeptOutByType: Record<string, number>;
  /** Kept-out total as of the last turn boundary, for exact per-turn deltas. */
  tokensKeptOutAtLastTurn: number;
  currentTurn: number;
  countedSavingsIds: string[];
  turnHistory: TurnSnapshot[];
  projectPath: string;
  lastContextTokens: number | null;
  lastContextPercent: number | null;
  lastContextWindow: number | null;
  systemHintState: SystemHintState;
}

export type StrategyName =
  | "short_circuit"
  | "code_filter"
  | "truncation"
  | "dedup"
  | "error_purge";

export interface SessionState {
  toolCalls: Map<string, ToolRecord>;
  tokensKeptOutTotal: number;
  tokensKeptOutByType: Record<string, number>;
  tokensKeptOutAtLastTurn: number;
  currentTurn: number;
  countedSavingsIds: Set<string>;
  turnHistory: TurnSnapshot[];
  projectPath: string;
  lastContextTokens: number | null;
  lastContextPercent: number | null;
  lastContextWindow: number | null;
  hasObservedTurnBoundary: boolean;
  systemHintState: SystemHintState;
}

