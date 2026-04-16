import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

export interface SystemHintState {
  lastAppliedText: string | null;
  appliedOnce: boolean;
}

export interface ToolRecord {
  toolCallId: string;
  toolName: string;
  inputArgs: unknown;
  inputFingerprint: string;
  isError: boolean;
  turnIndex: number;
  timestamp: number;
  tokenEstimate: number;
  inferredFromContext?: boolean;
  shapedContent?: (TextContent | ImageContent)[];
}

export interface PruneTarget {
  toolCallId: string;
  turnIndex: number;
  indexedAt: number;
  summaryRef: string;
  replacementText: string;
}

export interface TurnSnapshot {
  turnIndex: number;
  toolCount: number;
  messageCountAfterTurn: number;
  tokensKeptOutDelta: number;
  tokensSavedDelta: number;
  timestamp: number;
}

export type PersistedToolCall = [string, ToolRecord];

export interface PersistedSessionState {
  toolCalls: PersistedToolCall[];
  prunedToolIds: string[];
  pruneTargets: PruneTarget[];
  lastIndexedTurn: number;
  tokensKeptOutTotal: number;
  tokensSaved: number;
  tokensKeptOutByType: Record<string, number>;
  tokensSavedByType: Record<string, number>;
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
  | "error_purge"
  | "background_index";

export interface SessionState {
  toolCalls: Map<string, ToolRecord>;
  prunedToolIds: Set<string>;
  pruneTargets: PruneTarget[];
  lastIndexedTurn: number;
  tokensKeptOutTotal: number;
  tokensSaved: number;
  tokensKeptOutByType: Record<string, number>;
  tokensSavedByType: Record<string, number>;
  currentTurn: number;
  countedSavingsIds: Set<string>;
  turnHistory: TurnSnapshot[];
  projectPath: string;
  lastContextTokens: number | null;
  lastContextPercent: number | null;
  lastContextWindow: number | null;
  systemHintState: SystemHintState;
}

export interface StrategyResult {
  strategy: StrategyName;
  toolId: string;
  tokensSaved: number;
  tokensKeptOut: number;
  replacement?: string;
}
