import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerExtension from "../src/index.js";

let stateDir = "";

async function loadStateStore() {
  vi.resetModules();
  return import("../src/persistence/state-store");
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-runtime-hooks-"));
  process.env.PCN_STATE_DIR = stateDir;
  process.env.PCN_CONFIG_PATH = path.join(stateDir, "missing-config.yaml");
});

afterEach(() => {
  delete process.env.PCN_STATE_DIR;
  delete process.env.PCN_CONFIG_PATH;
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  stateDir = "";
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

  it("records turn lifecycle usage and persists restartable bookkeeping", async () => {
    const calls = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        calls.set(name, handler as (...args: any[]) => unknown);
      }),
    } as unknown as ExtensionAPI;

    registerExtension(pi);

    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionId: () => "session-a",
        getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
      getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
    } as any;

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

    calls.get("turn_end")?.(
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
