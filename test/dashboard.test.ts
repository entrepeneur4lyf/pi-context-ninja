import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { once } from "node:events";
import { createExtensionRuntime } from "../src/runtime/create-extension-runtime.js";
import { defaultConfig } from "../src/config.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startDashboardServer } from "../src/dashboard/server.js";
import { renderDashboardPage } from "../src/dashboard/pages.js";
import { createAnalyticsStore } from "../src/analytics/store.js";

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

function createDashboardScriptHarness({ search = "" }: { search?: string } = {}) {
  const html = renderDashboardPage();
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) {
    throw new Error("expected inline dashboard script");
  }

  const elements = new Map(
    [
      ["events", { textContent: "", scrollTop: 0, scrollHeight: 0 }],
      ["session-id", { textContent: "--" }],
      ["ctx-pct", { textContent: "--%" }],
      ["kept-out", { textContent: "--" }],
      ["turns", { textContent: "--" }],
    ].map(([id, element]) => [id, element as { textContent: string; scrollTop?: number; scrollHeight?: number }]),
  );

  const eventSources: Array<{
    url: string;
    closed: boolean;
    onmessage: ((event: { data: string }) => void) | null;
  }> = [];
  const replaceStateUrls: string[] = [];
  const location = {
    search,
    pathname: "/",
    origin: "http://localhost",
  };
  const history = {
    replaceState(_state: unknown, _title: string, url: string) {
      replaceStateUrls.push(url);
      const next = new URL(url, location.origin);
      location.pathname = next.pathname;
      location.search = next.search;
    },
  };

  const context = {
    JSON,
    URL,
    URLSearchParams,
    encodeURIComponent,
    EventSource: class {
      private source;

      constructor(url: string) {
        this.source = { url, closed: false, onmessage: null as ((event: { data: string }) => void) | null };
        eventSources.push(this.source);
        Object.defineProperty(this, "onmessage", {
          configurable: true,
          enumerable: true,
          get() {
            return this.source.onmessage;
          },
          set(value: ((event: { data: string }) => void) | null) {
            this.source.onmessage = value;
          },
        });
      }

      close() {
        this.source.closed = true;
      }
    },
    history,
    location,
    window: { history, location },
    document: {
      getElementById(id: string) {
        const element = elements.get(id);
        if (!element) {
          throw new Error(`missing test element: ${id}`);
        }
        return element;
      },
    },
  };

  vm.runInNewContext(scriptMatch[1], context);

  if (!eventSources.at(-1)?.onmessage) {
    throw new Error("expected EventSource onmessage handler");
  }

  return {
    dispatchSnapshot(data: unknown) {
      eventSources.at(-1)?.onmessage?.({
        data: JSON.stringify({ type: "snapshot", data }),
      });
    },
    getText(id: string) {
      const element = elements.get(id);
      if (!element) {
        throw new Error(`missing test element: ${id}`);
      }
      return element.textContent;
    },
    getEventSourceUrls() {
      return eventSources.map((source) => source.url);
    },
    getClosedEventSourceUrls() {
      return eventSources.filter((source) => source.closed).map((source) => source.url);
    },
    getReplaceStateUrls() {
      return replaceStateUrls;
    },
  };
}

describe("dashboard server", () => {
  it("redirects the default dashboard page to the active session and broadcasts scoped snapshots", async () => {
    const server = startDashboardServer({ port: 0, host: "127.0.0.1" });
    await once(server.server, "listening");

    try {
      const address = server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
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

      const redirect = await fetch(`${baseUrl}/`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/?sessionId=session-a");

      const html = await fetch(`${baseUrl}/?sessionId=session-a`).then((res) => res.text());
      expect(html).toContain("Pi Context Ninja");
      expect(html).toContain("URLSearchParams");
      expect(html).toContain("Tokens Kept Out");
      expect(html).toContain("Session");
      expect(html).toContain("session-id");
      expect(html).not.toContain("Tokens Saved");

      const response = await fetch(`${baseUrl}/events?sessionId=session-a`);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("expected SSE response body");
      }

      const decoder = new TextDecoder();
      const initial = decoder.decode((await reader.read()).value);
      expect(initial).toContain('"type":"connected"');
      expect(initial).toContain('"type":"snapshot"');
      expect(initial).toContain('"sessionId":"session-a"');

      await reader.cancel();
    } finally {
      await server.close();
    }
  });

  it("reuses one dashboard instance across session runtimes on the same port without drifting the default page", async () => {
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

    const snapshotA = await fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-a`).then((res) => res.json());
    expect(snapshotA.sessionId).toBe("session-a");
    expect(snapshotA.totalTurns).toBe(1);
    expect(snapshotA.context.tokens).toBe(420);

    const snapshotB = await fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-b`).then((res) => res.json());
    expect(snapshotB.sessionId).toBe("session-b");
    expect(snapshotB.totalTurns).toBe(1);
    expect(snapshotB.context.tokens).toBe(300);
    expect(snapshotB.totals.tokensKeptOutApprox).toBe(0);

    const defaultRedirect = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    expect(defaultRedirect.status).toBe(302);
    expect(defaultRedirect.headers.get("location")).toBe("/?sessionId=session-b");

    await expect(callsB.get("session_shutdown")?.({}, ctxB)).resolves.toBeUndefined();

    const fallbackRedirect = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    expect(fallbackRedirect.status).toBe(302);
    expect(fallbackRedirect.headers.get("location")).toBe("/?sessionId=session-a");

    const fallbackSnapshot = await fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-a`).then((res) => res.json());
    expect(fallbackSnapshot.sessionId).toBe("session-a");
    expect(fallbackSnapshot.totalTurns).toBe(1);
    expect(fallbackSnapshot.context.tokens).toBe(420);

    const clearedSnapshot = await fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-b`).then((res) => res.json());
    expect(clearedSnapshot).toBeNull();

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

  it("subscribes to the sessionId in the page URL when present", () => {
    const page = createDashboardScriptHarness({ search: "?sessionId=session-a" });

    expect(page.getEventSourceUrls()).toEqual(["/events?sessionId=session-a"]);
  });

  it("locks an initially unscoped page to the first session snapshot it receives", () => {
    const page = createDashboardScriptHarness();

    expect(page.getEventSourceUrls()).toEqual(["/events"]);

    page.dispatchSnapshot({
      sessionId: "session-a",
      context: { percent: 0.42 },
      totals: { tokensKeptOutApprox: 144 },
      totalTurns: 3,
    });

    expect(page.getReplaceStateUrls()).toEqual(["/?sessionId=session-a"]);
    expect(page.getClosedEventSourceUrls()).toEqual(["/events"]);
    expect(page.getEventSourceUrls()).toEqual(["/events", "/events?sessionId=session-a"]);
  });

  it("resets stale dashboard stat fields when the next snapshot omits them", () => {
    const page = createDashboardScriptHarness();

    page.dispatchSnapshot({
      sessionId: "session-a",
      context: { percent: 0.42 },
      totals: { tokensKeptOutApprox: 144 },
      totalTurns: 3,
    });

    expect(page.getText("session-id")).toBe("session-a");
    expect(page.getText("ctx-pct")).toBe("42.0%");
    expect(page.getText("kept-out")).toBe("144");
    expect(page.getText("turns")).toBe("3");

    page.dispatchSnapshot({
      sessionId: null,
      context: { percent: null },
      totals: { tokensKeptOutApprox: null },
      totalTurns: null,
    });

    expect(page.getText("session-id")).toBe("--");
    expect(page.getText("ctx-pct")).toBe("--%");
    expect(page.getText("kept-out")).toBe("--");
    expect(page.getText("turns")).toBe("--");
  });
});

describe("runtime integration", () => {
  it("records analytics but does not publish when only dashboard is disabled for the project", async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a bound probe port");
    }
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-disabled-"));
    fs.mkdirSync(path.join(projectDir, ".pi", ".pi-ninja"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_dashboard_disabled"), "", "utf8");

    const piCalls = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        piCalls.set(name, handler);
      }),
    } as unknown as ExtensionAPI;

    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(tmpDir, "analytics-dashboard-disabled.sqlite");
    config.dashboard.enabled = true;
    config.dashboard.port = port;
    config.dashboard.bindHost = "127.0.0.1";

    try {
      createExtensionRuntime(pi, config);

      const ctx = {
        cwd: projectDir,
        sessionManager: {
          getSessionId: () => "session-dashboard-disabled",
          getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
        getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
      } as any;

      await piCalls.get("turn_end")?.(
        {
          turnIndex: 0,
          message: { role: "assistant", content: "done" },
          toolResults: [],
        },
        ctx,
      );

      const analyticsStore = createAnalyticsStore({ dbPath: config.analytics.dbPath });
      const snapshot = analyticsStore.getSnapshot("session-dashboard-disabled");
      analyticsStore.close();

      expect(snapshot.totalTurns).toBe(1);
      expect(snapshot.context.tokens).toBe(420);

      await expect(fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-dashboard-disabled`)).rejects.toThrow();
      await piCalls.get("session_shutdown")?.({}, ctx);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("initializes analytics and dashboard once, records turn analytics, and shuts down cleanly", async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a bound probe port");
    }
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

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
    config.dashboard.port = port;
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

    const snapshot = await fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-a`).then((res) => res.json());
    expect(snapshot.totalTurns).toBe(1);
    expect(snapshot.context.tokens).toBe(420);
    expect(snapshot.totals.tokensSavedApprox).toBeGreaterThanOrEqual(0);

    await piCalls.get("session_shutdown")?.({}, ctx);

    await expect(fetch(`http://127.0.0.1:${port}/snapshot`)).rejects.toThrow();
  });
});
