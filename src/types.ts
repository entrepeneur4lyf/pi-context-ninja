import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

export interface ToolRecord {
  toolCallId: string;
  toolName: string;
  inputArgs: unknown;
  inputFingerprint: string;
  isError: boolean;
  turnIndex: number;
  timestamp: number;
  tokenEstimate: number;
  shapedContent?: (TextContent | ImageContent)[];
}

export interface OmitRange {
  startKey: string;
  endKey: string;
  turnRange: string;
  indexedAt: number;
  summaryRef: string;
  messageCount: number;
}

export interface TurnSnapshot {
  turnIndex: number;
  toolCount: number;
  tokensKeptOutDelta: number;
  tokensSavedDelta: number;
  timestamp: number;
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
  omitRanges: OmitRange[];
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
}

export interface StrategyResult {
  strategy: StrategyName;
  toolId: string;
  tokensSaved: number;
  tokensKeptOut: number;
  replacement?: string;
}
