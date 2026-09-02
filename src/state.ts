import type {
  PersistedSessionState,
  SessionState,
  SystemHintState,
  ToolRecord,
} from "./types.js";

export function createSessionState(projectPath: string): SessionState {
  return {
    toolCalls: new Map(),
    tokensKeptOutTotal: 0,
    tokensKeptOutByType: {},
    tokensKeptOutAtLastTurn: 0,
    currentTurn: -1,
    countedSavingsIds: new Set(),
    turnHistory: [],
    projectPath,
    lastContextTokens: null,
    lastContextPercent: null,
    lastContextWindow: null,
    hasObservedTurnBoundary: false,
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
  options?: {
    awaitingAuthoritativeTurn?: boolean;
  },
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
    awaitingAuthoritativeTurn: options?.awaitingAuthoritativeTurn,
  };
  state.toolCalls.set(toolCallId, record);
  return record;
}

/**
 * Credits kept-out tokens once per tool call and strategy
 * (02-shaping.md SHAPE-120). Returns false when the pair was already
 * credited.
 */
export function creditKeptOut(
  state: SessionState,
  toolCallId: string,
  strategy: string,
  tokensKeptOut: number,
): boolean {
  const key = `${toolCallId}:${strategy}`;
  if (state.countedSavingsIds.has(key)) return false;
  state.countedSavingsIds.add(key);

  state.tokensKeptOutTotal += tokensKeptOut;
  state.tokensKeptOutByType[strategy] = (state.tokensKeptOutByType[strategy] ?? 0) + tokensKeptOut;

  return true;
}

export function serializeSessionState(state: SessionState): PersistedSessionState {
  return {
    toolCalls: [...state.toolCalls.entries()].map(([toolCallId, record]) => [
      toolCallId,
      serializeToolRecord(record),
    ]),
    tokensKeptOutTotal: state.tokensKeptOutTotal,
    tokensKeptOutByType: { ...state.tokensKeptOutByType },
    tokensKeptOutAtLastTurn: state.tokensKeptOutAtLastTurn,
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
    tokensKeptOutTotal: persisted.tokensKeptOutTotal,
    tokensKeptOutByType: { ...persisted.tokensKeptOutByType },
    tokensKeptOutAtLastTurn: persisted.tokensKeptOutAtLastTurn,
    currentTurn: persisted.currentTurn,
    countedSavingsIds: new Set(persisted.countedSavingsIds),
    turnHistory: persisted.turnHistory.map((snapshot) => ({ ...snapshot })),
    projectPath: persisted.projectPath,
    lastContextTokens: persisted.lastContextTokens,
    lastContextPercent: persisted.lastContextPercent,
    lastContextWindow: persisted.lastContextWindow,
    hasObservedTurnBoundary: false,
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
    tokensKeptOutTotal: normalizeNumber(input.tokensKeptOutTotal),
    tokensKeptOutByType: normalizeRecord(input.tokensKeptOutByType),
    tokensKeptOutAtLastTurn: normalizeNumber(input.tokensKeptOutAtLastTurn),
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

/** Persists everything but the raw input; the fingerprint carries what later turns need. */
function serializeToolRecord(record: ToolRecord): ToolRecord {
  const { inputArgs: _inputArgs, ...rest } = record;
  return { ...rest };
}

function hydrateToolRecord(record: ToolRecord): ToolRecord {
  return { ...record };
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

function normalizeTurnSnapshot(value: unknown) {
  if (!isRecord(value)) {
    return {
      turnIndex: 0,
      toolCount: 0,
      messageCountAfterTurn: 0,
      tokensKeptOutDelta: 0,
      timestamp: 0,
    };
  }

  return {
    turnIndex: normalizeNumber(value.turnIndex),
    toolCount: normalizeNumber(value.toolCount),
    messageCountAfterTurn: normalizeNumber(value.messageCountAfterTurn),
    tokensKeptOutDelta: normalizeNumber(value.tokensKeptOutDelta),
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
    inputFingerprint: typeof value.inputFingerprint === "string" ? value.inputFingerprint : "",
    isError: typeof value.isError === "boolean" ? value.isError : false,
    turnIndex: normalizeNumber(value.turnIndex),
    timestamp: normalizeNumber(value.timestamp),
    tokenEstimate: normalizeNumber(value.tokenEstimate),
    inferredFromContext: typeof value.inferredFromContext === "boolean" ? value.inferredFromContext : undefined,
    awaitingAuthoritativeTurn:
      typeof value.awaitingAuthoritativeTurn === "boolean" ? value.awaitingAuthoritativeTurn : undefined,
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
  return isFiniteNumber(value.currentTurn)
    && Array.isArray(value.turnHistory)
    && typeof value.projectPath === "string";
}

function hasOptionalPersistedSessionStateCompatFields(value: Record<string, unknown>): boolean {
  return isOptionalFiniteNumber(value.tokensKeptOutTotal)
    && isOptionalRecord(value.tokensKeptOutByType)
    && isOptionalArray(value.toolCalls)
    && isOptionalArray(value.countedSavingsIds)
    && isOptionalNullableFiniteNumber(value.lastContextTokens)
    && isOptionalNullableFiniteNumber(value.lastContextPercent)
    && isOptionalNullableFiniteNumber(value.lastContextWindow)
    && isOptionalSystemHintStateRecord(value.systemHintState);
}

function isOptionalArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
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
