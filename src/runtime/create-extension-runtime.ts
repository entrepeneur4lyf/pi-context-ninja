import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import path from "node:path";
import type { CommandRuntimeHealth, OpenDashboardResult } from "../control/commands.js";
import { setCommandRuntimeDegradedReason } from "../control/commands.js";
import { createSessionState, getOrCreateToolRecord, hydrateSessionState, serializeSessionState } from "../state.js";
import { appendSessionState, readSessionStateFromBranch } from "../persistence/session-entries.js";
import type { PCNConfig } from "../config.js";
import { materializeContext } from "../strategies/materialize.js";
import type { SessionState } from "../types.js";
import { createAnalyticsStore } from "../analytics/store.js";
import type {
  AnalyticsStore,
  AnalyticsTurnWrite,
  DashboardImpactEvent,
  DashboardSnapshot,
  StrategyImpactTotals,
} from "../analytics/types.js";
import { buildLiveSnapshot } from "../dashboard/live-snapshot.js";
import type { OverlayModel } from "../dashboard/render.js";
import { createDashboardSurfaces, type DashboardSurfaces, type HostUiContext } from "../dashboard/surfaces.js";
import {
  estimateToolContentTokens,
  extractExclusiveToolText,
  isToolResultMessage,
  replaceExclusiveToolText,
} from "../messages.js";
import { applySafeToolTextShaping } from "../strategies/safe-shaping.js";
import { hasHashlineHeader, isProtectedTool, isReadResult } from "../strategies/protection.js";
import { isProjectDashboardEnabled, isProjectEnabled } from "../control/runtime-gate.js";
import { normalizeProjectPath } from "../control/project-state.js";
import { getProjectDir } from "../paths.js";

/**
 * Process-wide runtime state. Production uses one store per process, so
 * the status-line item and the overlay follow the host's active session;
 * tests inject a fresh store.
 */
export interface RuntimeStore {
  sessionMap: Map<string, SessionState>;
  analyticsStoresBySession: Map<string, AnalyticsStore>;
  dashboardSurfaces: DashboardSurfaces;
  /** Serialized form of the last entry appended per session, to skip identical appends. */
  lastPersisted: Map<string, string>;
}

/** Turn snapshots kept in session state; older ones live in analytics. */
const MAX_TURN_HISTORY = 100;

export function createRuntimeStore(): RuntimeStore {
  return {
    sessionMap: new Map(),
    analyticsStoresBySession: new Map(),
    dashboardSurfaces: createDashboardSurfaces(),
    lastPersisted: new Map(),
  };
}

const defaultRuntimeStore = createRuntimeStore();

type CreateAnalyticsStore = typeof createAnalyticsStore;

/** Injection points for tests; production callers omit them. */
export interface ExtensionRuntimeOptions {
  store?: RuntimeStore;
  createAnalyticsStore?: CreateAnalyticsStore;
}

const DASHBOARD_SHORTCUT_DEGRADED_REASON_KEY = "dashboard-shortcut";
const DASHBOARD_SURFACE_DEGRADED_REASON_KEY = "dashboard-surface";
const ANALYTICS_DISABLED_REASON = "analytics disabled in config";

export interface ExtensionRuntimeControls {
  revokeDashboardSession: (sessionId: string) => Promise<void>;
  revokeProjectDashboardSessions: (projectPath: string) => Promise<void>;
  /** Open the overlay for the session in `ctx`; resolves when it closes (DASH-030). */
  openDashboard: (ctx: HostSessionContext & HostUiContext) => Promise<OpenDashboardResult>;
}

/** The slice of the host context PCN reads for session identity and state. */
interface HostSessionContext {
  cwd?: string;
  sessionManager?: {
    getSessionId?: () => string | null | undefined;
    getBranch?: () => readonly unknown[];
  };
}

/** The host session id, or null when the host reports none (HOST-045). */
function resolveSessionId(ctx: HostSessionContext): string | null {
  const id = ctx.sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length > 0 ? id : null;
}

function readBranch(ctx: HostSessionContext): readonly unknown[] {
  const manager = ctx.sessionManager;
  return typeof manager?.getBranch === "function" ? manager.getBranch() : [];
}

function getState(store: RuntimeStore, sessionId: string, ctx: HostSessionContext): SessionState {
  const projectPath = ctx.cwd;
  const normalizedProjectPath = typeof projectPath === "string" && projectPath.length > 0
    ? normalizeProjectPath(projectPath)
    : undefined;
  let state = store.sessionMap.get(sessionId);
  if (!state) {
    const persisted = readSessionStateFromBranch(readBranch(ctx));
    state = persisted ? hydrateSessionState(persisted) : createSessionState(normalizedProjectPath ?? sessionId);
    store.sessionMap.set(sessionId, state);
  }
  if (typeof normalizedProjectPath === "string" && state.projectPath !== normalizedProjectPath) {
    state.projectPath = normalizedProjectPath;
  }
  return state;
}

function persistState(store: RuntimeStore, pi: ExtensionAPI, sessionId: string): void {
  const state = store.sessionMap.get(sessionId);
  if (!state) {
    return;
  }
  const serialized = JSON.stringify(serializeSessionState(state));
  if (store.lastPersisted.get(sessionId) === serialized) {
    return;
  }
  store.lastPersisted.set(sessionId, serialized);
  appendSessionState(pi, state);
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

/** The host carries the system prompt as an array of sections (HOST-062). */
function appendSystemHint(systemPrompt: readonly string[] | string | undefined, hintText: string): string[] {
  if (Array.isArray(systemPrompt)) {
    return [...systemPrompt, hintText];
  }
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    return [systemPrompt, hintText];
  }
  return [hintText];
}

function formatRuntimeError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
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
  if (isReadResult(toolResult.toolName) || isProtectedTool(toolResult.toolName, config)) {
    return undefined;
  }

  const originalText = extractExclusiveToolText(toolResult.content);
  if (originalText === null || hasHashlineHeader(originalText)) {
    return undefined;
  }

  const shapedText = applySafeToolTextShaping(originalText, config);
  if (shapedText === null || shapedText === originalText) {
    return undefined;
  }

  return replaceExclusiveToolText(toolResult.content, shapedText);
}

function getAnalyticsStore(
  store: RuntimeStore,
  openStore: CreateAnalyticsStore,
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
): AnalyticsStore | null {
  if (!config.analytics.enabled) {
    return null;
  }

  let analytics = store.analyticsStoresBySession.get(sessionId);
  if (!analytics) {
    const dbPath = config.analytics.dbPath || path.join(getProjectDir(state.projectPath), "analytics.sqlite");
    analytics = openStore({
      dbPath,
      retentionDays: config.analytics.retentionDays,
    });
    store.analyticsStoresBySession.set(sessionId, analytics);
  }

  return analytics;
}

function evictAnalyticsStore(store: RuntimeStore, sessionId: string): void {
  const analytics = store.analyticsStoresBySession.get(sessionId);
  if (!analytics) {
    return;
  }

  store.analyticsStoresBySession.delete(sessionId);

  try {
    analytics.close();
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

function summarizeImpactEvent(strategy: string, toolName: string | null): string {
  const subject = typeof toolName === "string" && toolName.length > 0
    ? toolName.replaceAll("_", " ")
    : "tool output";

  switch (strategy) {
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
  const strategies = Object.keys(state.tokensKeptOutByType);
  const toolName = resolveImpactToolName(turn.toolResults);
  const impactEvents: DashboardImpactEvent[] = [];

  for (const strategy of strategies) {
    const tokensKeptOutApprox =
      Math.max(0, (state.tokensKeptOutByType[strategy] ?? 0) - (persistedTotals[strategy]?.tokensKeptOutApprox ?? 0));

    if (tokensKeptOutApprox <= 0) {
      continue;
    }

    impactEvents.push({
      timestamp: turn.timestamp,
      sessionId,
      projectPath: state.projectPath,
      source: "runtime.materialize",
      toolName,
      strategy,
      tokensSavedApprox: tokensKeptOutApprox,
      tokensKeptOutApprox,
      contextPercent: state.lastContextPercent,
      summary: summarizeImpactEvent(strategy, toolName),
    });
  }

  return impactEvents;
}

interface TurnAnalyticsResult {
  snapshot: DashboardSnapshot | null;
  /** Why the snapshot is missing; null when analytics recorded the turn. */
  degradedReason: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordTurnAnalyticsSafely(
  store: RuntimeStore,
  openStore: CreateAnalyticsStore,
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
    toolResults: ToolResultLike[];
  },
): TurnAnalyticsResult {
  if (!config.analytics.enabled) {
    return { snapshot: null, degradedReason: ANALYTICS_DISABLED_REASON };
  }

  try {
    const analyticsStore = getAnalyticsStore(store, openStore, sessionId, state, config);
    if (!analyticsStore) {
      return { snapshot: null, degradedReason: ANALYTICS_DISABLED_REASON };
    }
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
    return { snapshot: analyticsStore.recordTurn(turnRecord), degradedReason: null };
  } catch (error) {
    // A broken store is evicted and reopened on a later turn (DASH-003).
    evictAnalyticsStore(store, sessionId);
    return { snapshot: null, degradedReason: errorMessage(error) };
  }
}

/**
 * The overlay's data: the store's snapshot, or live session counters with
 * the reason the store is unavailable (04-analytics-and-dashboard.md UX
 * flow, error path).
 */
function buildOverlayModel(
  store: RuntimeStore,
  openStore: CreateAnalyticsStore,
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
): OverlayModel {
  if (!config.analytics.enabled) {
    return { snapshot: buildLiveSnapshot(sessionId, state), degradedReason: ANALYTICS_DISABLED_REASON };
  }

  try {
    const analyticsStore = getAnalyticsStore(store, openStore, sessionId, state, config);
    if (analyticsStore) {
      return { snapshot: analyticsStore.getDashboardSnapshot(sessionId, state.projectPath), degradedReason: null };
    }
    return { snapshot: buildLiveSnapshot(sessionId, state), degradedReason: ANALYTICS_DISABLED_REASON };
  } catch (error) {
    evictAnalyticsStore(store, sessionId);
    return { snapshot: buildLiveSnapshot(sessionId, state), degradedReason: errorMessage(error) };
  }
}

function isDashboardActive(config: PCNConfig, projectPath: string): boolean {
  return config.dashboard.enabled && isProjectDashboardEnabled(projectPath);
}

/** Refresh or drop both surfaces after a turn (DASH-021, DASH-022, DASH-032). */
function refreshDashboardSurfaces(
  store: RuntimeStore,
  ctx: HostUiContext,
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
  analytics: TurnAnalyticsResult,
  runtimeHealth: CommandRuntimeHealth | undefined,
): void {
  try {
    if (!isDashboardActive(config, state.projectPath)) {
      store.dashboardSurfaces.clear(sessionId);
      return;
    }
    const model: OverlayModel = analytics.snapshot
      ? { snapshot: analytics.snapshot, degradedReason: null }
      : {
          snapshot: buildLiveSnapshot(sessionId, state),
          degradedReason: analytics.degradedReason ?? "analytics unavailable",
        };
    store.dashboardSurfaces.update(ctx, sessionId, model);
    if (runtimeHealth) {
      setCommandRuntimeDegradedReason(runtimeHealth, DASHBOARD_SURFACE_DEGRADED_REASON_KEY, null);
    }
  } catch (error) {
    // A UI failure records a degraded reason and never touches session state.
    if (runtimeHealth) {
      setCommandRuntimeDegradedReason(
        runtimeHealth,
        DASHBOARD_SURFACE_DEGRADED_REASON_KEY,
        formatRuntimeError("Dashboard surface update failed", error),
      );
    }
  }
}

function revokeDashboardSession(store: RuntimeStore, sessionId: string): void {
  store.dashboardSurfaces.clear(sessionId);
}

function revokeProjectDashboardSessions(store: RuntimeStore, projectPath: string): void {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  for (const sessionId of store.dashboardSurfaces.activeSessions()) {
    const state = store.sessionMap.get(sessionId);
    if (state?.projectPath === normalizedProjectPath) {
      store.dashboardSurfaces.clear(sessionId);
    }
  }
}

/** The analytics handle is closed and the surfaces released (HOST-080). */
function releaseSessionResources(store: RuntimeStore, sessionId: string): void {
  evictAnalyticsStore(store, sessionId);
  revokeDashboardSession(store, sessionId);
}

function isDataPlaneEnabled(projectPath?: string): boolean {
  return isProjectEnabled(projectPath);
}

export function createExtensionRuntime(
  pi: ExtensionAPI,
  config: PCNConfig,
  runtimeHealth?: CommandRuntimeHealth,
  options?: ExtensionRuntimeOptions,
): ExtensionRuntimeControls {
  const store = options?.store ?? defaultRuntimeStore;
  const openStore = options?.createAnalyticsStore ?? createAnalyticsStore;

  const openDashboard = async (ctx: HostSessionContext & HostUiContext): Promise<OpenDashboardResult> => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null) {
      return { opened: false, reason: "the host reported no session id" };
    }
    if (!isDataPlaneEnabled(ctx.cwd)) {
      return { opened: false, reason: "PCN is disabled for this project" };
    }
    const state = getState(store, sessionId, ctx);
    if (!isProjectDashboardEnabled(state.projectPath)) {
      return { opened: false, reason: "the dashboard is disabled for this project" };
    }
    if (!config.dashboard.enabled) {
      return { opened: false, reason: "dashboard.enabled is false in the config" };
    }
    const model = buildOverlayModel(store, openStore, sessionId, state, config);
    const opened = await store.dashboardSurfaces.open(ctx, sessionId, model);
    return opened ? { opened: true } : { opened: false, reason: "the host has no interactive UI" };
  };

  // The overlay shortcut (DASH-036). A host without shortcuts, or a key id
  // it rejects, leaves /pcn dashboard as the way in.
  if (config.dashboard.enabled && typeof pi.registerShortcut === "function") {
    try {
      pi.registerShortcut(config.dashboard.shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
        description: "Open the PCN dashboard",
        handler: async (ctx) => {
          try {
            await openDashboard(ctx);
          } catch (error) {
            if (runtimeHealth) {
              setCommandRuntimeDegradedReason(
                runtimeHealth,
                DASHBOARD_SHORTCUT_DEGRADED_REASON_KEY,
                formatRuntimeError("Dashboard shortcut failed", error),
              );
            }
          }
        },
      });
    } catch (error) {
      if (runtimeHealth) {
        setCommandRuntimeDegradedReason(
          runtimeHealth,
          DASHBOARD_SHORTCUT_DEGRADED_REASON_KEY,
          formatRuntimeError("Dashboard shortcut registration failed", error),
        );
      }
    }
  }

  // A hook that throws would block the host's tool loop. Every handler is
  // wrapped so an internal error records a degraded reason and returns the
  // event unchanged (00-overview.md PCN-002).
  type AnyHandler = (event: unknown, ctx: unknown) => unknown;
  const fallbackFor = (name: string, event: unknown): unknown =>
    name === "context" ? { messages: (event as { messages: unknown }).messages } : undefined;
  const guardHook = (name: string, handler: AnyHandler): AnyHandler => (event, ctx) => {
    const record = (error: unknown) => {
      if (runtimeHealth) {
        setCommandRuntimeDegradedReason(runtimeHealth, `hook:${name}`, formatRuntimeError(`hook:${name} failed`, error));
      }
    };
    try {
      const result = handler(event, ctx);
      return result instanceof Promise
        ? result.catch((error: unknown) => {
            record(error);
            return fallbackFor(name, event);
          })
        : result;
    } catch (error) {
      record(error);
      return fallbackFor(name, event);
    }
  };
  const guardedOn = ((name: string, handler: AnyHandler) => {
    pi.on(name as never, guardHook(name, handler) as never);
  }) as ExtensionAPI["on"];

  guardedOn("tool_call", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null || !isDataPlaneEnabled(ctx.cwd)) {
      return;
    }

    const state = getState(store, sessionId, ctx);
    getOrCreateToolRecord(state, event.toolCallId, event.toolName, event.input, false, state.currentTurn, {
      awaitingAuthoritativeTurn: !state.hasObservedTurnBoundary,
    });
  });

  guardedOn("tool_result", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null || !isDataPlaneEnabled(ctx.cwd)) {
      return undefined;
    }

    const state = getState(store, sessionId, ctx);
    syncToolRecord(state, event, state.currentTurn, {
      awaitingAuthoritativeTurn: !state.hasObservedTurnBoundary,
    });
    const shaped = shapeImmediateToolResult(event, config);
    return shaped ? { content: shaped } : undefined;
  });

  guardedOn("context", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null || !isDataPlaneEnabled(ctx.cwd)) {
      return { messages: event.messages };
    }

    const state = getState(store, sessionId, ctx);
    rebuildToolRecordsFromMessages(state, event.messages);
    return materializeContext(event.messages, { state, config });
  });

  guardedOn("turn_end", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null) {
      return;
    }
    if (!isDataPlaneEnabled(ctx.cwd)) {
      revokeDashboardSession(store, sessionId);
      return;
    }

    const state = getState(store, sessionId, ctx);

    if (typeof event.turnIndex === "number" && Number.isFinite(event.turnIndex)) {
      for (const toolResult of event.toolResults) {
        syncToolRecord(state, toolResult, event.turnIndex, { overwriteTurnIndex: true });
      }
      backfillObservedTurnIndices(state, event.turnIndex, event.toolResults);
    }

    const usage = ctx.getContextUsage();
    if (usage) {
      state.lastContextTokens = Number.isFinite(usage.tokens) ? usage.tokens : null;
      state.lastContextPercent = Number.isFinite(usage.percent) ? usage.percent : null;
      state.lastContextWindow = Number.isFinite(usage.contextWindow) ? usage.contextWindow : null;
    }

    state.turnHistory.push({
      turnIndex: event.turnIndex,
      toolCount: event.toolResults.length,
      messageCountAfterTurn: ctx.sessionManager.getEntries().length,
      tokensKeptOutDelta: Math.max(0, state.tokensKeptOutTotal - state.tokensKeptOutAtLastTurn),
      timestamp: Date.now(),
    });
    state.tokensKeptOutAtLastTurn = state.tokensKeptOutTotal;
    if (state.turnHistory.length > MAX_TURN_HISTORY) {
      state.turnHistory.splice(0, state.turnHistory.length - MAX_TURN_HISTORY);
    }

    state.currentTurn = typeof event.turnIndex === "number" ? event.turnIndex + 1 : state.currentTurn + 1;
    state.hasObservedTurnBoundary = true;
    const latestTurn = state.turnHistory.at(-1);
    try {
      const analytics: TurnAnalyticsResult = latestTurn
        ? recordTurnAnalyticsSafely(store, openStore, sessionId, state, config, {
            turnIndex: latestTurn.turnIndex,
            toolCount: latestTurn.toolCount,
            messageCountAfterTurn: latestTurn.messageCountAfterTurn,
            timestamp: latestTurn.timestamp,
            tokensSavedApprox: latestTurn.tokensKeptOutDelta,
            tokensKeptOutApprox: latestTurn.tokensKeptOutDelta,
            toolResults: event.toolResults,
          })
        : { snapshot: null, degradedReason: null };
      refreshDashboardSurfaces(store, ctx, sessionId, state, config, analytics, runtimeHealth);
    } finally {
      persistState(store, pi, sessionId);
    }
  });

  guardedOn("before_agent_start", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null || !isDataPlaneEnabled(ctx.cwd) || !config.systemHint.enabled) {
      return undefined;
    }

    const state = getState(store, sessionId, ctx);
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
      persistState(store, pi, sessionId);
      return { systemPrompt: appendSystemHint(event.systemPrompt, hintText) };
    }

    if (config.systemHint.frequency === "on_change" && hintState.lastAppliedText === hintText) {
      return undefined;
    }

    hintState.lastAppliedText = hintText;
    persistState(store, pi, sessionId);
    return { systemPrompt: appendSystemHint(event.systemPrompt, hintText) };
  });

  guardedOn("agent_end", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null || !isDataPlaneEnabled(ctx.cwd) || event.willContinue === true) {
      return;
    }

    const state = getState(store, sessionId, ctx);
    rebuildToolRecordsFromMessages(state, event.messages);
    persistState(store, pi, sessionId);
  });

  // The branch is the source of truth after a start, branch, or tree move (HOST-041).
  const rebuildFromBranch = (_event: unknown, ctx: HostSessionContext) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null) {
      return;
    }
    store.sessionMap.delete(sessionId);
    if (isDataPlaneEnabled(ctx.cwd)) {
      getState(store, sessionId, ctx);
    }
  };
  guardedOn("session_start", rebuildFromBranch);
  guardedOn("session_branch", rebuildFromBranch);
  guardedOn("session_tree", rebuildFromBranch);

  guardedOn("session_shutdown", async (_event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    if (sessionId === null) {
      return;
    }
    if (store.sessionMap.has(sessionId)) {
      persistState(store, pi, sessionId);
      store.sessionMap.delete(sessionId);
      store.lastPersisted.delete(sessionId);
    }
    releaseSessionResources(store, sessionId);
  });

  return {
    revokeDashboardSession: async (sessionId: string) => revokeDashboardSession(store, sessionId),
    revokeProjectDashboardSessions: async (projectPath: string) => revokeProjectDashboardSessions(store, projectPath),
    openDashboard,
  };
}
