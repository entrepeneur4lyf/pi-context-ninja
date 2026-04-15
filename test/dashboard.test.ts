import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createExtensionRuntime } from "../src/runtime/create-extension-runtime.js";
import { defaultConfig } from "../src/config.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startDashboardServer } from "../src/dashboard/server.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-"));
  process.env.PCN_STATE_DIR = path.join(tmpDir, "state");
});

afterEach(() => {
  delete process.env.PCN_STATE_DIR;
  delete process.env.PCN_CONFIG_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

async function readSseChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 100): Promise<string | null> {
  const result = await Promise.race([
    reader.read(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);

  if (result === null) {
    return null;
  }

  return new TextDecoder().decode(result.value);
}

describe("dashboard server", () => {
  it("serves the dashboard page, broadcasts snapshots, and closes cleanly", async () => {
    const server = startDashboardServer({ port: 0, host: "127.0.0.1" });
    await once(server.server, "listening");

    try {
      const address = server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      const html = await fetch(`${baseUrl}/`).then((res) => res.text());
      expect(html).toContain("Pi Context Ninja");
      expect(html).toContain("EventSource('/events')");
      expect(html).toContain("Tokens Kept Out");
      expect(html).toContain("Session");
      expect(html).toContain("session-id");
      expect(html).toContain("d==null");
      expect(html).toContain("function resetSnapshotStats()");
      expect(html).toContain("sessionIdEl.textContent='--'");
      expect(html).toContain("contextPctEl.textContent='--%'");
      expect(html).not.toContain("Tokens Saved");

      const response = await fetch(`${baseUrl}/events`);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("expected SSE response body");
      }

      const decoder = new TextDecoder();
      const initial = decoder.decode((await reader.read()).value);
      expect(initial).toContain('"type":"connected"');

      server.publish("session-a", {
        generatedAt: 1713081600000,
        sessionId: "session-a",
        projectPath: "/tmp/project",
        totalTurns: 1,
        totals: {
          tokensSavedApprox: 88,
          tokensKeptOutApprox: 144,
        },
        context: {
          tokens: 420,
          percent: 0.42,
          window: 1000,
        },
        latestTurn: null,
        recentTurns: [],
      });

      const next = decoder.decode((await reader.read()).value);
      expect(next).toContain('"type":"snapshot"');
      expect(next).toContain('"tokensSavedApprox":88');

      await reader.cancel();
    } finally {
      await server.close();
    }
  });

  it("reuses one dashboard instance across session runtimes on the same port", async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a bound probe port");
    }
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(tmpDir, "analytics-shared.sqlite");
    config.dashboard.enabled = true;
    config.dashboard.port = port;
    config.dashboard.bindHost = "127.0.0.1";

    const callsA = new Map<string, (...args: any[]) => unknown>();
    const piA = {
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        callsA.set(name, handler);
      }),
    } as unknown as ExtensionAPI;
    createExtensionRuntime(piA, config);

    const ctxA = {
      cwd: "/tmp/project-a",
      sessionManager: {
        getSessionId: () => "session-a",
        getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
      getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
    } as any;

    await expect(
      callsA.get("turn_end")?.(
        {
          turnIndex: 1,
          message: { role: "assistant", content: "done" },
          toolResults: [],
        },
        ctxA,
      ),
    ).resolves.toBeUndefined();

    const callsB = new Map<string, (...args: any[]) => unknown>();
    const piB = {
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        callsB.set(name, handler);
      }),
    } as unknown as ExtensionAPI;
    createExtensionRuntime(piB, config);

    const ctxB = {
      cwd: "/tmp/project-b",
      sessionManager: {
        getSessionId: () => "session-b",
        getEntries: () => [{ id: "m1" }, { id: "m2" }],
      },
      getContextUsage: () => ({ tokens: 300, percent: 0.3, contextWindow: 1000 }),
    } as any;

    await expect(
      callsB.get("turn_end")?.(
        {
          turnIndex: 2,
          message: { role: "assistant", content: "done" },
          toolResults: [],
        },
        ctxB,
      ),
    ).resolves.toBeUndefined();

    const snapshot = await fetch(`http://127.0.0.1:${port}/snapshot`).then((res) => res.json());
    expect(snapshot.sessionId).toBe("session-b");
    expect(snapshot.totalTurns).toBe(1);
    expect(snapshot.context.tokens).toBe(300);
    expect(snapshot.totals.tokensKeptOutApprox).toBe(0);

    await expect(callsB.get("session_shutdown")?.({}, ctxB)).resolves.toBeUndefined();

    const fallbackSnapshot = await fetch(`http://127.0.0.1:${port}/snapshot`).then((res) => res.json());
    expect(fallbackSnapshot.sessionId).toBe("session-a");
    expect(fallbackSnapshot.totalTurns).toBe(1);
    expect(fallbackSnapshot.context.tokens).toBe(420);

    await expect(callsA.get("session_shutdown")?.({}, ctxA)).resolves.toBeUndefined();
  });

  it("only delivers SSE snapshots to clients subscribed to that session", async () => {
    const server = startDashboardServer({ port: 0, host: "127.0.0.1" });
    await once(server.server, "listening");

    try {
      const address = server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${baseUrl}/events?sessionId=session-a`);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("expected SSE response body");
      }

      expect(await readSseChunk(reader)).toContain('"type":"connected"');

      server.publish("session-a", {
        generatedAt: 1713081600000,
        sessionId: "session-a",
        projectPath: "/tmp/project-a",
        totalTurns: 1,
        totals: {
          tokensSavedApprox: 10,
          tokensKeptOutApprox: 20,
        },
        context: {
          tokens: 100,
          percent: 0.1,
          window: 1000,
        },
        latestTurn: null,
        recentTurns: [],
      });

      const sessionAChunk = await readSseChunk(reader);
      expect(sessionAChunk).toContain('"type":"snapshot"');
      expect(sessionAChunk).toContain('"sessionId":"session-a"');

      server.publish("session-b", {
        generatedAt: 1713081600001,
        sessionId: "session-b",
        projectPath: "/tmp/project-b",
        totalTurns: 1,
        totals: {
          tokensSavedApprox: 30,
          tokensKeptOutApprox: 40,
        },
        context: {
          tokens: 300,
          percent: 0.3,
          window: 1000,
        },
        latestTurn: null,
        recentTurns: [],
      });

      expect(await readSseChunk(reader)).toBeNull();
      await reader.cancel();
    } finally {
      await server.close();
    }
  });
});

describe("runtime integration", () => {
  it("initializes analytics and dashboard once, records turn analytics, and shuts down cleanly", async () => {
    const piCalls = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        piCalls.set(name, handler);
      }),
    } as unknown as ExtensionAPI;

    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(tmpDir, "analytics.sqlite");
    config.dashboard.enabled = true;
    config.dashboard.port = 49123;
    config.dashboard.bindHost = "127.0.0.1";

    createExtensionRuntime(pi, config);

    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionId: () => "session-a",
        getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
      getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
    } as any;

    await piCalls.get("turn_end")?.(
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

    const snapshot = await fetch("http://127.0.0.1:49123/snapshot").then((res) => res.json());
    expect(snapshot.totalTurns).toBe(1);
    expect(snapshot.context.tokens).toBe(420);
    expect(snapshot.totals.tokensSavedApprox).toBeGreaterThanOrEqual(0);

    await piCalls.get("session_shutdown")?.({}, ctx);

    await expect(fetch("http://127.0.0.1:49123/snapshot")).rejects.toThrow();
  });
});
