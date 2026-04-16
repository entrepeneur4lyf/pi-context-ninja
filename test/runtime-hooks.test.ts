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
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const pi = {
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      calls.set(name, handler);
    }),
    registerCommand: vi.fn((name: string, options: { handler: (...args: unknown[]) => unknown }) => {
      commands.set(name, options);
    }),
  } as unknown as ExtensionAPI;

  return { calls, commands, pi };
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
      registerCommand: vi.fn(),
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

  it("registers the /pcn command surface", () => {
    const { pi } = createPiMock();

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
    const { commands, pi } = createPiMock();
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
      expect(fs.existsSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_disabled"))).toBe(true);

      await commands.get("pcn")?.handler("enable", ctx);
      expect(fs.existsSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_disabled"))).toBe(false);

      await commands.get("pcn")?.handler("disable dashboard", ctx);
      expect(fs.existsSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_dashboard_disabled"))).toBe(true);

      await commands.get("pcn")?.handler("enable dashboard", ctx);
      expect(fs.existsSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_dashboard_disabled"))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.each(["disable", "disable dashboard"])(
    "revokes the active dashboard session immediately when `/pcn %s` runs",
    async (command) => {
      const dashboardHandle = {
        ready: Promise.resolve(),
        close: vi.fn(async () => {}),
        clearSession: vi.fn(),
        publish: vi.fn(),
      };
      const startDashboardServerMock = vi.fn(() => dashboardHandle);

      vi.resetModules();
      vi.doMock("../src/dashboard/server.js", () => ({
        startDashboardServer: startDashboardServerMock,
      }));

      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-command-revoke-"));
      const sessionId = `session-${command.replace(/\s+/g, "-")}`;
      const ctx = {
        ...createContext(sessionId, projectDir),
        ui: {
          notify: vi.fn(),
        },
      } as any;

      try {
        const { default: registerExtensionWithMockedDashboard } = await import("../src/index.js");
        const { commands, calls, pi } = createPiMock();
        registerExtensionWithMockedDashboard(pi);

        await calls.get("turn_end")?.(
          {
            turnIndex: 0,
            message: { role: "assistant", content: "first turn" },
            toolResults: [],
          },
          ctx,
        );

        expect(startDashboardServerMock).toHaveBeenCalledTimes(1);

        dashboardHandle.clearSession.mockClear();
        dashboardHandle.close.mockClear();

        await commands.get("pcn")?.handler(command, ctx);

        expect(dashboardHandle.clearSession).toHaveBeenCalledWith(sessionId);
        expect(dashboardHandle.close).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.resolve();
        vi.doUnmock("../src/dashboard/server.js");
        vi.resetModules();
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["disable", "disable dashboard"])(
    "revokes all active dashboard sessions for the same project when `/pcn %s` runs",
    async (command) => {
      const dashboardHandle = {
        ready: Promise.resolve(),
        close: vi.fn(async () => {}),
        clearSession: vi.fn(),
        publish: vi.fn(),
      };
      const startDashboardServerMock = vi.fn(() => dashboardHandle);

      vi.resetModules();
      vi.doMock("../src/dashboard/server.js", () => ({
        startDashboardServer: startDashboardServerMock,
      }));

      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-command-revoke-all-"));
      const sessionA = `session-a-${command.replace(/\s+/g, "-")}`;
      const sessionB = `session-b-${command.replace(/\s+/g, "-")}`;
      const ctxA = {
        ...createContext(sessionA, projectDir),
        ui: {
          notify: vi.fn(),
        },
      } as any;
      const ctxB = {
        ...createContext(sessionB, projectDir),
        ui: {
          notify: vi.fn(),
        },
      } as any;

      try {
        const { default: registerExtensionWithMockedDashboard } = await import("../src/index.js");
        const { commands, calls, pi } = createPiMock();
        registerExtensionWithMockedDashboard(pi);

        await calls.get("turn_end")?.(
          {
            turnIndex: 0,
            message: { role: "assistant", content: "first turn" },
            toolResults: [],
          },
          ctxA,
        );
        await calls.get("turn_end")?.(
          {
            turnIndex: 1,
            message: { role: "assistant", content: "second turn" },
            toolResults: [],
          },
          ctxB,
        );

        expect(startDashboardServerMock).toHaveBeenCalledTimes(1);

        dashboardHandle.clearSession.mockClear();
        dashboardHandle.close.mockClear();

        await commands.get("pcn")?.handler(command, ctxA);

        expect(dashboardHandle.clearSession).toHaveBeenCalledTimes(2);
        expect(dashboardHandle.clearSession).toHaveBeenCalledWith(sessionA);
        expect(dashboardHandle.clearSession).toHaveBeenCalledWith(sessionB);
        expect(dashboardHandle.close).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.resolve();
        vi.doUnmock("../src/dashboard/server.js");
        vi.resetModules();
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps /pcn registered when runtime config loading fails during startup", () => {
    const { commands, pi } = createPiMock();
    const brokenConfigPath = path.join(stateDir, "broken-config.yaml");
    fs.writeFileSync(brokenConfigPath, "strategies: [broken", "utf8");
    process.env.PCN_CONFIG_PATH = brokenConfigPath;

    expect(() => registerExtension(pi)).not.toThrow();
    expect(commands.has("pcn")).toBe(true);
  });

  it("reports degraded config state through /pcn status, /pcn doctor, and /pcn export", async () => {
    const { commands, pi } = createPiMock();
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
      expect(reportPath).toContain(path.join(projectDir, ".pi", ".pi-ninja", "reports"));
      expect(fs.existsSync(reportPath)).toBe(true);
      expect(fs.readFileSync(reportPath, "utf8")).toContain("Runtime loaded: no");
      expect(fs.readFileSync(reportPath, "utf8")).toContain("Runtime configuration could not be loaded.");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports live dashboard runtime degradation through /pcn status after startup", async () => {
    const dashboardStartError = new Error("bind EADDRINUSE 127.0.0.1:48900");
    const dashboardHandle = {
      ready: {
        then(_resolve: (value: never) => void, reject: (reason: unknown) => void) {
          reject(dashboardStartError);
        },
      } as Promise<never>,
      close: vi.fn(async () => {}),
      clearSession: vi.fn(),
      publish: vi.fn(),
    };
    const startDashboardServerMock = vi.fn(() => dashboardHandle);

    vi.resetModules();
    vi.doMock("../src/dashboard/server.js", () => ({
      startDashboardServer: startDashboardServerMock,
    }));

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-live-dashboard-degraded-"));
    const notify = vi.fn();
    const ctx = {
      ...createContext("session-live-dashboard-degraded", projectDir),
      ui: { notify },
    } as any;

    try {
      const { default: registerExtensionWithMockedDashboard } = await import("../src/index.js");
      const { commands, calls, pi } = createPiMock();
      registerExtensionWithMockedDashboard(pi);

      await commands.get("pcn")?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("PCN full"), "info");

      notify.mockClear();
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

      await commands.get("pcn")?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("PCN degraded"), "info");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Dashboard server failed to start"), "info");
      expect(startDashboardServerMock).toHaveBeenCalledTimes(1);
      expect(dashboardHandle.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("../src/dashboard/server.js");
      vi.resetModules();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("warns for invalid /pcn arguments", async () => {
    const { commands, pi } = createPiMock();
    const notify = vi.fn();

    registerExtension(pi);

    await commands.get("pcn")?.handler("unknown", {
      ...createContext("session-invalid-args"),
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith(
      "Usage: /pcn status|doctor|export|enable|disable|enable dashboard|disable dashboard",
      "warning",
    );
  });

  it("warns when /pcn runs without a project cwd", async () => {
    const { commands, pi } = createPiMock();
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

  it("persists once-per-session system hint state across runtime reloads", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const sessionId = "session-hint-persisted";
    const ctx = createContext(sessionId);

    const firstRuntime = createPiMock();
    createExtensionRuntime(firstRuntime.pi, config);

    const first = await firstRuntime.calls.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      ctx,
    );

    expect(first).toEqual({ systemPrompt: "base\n\nKeep the context small." });

    await firstRuntime.calls.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

    const secondRuntime = createPiMock();
    createExtensionRuntime(secondRuntime.pi, config);

    const second = await secondRuntime.calls.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      ctx,
    );

    expect(second).toBeUndefined();
  });

  it("falls back to a fresh session state when persisted session JSON is malformed", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const sessionId = "session-corrupt-state";
    fs.writeFileSync(path.join(stateDir, `${encodeURIComponent(sessionId)}.json`), "{\"currentTurn\":", "utf8");

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const result = await calls.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      createContext(sessionId),
    );

    expect(result).toEqual({ systemPrompt: "base\n\nKeep the context small." });

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState(sessionId);
    expect(persisted).not.toBeNull();
    expect(persisted?.projectPath).toBe("/tmp/project");
    expect(persisted?.systemHintState).toEqual({
      appliedOnce: true,
      lastAppliedText: "Keep the context small.",
    });
    expect(persisted?.turnHistory).toEqual([]);
  });

  it("falls back to a fresh session state when persisted session state is parseable but structurally invalid", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.systemHint.enabled = true;
    config.systemHint.frequency = "once_per_session";
    config.systemHint.text = "Keep the context small.";

    const sessionId = "session-invalid-structure";
    fs.writeFileSync(
      path.join(stateDir, `${encodeURIComponent(sessionId)}.json`),
      JSON.stringify({
        currentTurn: "wrong-type",
        projectPath: 42,
        turnHistory: "wrong-type",
      }),
      "utf8",
    );

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const result = await calls.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "question",
        images: undefined,
        systemPrompt: "base",
      },
      createContext(sessionId),
    );

    expect(result).toEqual({ systemPrompt: "base\n\nKeep the context small." });

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState(sessionId);
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

  it("passes through data-plane hooks and skips bookkeeping when the project is disabled", async () => {
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(stateDir, "analytics-disabled.sqlite");
    config.dashboard.enabled = true;

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-disabled-project-"));
    fs.mkdirSync(path.join(projectDir, ".pi", ".pi-ninja"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_disabled"), "", "utf8");

    try {
      const { calls, pi } = createPiMock();
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

      const { loadSessionState } = await loadStateStore();
      expect(loadSessionState("session-disabled")).toBeNull();
      expect(fs.existsSync(config.analytics.dbPath)).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not expand already shortened tool results during background pruning", async () => {
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

    await calls.get("turn_end")?.(
      {
        turnIndex: 6,
        message: { role: "assistant", content: "later" },
        toolResults: [],
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
            content: [{ type: "text", text: "[ok]" }],
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
            content: [{ type: "text", text: "[ok]" }],
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
    expect(contextResult.messages?.[2]?.content[0]?.text).toBe("[ok]");

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-background-index");
    expect(persisted?.pruneTargets).toHaveLength(1);
    expect(persisted?.tokensSavedByType.background_index ?? 0).toBe(0);
    expect(persisted?.tokensKeptOutByType.background_index ?? 0).toBe(0);
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
      lastIndexedTurn: -1,
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

    await calls.get("turn_end")?.(
      {
        turnIndex: 9,
        message: { role: "assistant", content: "later" },
        toolResults: [],
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

    await calls.get("turn_end")?.(
      {
        turnIndex: 6,
        message: { role: "assistant", content: "later" },
        toolResults: [],
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
        turnIndex: 7,
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
      turnIndex: 7,
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

  it("does not deduplicate resumed inferred tool results when rebuild lacks input provenance", async () => {
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

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState(sessionId);
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

  it("isolates analytics recordTurn failures from turn persistence and evicts the broken session store", async () => {
    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(stateDir, "analytics.sqlite");
    config.dashboard.enabled = false;

    const brokenStore = {
      recordTurn: vi.fn(() => {
        throw new Error("analytics write failed");
      }),
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
        percent: 0.42,
        window: 1000,
      },
      latestTurn: null,
      recentTurns: [],
    };
    const healthyStore = {
      recordTurn: vi.fn(() => healthySnapshot),
      getSnapshot: vi.fn(() => healthySnapshot),
      close: vi.fn(),
    };
    const createAnalyticsStoreMock = vi
      .fn()
      .mockReturnValueOnce(brokenStore)
      .mockReturnValueOnce(healthyStore);

    vi.resetModules();
    vi.doMock("../src/analytics/store.js", () => ({
      createAnalyticsStore: createAnalyticsStoreMock,
    }));

    try {
      const { createExtensionRuntime: createRuntimeWithMockedAnalytics } = await import(
        "../src/runtime/create-extension-runtime.js"
      );

      const { calls, pi } = createPiMock();
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

      const { loadSessionState } = await loadStateStore();
      let persisted = loadSessionState("session-analytics-failure");
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

      persisted = loadSessionState("session-analytics-failure");
      expect(persisted?.currentTurn).toBe(2);
      expect(persisted?.turnHistory).toHaveLength(2);
      expect(createAnalyticsStoreMock).toHaveBeenCalledTimes(2);
      expect(healthyStore.recordTurn).toHaveBeenCalledTimes(1);
      expect(healthyStore.close).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/analytics/store.js");
      vi.resetModules();
    }
  });

  it("backfills first-observed tool turn indices from turn_end so resumed sessions do not age fresh results as stale", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = true;
    config.strategies.errorPurge.maxTurnsAgo = 3;
    config.strategies.deduplication.enabled = false;

    const { calls, pi } = createPiMock();
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

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-midstream");
    expect(persisted?.toolCalls).toEqual([
      [
        "read-midstream",
        expect.objectContaining({
          turnIndex: 12,
          isError: true,
        }),
      ],
    ]);
    expect(persisted?.pruneTargets).toEqual([]);
    expect(readIndexEntries(getIndexPath("/tmp/project"))).toEqual([]);
  });

  it("overwrites stale resumed positive turn indices with the later authoritative turn_end turn", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = true;
    config.strategies.errorPurge.maxTurnsAgo = 3;
    config.strategies.deduplication.enabled = false;

    const sessionId = "session-resumed-stale-positive-turn";
    writeLegacyState(sessionId, {
      toolCalls: [],
      prunedToolIds: [],
      pruneTargets: [],
      lastIndexedTurn: -1,
      tokensKeptOutTotal: 0,
      tokensSaved: 0,
      tokensKeptOutByType: {},
      tokensSavedByType: {},
      currentTurn: 2,
      countedSavingsIds: [],
      turnHistory: [
        {
          turnIndex: 1,
          toolCount: 0,
          messageCountAfterTurn: 2,
          tokensKeptOutDelta: 0,
          tokensSavedDelta: 0,
          timestamp: 111,
        },
      ],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
    });

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext(sessionId);
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

    const { loadSessionState } = await loadStateStore();
    let persisted = loadSessionState(sessionId);
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

    persisted = loadSessionState(sessionId);
    expect(persisted?.pruneTargets).toEqual([]);
    expect(readIndexEntries(getIndexPath("/tmp/project"))).toEqual([]);
  });

  it("rebuilds missing tool records from context messages, survives reload, and lets later turn_end make the authoritative age apply", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.backgroundIndexing.enabled = true;
    config.backgroundIndexing.minRangeTurns = 1;
    config.strategies.shortCircuit.enabled = false;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = true;
    config.strategies.errorPurge.maxTurnsAgo = 3;
    config.strategies.deduplication.enabled = false;

    const sessionId = "session-rebuild-from-context";
    writeLegacyState(sessionId, {
      toolCalls: [],
      prunedToolIds: [],
      pruneTargets: [],
      lastIndexedTurn: -1,
      tokensKeptOutTotal: 0,
      tokensSaved: 0,
      tokensKeptOutByType: {},
      tokensSavedByType: {},
      currentTurn: 20,
      countedSavingsIds: [],
      turnHistory: [
        {
          turnIndex: 20,
          toolCount: 1,
          messageCountAfterTurn: 3,
          tokensKeptOutDelta: 0,
          tokensSavedDelta: 0,
          timestamp: 111,
        },
      ],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
    });

    const firstRuntime = createPiMock();
    createExtensionRuntime(firstRuntime.pi, config);

    const ctx = createContext(sessionId);
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

    const { loadSessionState } = await loadStateStore();
    let persisted = loadSessionState(sessionId);
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
    expect(persisted?.pruneTargets).toEqual([]);
    expect(readIndexEntries(getIndexPath("/tmp/project"))).toHaveLength(0);

    await firstRuntime.calls.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

    const secondRuntime = createPiMock();
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

    persisted = loadSessionState(sessionId);
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

    expect(readIndexEntries(getIndexPath("/tmp/project"))).toHaveLength(1);
  });

  it("uses the newest historical turn when currentTurn is missing and still rebuilds tool records safely", async () => {
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

    const sessionId = "session-rebuild-legacy-current-turn";
    writeLegacyState(sessionId, {
      toolCalls: [],
      prunedToolIds: [],
      pruneTargets: [],
      lastIndexedTurn: -1,
      tokensKeptOutTotal: 0,
      tokensSaved: 0,
      tokensKeptOutByType: {},
      tokensSavedByType: {},
      currentTurn: -1,
      countedSavingsIds: [],
      turnHistory: [
        {
          turnIndex: 2,
          toolCount: 1,
          messageCountAfterTurn: 3,
          tokensKeptOutDelta: 0,
          tokensSavedDelta: 0,
          timestamp: 111,
        },
        {
          turnIndex: 7,
          toolCount: 1,
          messageCountAfterTurn: 7,
          tokensKeptOutDelta: 0,
          tokensSavedDelta: 0,
          timestamp: 222,
        },
      ],
      projectPath: "/tmp/project",
      lastContextTokens: null,
      lastContextPercent: null,
      lastContextWindow: null,
    });

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext(sessionId);
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

    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState(sessionId);
    expect(persisted?.toolCalls).toEqual([
      [
        "legacy-fresh",
        expect.objectContaining({
          turnIndex: 7,
        }),
      ],
    ]);
    expect(persisted?.pruneTargets).toEqual([]);
    expect(readIndexEntries(getIndexPath("/tmp/project"))).toEqual([]);
  });

  it("applies immediate safe tool_result shaping only to successful single-text results", async () => {
    const config = defaultConfig();
    config.analytics.enabled = false;
    config.dashboard.enabled = false;
    config.strategies.shortCircuit.enabled = true;
    config.strategies.shortCircuit.minTokens = 0;
    config.strategies.codeFilter.enabled = false;
    config.strategies.truncation.enabled = false;
    config.strategies.errorPurge.enabled = false;
    config.strategies.deduplication.enabled = false;

    const { calls, pi } = createPiMock();
    createExtensionRuntime(pi, config);

    const ctx = createContext("session-tool-result-shaping");
    calls.get("tool_call")?.(
      {
        toolCallId: "call-shaped",
        toolName: "read",
        input: { path: "result.json" },
      },
      ctx,
    );

    const shaped = await calls.get("tool_result")?.(
      {
        toolCallId: "call-shaped",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "{\"status\":\"ok\",\"payload\":\"done\"}" }],
      },
      ctx,
    );

    const mixed = await calls.get("tool_result")?.(
      {
        toolCallId: "call-mixed",
        toolName: "read",
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
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "{\"status\":\"ok\"}" }],
      },
      ctx,
    );

    expect(shaped).toEqual({
      content: [{ type: "text", text: "[ok]" }],
    });
    expect(mixed).toBeUndefined();
    expect(errored).toBeUndefined();

    await calls.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    const { loadSessionState } = await loadStateStore();
    const persisted = loadSessionState("session-tool-result-shaping");
    expect(persisted?.toolCalls).toEqual([
      [
        "call-shaped",
        expect.objectContaining({
          toolCallId: "call-shaped",
          toolName: "read",
          isError: false,
          tokenEstimate: expect.any(Number),
          shapedContent: [{ type: "text", text: "[ok]" }],
        }),
      ],
      [
        "call-mixed",
        expect.objectContaining({
          toolCallId: "call-mixed",
          toolName: "read",
          isError: false,
          shapedContent: undefined,
        }),
      ],
      [
        "call-error",
        expect.objectContaining({
          toolCallId: "call-error",
          toolName: "read",
          isError: true,
          shapedContent: undefined,
        }),
      ],
    ]);
  });
});
