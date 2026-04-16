import type {
  PersistedSessionState,
  SessionState,
  SystemHintState,
  ToolRecord,
} from "./types.js";

export function createSessionState(projectPath: string): SessionState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    pruneTargets: [],
    lastIndexedTurn: -1,
    tokensKeptOutTotal: 0,
    tokensSaved: 0,
    tokensKeptOutByType: {},
    tokensSavedByType: {},
    currentTurn: -1,
    countedSavingsIds: new Set(),
    turnHistory: [],
    projectPath,
    lastContextTokens: null,
    lastContextPercent: null,
    lastContextWindow: null,
    systemHintState: createSystemHintState(),
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
  state.tokensKeptOutTotal += tokensKeptOut;
  state.tokensKeptOutByType[strategy] = (state.tokensKeptOutByType[strategy] ?? 0) + tokensKeptOut;

  // Gating: only credit saved tokens once per toolCallId+strategy combination
  const key = `${toolCallId}:${strategy}`;
  if (state.countedSavingsIds.has(key)) return false;
  state.countedSavingsIds.add(key);

  state.tokensSaved += tokensSaved;
  state.tokensSavedByType[strategy] = (state.tokensSavedByType[strategy] ?? 0) + tokensSaved;

  return true;
}

export function serializeSessionState(state: SessionState): PersistedSessionState {
  return {
    toolCalls: [...state.toolCalls.entries()].map(([toolCallId, record]) => [
      toolCallId,
      serializeToolRecord(record),
    ]),
    prunedToolIds: [...state.prunedToolIds],
    pruneTargets: state.pruneTargets.map((target) => ({ ...target })),
    lastIndexedTurn: state.lastIndexedTurn,
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
    systemHintState: { ...state.systemHintState },
  };
}

export function hydrateSessionState(persisted: PersistedSessionState): SessionState {
  return {
    toolCalls: new Map(persisted.toolCalls.map(([toolCallId, record]) => [
      toolCallId,
      hydrateToolRecord(record),
    ])),
    prunedToolIds: new Set(persisted.prunedToolIds),
    pruneTargets: persisted.pruneTargets.map((target) => ({ ...target })),
    lastIndexedTurn: persisted.lastIndexedTurn,
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
    systemHintState: { ...persisted.systemHintState },
  };
}

export function normalizePersistedSessionState(input: unknown): PersistedSessionState | null {
  if (!isPersistedSessionStateRoot(input)) {
    return null;
  }

  const turnHistory = Array.isArray(input.turnHistory)
    ? input.turnHistory.map(normalizeTurnSnapshot)
    : [];

  return {
    toolCalls: normalizeToolCalls(input.toolCalls),
    prunedToolIds: normalizeStringArray(input.prunedToolIds),
    pruneTargets: normalizePruneTargets(input.pruneTargets),
    lastIndexedTurn: normalizeNumber(input.lastIndexedTurn, -1),
    tokensKeptOutTotal: normalizeNumber(input.tokensKeptOutTotal),
    tokensSaved: normalizeNumber(input.tokensSaved),
    tokensKeptOutByType: normalizeRecord(input.tokensKeptOutByType),
    tokensSavedByType: normalizeRecord(input.tokensSavedByType),
    currentTurn: normalizeNumber(input.currentTurn, -1),
    countedSavingsIds: normalizeStringArray(input.countedSavingsIds),
    turnHistory,
    projectPath: typeof input.projectPath === "string" ? input.projectPath : "",
    lastContextTokens: normalizeNullableNumber(input.lastContextTokens),
    lastContextPercent: normalizeNullableNumber(input.lastContextPercent),
    lastContextWindow: normalizeNullableNumber(input.lastContextWindow),
    systemHintState: normalizeSystemHintState(input.systemHintState),
  };
}

// Private stable stringify helper
function stableStringify(value: unknown): string {
  const serialized = JSON.stringify(value, getSortedKeysReplacer());
  return typeof serialized === "string" ? serialized : "";
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

function normalizeToolCalls(value: unknown): [string, ToolRecord][] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string" || !isRecord(entry[1])) {
      return [];
    }

    return [[entry[0], normalizeToolRecord(entry[1])]];
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function normalizePruneTargets(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).flatMap((target) => {
    const turnIndex = normalizeNullableNumber(target.turnIndex);
    const indexedAt = normalizeNullableNumber(target.indexedAt);

    if (
      typeof target.toolCallId !== "string" ||
      turnIndex === null ||
      indexedAt === null ||
      typeof target.summaryRef !== "string" ||
      typeof target.replacementText !== "string"
    ) {
      return [];
    }

    return [{
      toolCallId: target.toolCallId,
      turnIndex,
      indexedAt,
      summaryRef: target.summaryRef,
      replacementText: target.replacementText,
    }];
  });
}

function normalizeTurnSnapshot(value: unknown) {
  if (!isRecord(value)) {
    return {
      turnIndex: 0,
      toolCount: 0,
      messageCountAfterTurn: 0,
      tokensKeptOutDelta: 0,
      tokensSavedDelta: 0,
      timestamp: 0,
    };
  }

  return {
    turnIndex: normalizeNumber(value.turnIndex),
    toolCount: normalizeNumber(value.toolCount),
    messageCountAfterTurn: normalizeNumber(value.messageCountAfterTurn),
    tokensKeptOutDelta: normalizeNumber(value.tokensKeptOutDelta),
    tokensSavedDelta: normalizeNumber(value.tokensSavedDelta),
    timestamp: normalizeNumber(value.timestamp),
  };
}

function normalizeRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeNullableNumber(entry);
    if (normalized !== null) {
      result[key] = normalized;
    }
  }
  return result;
}

function normalizeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeToolRecord(value: Record<string, unknown>): ToolRecord {
  return {
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : "",
    toolName: typeof value.toolName === "string" ? value.toolName : "",
    inputArgs: value.inputArgs,
    inputFingerprint: typeof value.inputFingerprint === "string" ? value.inputFingerprint : "",
    isError: typeof value.isError === "boolean" ? value.isError : false,
    turnIndex: normalizeNumber(value.turnIndex),
    timestamp: normalizeNumber(value.timestamp),
    tokenEstimate: normalizeNumber(value.tokenEstimate),
    inferredFromContext: typeof value.inferredFromContext === "boolean" ? value.inferredFromContext : undefined,
    shapedContent: Array.isArray(value.shapedContent)
      ? (value.shapedContent.filter(isRecord).map((block) => ({ ...block })) as unknown as ToolRecord["shapedContent"])
      : undefined,
  };
}

function normalizeSystemHintState(value: unknown): SystemHintState {
  if (!isRecord(value)) {
    return createSystemHintState();
  }

  return {
    appliedOnce: typeof value.appliedOnce === "boolean" ? value.appliedOnce : false,
    lastAppliedText: typeof value.lastAppliedText === "string" ? value.lastAppliedText : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedSessionStateRoot(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return hasSharedPersistedSessionStateFields(value)
    && hasOptionalPersistedSessionStateCompatFields(value);
}

function hasSharedPersistedSessionStateFields(value: Record<string, unknown>): boolean {
  return isFiniteNumber(value.lastIndexedTurn)
    && isFiniteNumber(value.tokensKeptOutTotal)
    && isFiniteNumber(value.tokensSaved)
    && isRecord(value.tokensKeptOutByType)
    && isRecord(value.tokensSavedByType)
    && isFiniteNumber(value.currentTurn)
    && Array.isArray(value.turnHistory)
    && typeof value.projectPath === "string";
}

function hasOptionalPersistedSessionStateCompatFields(value: Record<string, unknown>): boolean {
  return isOptionalArray(value.omitRanges)
    && isOptionalArray(value.toolCalls)
    && isOptionalArray(value.prunedToolIds)
    && isOptionalArray(value.pruneTargets)
    && isOptionalArray(value.countedSavingsIds)
    && isOptionalNullableFiniteNumber(value.lastContextTokens)
    && isOptionalNullableFiniteNumber(value.lastContextPercent)
    && isOptionalNullableFiniteNumber(value.lastContextWindow)
    && isOptionalSystemHintStateRecord(value.systemHintState);
}

function isOptionalArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isOptionalNullableFiniteNumber(value: unknown): boolean {
  return value === undefined || isNullableFiniteNumber(value);
}

function isSystemHintStateRecord(value: unknown): value is SystemHintState {
  return isRecord(value)
    && typeof value.appliedOnce === "boolean"
    && (typeof value.lastAppliedText === "string" || value.lastAppliedText === null);
}

function isOptionalSystemHintStateRecord(value: unknown): boolean {
  return value === undefined || isSystemHintStateRecord(value);
}

function createSystemHintState(): SystemHintState {
  return {
    lastAppliedText: null,
    appliedOnce: false,
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
