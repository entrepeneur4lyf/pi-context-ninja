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
type RuntimeServices = {
  analyticsStore: AnalyticsStore | null;
  dashboardServer: DashboardServerHandle | null;
};
const servicesBySession = new Map<string, RuntimeServices>();

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

function getRuntimeServices(
  sessionId: string,
  state: SessionState,
  config: PCNConfig,
): RuntimeServices | null {
  if (!config.analytics.enabled && !config.dashboard.enabled) {
    return null;
  }

  let services = servicesBySession.get(sessionId);
  if (!services) {
    services = {
      analyticsStore: null,
      dashboardServer: null,
    };

    const dbPath = config.analytics.dbPath || path.join(state.projectPath, ".pi-ninja", "analytics.sqlite");
    services.analyticsStore = createAnalyticsStore({
      dbPath,
      retentionDays: config.analytics.retentionDays,
    });

    if (config.dashboard.enabled) {
      services.dashboardServer = startDashboardServer({
        port: config.dashboard.port,
        host: config.dashboard.bindHost,
      });
    }

    servicesBySession.set(sessionId, services);
  }

  return services;
}

async function closeRuntimeServices(sessionId: string): Promise<void> {
  const services = servicesBySession.get(sessionId);
  if (!services) {
    return;
  }

  servicesBySession.delete(sessionId);

  if (services.dashboardServer) {
    await services.dashboardServer.close();
  }
  if (services.analyticsStore) {
    services.analyticsStore.close();
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
    const services = getRuntimeServices(sessionId, state, config);
    const latestTurn = state.turnHistory.at(-1);
    if (services && latestTurn) {
      if (services.dashboardServer) {
        await services.dashboardServer.ready;
      }

      const snapshot = services.analyticsStore?.recordTurn({
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

      if (snapshot && services.dashboardServer) {
        services.dashboardServer.publish(snapshot);
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
    for (const [storedSessionId, state] of sessionMap) {
      saveSessionState(storedSessionId, state);
    }
    sessionMap.clear();
    const serviceSessionIds = [...servicesBySession.keys()];
    for (const serviceSessionId of serviceSessionIds) {
      await closeRuntimeServices(serviceSessionId);
    }
  });
}
