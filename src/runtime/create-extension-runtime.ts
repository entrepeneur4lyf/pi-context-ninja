import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
  const store = analyticsStoresBySession.get(sessionId);
  if (store) {
    store.close();
    analyticsStoresBySession.delete(sessionId);
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
    );
  });

  pi.on("tool_result", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    if (event.isError) {
      const rec = state.toolCalls.get(event.toolCallId);
      if (rec) {
        rec.isError = true;
      }
    }
  });

  pi.on("context", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
    return materializeContext(event.messages, { state, config });
  });

  pi.on("turn_end", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);

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
    const latestTurn = state.turnHistory.at(-1);
    if (latestTurn) {
      const analyticsStore = getAnalyticsStore(sessionId, state, config);
      const snapshot = analyticsStore?.recordTurn({
        sessionId,
        projectPath: state.projectPath,
        turnIndex: latestTurn.turnIndex,
        toolCount: latestTurn.toolCount,
        messageCountAfterTurn: latestTurn.messageCountAfterTurn,
        timestamp: latestTurn.timestamp,
        contextTokens: state.lastContextTokens,
        contextPercent: state.lastContextPercent,
        contextWindow: state.lastContextWindow,
        tokensSavedApprox: latestTurn.tokensSavedDelta,
        tokensKeptOutApprox: latestTurn.tokensKeptOutDelta,
      });

      if (snapshot) {
        const dashboardServer = await ensureDashboardServer(sessionId, config);
        if (dashboardServer) {
          dashboardServer.publish(snapshot);
        }
      }
    }

    persistState(sessionId);
  });

  pi.on("before_agent_start", (event) => {
    if (!config.systemHint.enabled) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${config.systemHint.text}`,
    };
  });

  pi.on("before_provider_request", (_event, _ctx) => undefined);

  pi.on("session_before_compact", (_event, _ctx) => undefined);

  pi.on("agent_end", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId, ctx.cwd);
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
