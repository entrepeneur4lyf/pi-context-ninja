import type {
  PersistedSessionState,
  SessionState,
  OmitRange,
  ToolRecord,
} from "./types.js";

export function createSessionState(projectPath: string): SessionState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    pruneTargets: [],
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
    pruneTargets: state.pruneTargets.map((target) => ({ ...target })),
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
    pruneTargets: persisted.pruneTargets.map((target) => ({ ...target })),
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

export function normalizePersistedSessionState(input: unknown): PersistedSessionState | null {
  if (!isRecord(input)) {
    return null;
  }

  const turnHistory = Array.isArray(input.turnHistory)
    ? input.turnHistory.map(normalizeTurnSnapshot)
    : [];

  return {
    toolCalls: normalizeToolCalls(input.toolCalls),
    prunedToolIds: normalizeStringArray(input.prunedToolIds),
    omitRanges: normalizeOmitRanges(input.omitRanges, turnHistory),
    pruneTargets: normalizePruneTargets(input.pruneTargets),
    tokensKeptOutTotal: normalizeNumber(input.tokensKeptOutTotal),
    tokensSaved: normalizeNumber(input.tokensSaved),
    tokensKeptOutByType: normalizeRecord(input.tokensKeptOutByType),
    tokensSavedByType: normalizeRecord(input.tokensSavedByType),
    currentTurn: normalizeNumber(input.currentTurn),
    countedSavingsIds: normalizeStringArray(input.countedSavingsIds),
    turnHistory,
    projectPath: typeof input.projectPath === "string" ? input.projectPath : "",
    lastContextTokens: normalizeNullableNumber(input.lastContextTokens),
    lastContextPercent: normalizeNullableNumber(input.lastContextPercent),
    lastContextWindow: normalizeNullableNumber(input.lastContextWindow),
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

function normalizeOmitRanges(
  value: unknown,
  turnHistory: Array<ReturnType<typeof normalizeTurnSnapshot>>,
): OmitRange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).flatMap((range) => {
    const turnBounds = parseRangeTurns(range);
    if (!turnBounds) {
      return [];
    }

    const { startTurn, endTurn } = turnBounds;
    const startOffset = normalizeNullableNumber(range.startOffset);
    const endOffset = normalizeNullableNumber(range.endOffset);
    const indexedAt = normalizeNullableNumber(range.indexedAt);
    const messageCount = normalizeNullableNumber(range.messageCount);
    const summaryRef = typeof range.summaryRef === "string" && range.summaryRef.length > 0
      ? range.summaryRef
      : `${startTurn}-${endTurn}`;
    const resolvedOffsets = startOffset !== null && endOffset !== null
      ? { startOffset, endOffset }
      : resolveTurnOffsets(
          turnHistory,
          startTurn,
          endTurn,
          messageCount ?? 0,
        );

    if (
      indexedAt === null ||
      messageCount === null ||
      resolvedOffsets.startOffset === null ||
      resolvedOffsets.endOffset === null
    ) {
      return [];
    }

    return [{
      startTurn,
      endTurn,
      startOffset: resolvedOffsets.startOffset,
      endOffset: resolvedOffsets.endOffset,
      indexedAt,
      summaryRef,
      messageCount,
    }];
  });
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

function parseRangeTurns(range: Record<string, unknown>): { startTurn: number; endTurn: number } | null {
  const startTurn = normalizeNullableNumber(range.startTurn);
  const endTurn = normalizeNullableNumber(range.endTurn);

  if (startTurn !== null && endTurn !== null) {
    return { startTurn, endTurn };
  }

  if (typeof range.turnRange === "string") {
    const match = range.turnRange.match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
      return {
        startTurn: Number.parseInt(match[1] ?? "0", 10),
        endTurn: Number.parseInt(match[2] ?? "0", 10),
      };
    }
  }

  return null;
}

function resolveTurnOffsets(
  turnHistory: Array<ReturnType<typeof normalizeTurnSnapshot>>,
  startTurn: number,
  endTurn: number,
  messageCount: number,
): { startOffset: number | null; endOffset: number | null } {
  const previousTurn = turnHistory.find((entry) => entry.turnIndex === startTurn - 1);
  const endTurnEntry = turnHistory.find((entry) => entry.turnIndex === endTurn);

  if (startTurn > 0 && !previousTurn) {
    return { startOffset: null, endOffset: null };
  }
  if (!endTurnEntry) {
    return { startOffset: null, endOffset: null };
  }

  const startOffset = previousTurn?.messageCountAfterTurn ?? 0;
  const derivedEndOffset = endTurnEntry.messageCountAfterTurn - 1;
  const endOffset = derivedEndOffset >= startOffset
    ? derivedEndOffset
    : startOffset + Math.max(0, messageCount - 1);

  return {
    startOffset,
    endOffset,
  };
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

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
    shapedContent: Array.isArray(value.shapedContent)
      ? (value.shapedContent.filter(isRecord).map((block) => ({ ...block })) as unknown as ToolRecord["shapedContent"])
      : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
