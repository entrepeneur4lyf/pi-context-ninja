import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSessionState, getOrCreateToolRecord } from "./state.js";
import { loadConfig, defaultConfig } from "./config.js";
import { materializeContext } from "./strategies/materialize.js";
import { resolveSessionId, saveSessionState, loadSessionState } from "./persistence/state-store.js";

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

export default function (pi: ExtensionAPI) {
  const cfgPath = process.env.PCN_CONFIG_PATH ?? `${process.env.HOME}/.pi-ninja/config.yaml`;
  const cfg = loadConfig(cfgPath);

  pi.on("tool_call", (ctx, event) => {
    const sessionId = resolveSessionId(ctx);
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

  pi.on("tool_result", (ctx, event) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId);
    if (event.isError) {
      const rec = state.toolCalls.get(event.toolCallId);
      if (rec) rec.isError = true;
    }
  });

  pi.on("context", async (ctx, event) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId);
    return materializeContext(event.messages, { state, config: cfg });
  });

  pi.on("before_agent_start", (ctx) => {
    if (cfg.systemHint.enabled) {
      return { systemHint: cfg.systemHint.text };
    }
    return {};
  });

  pi.on("agent_end", (ctx) => {
    const sessionId = resolveSessionId(ctx);
    const state = getState(sessionId);
    state.currentTurn++;
    saveSessionState(sessionId, state);
  });

  pi.on("session_shutdown", () => {
    sessionMap.clear();
  });
}
