import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import path from "node:path";
import type { CommandRuntimeHealth } from "../control/commands.js";
import { setCommandRuntimeDegradedReason } from "../control/commands.js";
import { createSessionState, getOrCreateToolRecord, hydrateSessionState } from "../state.js";
import { loadSessionState, resolveSessionId, saveSessionState } from "../persistence/state-store.js";
import type { PCNConfig } from "../config.js";
import { materializeContext } from "../strategies/materialize.js";
import type { SessionState } from "../types.js";
import { refreshRangeIndex } from "./index-manager.js";
import { createAnalyticsStore } from "../analytics/store.js";
import type { AnalyticsStore, DashboardImpactEvent, StrategyImpactTotals, AnalyticsTurnWrite } from "../analytics/types.js";
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
import { isProjectDashboardEnabled, isProjectEnabled } from "../control/runtime-gate.js";
import { normalizeProjectPath } from "../control/project-state.js";

const sessionMap = new Map<string, SessionState>();
const analyticsStoresBySession = new Map<string, AnalyticsStore>();

type DashboardRuntime = {
  handle: DashboardServerHandle | null;
  startPromise: Promise<DashboardServerHandle | null> | null;
  failed: boolean;
  lastFailureAt: number | null;
  activeSessions: Set<string>;
};

const dashboardRuntime: DashboardRuntime = {
  handle: null,
  startPromise: null,
  failed: false,
  lastFailureAt: null,
  activeSessions: new Set(),
};

const DASHBOARD_RUNTIME_DEGRADED_REASON_KEY = "dashboard-bind";
const DASHBOARD_RETRY_COOLDOWN_MS = 5_000;

export interface ExtensionRuntimeControls {
  revokeDashboardSession: (sessionId: string) => Promise<void>;
  revokeProjectDashboardSessions: (projectPath: string) => Promise<void>;
}

function getState(sessionId: string, projectPath?: string): SessionState {
  const normalizedProjectPath = typeof projectPath === "string" && projectPath.length > 0
    ? normalizeProjectPath(projectPath)
    : undefined;
  let state = sessionMap.get(sessionId);
  if (!state) {
    const persisted = loadSessionState(sessionId);
    if (persisted) {
      state = hydrateSessionState(persisted);
    } else {
      state = createSessionState(normalizedProjectPath ?? sessionId);
    }
    sessionMap.set(sessionId, state);
  }
  if (typeof normalizedProjectPath === "string" && state.projectPath !== normalizedProjectPath) {
    state.projectPath = normalizedProjectPath;
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

function formatRuntimeError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}

function setDashboardRuntimeDegradedReason(runtimeHealth: CommandRuntimeHealth | undefined, error: unknown | null): void {
  if (!runtimeHealth) {
    return;
  }

  setCommandRuntimeDegradedReason(
    runtimeHealth,
    DASHBOARD_RUNTIME_DEGRADED_REASON_KEY,
    error === null ? null : formatRuntimeError("Dashboard server failed to start", error),
  );
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

function getPersistedStrategyImpactTotals(
  analyticsStore: AnalyticsStore | null,
  sessionId: string,
): Record<string, StrategyImpactTotals> {
  if (!analyticsStore) {
    return {};
  }

  return analyticsStore.getStrategyImpactTotals(sessionId);
}

function summarizeImpactEvent(
  strategy: string,
  toolName: string | null,
  tokensSavedApprox: number,
  tokensKeptOutApprox: number,
): string {
  const subject = typeof toolName === "string" && toolName.length > 0
    ? toolName.replaceAll("_", " ")
    : "tool output";

  switch (strategy) {
    case "background_index":
      return `Indexed older ${subject} output`;
    case "error_purge":
      return `Cleared stale ${subject} error output`;
    case "dedup":
    case "deduplication":
      return `Collapsed repeated ${subject} output`;
    case "short_circuit":
      return `Skipped repeated ${subject} output`;
    case "code_filter":
      return `Trimmed ${subject} code output`;
    case "truncation":
      return `Shortened oversized ${subject} output`;
    default:
      return `${strategy} affected ${subject}`;
  }
}

function resolveImpactToolName(toolResults: ToolResultLike[]): string | null {
  const toolNames = [...new Set(
    toolResults
      .map((toolResult) => (typeof toolResult.toolName === "string" ? toolResult.toolName : "").trim())
      .filter((toolName) => toolName.length > 0),
  )];

  return toolNames.length === 1 ? toolNames[0] : null;
}

function normalizeContextPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value > 1 ? value / 100 : value;
}

function buildDashboardImpactEvents(
  sessionId: string,
  state: SessionState,
  analyticsStore: AnalyticsStore | null,
  turn: {
    timestamp: number;
    toolResults: ToolResultLike[];
  },
): DashboardImpactEvent[] {
  const persistedTotals = getPersistedStrategyImpactTotals(analyticsStore, sessionId);
  const strategies = new Set([
    ...Object.keys(state.tokensSavedByType),
    ...Object.keys(state.tokensKeptOutByType),
  ]);
  const toolName = resolveImpactToolName(turn.toolResults);
  const impactEvents: DashboardImpactEvent[] = [];

  for (const strategy of strategies) {
    const tokensSavedApprox =
      Math.max(0, (state.tokensSavedByType[strategy] ?? 0) - (persistedTotals[strategy]?.tokensSavedApprox ?? 0));
    const tokensKeptOutApprox =
      Math.max(0, (state.tokensKeptOutByType[strategy] ?? 0) - (persistedTotals[strategy]?.tokensKeptOutApprox ?? 0));

    if (tokensSavedApprox <= 0 && tokensKeptOutApprox <= 0) {
      continue;
    }

    impactEvents.push({
      timestamp: turn.timestamp,
      sessionId,
      projectPath: state.projectPath,
      source: "runtime.materialize",
      toolName,
      strategy,
      tokensSavedApprox,
      tokensKeptOutApprox,
      contextPercent: state.lastContextPercent,
      summary: summarizeImpactEvent(strategy, toolName, tokensSavedApprox, tokensKeptOutApprox),
    });
  }

  return impactEvents;
}

async function recordTurnAnalyticsSafely(
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
  runtimeHealth: CommandRuntimeHealth | undefined,
  turn: {
    turnIndex: number;
    toolCount: number;
    messageCountAfterTurn: number;
    timestamp: number;
    tokensSavedApprox: number;
    tokensKeptOutApprox: number;
    toolResults: ToolResultLike[];
  },
): Promise<void> {
  if (!config.analytics.enabled) {
    return;
  }

  try {
    const analyticsStore = getAnalyticsStore(sessionId, state, config);
    const impactEvents = buildDashboardImpactEvents(sessionId, state, analyticsStore, {
      timestamp: turn.timestamp,
      toolResults: turn.toolResults,
    });
    const turnRecord: AnalyticsTurnWrite = {
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
      impactEvents,
    };
    const snapshot = analyticsStore?.recordTurn(turnRecord);

    if (!snapshot) {
      return;
    }

    if (!isProjectDashboardEnabled(state.projectPath)) {
      await revokeDashboardSession(sessionId, runtimeHealth);
      return;
    }

    const dashboardServer = await ensureDashboardServer(sessionId, config, runtimeHealth);
    if (dashboardServer) {
      dashboardServer.publish(sessionId, snapshot);
    }
  } catch {
    evictAnalyticsStore(sessionId);
  }
}

async function ensureDashboardServer(
  sessionId: string,
  config: PCNConfig,
  runtimeHealth?: CommandRuntimeHealth,
): Promise<DashboardServerHandle | null> {
  if (!config.dashboard.enabled) {
    return null;
  }

  dashboardRuntime.activeSessions.add(sessionId);

  if (dashboardRuntime.handle) {
    setDashboardRuntimeDegradedReason(runtimeHealth, null);
    return dashboardRuntime.handle;
  }

  if (dashboardRuntime.failed) {
    const lastFailureAt = dashboardRuntime.lastFailureAt ?? 0;
    if (Date.now() - lastFailureAt < DASHBOARD_RETRY_COOLDOWN_MS) {
      return null;
    }
    dashboardRuntime.failed = false;
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
        dashboardRuntime.failed = false;
        dashboardRuntime.lastFailureAt = null;
        setDashboardRuntimeDegradedReason(runtimeHealth, null);
        return handle;
      } catch (error) {
        dashboardRuntime.failed = true;
        dashboardRuntime.lastFailureAt = Date.now();
        setDashboardRuntimeDegradedReason(runtimeHealth, error);
        await handle.close().catch(() => {});
        return null;
      } finally {
        dashboardRuntime.startPromise = null;
      }
    })();
  }

  return dashboardRuntime.startPromise;
}

async function revokeDashboardSession(sessionId: string, runtimeHealth?: CommandRuntimeHealth): Promise<void> {
  if (dashboardRuntime.handle) {
    dashboardRuntime.handle.clearSession(sessionId);
  }

  dashboardRuntime.activeSessions.delete(sessionId);
  if (dashboardRuntime.activeSessions.size === 0 && dashboardRuntime.handle) {
    const handle = dashboardRuntime.handle;
    dashboardRuntime.handle = null;
    dashboardRuntime.failed = false;
    dashboardRuntime.lastFailureAt = null;
    setDashboardRuntimeDegradedReason(runtimeHealth, null);
    await handle.close().catch(() => {});
  } else if (dashboardRuntime.activeSessions.size === 0) {
    dashboardRuntime.failed = false;
    dashboardRuntime.lastFailureAt = null;
    setDashboardRuntimeDegradedReason(runtimeHealth, null);
  }
}

async function revokeProjectDashboardSessions(
  projectPath: string,
  runtimeHealth?: CommandRuntimeHealth,
): Promise<void> {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  const sessionIds = [...dashboardRuntime.activeSessions];
  for (const sessionId of sessionIds) {
    const state = sessionMap.get(sessionId);
    if (state?.projectPath !== normalizedProjectPath) {
      continue;
    }

    await revokeDashboardSession(sessionId, runtimeHealth);
  }
}

async function releaseSessionResources(sessionId: string, runtimeHealth?: CommandRuntimeHealth): Promise<void> {
  evictAnalyticsStore(sessionId);
  await revokeDashboardSession(sessionId, runtimeHealth);
}

function isDataPlaneEnabled(projectPath?: string): boolean {
  return isProjectEnabled(projectPath);
}

export function createExtensionRuntime(
  pi: ExtensionAPI,
  config: PCNConfig,
  runtimeHealth?: CommandRuntimeHealth,
): ExtensionRuntimeControls {
  pi.on("tool_call", (event, ctx) => {
    if (!isDataPlaneEnabled(ctx.cwd)) {
      return;
    }

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
    if (!isDataPlaneEnabled(ctx.cwd)) {
      return undefined;
    }

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
    if (!isDataPlaneEnabled(ctx.cwd)) {
      return { messages: event.messages };
    }

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
    if (!isDataPlaneEnabled(ctx.cwd)) {
      const sessionId = resolveSessionId(ctx);
      await revokeDashboardSession(sessionId, runtimeHealth);
      return;
    }

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
      state.lastContextPercent = normalizeContextPercent(usage.percent);
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
        await recordTurnAnalyticsSafely(sessionId, state, config, runtimeHealth, {
          turnIndex: latestTurn.turnIndex,
          toolCount: latestTurn.toolCount,
          messageCountAfterTurn: latestTurn.messageCountAfterTurn,
          timestamp: latestTurn.timestamp,
          tokensSavedApprox: latestTurn.tokensSavedDelta,
          tokensKeptOutApprox: latestTurn.tokensKeptOutDelta,
          toolResults: event.toolResults,
        });
      }
    } finally {
      persistState(sessionId);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!isDataPlaneEnabled(ctx.cwd)) {
      return undefined;
    }

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
    if (!isDataPlaneEnabled(ctx.cwd)) {
      return undefined;
    }

    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    return buildNativeCompactionResult(sessionId, state, config, ctx, event.preparation);
  });

  pi.on("agent_end", (event, ctx) => {
    if (!isDataPlaneEnabled(ctx.cwd)) {
      return;
    }

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
    await releaseSessionResources(sessionId, runtimeHealth);
  });

  return {
    revokeDashboardSession: async (sessionId: string) => revokeDashboardSession(sessionId, runtimeHealth),
    revokeProjectDashboardSessions: async (projectPath: string) => {
      await revokeProjectDashboardSessions(projectPath, runtimeHealth);
    },
  };
}
