import type { SessionState, ToolRecord } from "./types.js";

export function createSessionState(projectPath: string): SessionState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    omitRanges: [],
    tokensKeptOutTotal: 0,
    tokensSaved: 0,
    tokensKeptOutByType: {},
    tokensSavedByType: {},
    currentTurn: 0,
    countedSavingsIds: new Set(),
    turnHistory: [],
    projectPath,
    lastContextTokens: null,
    lastContextPercent: null,
    lastContextWindow: null,
  };
}

export function getOrCreateToolRecord(
  state: SessionState,
  toolCallId: string,
  toolName: string,
  inputArgs: unknown,
  isError: boolean,
  turnIndex: number,
): ToolRecord {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) return existing;

  const record: ToolRecord = {
    toolCallId,
    toolName,
    inputArgs,
    inputFingerprint: stableStringify(inputArgs),
    isError,
    turnIndex,
    timestamp: Date.now(),
    tokenEstimate: 0,
  };
  state.toolCalls.set(toolCallId, record);
  return record;
}

export function creditSavings(
  state: SessionState,
  toolCallId: string,
  strategy: string,
  tokensSaved: number,
  tokensKeptOut: number,
): boolean {
  // Gating: only credit once per toolCallId+strategy combination
  const key = `${toolCallId}:${strategy}`;
  if (state.countedSavingsIds.has(key)) return false;
  state.countedSavingsIds.add(key);

  state.tokensSaved += tokensSaved;
  state.tokensKeptOutTotal += tokensKeptOut;
  state.tokensSavedByType[strategy] = (state.tokensSavedByType[strategy] ?? 0) + tokensSaved;
  state.tokensKeptOutByType[strategy] = (state.tokensKeptOutByType[strategy] ?? 0) + tokensKeptOut;

  return true;
}

// Private stable stringify helper
function stableStringify(value: unknown): string {
  return JSON.stringify(value, getSortedKeysReplacer());
}

function getSortedKeysReplacer(): (key: string, value: unknown) => unknown {
  return (_key: string, value: unknown) => {
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === "object") {
      const sorted = Object.keys(value as Record<string, unknown>).sort();
      const result: Record<string, unknown> = {};
      for (const k of sorted) {
        result[k] = (value as Record<string, unknown>)[k];
      }
      return result;
    }
    return value;
  };
}
