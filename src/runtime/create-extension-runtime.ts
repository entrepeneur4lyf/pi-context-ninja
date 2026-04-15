import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSessionState, getOrCreateToolRecord } from "../state.js";
import { loadSessionState, resolveSessionId, saveSessionState } from "../persistence/state-store.js";
import type { PCNConfig } from "../config.js";
import { materializeContext } from "../strategies/materialize.js";

const sessionMap = new Map<string, ReturnType<typeof createSessionState>>();

function getState(sessionId: string): ReturnType<typeof createSessionState> {
  let state = sessionMap.get(sessionId);
  if (!state) {
    const persisted = loadSessionState(sessionId);
    if (persisted) {
      state = createSessionState(persisted.projectPath);
      state.omitRanges = persisted.omitRanges;
      state.currentTurn = persisted.currentTurn;
      state.tokensKeptOutTotal = persisted.tokensKeptOutTotal;
      state.tokensSaved = persisted.tokensSaved;
      state.tokensKeptOutByType = persisted.tokensKeptOutByType;
      state.tokensSavedByType = persisted.tokensSavedByType;
      state.turnHistory = persisted.turnHistory;
    } else {
      state = createSessionState(sessionId);
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

export function createExtensionRuntime(pi: ExtensionAPI, config: PCNConfig): void {
  pi.on("tool_call", (event, ctx) => {
    const sessionId = resolveSessionId(ctx as any);
    const state = getState(sessionId);
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
    const sessionId = resolveSessionId(ctx as any);
    const state = getState(sessionId);
    if (event.isError) {
      const rec = state.toolCalls.get(event.toolCallId);
      if (rec) {
        rec.isError = true;
      }
    }
  });

  pi.on("context", async (event, ctx) => {
    const sessionId = resolveSessionId(ctx as any);
    const state = getState(sessionId);
    return materializeContext(event.messages, { state, config });
  });

  pi.on("turn_end", (event, ctx) => {
    const sessionId = resolveSessionId(ctx as any);
    const state = getState(sessionId);
    state.currentTurn = typeof event.turnIndex === "number" ? event.turnIndex + 1 : state.currentTurn + 1;
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

  pi.on("agent_end", (_event, ctx) => {
    const sessionId = resolveSessionId(ctx as any);
    persistState(sessionId);
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    for (const [sessionId, state] of sessionMap) {
      saveSessionState(sessionId, state);
    }
    sessionMap.clear();
  });
}
