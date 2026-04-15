import type {
  PersistedSessionState,
  SessionState,
  ToolRecord,
} from "./types.js";

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

export function serializeSessionState(state: SessionState): PersistedSessionState {
  return {
    toolCalls: [...state.toolCalls.entries()].map(([toolCallId, record]) => [
      toolCallId,
      serializeToolRecord(record),
    ]),
    prunedToolIds: [...state.prunedToolIds],
    omitRanges: state.omitRanges.map((range) => ({ ...range })),
    tokensKeptOutTotal: state.tokensKeptOutTotal,
    tokensSaved: state.tokensSaved,
    tokensKeptOutByType: { ...state.tokensKeptOutByType },
    tokensSavedByType: { ...state.tokensSavedByType },
    currentTurn: state.currentTurn,
    countedSavingsIds: [...state.countedSavingsIds],
    turnHistory: state.turnHistory.map((snapshot) => ({ ...snapshot })),
    projectPath: state.projectPath,
    lastContextTokens: state.lastContextTokens,
    lastContextPercent: state.lastContextPercent,
    lastContextWindow: state.lastContextWindow,
  };
}

export function hydrateSessionState(persisted: PersistedSessionState): SessionState {
  return {
    toolCalls: new Map(persisted.toolCalls.map(([toolCallId, record]) => [
      toolCallId,
      hydrateToolRecord(record),
    ])),
    prunedToolIds: new Set(persisted.prunedToolIds),
    omitRanges: persisted.omitRanges.map((range) => ({ ...range })),
    tokensKeptOutTotal: persisted.tokensKeptOutTotal,
    tokensSaved: persisted.tokensSaved,
    tokensKeptOutByType: { ...persisted.tokensKeptOutByType },
    tokensSavedByType: { ...persisted.tokensSavedByType },
    currentTurn: persisted.currentTurn,
    countedSavingsIds: new Set(persisted.countedSavingsIds),
    turnHistory: persisted.turnHistory.map((snapshot) => ({ ...snapshot })),
    projectPath: persisted.projectPath,
    lastContextTokens: persisted.lastContextTokens,
    lastContextPercent: persisted.lastContextPercent,
    lastContextWindow: persisted.lastContextWindow,
  };
}

// Private stable stringify helper
function stableStringify(value: unknown): string {
  return JSON.stringify(value, getSortedKeysReplacer());
}

function serializeToolRecord(record: ToolRecord): ToolRecord {
  return {
    ...record,
    shapedContent: record.shapedContent?.map((block) => ({ ...block })),
  };
}

function hydrateToolRecord(record: ToolRecord): ToolRecord {
  return {
    ...record,
    shapedContent: record.shapedContent?.map((block) => ({ ...block })),
  };
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
