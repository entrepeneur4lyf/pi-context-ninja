import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import path from "node:path";
import { createSessionState, getOrCreateToolRecord, hydrateSessionState } from "../state.js";
import { loadSessionState, resolveSessionId, saveSessionState } from "../persistence/state-store.js";
import type { PCNConfig } from "../config.js";
import { materializeContext } from "../strategies/materialize.js";
import type { SessionState } from "../types.js";
import { refreshRangeIndex } from "./index-manager.js";
import { createAnalyticsStore } from "../analytics/store.js";
import type { AnalyticsStore } from "../analytics/types.js";
import { startDashboardServer, type DashboardServerHandle } from "../dashboard/server.js";
import { buildCompactionSummary } from "../compression/index-entry.js";
import { getIndexPath, readIndexEntries } from "../persistence/index-store.js";
import { applyPruneTargets } from "../strategies/pruning.js";
import {
  estimateToolContentTokens,
  extractExclusiveToolText,
  isToolResultMessage,
  replaceExclusiveToolText,
} from "../messages.js";
import { applySafeToolTextShaping } from "../strategies/safe-shaping.js";

const sessionMap = new Map<string, SessionState>();
const analyticsStoresBySession = new Map<string, AnalyticsStore>();

type DashboardRuntime = {
  handle: DashboardServerHandle | null;
  startPromise: Promise<DashboardServerHandle | null> | null;
  failed: boolean;
  activeSessions: Set<string>;
};

const dashboardRuntime: DashboardRuntime = {
  handle: null,
  startPromise: null,
  failed: false,
  activeSessions: new Set(),
};

function getState(sessionId: string, projectPath?: string): SessionState {
  let state = sessionMap.get(sessionId);
  if (!state) {
    const persisted = loadSessionState(sessionId);
    if (persisted) {
      state = hydrateSessionState(persisted);
    } else {
      state = createSessionState(projectPath ?? sessionId);
    }
    sessionMap.set(sessionId, state);
  }
  return state;
}

function persistState(sessionId: string): void {
  const state = sessionMap.get(sessionId);
  if (state) {
    saveSessionState(sessionId, state);
  }
}

function backfillObservedTurnIndices(
  state: SessionState,
  turnIndex: number,
  toolResults: Array<{ toolCallId?: string }>,
): void {
  for (const toolResult of toolResults) {
    if (typeof toolResult.toolCallId !== "string") {
      continue;
    }

    const record = state.toolCalls.get(toolResult.toolCallId);
    if (record && (record.awaitingAuthoritativeTurn || record.inferredFromContext || record.turnIndex < 0)) {
      record.turnIndex = turnIndex;
      record.awaitingAuthoritativeTurn = false;
      record.inferredFromContext = false;
    }
  }
}

function appendSystemHint(systemPrompt: string, hintText: string): string {
  const trimmedSystemPrompt = systemPrompt.trimEnd();
  if (!trimmedSystemPrompt) {
    return hintText;
  }

  return `${trimmedSystemPrompt}\n\n${hintText}`;
}

function resolveContextTokens(state: SessionState, ctx: { getContextUsage(): { tokens: number | null } | undefined }): number | null {
  const usage = ctx.getContextUsage();
  if (usage?.tokens !== undefined && usage.tokens !== null) {
    return usage.tokens;
  }
  return state.lastContextTokens;
}

type ToolResultLike = Pick<ToolResultMessage, "toolCallId" | "toolName" | "content" | "isError">;

function resolveHistoricalTurnIndex(state: SessionState): number {
  if (state.currentTurn >= 0) {
    return state.currentTurn - 1;
  }

  const latestTurnIndex = state.turnHistory.reduce<number>(
    (max, snapshot) => Math.max(max, snapshot.turnIndex),
    Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(latestTurnIndex) ? latestTurnIndex : 0;
}

function syncToolRecord(
  state: SessionState,
  toolResult: ToolResultLike,
  turnIndex: number,
  options?: {
    overwriteTurnIndex?: boolean;
    awaitingAuthoritativeTurn?: boolean;
  },
): ReturnType<typeof getOrCreateToolRecord> | null {
  if (typeof toolResult.toolCallId !== "string" || typeof toolResult.toolName !== "string") {
    return null;
  }

  const record = getOrCreateToolRecord(
    state,
    toolResult.toolCallId,
    toolResult.toolName,
    undefined,
    Boolean(toolResult.isError),
    turnIndex,
    {
      awaitingAuthoritativeTurn: options?.awaitingAuthoritativeTurn,
    },
  );

  if (
    ((options?.overwriteTurnIndex ?? false) && (record.inferredFromContext || record.awaitingAuthoritativeTurn))
    || record.turnIndex < 0
  ) {
    record.turnIndex = turnIndex;
    record.awaitingAuthoritativeTurn = false;
    record.inferredFromContext = false;
  }
  record.toolName = toolResult.toolName;
  record.isError = record.isError || Boolean(toolResult.isError);
  record.tokenEstimate = estimateToolContentTokens(toolResult.content);

  return record;
}

function rebuildToolRecordsFromMessages(state: SessionState, messages: AgentMessage[]): void {
  const historicalTurnIndex = resolveHistoricalTurnIndex(state);
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const hadRecord = state.toolCalls.has(message.toolCallId);
    const record = syncToolRecord(state, message, historicalTurnIndex);
    if (record && !hadRecord) {
      record.inferredFromContext = true;
    }
  }
}

function shapeImmediateToolResult(
  toolResult: ToolResultLike,
  config: PCNConfig,
): ToolResultMessage["content"] | undefined {
  if (toolResult.isError) {
    return undefined;
  }

  const originalText = extractExclusiveToolText(toolResult.content);
  if (originalText === null) {
    return undefined;
  }

  const shapedText = applySafeToolTextShaping(originalText, config);
  if (shapedText === null || shapedText === originalText) {
    return undefined;
  }

  return replaceExclusiveToolText(toolResult.content, shapedText);
}

function resolveCompactionTokensBefore(
  state: SessionState,
  ctx: { getContextUsage(): { tokens: number | null } | undefined },
  preparation: { tokensBefore?: number | null },
): number | null {
  if (typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)) {
    return preparation.tokensBefore;
  }

  return resolveContextTokens(state, ctx);
}

function buildNativeCompactionResult(
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
  ctx: { getContextUsage(): { tokens: number | null } | undefined },
  preparation: { firstKeptEntryId: string; tokensBefore?: number | null },
): { cancel?: boolean; compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number } } | undefined {
  if (!config.nativeCompactionIntegration.enabled) {
    return undefined;
  }

  const contextTokens = resolveCompactionTokensBefore(state, ctx, preparation);
  const threshold = config.nativeCompactionIntegration.maxContextSize;
  if (contextTokens === null || contextTokens < threshold) {
    return undefined;
  }

  try {
    const indexPath = getIndexPath(state.projectPath || sessionId);
    const entries = readIndexEntries(indexPath);
    if (entries.length === 0) {
      return config.nativeCompactionIntegration.fallbackOnFailure ? undefined : { cancel: true };
    }

    return {
      compaction: {
        summary: buildCompactionSummary(entries),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: contextTokens,
      },
    };
  } catch {
    return config.nativeCompactionIntegration.fallbackOnFailure ? undefined : { cancel: true };
  }
}

function getAnalyticsStore(sessionId: string, state: SessionState, config: PCNConfig): AnalyticsStore | null {
  if (!config.analytics.enabled) {
    return null;
  }

  let store = analyticsStoresBySession.get(sessionId);
  if (!store) {
    const dbPath = config.analytics.dbPath || path.join(state.projectPath, ".pi-ninja", "analytics.sqlite");
    store = createAnalyticsStore({
      dbPath,
      retentionDays: config.analytics.retentionDays,
    });
    analyticsStoresBySession.set(sessionId, store);
  }

  return store;
}

function evictAnalyticsStore(sessionId: string): void {
  const store = analyticsStoresBySession.get(sessionId);
  if (!store) {
    return;
  }

  analyticsStoresBySession.delete(sessionId);

  try {
    store.close();
  } catch {
    // Treat broken analytics stores as disposable; core runtime state must survive.
  }
}

async function recordTurnAnalyticsSafely(
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
  turn: {
    turnIndex: number;
    toolCount: number;
    messageCountAfterTurn: number;
    timestamp: number;
    tokensSavedApprox: number;
    tokensKeptOutApprox: number;
  },
): Promise<void> {
  if (!config.analytics.enabled) {
    return;
  }

  try {
    const analyticsStore = getAnalyticsStore(sessionId, state, config);
    const snapshot = analyticsStore?.recordTurn({
      sessionId,
      projectPath: state.projectPath,
      turnIndex: turn.turnIndex,
      toolCount: turn.toolCount,
      messageCountAfterTurn: turn.messageCountAfterTurn,
      timestamp: turn.timestamp,
      contextTokens: state.lastContextTokens,
      contextPercent: state.lastContextPercent,
      contextWindow: state.lastContextWindow,
      tokensSavedApprox: turn.tokensSavedApprox,
      tokensKeptOutApprox: turn.tokensKeptOutApprox,
    });

    if (!snapshot) {
      return;
    }

    const dashboardServer = await ensureDashboardServer(sessionId, config);
    if (dashboardServer) {
      dashboardServer.publish(sessionId, snapshot);
    }
  } catch {
    evictAnalyticsStore(sessionId);
  }
}

async function ensureDashboardServer(sessionId: string, config: PCNConfig): Promise<DashboardServerHandle | null> {
  if (!config.dashboard.enabled) {
    return null;
  }

  dashboardRuntime.activeSessions.add(sessionId);

  if (dashboardRuntime.handle) {
    return dashboardRuntime.handle;
  }

  if (dashboardRuntime.failed) {
    return null;
  }

  if (!dashboardRuntime.startPromise) {
    dashboardRuntime.startPromise = (async () => {
      const handle = startDashboardServer({
        port: config.dashboard.port,
        host: config.dashboard.bindHost,
      });

      try {
        await handle.ready;
        dashboardRuntime.handle = handle;
        return handle;
      } catch {
        dashboardRuntime.failed = true;
        await handle.close().catch(() => {});
        return null;
      } finally {
        dashboardRuntime.startPromise = null;
      }
    })();
  }

  return dashboardRuntime.startPromise;
}

async function releaseSessionResources(sessionId: string): Promise<void> {
  evictAnalyticsStore(sessionId);

  if (dashboardRuntime.handle) {
    dashboardRuntime.handle.clearSession(sessionId);
  }

  dashboardRuntime.activeSessions.delete(sessionId);
  if (dashboardRuntime.activeSessions.size === 0 && dashboardRuntime.handle) {
    const handle = dashboardRuntime.handle;
    dashboardRuntime.handle = null;
    dashboardRuntime.failed = false;
    await handle.close().catch(() => {});
  } else if (dashboardRuntime.activeSessions.size === 0) {
    dashboardRuntime.failed = false;
  }
}

export function createExtensionRuntime(pi: ExtensionAPI, config: PCNConfig): void {
  pi.on("tool_call", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    getOrCreateToolRecord(
      state,
      event.toolCallId,
      event.toolName,
      event.input,
      false,
      state.currentTurn,
      {
        awaitingAuthoritativeTurn: !state.hasObservedTurnBoundary,
      },
    );
  });

  pi.on("tool_result", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    const record = syncToolRecord(state, event, state.currentTurn, {
      awaitingAuthoritativeTurn: !state.hasObservedTurnBoundary,
    });
    const shapedContent = shapeImmediateToolResult(event, config);
    if (record) {
      record.shapedContent = shapedContent?.map((block) => ({ ...block }));
    }
    if (shapedContent) {
      return { content: shapedContent };
    }
    return undefined;
  });

  pi.on("context", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    rebuildToolRecordsFromMessages(state, event.messages);
    const materialized = materializeContext(event.messages, { state, config });
    return {
      ...materialized,
      messages: applyPruneTargets(materialized.messages ?? event.messages, state.pruneTargets, state),
    };
  });

  pi.on("turn_end", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);

    if (typeof event.turnIndex === "number" && Number.isFinite(event.turnIndex)) {
      for (const toolResult of event.toolResults) {
        syncToolRecord(state, toolResult, event.turnIndex, {
          overwriteTurnIndex: true,
        });
      }
    }

    if (typeof event.turnIndex === "number" && Number.isFinite(event.turnIndex)) {
      backfillObservedTurnIndices(state, event.turnIndex, event.toolResults);
    }

    const usage = ctx.getContextUsage();
    if (usage) {
      state.lastContextTokens = usage.tokens;
      state.lastContextPercent = usage.percent;
      state.lastContextWindow = usage.contextWindow;
    }

    const previousTotals = state.turnHistory.reduce(
      (acc, snapshot) => ({
        tokensSaved: acc.tokensSaved + snapshot.tokensSavedDelta,
        tokensKeptOut: acc.tokensKeptOut + snapshot.tokensKeptOutDelta,
      }),
      { tokensSaved: 0, tokensKeptOut: 0 },
    );

    state.turnHistory.push({
      turnIndex: event.turnIndex,
      toolCount: event.toolResults.length,
      messageCountAfterTurn: ctx.sessionManager.getEntries().length,
      tokensKeptOutDelta: Math.max(0, state.tokensKeptOutTotal - previousTotals.tokensKeptOut),
      tokensSavedDelta: Math.max(0, state.tokensSaved - previousTotals.tokensSaved),
      timestamp: Date.now(),
    });

    state.currentTurn = typeof event.turnIndex === "number" ? event.turnIndex + 1 : state.currentTurn + 1;
    state.hasObservedTurnBoundary = true;
    const latestTurn = state.turnHistory.at(-1);
    try {
      if (latestTurn) {
        await recordTurnAnalyticsSafely(sessionId, state, config, {
          turnIndex: latestTurn.turnIndex,
          toolCount: latestTurn.toolCount,
          messageCountAfterTurn: latestTurn.messageCountAfterTurn,
          timestamp: latestTurn.timestamp,
          tokensSavedApprox: latestTurn.tokensSavedDelta,
          tokensKeptOutApprox: latestTurn.tokensKeptOutDelta,
        });
      }
    } finally {
      persistState(sessionId);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!config.systemHint.enabled) {
      return undefined;
    }

    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    const hintState = state.systemHintState;
    const hintText = config.systemHint.text.trim();
    if (!hintText) {
      return undefined;
    }

    if (config.systemHint.frequency === "once_per_session") {
      if (hintState.appliedOnce) {
        return undefined;
      }
      hintState.appliedOnce = true;
      hintState.lastAppliedText = hintText;
      persistState(sessionId);
      return {
        systemPrompt: appendSystemHint(event.systemPrompt, hintText),
      };
    }

    if (config.systemHint.frequency === "on_change" && hintState.lastAppliedText === hintText) {
      return undefined;
    }

    hintState.lastAppliedText = hintText;
    persistState(sessionId);
    return {
      systemPrompt: appendSystemHint(event.systemPrompt, hintText),
    };
  });

  pi.on("before_provider_request", (event) => event.payload);

  pi.on("session_before_compact", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    return buildNativeCompactionResult(sessionId, state, config, ctx, event.preparation);
  });

  pi.on("agent_end", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    rebuildToolRecordsFromMessages(state, event.messages);
    refreshRangeIndex(event.messages, state, config, ctx.cwd);
    persistState(sessionId);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    const sessionId = resolveSessionId(_ctx);
    const state = sessionMap.get(sessionId);
    if (state) {
      saveSessionState(sessionId, state);
      sessionMap.delete(sessionId);
    }
    await releaseSessionResources(sessionId);
  });
}
