import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerExtension from "../src/index.js";
import { defaultConfig } from "../src/config.js";
import { createExtensionRuntime } from "../src/runtime/create-extension-runtime.js";
import { appendIndexEntry, getIndexPath, readIndexEntries } from "../src/persistence/index-store.js";
import { buildIndexEntry, formatTOC } from "../src/compression/index-entry.js";

let stateDir = "";
let indexDir = "";

async function loadStateStore() {
  vi.resetModules();
  return import("../src/persistence/state-store");
}

function writeLegacyState(sessionId: string, state: Record<string, unknown>): void {
  const statePath = path.join(stateDir, `${encodeURIComponent(sessionId)}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
}

function createPiMock() {
  const calls = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      calls.set(name, handler);
    }),
  } as unknown as ExtensionAPI;

  return { calls, pi };
}

function createContext(sessionId: string, cwd = "/tmp/project") {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    },
    getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
  } as any;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-runtime-hooks-"));
  indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-index-"));
  process.env.PCN_STATE_DIR = stateDir;
  process.env.PCN_INDEX_DIR = indexDir;
  process.env.PCN_CONFIG_PATH = path.join(stateDir, "missing-config.yaml");
});

afterEach(() => {
  delete process.env.PCN_STATE_DIR;
  delete process.env.PCN_INDEX_DIR;
  delete process.env.PCN_CONFIG_PATH;
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  if (indexDir) {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
  stateDir = "";
  indexDir = "";
});

describe("runtime hook registration", () => {
  it("registers the Pi 0.67.2 extension hooks", () => {
    const calls: Array<[string, (...args: unknown[]) => unknown]> = [];
    const pi = {
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        calls.push([name, handler]);
      }),
    } as unknown as ExtensionAPI;

    registerExtension(pi);

    expect(calls.map(([name]) => name)).toEqual([
      "tool_call",
      "tool_result",
      "context",
      "turn_end",
      "before_agent_start",
      "before_provider_request",
      "session_before_compact",
      "agent_end",
      "session_shutdown",
    ]);
    expect(calls).toHaveLength(9);
    expect(calls.every(([, handler]) => typeof handler === "function")).toBe(true);
  });

  it("applies the system hint only once per session when frequency is once_per_session", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-hint");
    const handler = calls.get("before_agent_start");

    const first = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      ctx,
    );
    const second = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      ctx,
    );

    expect(first).toEqual({ systemPrompt: "base\n\nKeep the context small." });
    expect(second).toBeUndefined();
  });

  it("re-applies the system hint when frequency is on_change and the text changes", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "on_change";
    config.systemHint.text = "Keep the context small.";

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-hint-change");
    const handler = calls.get("before_agent_start");

    const first = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      ctx,
    );
    config.systemHint.text = "Keep the context small and explicit.";
    const second = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      ctx,
    );

    expect(first).toEqual({ systemPrompt: "base\n\nKeep the context small." });
    expect(second).toEqual({ systemPrompt: "base\n\nKeep the context small and explicit." });
  });

  it("returns the provider payload unchanged", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const payload = { provider: "openai", body: { model: "gpt-5.4" } };
    const ctx = createContext("session-provider");
    const result = await calls.get("before_provider_request")?.(
      {
        type: "before_provider_request",
        payload,
      },
      ctx,
    );

    expect(result).toBe(payload);
    expect(payload).toEqual({ provider: "openai", body: { model: "gpt-5.4" } });
  });

  it("indexes only tool results for background pruning", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.enabled = false;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-background-index");

    calls.get("tool_call")?.(
      {
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );

    await calls.get("turn_end")?.(
      {
        turnIndex: 3,
        message: { role: "assistant", content: "done" },
        toolResults: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "long file body" }],
            toolName: "read",
            isError: false,
            toolCallId: "read-1",
          },
        ],
      },
      ctx,
    );

    await calls.get("agent_end")?.(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "show me the file" }] },
          { role: "assistant", content: "running read" },
          {
            role: "toolResult",
            content: [{ type: "text", text: "long file body" }],
            toolName: "read",
            isError: false,
            toolCallId: "read-1",
          },
        ],
      },
      ctx,
    );

    const contextResult = (await calls.get("context")?.(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "show me the file" }] },
          { role: "assistant", content: "running read" },
          {
            role: "toolResult",
            content: [{ type: "text", text: "long file body" }],
            toolName: "read",
            isError: false,
            toolCallId: "read-1",
          },
        ],
      },
      ctx,
    )) as { messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };

    expect(contextResult.messages?.[0]?.role).toBe("user");
    expect(contextResult.messages?.[1]?.role).toBe("assistant");
    expect(contextResult.messages?.[2]?.role).toBe("toolResult");
    expect(contextResult.messages?.[2]?.content[0]?.text).toContain("[pruned:");

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-background-index");
    expect(persisted?.pruneTargets).toHaveLength(1);
    expect((persisted as any)?.omitRanges).toBeUndefined();
  });

  it("skips error tool results when generating prune targets", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-error-result");

    calls.get("tool_call")?.(
      {
        toolCallId: "read-error",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );

    await calls.get("turn_end")?.(
      {
        turnIndex: 6,
        message: { role: "assistant", content: "done" },
        toolResults: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "read-error",
          },
        ],
      },
      ctx,
    );

    await calls.get("agent_end")?.(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "show me the file" }] },
          { role: "assistant", content: "running read" },
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "read-error",
          },
        ],
      },
      ctx,
    );

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-error-result");
    expect(persisted?.pruneTargets).toEqual([]);
    expect((persisted as any)?.omitRanges).toBeUndefined();
    expect(readIndexEntries(getIndexPath("/tmp/project"))).toEqual([]);
  });

  it("drops legacy omit ranges instead of backfilling prune targets from them", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;

    const sessionId = "session-legacy-omit";
    writeLegacyState(sessionId, {
      omitRanges: [
        {
          startTurn: 0,
          endTurn: 3,
          startOffset: 0,
          endOffset: 3,
          indexedAt: 1,
          summaryRef: "0-3",
          messageCount: 4,
        },
      ],
      pruneTargets: [],
      toolCalls: [],
      prunedToolIds: [],
      tokensKeptOutTotal: 0,
      tokensSaved: 0,
      tokensKeptOutByType: {},
      tokensSavedByType: {},
      currentTurn: 0,
      countedSavingsIds: [],
      turnHistory: [],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
    });

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext(sessionId);

    calls.get("tool_call")?.(
      {
        toolCallId: "read-legacy",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );

    await calls.get("turn_end")?.(
      {
        turnIndex: 6,
        message: { role: "assistant", content: "done" },
        toolResults: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "long file body" }],
            toolName: "read",
            isError: false,
            toolCallId: "read-legacy",
          },
        ],
      },
      ctx,
    );

    await calls.get("agent_end")?.(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "show me the file" }] },
          { role: "assistant", content: "running read" },
          {
            role: "toolResult",
            content: [{ type: "text", text: "long file body" }],
            toolName: "read",
            isError: false,
            toolCallId: "read-legacy",
          },
        ],
      },
      ctx,
    );

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState(sessionId);
    expect(persisted?.pruneTargets).toHaveLength(1);
    expect((persisted as any)?.omitRanges).toBeUndefined();
    expect(readIndexEntries(getIndexPath("/tmp/project"))).toHaveLength(1);
  });

  it("counts repeated prune-target omissions in kept-out metrics while gating saved credit", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-background-kept-out");
    const longBody = "line\n".repeat(400);

    calls.get("tool_call")?.(
      {
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );

    await calls.get("turn_end")?.(
      {
        turnIndex: 3,
        message: { role: "assistant", content: "done" },
        toolResults: [
          {
            role: "toolResult",
            content: [{ type: "text", text: longBody }],
            toolName: "read",
            isError: false,
            toolCallId: "read-1",
          },
        ],
      },
      ctx,
    );

    await calls.get("agent_end")?.(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "show me the file" }] },
          { role: "assistant", content: "running read" },
          {
            role: "toolResult",
            content: [{ type: "text", text: longBody }],
            toolName: "read",
            isError: false,
            toolCallId: "read-1",
          },
        ],
      },
      ctx,
    );

    const contextMessages = [
      { role: "user", content: [{ type: "text", text: "show me the file" }] },
      { role: "assistant", content: "running read" },
      {
        role: "toolResult",
        content: [{ type: "text", text: longBody }],
        toolName: "read",
        isError: false,
        toolCallId: "read-1",
      },
    ];

    await calls.get("context")?.({ messages: contextMessages }, ctx);
    await calls.get("context")?.({ messages: contextMessages }, ctx);

    await calls.get("turn_end")?.(
      {
        turnIndex: 4,
        message: { role: "assistant", content: "reused indexed result" },
        toolResults: [],
      },
      ctx,
    );

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-background-kept-out");
    const saved = persisted?.tokensSavedByType.background_index ?? 0;
    const keptOut = persisted?.tokensKeptOutByType.background_index ?? 0;

    expect(saved).toBeGreaterThan(0);
    expect(keptOut).toBe(saved * 2);
    expect(persisted?.tokensSaved).toBeGreaterThanOrEqual(saved);
    expect(persisted?.tokensKeptOutTotal).toBeGreaterThanOrEqual(keptOut);
    expect(persisted?.turnHistory.at(-1)).toMatchObject({
      turnIndex: 4,
    });
    expect((persisted?.turnHistory.at(-1)?.tokensSavedDelta ?? 0)).toBeGreaterThanOrEqual(saved);
    expect((persisted?.turnHistory.at(-1)?.tokensKeptOutDelta ?? 0)).toBeGreaterThanOrEqual(keptOut);
  });

  it("counts repeated materialized omissions in kept-out metrics while gating saved credit", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = false;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.maxOccurrences = 1;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-repeat-kept-out");
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "same payload\n".repeat(200) }],
        toolName: "read",
        isError: false,
        toolCallId: "read-1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "same payload\n".repeat(200) }],
        toolName: "read",
        isError: false,
        toolCallId: "read-2",
      },
    ];

    calls.get("tool_call")?.(
      {
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );
    calls.get("tool_call")?.(
      {
        toolCallId: "read-2",
        toolName: "read",
        input: { path: "README-copy.md" },
      },
      ctx,
    );

    await calls.get("context")?.({ messages }, ctx);
    await calls.get("context")?.({ messages }, ctx);

    await calls.get("turn_end")?.(
      {
        turnIndex: 1,
        message: { role: "assistant", content: "done" },
        toolResults: [],
      },
      ctx,
    );

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-repeat-kept-out");
    const saved = persisted?.tokensSavedByType.dedup ?? 0;
    const keptOut = persisted?.tokensKeptOutByType.dedup ?? 0;

    expect(saved).toBeGreaterThan(0);
    expect(keptOut).toBe(saved * 2);
    expect(persisted?.turnHistory.at(-1)).toMatchObject({
      turnIndex: 1,
    });
    expect((persisted?.turnHistory.at(-1)?.tokensSavedDelta ?? 0)).toBeGreaterThanOrEqual(saved);
    expect((persisted?.turnHistory.at(-1)?.tokensKeptOutDelta ?? 0)).toBeGreaterThanOrEqual(keptOut);
  });

  it("returns a native compaction result from the indexed TOC when enabled", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.nativeCompactionIntegration.enabled = true;
    config.nativeCompactionIntegration.fallbackOnFailure = true;
    config.nativeCompactionIntegration.maxContextSize = 1000;

    const projectPath = "/tmp/project";
    const entries = [
      buildIndexEntry(0, 10, "setup", 11),
      buildIndexEntry(11, 20, "tests", 10),
    ];
    for (const entry of entries) {
      appendIndexEntry(getIndexPath(projectPath), entry);
    }

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const handler = calls.get("session_before_compact");
    const ctx = {
      cwd: projectPath,
      sessionManager: {
        getSessionId: () => "session-compact",
        getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
      getContextUsage: () => ({ tokens: 4096, percent: 0.5, contextWindow: 8192 }),
    } as any;
    const signal = new AbortController().signal;
    const result = await handler?.(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-21",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 4096,
          fileOps: {},
          settings: {},
        },
        branchEntries: [],
        customInstructions: "Use the index.",
        signal,
      },
      ctx,
    );

    expect(result).toEqual({
      compaction: {
        summary: formatTOC(entries),
        firstKeptEntryId: "entry-21",
        tokensBefore: 4096,
      },
    });
  });

  it("uses preparation.tokensBefore as the authoritative native compaction threshold and payload value", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.nativeCompactionIntegration.enabled = true;
    config.nativeCompactionIntegration.fallbackOnFailure = true;
    config.nativeCompactionIntegration.maxContextSize = 1000;

    const projectPath = "/tmp/project";
    const entries = [
      buildIndexEntry(0, 10, "setup", 11),
      buildIndexEntry(11, 20, "tests", 10),
    ];
    for (const entry of entries) {
      appendIndexEntry(getIndexPath(projectPath), entry);
    }

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const handler = calls.get("session_before_compact");
    const lowUsageCtx = {
      cwd: projectPath,
      sessionManager: {
        getSessionId: () => "session-compact-authoritative",
        getEntries: () => [{ id: "m1" }],
      },
      getContextUsage: () => ({ tokens: 200, percent: 0.05, contextWindow: 8192 }),
    } as any;

    const compacted = await handler?.(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-21",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 4096,
          fileOps: {},
          settings: {},
        },
        branchEntries: [],
        signal: new AbortController().signal,
      },
      lowUsageCtx,
    );

    expect(compacted).toEqual({
      compaction: {
        summary: formatTOC(entries),
        firstKeptEntryId: "entry-21",
        tokensBefore: 4096,
      },
    });

    const highUsageCtx = {
      cwd: projectPath,
      sessionManager: {
        getSessionId: () => "session-compact-authoritative-low",
        getEntries: () => [{ id: "m1" }],
      },
      getContextUsage: () => ({ tokens: 4096, percent: 0.5, contextWindow: 8192 }),
    } as any;

    const skipped = await handler?.(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-21",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 200,
          fileOps: {},
          settings: {},
        },
        branchEntries: [],
        signal: new AbortController().signal,
      },
      highUsageCtx,
    );

    expect(skipped).toBeUndefined();
  });

  it("caps native compaction summaries to a compact size", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.nativeCompactionIntegration.enabled = true;
    config.nativeCompactionIntegration.fallbackOnFailure = true;
    config.nativeCompactionIntegration.maxContextSize = 1000;

    const projectPath = "/tmp/project";
    const entries = Array.from({ length: 120 }, (_, index) =>
      buildIndexEntry(index * 10, index * 10 + 9, `topic-${index}-${"x".repeat(80)}`, 10),
    );
    for (const entry of entries) {
      appendIndexEntry(getIndexPath(projectPath), entry);
    }

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const handler = calls.get("session_before_compact");
    const ctx = {
      cwd: projectPath,
      sessionManager: {
        getSessionId: () => "session-compact-cap",
        getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
      getContextUsage: () => ({ tokens: 4096, percent: 0.5, contextWindow: 8192 }),
    } as any;
    const result = await handler?.(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-21",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 4096,
          fileOps: {},
          settings: {},
        },
        branchEntries: [],
        signal: new AbortController().signal,
      },
      ctx,
    );

    const summary = (result as { compaction?: { summary?: string } } | undefined)?.compaction?.summary ?? "";
    expect(summary).toBeTruthy();
    expect(summary?.length).toBeLessThanOrEqual(4096);
    expect(summary).toContain("completed phase(s) indexed");
    expect(summary).toContain("..."); // truncation marker
  });

  it("cancels native compaction when the index is unavailable and fallbackOnFailure is disabled", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.nativeCompactionIntegration.enabled = true;
    config.nativeCompactionIntegration.fallbackOnFailure = false;
    config.nativeCompactionIntegration.maxContextSize = 1000;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const handler = calls.get("session_before_compact");
    const ctx = {
      cwd: "/tmp/missing-project",
      sessionManager: {
        getSessionId: () => "session-compact-fail",
        getEntries: () => [{ id: "m1" }],
      },
      getContextUsage: () => ({ tokens: 4096, percent: 0.5, contextWindow: 8192 }),
    } as any;
    const result = await handler?.(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-21",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 4096,
          fileOps: {},
          settings: {},
        },
        branchEntries: [],
        signal: new AbortController().signal,
      },
      ctx,
    );

    expect(result).toEqual({ cancel: true });
  });

  it("records turn lifecycle usage and persists restartable bookkeeping", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-a");

    calls.get("tool_call")?.(
      {
        toolCallId: "call-1",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );

    const materialized = (await calls.get("context")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [
              {
                type: "text",
                text: `{"status":"ok","details":"${"x".repeat(40000)}"}`,
              },
            ],
            toolName: "read",
            isError: false,
            toolCallId: "call-1",
            _key: "call-1",
          },
        ],
      },
      ctx,
    )) as { messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };

    expect(materialized.messages?.[0].content[0].text).toBe("[ok]");

    await calls.get("turn_end")?.(
      {
        turnIndex: 3,
        message: { role: "assistant", content: "done" },
        toolResults: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "[ok]" }],
            toolName: "read",
            isError: false,
            toolCallId: "call-1",
          },
        ],
      },
      ctx,
    );

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-a");
    expect(persisted).not.toBeNull();
    expect(persisted?.currentTurn).toBe(4);
    expect(persisted?.lastContextTokens).toBe(420);
    expect(persisted?.lastContextPercent).toBe(0.42);
    expect(persisted?.lastContextWindow).toBe(1000);
    expect(persisted?.toolCalls).toHaveLength(1);
    expect(persisted?.countedSavingsIds.length).toBeGreaterThan(0);
    expect(persisted?.turnHistory).toHaveLength(1);
    expect(persisted?.turnHistory[0]).toMatchObject({
      turnIndex: 3,
      messageCountAfterTurn: 3,
    });
  });
});
