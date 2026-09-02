import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerExtension from "../src/index.js";
import { defaultConfig } from "../src/config.js";
import {
  createExtensionRuntime,
  createRuntimeStore,
  type ExtensionRuntimeOptions,
} from "../src/runtime/create-extension-runtime.js";
import { SESSION_STATE_ENTRY_TYPE, readSessionStateFromBranch } from "../src/persistence/session-entries.js";
import { createPiMock, createUiMock, type RecordedEntry } from "./helpers";
import type { PCNConfig } from "../src/config.js";
import { createAnalyticsStore } from "../src/analytics/store.js";
import { disableProject, disableProjectDashboard } from "../src/control/project-state.js";
import { STATUS_KEY } from "../src/dashboard/surfaces.js";
import { creditKeptOut } from "../src/state.js";

let stateDir = "";

/** Seeds a branch with a persisted PCN state entry, as a resumed session would carry. */
function seedSessionState(entries: RecordedEntry[], data: Record<string, unknown>): void {
  entries.push({ type: "custom", id: `seed-${entries.length + 1}`, customType: SESSION_STATE_ENTRY_TYPE, data, timestamp: 0 });
}

function createContext(sessionId: string | null, cwd = "/tmp/project", entries: RecordedEntry[] = []) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      getBranch: () => entries,
    },
    getContextUsage: () => ({ tokens: 420, percent: 42, contextWindow: 1000 }),
  } as any;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-runtime-hooks-"));
  process.env.PCN_CONFIG_PATH = path.join(stateDir, "missing-config.yaml");
});

afterEach(() => {
  delete process.env.PCN_CONFIG_PATH;
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  stateDir = "";
});

describe("runtime hook registration", () => {
  it("registers the oh-my-pi extension hooks", () => {
    const calls: Array<[string, (...args: unknown[]) => unknown]> = [];
    const pi = {
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        calls.push([name, handler]);
      }),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;

    registerExtension(pi);

    expect(calls.map(([name]) => name)).toEqual([
      "tool_call",
      "tool_result",
      "context",
      "turn_end",
      "before_agent_start",
      "agent_end",
      "session_start",
      "session_branch",
      "session_tree",
      "session_shutdown",
    ]);
    expect(calls).toHaveLength(10);
    expect(calls.every(([, handler]) => typeof handler === "function")).toBe(true);
  });

  it("registers the /pcn command surface", () => {
    const { pi, entries } = createPiMock();

    registerExtension(pi);

    expect((pi as any).registerCommand).toHaveBeenCalledTimes(1);
    expect((pi as any).registerCommand).toHaveBeenCalledWith(
      "pcn",
      expect.objectContaining({
        description: expect.stringContaining("Pi Context Ninja"),
        handler: expect.any(Function),
      }),
    );
  });

  it("toggles project-local markers through /pcn subcommands", async () => {
    const { commands, pi, entries } = createPiMock();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-control-"));
    const ctx = {
      ...createContext("session-commands", projectDir),
      ui: {
        notify: vi.fn(),
      },
    } as any;

    try {
      registerExtension(pi);

      await commands.get("pcn")?.handler("disable", ctx);
      expect(fs.existsSync(path.join(projectDir, ".omp", "pcn", ".pcn_disabled"))).toBe(true);

      await commands.get("pcn")?.handler("enable", ctx);
      expect(fs.existsSync(path.join(projectDir, ".omp", "pcn", ".pcn_disabled"))).toBe(false);

      await commands.get("pcn")?.handler("disable dashboard", ctx);
      expect(fs.existsSync(path.join(projectDir, ".omp", "pcn", ".pcn_dashboard_disabled"))).toBe(true);

      await commands.get("pcn")?.handler("enable dashboard", ctx);
      expect(fs.existsSync(path.join(projectDir, ".omp", "pcn", ".pcn_dashboard_disabled"))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps /pcn registered when runtime config loading fails during startup", () => {
    const { commands, pi, entries } = createPiMock();
    const brokenConfigPath = path.join(stateDir, "broken-config.yaml");
    fs.writeFileSync(brokenConfigPath, "strategies: [broken", "utf8");
    process.env.PCN_CONFIG_PATH = brokenConfigPath;

    expect(() => registerExtension(pi)).not.toThrow();
    expect(commands.has("pcn")).toBe(true);
  });

  it("reports degraded config state through /pcn status, /pcn doctor, and /pcn export", async () => {
    const { commands, pi, entries } = createPiMock();
    const brokenConfigPath = path.join(stateDir, "broken-config.yaml");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-degraded-"));
    fs.writeFileSync(brokenConfigPath, "strategies: [broken", "utf8");
    process.env.PCN_CONFIG_PATH = brokenConfigPath;
    const notify = vi.fn();
    const ctx = {
      ...createContext("session-degraded", projectDir),
      ui: { notify },
    } as any;

    try {
      registerExtension(pi);

      await commands.get("pcn")?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("PCN degraded"), "info");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken-config.yaml"), "info");

      notify.mockClear();
      await commands.get("pcn")?.handler("doctor", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Runtime configuration could not be loaded."), "info");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken-config.yaml"), "info");

      notify.mockClear();
      await commands.get("pcn")?.handler("export", ctx);
      const exportMessage = notify.mock.calls[0]?.[0];
      expect(typeof exportMessage).toBe("string");
      const reportPath = String(exportMessage).replace("Exported PCN report to ", "");
      expect(reportPath).toContain(path.join(projectDir, ".omp", "pcn", "reports"));
      expect(fs.existsSync(reportPath)).toBe(true);
      expect(fs.readFileSync(reportPath, "utf8")).toContain("Runtime loaded: no");
      expect(fs.readFileSync(reportPath, "utf8")).toContain("Runtime configuration could not be loaded.");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports dashboard preference separately from effective availability in /pcn status", async () => {
    const { commands, pi, entries } = createPiMock();
    const notify = vi.fn();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-status-dashboard-state-"));
    const ctx = {
      ...createContext("session-status-dashboard-state", projectDir),
      ui: { notify },
    } as any;

    try {
      registerExtension(pi);

      await commands.get("pcn")?.handler("disable", ctx);
      notify.mockClear();

      await commands.get("pcn")?.handler("status", ctx);

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Dashboard preference: enabled"), "info");
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Dashboard active: no (PCN disabled for project)"),
        "info",
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("warns for invalid /pcn arguments", async () => {
    const { commands, pi, entries } = createPiMock();
    const notify = vi.fn();

    registerExtension(pi);

    await commands.get("pcn")?.handler("unknown", {
      ...createContext("session-invalid-args"),
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith(
      "Usage: /pcn status|doctor|export|dashboard|enable|disable|enable dashboard|disable dashboard",
      "warning",
    );
  });

  it("warns when /pcn runs without a project cwd", async () => {
    const { commands, pi, entries } = createPiMock();
    const notify = vi.fn();

    registerExtension(pi);

    await commands.get("pcn")?.handler("status", {
      ...createContext("session-no-cwd", ""),
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith(
      "Pi Context Ninja commands require an active project directory.",
      "warning",
    );
  });

  it.each(["", " ", "\n\t "])(
    "passes through gated runtime hooks when cwd is blank (%p)",
    async (cwd) => {
      const config = defaultConfig();
      config.analytics.enabled = true;
      config.analytics.dbPath = path.join(stateDir, "analytics-blank-cwd.sqlite");
      config.dashboard.enabled = true;
      config.systemHint.enabled = true;
      config.systemHint.text = "Keep the context small.";

      const { calls, pi, entries } = createPiMock();
      createExtensionRuntime(pi, config);

      const sessionId = `session-blank-cwd-${Buffer.from(cwd).toString("hex")}`;
      const ctx = createContext(sessionId, cwd);
      const messages = [{ role: "assistant", content: "hello" }] as const;

      const toolResult = await calls.get("tool_result")?.(
        {
          type: "tool_result",
          toolCallId: "call-blank",
          toolName: "read",
          content: [{ type: "text", text: "body" }],
          isError: false,
        },
        ctx,
      );

      const contextResult = await calls.get("context")?.(
        {
          type: "context",
          messages: [...messages],
        },
        ctx,
      );

      const beforeAgentStartResult = await calls.get("before_agent_start")?.(
        {
          type: "before_agent_start",
          prompt: "question",
          images: undefined,
          systemPrompt: ["base"],
        },
        ctx,
      );

      const sessionBeforeCompactResult = await calls.get("session_before_compact")?.(
        {
          type: "session_before_compact",
          preparation: { type: "compaction" },
        },
        ctx,
      );

      const agentEndResult = await calls.get("agent_end")?.(
        {
          type: "agent_end",
          messages: [
            { role: "user", content: [{ type: "text", text: "question" }] },
            { role: "assistant", content: "answer" },
          ],
        },
        ctx,
      );

      await calls.get("turn_end")?.(
        {
          type: "turn_end",
          turnIndex: 0,
          message: { role: "assistant", content: "done" },
          toolResults: [],
        },
        ctx,
      );

      expect(toolResult).toBeUndefined();
      expect(contextResult).toEqual({ messages });
      expect(beforeAgentStartResult).toBeUndefined();
      expect(sessionBeforeCompactResult).toBeUndefined();
      expect(agentEndResult).toBeUndefined();
      expect(readSessionStateFromBranch(entries)).toBeNull();
    },
  );

  it("applies the system hint only once per session when frequency is once_per_session", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-hint");
    const handler = calls.get("before_agent_start");

    const first = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: ["base"],
      },
      ctx,
    );
    const second = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: ["base"],
      },
      ctx,
    );

    expect(first).toEqual({ systemPrompt: ["base", "Keep the context small."] });
    expect(second).toBeUndefined();
  });

  it("returns a one-element prompt array when event.systemPrompt is missing or malformed", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const handler = calls.get("before_agent_start");

    for (const badPrompt of [undefined, null, 42, {}, []]) {
      const sessionCtx = createContext(`session-non-string-${String(badPrompt)}`);
      const result = await handler?.(
        {
          type: "before_agent_start",
          prompt: "question",
          images: undefined,
          systemPrompt: badPrompt as any,
        },
        sessionCtx,
      );
      expect(result).toEqual({ systemPrompt: ["Keep the context small."] });
    }
  });

  it("persists once-per-session system hint state across runtime reloads", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const sessionId = "session-hint-persisted";
    const shared: RecordedEntry[] = [];
    const ctx = createContext(sessionId, "/tmp/project", shared);

    const firstRuntime = createPiMock(shared);
    createExtensionRuntime(firstRuntime.pi, config);

    const first = await firstRuntime.calls.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: ["base"],
      },
      ctx,
    );

    expect(first).toEqual({ systemPrompt: ["base", "Keep the context small."] });

    await firstRuntime.calls.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

    const secondRuntime = createPiMock(shared);
    createExtensionRuntime(secondRuntime.pi, config);

    const second = await secondRuntime.calls.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: ["base"],
      },
      ctx,
    );

    expect(second).toBeUndefined();
  });

  it("falls back to a fresh session state when persisted session state is parseable but structurally invalid", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const sessionId = "session-invalid-structure";
    const seeded: RecordedEntry[] = [];
    seedSessionState(seeded, {
      currentTurn: "wrong-type",
      projectPath: 42,
      turnHistory: "wrong-type",
    });

    const { calls, pi, entries } = createPiMock(seeded);
    createExtensionRuntime(pi, config);

    const result = await calls.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: ["base"],
      },
      createContext(sessionId, "/tmp/project", seeded),
    );

    expect(result).toEqual({ systemPrompt: ["base", "Keep the context small."] });
    const persisted = readSessionStateFromBranch(entries);
    expect(persisted).not.toBeNull();
    expect(persisted?.projectPath).toBe("/tmp/project");
    expect(persisted?.systemHintState).toEqual({
      appliedOnce: true,
      lastAppliedText: "Keep the context small.",
    });
    expect(persisted?.turnHistory).toEqual([]);
  });

  it("re-applies the system hint when frequency is on_change and the text changes", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "on_change";
    config.systemHint.text = "Keep the context small.";

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-hint-change");
    const handler = calls.get("before_agent_start");

    const first = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: ["base"],
      },
      ctx,
    );
    config.systemHint.text = "Keep the context small and explicit.";
    const second = await handler?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: ["base"],
      },
      ctx,
    );

    expect(first).toEqual({ systemPrompt: ["base", "Keep the context small."] });
    expect(second).toEqual({ systemPrompt: ["base", "Keep the context small and explicit."] });
  });

  it("passes through data-plane hooks and skips bookkeeping when the project is disabled", async () => {
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(stateDir, "analytics-disabled.sqlite");
    config.dashboard.enabled = true;

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-disabled-project-"));
    fs.mkdirSync(path.join(projectDir, ".omp", "pcn"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".omp", "pcn", ".pcn_disabled"), "", "utf8");

    try {
      const { calls, pi, entries } = createPiMock();
      createExtensionRuntime(pi, config);

      const ctx = createContext("session-disabled", projectDir);

      calls.get("tool_call")?.(
        {
          toolCallId: "call-disabled",
          toolName: "read",
          input: { path: "README.md" },
        },
        ctx,
      );

      const toolResult = await calls.get("tool_result")?.(
        {
          type: "tool_result",
          toolCallId: "call-disabled",
          toolName: "read",
          content: [{ type: "text", text: "{\"status\":\"ok\"}" }],
          isError: false,
        },
        ctx,
      );

      expect(toolResult).toBeUndefined();

      const messages = [
        {
          role: "toolResult",
          content: [{ type: "text", text: "body" }],
          toolName: "read",
          isError: false,
          toolCallId: "call-disabled",
        },
      ] as const;

      const contextResult = await calls.get("context")?.(
        {
          type: "context",
          messages: [...messages],
        },
        ctx,
      );

      expect(contextResult).toEqual({ messages });

      await calls.get("turn_end")?.(
        {
          type: "turn_end",
          turnIndex: 0,
          message: { role: "assistant", content: "done" },
          toolResults: [],
        },
        ctx,
      );
      expect(readSessionStateFromBranch(entries)).toBeNull();
      expect(fs.existsSync(config.analytics.dbPath)).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("credits repeated materialized omissions only once in kept-out metrics", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.maxOccurrences = 1;

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-repeat-kept-out");
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "same payload\n".repeat(200) }],
        toolName: "grep",
        isError: false,
        toolCallId: "read-1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "same payload\n".repeat(200) }],
        toolName: "grep",
        isError: false,
        toolCallId: "read-2",
      },
    ];

    calls.get("tool_call")?.(
      {
        toolCallId: "read-1",
        toolName: "grep",
        input: { path: "README.md" },
      },
      ctx,
    );
    calls.get("tool_call")?.(
      {
        toolCallId: "read-2",
        toolName: "grep",
        input: { path: "README.md" },
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
    const persisted = readSessionStateFromBranch(entries);
    const saved = persisted?.tokensKeptOutByType.dedup ?? 0;
    const keptOut = persisted?.tokensKeptOutByType.dedup ?? 0;

    expect(saved).toBeGreaterThan(0);
    expect(keptOut).toBe(saved);
    expect(persisted?.turnHistory.at(-1)).toMatchObject({
      turnIndex: 1,
    });
    expect((persisted?.turnHistory.at(-1)?.tokensKeptOutDelta ?? 0)).toBeGreaterThanOrEqual(saved);
    expect((persisted?.turnHistory.at(-1)?.tokensKeptOutDelta ?? 0)).toBeGreaterThanOrEqual(keptOut);
  });

  it("does not deduplicate resumed inferred tool results when rebuild lacks input provenance", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.maxOccurrences = 1;

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const sessionId = "session-resumed-missing-provenance";
    const ctx = createContext(sessionId);
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "build 2026-04-14T10:11:12Z abcdefab-cdef-4123-89ab-abcdefabcdef" }],
        toolName: "read",
        isError: false,
        toolCallId: "read-1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "build 2026-04-15T11:12:13Z 12345678-1234-4123-8234-1234567890ab" }],
        toolName: "read",
        isError: false,
        toolCallId: "read-2",
      },
    ];

    const contextResult = await calls.get("context")?.({ messages }, ctx) as
      | { messages?: Array<{ content: Array<{ type: string; text?: string }> }> }
      | undefined;

    expect(contextResult?.messages?.[0]?.content[0]?.text).toBe(messages[0].content[0].text);
    expect(contextResult?.messages?.[1]?.content[0]?.text).toBe(messages[1].content[0].text);

    await calls.get("agent_end")?.({ messages }, ctx);
    const persisted = readSessionStateFromBranch(entries);
    expect(persisted?.toolCalls).toEqual([
      [
        "read-1",
        expect.objectContaining({
          inferredFromContext: true,
          inputFingerprint: "",
        }),
      ],
      [
        "read-2",
        expect.objectContaining({
          inferredFromContext: true,
          inputFingerprint: "",
        }),
      ],
    ]);
  });

  it("records turn lifecycle usage and persists restartable bookkeeping", async () => {
    const config = defaultConfig();
    config.strategies.shortCircuit.maxTokens = 100_000;
    config.analytics.enabled = false;
    config.dashboard.enabled = false;

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-a");

    calls.get("tool_call")?.(
      {
        toolCallId: "call-1",
        toolName: "grep",
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
            toolName: "grep",
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
            toolName: "grep",
            isError: false,
            toolCallId: "call-1",
          },
        ],
      },
      ctx,
    );
    const persisted = readSessionStateFromBranch(entries);
    expect(persisted).not.toBeNull();
    expect(persisted?.currentTurn).toBe(4);
    expect(persisted?.lastContextTokens).toBe(420);
    expect(persisted?.lastContextPercent).toBe(42);
    expect(persisted?.lastContextWindow).toBe(1000);
    expect(persisted?.toolCalls).toHaveLength(1);
    expect(persisted?.countedSavingsIds.length).toBeGreaterThan(0);
    expect(persisted?.turnHistory).toHaveLength(1);
    expect(persisted?.turnHistory[0]).toMatchObject({
      turnIndex: 3,
      messageCountAfterTurn: 3,
    });
  });

  it("isolates analytics recordTurn failures from turn persistence and evicts the broken session store", async () => {
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(stateDir, "analytics.sqlite");
    config.dashboard.enabled = false;

    const brokenStore = {
      getStrategyImpactTotals: vi.fn(() => ({})),
      recordTurn: vi.fn(() => {
        throw new Error("analytics write failed");
      }),
      getDashboardSnapshot: vi.fn(),
      getSnapshot: vi.fn(),
      close: vi.fn(),
    };
    const healthySnapshot = {
      generatedAt: Date.now(),
      sessionId: "session-analytics-failure",
      projectPath: "/tmp/project",
      totalTurns: 1,
      totals: {
        tokensSavedApprox: 0,
        tokensKeptOutApprox: 0,
      },
      context: {
        tokens: 420,
        percent: 42,
        window: 1000,
      },
      latestTurn: null,
      recentTurns: [],
    };
    const healthyStore = {
      getStrategyImpactTotals: vi.fn(() => ({})),
      recordTurn: vi.fn(() => healthySnapshot),
      getDashboardSnapshot: vi.fn(() => healthySnapshot),
      getSnapshot: vi.fn(() => healthySnapshot),
      close: vi.fn(),
    };
    const createAnalyticsStoreMock = vi
      .fn()
      .mockReturnValueOnce(brokenStore)
      .mockReturnValueOnce(healthyStore);
    const runtimeOptions: ExtensionRuntimeOptions = {
        store: createRuntimeStore(),
        createAnalyticsStore: createAnalyticsStoreMock as unknown as ExtensionRuntimeOptions["createAnalyticsStore"],
      };

    try {
      const createRuntimeWithMockedAnalytics = (piArg: ExtensionAPI, cfg: PCNConfig) =>
        createExtensionRuntime(piArg, cfg, undefined, runtimeOptions);

      const { calls, pi, entries } = createPiMock();
      createRuntimeWithMockedAnalytics(pi, config);

      const ctx = createContext("session-analytics-failure");

      await expect(
        calls.get("turn_end")?.(
          {
            turnIndex: 0,
            message: { role: "assistant", content: "first turn" },
            toolResults: [],
          },
          ctx,
        ),
      ).resolves.toBeUndefined();
      let persisted = readSessionStateFromBranch(entries);
      expect(persisted).not.toBeNull();
      expect(persisted?.currentTurn).toBe(1);
      expect(persisted?.turnHistory).toHaveLength(1);
      expect(persisted?.turnHistory[0]).toMatchObject({
        turnIndex: 0,
        messageCountAfterTurn: 3,
      });
      expect(createAnalyticsStoreMock).toHaveBeenCalledTimes(1);
      expect(brokenStore.recordTurn).toHaveBeenCalledTimes(1);
      expect(brokenStore.close).toHaveBeenCalledTimes(1);

      await expect(
        calls.get("turn_end")?.(
          {
            turnIndex: 1,
            message: { role: "assistant", content: "second turn" },
            toolResults: [],
          },
          ctx,
        ),
      ).resolves.toBeUndefined();

      persisted = readSessionStateFromBranch(entries);
      expect(persisted?.currentTurn).toBe(2);
      expect(persisted?.turnHistory).toHaveLength(2);
      expect(createAnalyticsStoreMock).toHaveBeenCalledTimes(2);
      expect(healthyStore.recordTurn).toHaveBeenCalledTimes(1);
      expect(healthyStore.close).not.toHaveBeenCalled();
    } finally {
    }
  });

  it("records nonzero impact events for the session from runtime savings deltas", async () => {
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(stateDir, "analytics.sqlite");
    config.dashboard.enabled = true;
    config.strategies.shortCircuit.enabled = true;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.enabled = true;
    config.strategies.deduplication.maxOccurrences = 1;

    const store = createRuntimeStore();
    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store });

    const ctx = createContext("session-impact-events");
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "{\"status\":\"ok\"}" }],
        toolName: "grep",
        isError: false,
        toolCallId: "read-1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "{\"status\":\"ok\"}" }],
        toolName: "grep",
        isError: false,
        toolCallId: "read-2",
      },
    ];

    calls.get("tool_call")?.({ toolCallId: "read-1", toolName: "grep", input: { path: "README.md" } }, ctx);
    calls.get("tool_call")?.({ toolCallId: "read-2", toolName: "grep", input: { path: "README.md" } }, ctx);

    await calls.get("context")?.({ messages }, ctx);
    await calls.get("turn_end")?.(
      {
        turnIndex: 0,
        message: { role: "assistant", content: "done" },
        toolResults: messages,
      },
      ctx,
    );

    const snapshot = store.analyticsStoresBySession
      .get("session-impact-events")!
      .getDashboardSnapshot("session-impact-events", "/tmp/project");
    expect(snapshot.strategyTotals).toEqual(expect.objectContaining({ short_circuit: expect.any(Number) }));
    expect(snapshot.recentImpactEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "runtime.materialize",
          toolName: "grep",
          strategy: "short_circuit",
          summary: "Skipped repeated grep output",
        }),
      ]),
    );
    expect(snapshot.recentImpactEvents.map((event) => event.strategy)).toEqual(["short_circuit"]);
    expect(snapshot.recentImpactEvents.every((event) => event.tokensSavedApprox > 0 || event.tokensKeptOutApprox > 0)).toBe(true);
  });

  it("does not re-emit historical impact after retention prunes old impact-event rows", async () => {
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(stateDir, "analytics.sqlite");
    config.analytics.retentionDays = 1;
    config.dashboard.enabled = true;
    config.strategies.shortCircuit.enabled = true;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.enabled = false;

    const now = vi.spyOn(Date, "now");
    const oneDayMs = 24 * 60 * 60 * 1000;
    const store = createRuntimeStore();

    try {
      const { calls, pi } = createPiMock();
      createExtensionRuntime(pi, config, undefined, { store });

      const ctx = createContext("session-impact-retention");
      const firstTurnMessages = [
        {
          role: "toolResult",
          content: [{ type: "text", text: "{\"status\":\"ok\"}" }],
          toolName: "grep",
          isError: false,
          toolCallId: "read-1",
        },
      ] as const;
      const readSnapshot = () =>
        store.analyticsStoresBySession
          .get("session-impact-retention")!
          .getDashboardSnapshot("session-impact-retention", "/tmp/project");

      calls.get("tool_call")?.({ toolCallId: "read-1", toolName: "grep", input: { path: "README.md" } }, ctx);
      await calls.get("context")?.({ messages: firstTurnMessages }, ctx);

      now.mockImplementation(() => 1_000);
      await calls.get("turn_end")?.(
        { turnIndex: 0, message: { role: "assistant", content: "first" }, toolResults: firstTurnMessages },
        ctx,
      );
      expect(readSnapshot().recentImpactEvents.map((event) => event.strategy)).toEqual(["short_circuit"]);

      now.mockImplementation(() => (2 * oneDayMs) + 1_000);
      await calls.get("turn_end")?.(
        { turnIndex: 1, message: { role: "assistant", content: "second" }, toolResults: [] },
        ctx,
      );

      const second = readSnapshot();
      expect(second.recentImpactEvents).toEqual([]);
      expect(second.strategyTotals).toEqual({ short_circuit: expect.any(Number) });
    } finally {
      now.mockRestore();
    }
  });

  it("backfills first-observed tool turn indices from turn_end so resumed sessions do not age fresh results as stale", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = true;
    config.strategies.errorPurge.maxTurnsAgo = 3;
    config.strategies.deduplication.enabled = false;

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-midstream");

    calls.get("tool_call")?.(
      {
        toolCallId: "read-midstream",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );

    calls.get("tool_result")?.(
      {
        toolCallId: "read-midstream",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      },
      ctx,
    );

    await calls.get("turn_end")?.(
      {
        turnIndex: 12,
        message: { role: "assistant", content: "done" },
        toolResults: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "read-midstream",
          },
        ],
      },
      ctx,
    );

    const contextResult = await calls.get("context")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "read-midstream",
          },
        ],
      },
      ctx,
    ) as { messages?: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;

    expect(contextResult?.messages?.[0]?.content).toEqual([
      { type: "text", text: "boom" },
    ]);

    await calls.get("agent_end")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "fresh body" }],
            toolName: "read",
            isError: false,
            toolCallId: "read-midstream",
          },
        ],
      },
      ctx,
    );
    const persisted = readSessionStateFromBranch(entries);
    expect(persisted?.toolCalls).toEqual([
      [
        "read-midstream",
        expect.objectContaining({
          turnIndex: 12,
          isError: true,
        }),
      ],
    ]);
  });

  it("overwrites stale resumed positive turn indices with the later authoritative turn_end turn", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = true;
    config.strategies.errorPurge.maxTurnsAgo = 3;
    config.strategies.deduplication.enabled = false;

    const sessionId = "session-resumed-stale-positive-turn";
    const seeded: RecordedEntry[] = [];
    seedSessionState(seeded, {
      toolCalls: [],
      tokensKeptOutTotal: 0,
      tokensKeptOutByType: {},
      currentTurn: 2,
      countedSavingsIds: [],
      turnHistory: [
        {
          turnIndex: 1,
          toolCount: 0,
          messageCountAfterTurn: 2,
          tokensKeptOutDelta: 0,
          timestamp: 111,
        },
      ],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
    });

    const { calls, pi, entries } = createPiMock(seeded);
    createExtensionRuntime(pi, config);

    const ctx = createContext(sessionId, "/tmp/project", seeded);
    const freshMessages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: "boom" }],
        toolName: "read",
        isError: true,
        toolCallId: "fresh-error",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "fresh body" }],
        toolName: "read",
        isError: false,
        toolCallId: "fresh-success",
      },
    ] as const;

    calls.get("tool_call")?.(
      {
        toolCallId: "fresh-error",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );
    calls.get("tool_result")?.(
      {
        toolCallId: "fresh-error",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      },
      ctx,
    );

    calls.get("tool_call")?.(
      {
        toolCallId: "fresh-success",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );
    calls.get("tool_result")?.(
      {
        toolCallId: "fresh-success",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "fresh body" }],
      },
      ctx,
    );

    await calls.get("turn_end")?.(
      {
        turnIndex: 12,
        message: { role: "assistant", content: "done" },
        toolResults: freshMessages,
      },
      ctx,
    );
    let persisted = readSessionStateFromBranch(seeded);
    expect(persisted?.toolCalls).toEqual([
      [
        "fresh-error",
        expect.objectContaining({
          turnIndex: 12,
          isError: true,
        }),
      ],
      [
        "fresh-success",
        expect.objectContaining({
          turnIndex: 12,
          isError: false,
        }),
      ],
    ]);

    await calls.get("turn_end")?.(
      {
        turnIndex: 13,
        message: { role: "assistant", content: "next turn" },
        toolResults: [],
      },
      ctx,
    );

    await calls.get("agent_end")?.(
      {
        messages: freshMessages as any,
      },
      ctx,
    );

    const contextResult = await calls.get("context")?.(
      {
        messages: freshMessages as any,
      },
      ctx,
    ) as { messages?: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;

    expect(contextResult?.messages?.[0]?.content).toEqual([
      { type: "text", text: "boom" },
    ]);
    expect(contextResult?.messages?.[1]?.content).toEqual([
      { type: "text", text: "fresh body" },
    ]);

    persisted = readSessionStateFromBranch(seeded);
  });

  it("rebuilds missing tool records from context messages, survives reload, and lets later turn_end make the authoritative age apply", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = true;
    config.strategies.errorPurge.maxTurnsAgo = 3;
    config.strategies.deduplication.enabled = false;

    const sessionId = "session-rebuild-from-context";
    const seeded: RecordedEntry[] = [];
    seedSessionState(seeded, {
      toolCalls: [],
      tokensKeptOutTotal: 0,
      tokensKeptOutByType: {},
      currentTurn: 20,
      countedSavingsIds: [],
      turnHistory: [
        {
          turnIndex: 20,
          toolCount: 1,
          messageCountAfterTurn: 3,
          tokensKeptOutDelta: 0,
          timestamp: 111,
        },
      ],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
    });

    const firstRuntime = createPiMock(seeded);
    createExtensionRuntime(firstRuntime.pi, config);

    const ctx = createContext(sessionId, "/tmp/project", seeded);
    const contextResult = await firstRuntime.calls.get("context")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "historic-error",
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "archived output" }],
            toolName: "read",
            isError: false,
            toolCallId: "historic-success",
          },
        ],
      },
      ctx,
    ) as { messages?: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;

    expect(contextResult?.messages?.[0]?.content).toEqual([
      { type: "text", text: "boom" },
    ]);

    await firstRuntime.calls.get("agent_end")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "historic-error",
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "archived output" }],
            toolName: "read",
            isError: false,
            toolCallId: "historic-success",
          },
        ],
      },
      ctx,
    );
    let persisted = readSessionStateFromBranch(seeded);
    expect(persisted?.toolCalls).toEqual([
      [
        "historic-error",
        expect.objectContaining({
          toolName: "read",
          isError: true,
          turnIndex: 19,
          inferredFromContext: true,
        }),
      ],
      [
        "historic-success",
        expect.objectContaining({
          toolName: "read",
          isError: false,
          turnIndex: 19,
          inferredFromContext: true,
        }),
      ],
    ]);

    await firstRuntime.calls.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

    const secondRuntime = createPiMock(seeded);
    createExtensionRuntime(secondRuntime.pi, config);

    const contextAfterReload = await secondRuntime.calls.get("context")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "historic-error",
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "archived output" }],
            toolName: "read",
            isError: false,
            toolCallId: "historic-success",
          },
        ],
      },
      ctx,
    ) as { messages?: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;

    expect(contextAfterReload?.messages?.[0]?.content).toEqual([
      { type: "text", text: "boom" },
    ]);

    await secondRuntime.calls.get("turn_end")?.(
      {
        turnIndex: 12,
        message: { role: "assistant", content: "late authoritative turn" },
        toolResults: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "historic-error",
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "archived output" }],
            toolName: "read",
            isError: false,
            toolCallId: "historic-success",
          },
        ],
      },
      ctx,
    );

    persisted = readSessionStateFromBranch(seeded);
    expect(persisted?.toolCalls).toEqual([
      [
        "historic-error",
        expect.objectContaining({
          turnIndex: 12,
        }),
      ],
      [
        "historic-success",
        expect.objectContaining({
          turnIndex: 12,
          inferredFromContext: false,
        }),
      ],
    ]);

    await secondRuntime.calls.get("turn_end")?.(
      { turnIndex: 13, message: { role: "assistant", content: "noop" }, toolResults: [] },
      ctx,
    );
    await secondRuntime.calls.get("turn_end")?.(
      { turnIndex: 14, message: { role: "assistant", content: "noop" }, toolResults: [] },
      ctx,
    );
    await secondRuntime.calls.get("turn_end")?.(
      { turnIndex: 15, message: { role: "assistant", content: "noop" }, toolResults: [] },
      ctx,
    );
    await secondRuntime.calls.get("turn_end")?.(
      { turnIndex: 16, message: { role: "assistant", content: "noop" }, toolResults: [] },
      ctx,
    );

    const purgedContext = await secondRuntime.calls.get("context")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "historic-error",
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "archived output" }],
            toolName: "read",
            isError: false,
            toolCallId: "historic-success",
          },
        ],
      },
      ctx,
    ) as { messages?: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;

    expect(purgedContext?.messages?.[0]?.content).toEqual([
      {
        type: "text",
        text: `[Error output removed -- tool failed more than ${config.strategies.errorPurge.maxTurnsAgo} turns ago]`,
      },
    ]);

    await secondRuntime.calls.get("agent_end")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "boom" }],
            toolName: "read",
            isError: true,
            toolCallId: "historic-error",
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "archived output" }],
            toolName: "read",
            isError: false,
            toolCallId: "historic-success",
          },
        ],
      },
      ctx,
    );
  });

  it("uses the newest historical turn when currentTurn is missing and still rebuilds tool records safely", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.enabled = false;

    const sessionId = "session-rebuild-legacy-current-turn";
    const seeded: RecordedEntry[] = [];
    seedSessionState(seeded, {
      toolCalls: [],
      tokensKeptOutTotal: 0,
      tokensKeptOutByType: {},
      currentTurn: -1,
      countedSavingsIds: [],
      turnHistory: [
        {
          turnIndex: 2,
          toolCount: 1,
          messageCountAfterTurn: 3,
          tokensKeptOutDelta: 0,
          timestamp: 111,
        },
        {
          turnIndex: 7,
          toolCount: 1,
          messageCountAfterTurn: 7,
          tokensKeptOutDelta: 0,
          timestamp: 222,
        },
      ],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
    });

    const { calls, pi, entries } = createPiMock(seeded);
    createExtensionRuntime(pi, config);

    const ctx = createContext(sessionId, "/tmp/project", seeded);
    await calls.get("context")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "fresh result" }],
            toolName: "read",
            isError: false,
            toolCallId: "legacy-fresh",
          },
        ],
      },
      ctx,
    );

    await calls.get("agent_end")?.(
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "fresh result" }],
            toolName: "read",
            isError: false,
            toolCallId: "legacy-fresh",
          },
        ],
      },
      ctx,
    );
    const persisted = readSessionStateFromBranch(seeded);
    expect(persisted?.toolCalls).toEqual([
      [
        "legacy-fresh",
        expect.objectContaining({
          turnIndex: 7,
        }),
      ],
    ]);
  });

  it("applies immediate safe tool_result shaping only to successful single-text results", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = true;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.enabled = false;

    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-tool-result-shaping");
    calls.get("tool_call")?.(
      {
        toolCallId: "call-shaped",
        toolName: "bash",
        input: { command: "cat result.json" },
      },
      ctx,
    );

    const shaped = await calls.get("tool_result")?.(
      {
        toolCallId: "call-shaped",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "{\"status\":\"ok\",\"payload\":\"done\"}" }],
      },
      ctx,
    );

    const mixed = await calls.get("tool_result")?.(
      {
        toolCallId: "call-mixed",
        toolName: "bash",
        isError: false,
        content: [
          { type: "text", text: "{\"status\":\"ok\"}" },
          { type: "image", imageUrl: "https://example.com/image.png" },
        ],
      },
      ctx,
    );

    const errored = await calls.get("tool_result")?.(
      {
        toolCallId: "call-error",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "{\"status\":\"ok\"}" }],
      },
      ctx,
    );

    const readResult = await calls.get("tool_result")?.(
      {
        toolCallId: "call-read",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "{\"status\":\"ok\",\"payload\":\"done\"}" }],
      },
      ctx,
    );

    expect(shaped).toEqual({
      content: [{ type: "text", text: "[ok]" }],
    });
    expect(mixed).toBeUndefined();
    expect(errored).toBeUndefined();
    expect(readResult).toBeUndefined();

    await calls.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    const persisted = readSessionStateFromBranch(entries);
    expect(persisted?.toolCalls).toEqual([
      [
        "call-shaped",
        expect.objectContaining({
          toolCallId: "call-shaped",
          toolName: "bash",
          isError: false,
          tokenEstimate: expect.any(Number),
        }),
      ],
      [
        "call-mixed",
        expect.objectContaining({
          toolCallId: "call-mixed",
          toolName: "bash",
          isError: false,
        }),
      ],
      [
        "call-error",
        expect.objectContaining({
          toolCallId: "call-error",
          toolName: "bash",
          isError: true,
        }),
      ],
      [
        "call-read",
        expect.objectContaining({
          toolCallId: "call-read",
          toolName: "read",
          isError: false,
        }),
      ],
    ]);
  });
});

describe("runtime store injection", () => {
  it("keeps session state isolated between runtimes with different stores", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    const a = createPiMock();
    const b = createPiMock();
    const storeA = createRuntimeStore();
    const storeB = createRuntimeStore();
    createExtensionRuntime(a.pi, config, undefined, { store: storeA });
    createExtensionRuntime(b.pi, config, undefined, { store: storeB });

    const ctx = createContext("shared-session");
    await a.calls.get("turn_end")!(
      { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] },
      ctx,
    );

    expect(storeA.sessionMap.get("shared-session")?.currentTurn).toBe(1);
    expect(storeB.sessionMap.has("shared-session")).toBe(false);
  });

  it("disables the data plane for a session without a host session id", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store: createRuntimeStore() });
    const ctx = createContext(null);

    const messages = [{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: '{"status":"ok"}' }] }];
    const result = await calls.get("context")?.({ type: "context", messages }, ctx);
    await calls.get("turn_end")?.({ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, ctx);

    expect((result as any).messages[0].content[0].text).toBe('{"status":"ok"}');
    expect(entries).toHaveLength(0);
  });

  it("appends no session entry on an agent_end that will continue", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store: createRuntimeStore() });
    const ctx = createContext("session-continue");

    await calls.get("agent_end")?.({ type: "agent_end", messages: [], willContinue: true }, ctx);
    expect(entries).toHaveLength(0);

    await calls.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
    expect(entries).toHaveLength(1);
  });

  it("rebuilds session state from the branch on session_start", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    const seeded: RecordedEntry[] = [];
    seedSessionState(seeded, {
      toolCalls: [],
      tokensKeptOutTotal: 77,
      tokensKeptOutByType: { dedup: 77 },
      currentTurn: 3,
      countedSavingsIds: [],
      turnHistory: [],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
      systemHintState: { appliedOnce: false, lastAppliedText: null },
    });
    const store = createRuntimeStore();
    const { calls, pi } = createPiMock(seeded);
    createExtensionRuntime(pi, config, undefined, { store });
    const ctx = createContext("session-rebuild", "/tmp/project", seeded);

    await calls.get("session_start")?.({ type: "session_start" }, ctx);

    expect(store.sessionMap.get("session-rebuild")?.tokensKeptOutTotal).toBe(77);
    expect(store.sessionMap.get("session-rebuild")?.currentTurn).toBe(3);
  });

  it("warns from /pcn dashboard when the runtime did not start", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-cmd-"));
    const brokenConfigPath = path.join(stateDir, "broken-config.yaml");
    fs.writeFileSync(brokenConfigPath, "strategies: [broken", "utf8");
    process.env.PCN_CONFIG_PATH = brokenConfigPath;
    const { commands, pi } = createPiMock();
    registerExtension(pi, { store: createRuntimeStore() });
    const host = createUiMock();
    const ctx = { ...createContext("session-dashboard-cmd", projectDir), ...host.ctx } as any;
    try {
      await commands.get("pcn")?.handler("dashboard", ctx);
      expect(host.notify).toHaveBeenCalledWith(expect.stringContaining("not available"), "warning");
      expect(host.custom).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns the context unchanged and records a degraded reason when a hook throws", async () => {
    const { calls, commands, pi } = createPiMock();
    registerExtension(pi, { store: createRuntimeStore() });
    const ctx = createContext("session-hook-guard");
    const notify = vi.fn();
    const brokenEvent = { type: "context", messages: 42 as unknown as never[] };

    const result = await calls.get("context")?.(brokenEvent, ctx);
    expect(result).toEqual({ messages: 42 });

    await commands.get("pcn")?.handler("doctor", { ...ctx, ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("hook:context"), "info");
  });

  it("places the analytics database under the project's .omp/pcn directory", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-analytics-path-"));
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = "";
    config.dashboard.enabled = false;
    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store: createRuntimeStore() });
    const ctx = createContext("session-analytics-path", projectDir);
    try {
      await calls.get("turn_end")?.({ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, ctx);
      await calls.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
      expect(fs.existsSync(path.join(projectDir, ".omp", "pcn", "analytics.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, ".pi-ninja"))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not append an identical session state twice", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    const { calls, pi, entries } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store: createRuntimeStore() });
    const ctx = createContext("session-no-duplicate-entries");

    await calls.get("turn_end")?.({ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, ctx);
    await calls.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);

    expect(entries).toHaveLength(1);
  });

  it("caps turn history and keeps kept-out deltas exact beyond the cap", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    const store = createRuntimeStore();
    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store });
    const ctx = createContext("session-history-cap");

    for (let turn = 0; turn < 120; turn++) {
      await calls.get("turn_end")?.({ type: "turn_end", turnIndex: turn, message: { role: "assistant", content: [] }, toolResults: [] }, ctx);
    }
    const state = store.sessionMap.get("session-history-cap")!;
    expect(state.turnHistory).toHaveLength(100);

    state.tokensKeptOutTotal += 37;
    await calls.get("turn_end")?.({ type: "turn_end", turnIndex: 120, message: { role: "assistant", content: [] }, toolResults: [] }, ctx);
    expect(state.turnHistory.at(-1)?.tokensKeptOutDelta).toBe(37);
    expect(state.turnHistory).toHaveLength(100);
  });
});

describe("dashboard surfaces in the runtime (DASH-020 to DASH-036)", () => {
  function turnEnd(calls: Map<string, (...args: any[]) => unknown>, ctx: unknown, turnIndex: number) {
    return calls.get("turn_end")?.(
      { turnIndex, message: { role: "assistant", content: `turn ${turnIndex}` }, toolResults: [] },
      ctx,
    );
  }

  function runtimeConfig(): PCNConfig {
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(stateDir, `analytics-${Math.random().toString(16).slice(2)}.sqlite`);
    return config;
  }

  it("updates the status-line item after each turn_end", async () => {
    const store = createRuntimeStore();
    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, runtimeConfig(), undefined, { store });
    const host = createUiMock();
    const ctx = { ...createContext("session-status"), ...host.ctx };

    await turnEnd(calls, ctx, 0);
    expect(host.status.get(STATUS_KEY)).toBe("pcn 0 kept out");

    creditKeptOut(store.sessionMap.get("session-status")!, "call-x", "truncation", 12_345);
    await turnEnd(calls, ctx, 1);
    expect(host.status.get(STATUS_KEY)).toBe("pcn 12.3k kept out");
    expect(host.ui.setStatus).toHaveBeenCalledTimes(2);
  });

  it("removes the status-line item when the project is disabled on a later turn", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-status-disable-"));
    const store = createRuntimeStore();
    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, runtimeConfig(), undefined, { store });
    const host = createUiMock();
    const ctx = { ...createContext("session-status-disable", projectDir), ...host.ctx };
    try {
      await turnEnd(calls, ctx, 0);
      expect(host.status.get(STATUS_KEY)).toBe("pcn 0 kept out");

      disableProject(projectDir);
      await turnEnd(calls, ctx, 1);
      expect(host.status.get(STATUS_KEY)).toBeUndefined();
      expect(store.dashboardSurfaces.activeSessions()).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.each(["disable", "disable dashboard"])("removes the status-line item when /pcn %s runs", async (command) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-status-command-"));
    const store = createRuntimeStore();
    const { calls, commands, pi } = createPiMock();
    registerExtension(pi, { store });
    const host = createUiMock();
    const ctx = { ...createContext(`session-${command.replace(/\s+/g, "-")}`, projectDir), ...host.ctx };
    try {
      await turnEnd(calls, ctx, 0);
      expect(host.status.get(STATUS_KEY)).toBe("pcn 0 kept out");

      await commands.get("pcn")?.handler(command, ctx);
      expect(host.status.get(STATUS_KEY)).toBeUndefined();
      expect(store.dashboardSurfaces.activeSessions()).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.each(["disable", "disable dashboard"])(
    "removes the status-line items of every session of the same project when /pcn %s runs",
    async (command) => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-status-command-all-"));
      const store = createRuntimeStore();
      const { calls, commands, pi } = createPiMock();
      registerExtension(pi, { store });
      const hostA = createUiMock();
      const hostB = createUiMock();
      const suffix = command.replace(/\s+/g, "-");
      const ctxA = { ...createContext(`session-a-${suffix}`, projectDir), ...hostA.ctx };
      const ctxB = { ...createContext(`session-b-${suffix}`, `${projectDir}${path.sep}`), ...hostB.ctx };
      try {
        await turnEnd(calls, ctxA, 0);
        await turnEnd(calls, ctxB, 0);
        expect(hostA.status.get(STATUS_KEY)).toBe("pcn 0 kept out");
        expect(hostB.status.get(STATUS_KEY)).toBe("pcn 0 kept out");

        await commands.get("pcn")?.handler(command, ctxB);
        expect(hostA.status.get(STATUS_KEY)).toBeUndefined();
        expect(hostB.status.get(STATUS_KEY)).toBeUndefined();
        expect(store.dashboardSurfaces.activeSessions()).toEqual([]);
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  it("leaves the status line alone and registers no shortcut when dashboard.enabled is false", async () => {
    const config = runtimeConfig();
    config.dashboard.enabled = false;
    const { calls, pi, shortcuts } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store: createRuntimeStore() });
    const host = createUiMock();
    const ctx = { ...createContext("session-no-dashboard"), ...host.ctx };

    await turnEnd(calls, ctx, 0);
    expect(host.ui.setStatus).not.toHaveBeenCalled();
    expect(shortcuts.size).toBe(0);
  });

  it("skips both surfaces when ctx.hasUI is false", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-headless-"));
    const store = createRuntimeStore();
    const { calls, commands, pi } = createPiMock();
    registerExtension(pi, { store });
    const host = createUiMock({ hasUI: false });
    const ctx = { ...createContext("session-headless", projectDir), ...host.ctx };
    try {
      await turnEnd(calls, ctx, 0);
      expect(host.ui.setStatus).not.toHaveBeenCalled();

      await commands.get("pcn")?.handler("dashboard", ctx);
      expect(host.custom).not.toHaveBeenCalled();
      expect(host.notify).toHaveBeenCalledWith(expect.stringContaining("no interactive UI"), "warning");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("opens the overlay from /pcn dashboard with the analytics snapshot", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-open-"));
    const store = createRuntimeStore();
    const { calls, commands, pi } = createPiMock();
    registerExtension(pi, { store });
    const host = createUiMock();
    const ctx = { ...createContext("session-open", projectDir), ...host.ctx };
    try {
      await turnEnd(calls, ctx, 0);
      creditKeptOut(store.sessionMap.get("session-open")!, "call-y", "error_purge", 12_345);
      await turnEnd(calls, ctx, 1);

      const opening = commands.get("pcn")?.handler("dashboard", ctx);
      expect(host.custom).toHaveBeenCalledTimes(1);
      expect(host.overlay?.options).toEqual({ overlay: true });
      const lines = host.overlay!.component.render(100);
      expect(lines).toContain("Kept out    session 12.3k   project 12.3k   lifetime 12.3k");
      expect(lines.some((line) => line.startsWith("  error_purge"))).toBe(true);
      expect(host.notify).not.toHaveBeenCalled();

      host.overlay!.component.handleInput!("\x1b");
      await opening;
      expect(store.dashboardSurfaces.isOverlayOpen("session-open")).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("warns from /pcn dashboard when the dashboard is disabled for the project", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-off-"));
    const { commands, pi } = createPiMock();
    registerExtension(pi, { store: createRuntimeStore() });
    const host = createUiMock();
    const ctx = { ...createContext("session-off", projectDir), ...host.ctx };
    try {
      disableProjectDashboard(projectDir);
      await commands.get("pcn")?.handler("dashboard", ctx);
      expect(host.custom).not.toHaveBeenCalled();
      expect(host.notify).toHaveBeenCalledWith(expect.stringContaining("disabled for this project"), "warning");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("registers the overlay shortcut from dashboard.shortcut", async () => {
    const config = runtimeConfig();
    config.dashboard.shortcut = "ctrl+alt+d";
    const store = createRuntimeStore();
    const { calls, pi, shortcuts } = createPiMock();
    createExtensionRuntime(pi, config, undefined, { store });
    expect([...shortcuts.keys()]).toEqual(["ctrl+alt+d"]);

    const host = createUiMock();
    const ctx = { ...createContext("session-shortcut"), ...host.ctx };
    await turnEnd(calls, ctx, 0);

    const opening = shortcuts.get("ctrl+alt+d")!.handler(ctx);
    expect(host.custom).toHaveBeenCalledTimes(1);
    host.overlay!.component.handleInput!("\x1b");
    await opening;
    expect(store.dashboardSurfaces.isOverlayOpen("session-shortcut")).toBe(false);
  });

  it("shows the degraded reason in the overlay when the analytics store throws", async () => {
    const store = createRuntimeStore();
    const { calls, pi } = createPiMock();
    const brokenStore = {
      recordTurn: () => {
        throw new Error("disk full");
      },
      getDashboardSnapshot: () => {
        throw new Error("disk full");
      },
      getStrategyImpactTotals: () => ({}),
      close: () => {},
    };
    const controls = createExtensionRuntime(pi, runtimeConfig(), undefined, {
      store,
      createAnalyticsStore: () => brokenStore as any,
    });
    const host = createUiMock();
    const ctx = { ...createContext("session-broken"), ...host.ctx };

    await turnEnd(calls, ctx, 0);
    expect(host.status.get(STATUS_KEY)).toBe("pcn 0 kept out");
    creditKeptOut(store.sessionMap.get("session-broken")!, "call-b", "truncation", 500);
    await turnEnd(calls, ctx, 1);
    expect(host.status.get(STATUS_KEY)).toBe("pcn 500 kept out");

    const opening = controls.openDashboard(ctx);
    const lines = host.overlay!.component.render(100);
    expect(lines).toContain("Analytics unavailable: disk full. Live session counters only.");
    expect(lines).toContain("Kept out    session 500   project n/a   lifetime n/a");
    host.overlay!.component.handleInput!("\x1b");
    await expect(opening).resolves.toEqual({ opened: true });
  });

  it("refreshes an open overlay at turn_end", async () => {
    const store = createRuntimeStore();
    const { calls, pi } = createPiMock();
    const controls = createExtensionRuntime(pi, runtimeConfig(), undefined, { store });
    const host = createUiMock();
    const ctx = { ...createContext("session-refresh"), ...host.ctx };
    await turnEnd(calls, ctx, 0);

    const opening = controls.openDashboard(ctx);
    const tui = host.overlay!.tui;
    creditKeptOut(store.sessionMap.get("session-refresh")!, "call-z", "dedup", 2000);
    await turnEnd(calls, ctx, 1);

    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    expect(host.overlay!.component.render(100)).toContain("Kept out    session 2k   project 2k   lifetime 2k");
    host.overlay!.component.handleInput!("\x1b");
    await expect(opening).resolves.toEqual({ opened: true });
  });

  it("releases the status-line item and closes the analytics store on session_shutdown", async () => {
    const closeSpy = vi.fn();
    const store = createRuntimeStore();
    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, runtimeConfig(), undefined, {
      store,
      createAnalyticsStore: (options) => {
        const real = createAnalyticsStore(options);
        return {
          ...real,
          close: () => {
            closeSpy();
            real.close();
          },
        };
      },
    });
    const host = createUiMock();
    const ctx = { ...createContext("session-shutdown-surfaces"), ...host.ctx };

    await turnEnd(calls, ctx, 0);
    expect(host.status.get(STATUS_KEY)).toBe("pcn 0 kept out");

    await calls.get("session_shutdown")?.({}, ctx);
    expect(host.status.get(STATUS_KEY)).toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(store.dashboardSurfaces.activeSessions()).toEqual([]);
    expect(store.analyticsStoresBySession.size).toBe(0);
  });
});
