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
import registerExtension from "../src/index.js";
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

async function readSsePayload(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxChunks = 3,
  timeoutMs = 100,
): Promise<string> {
  let payload = "";

  for (let index = 0; index < maxChunks; index += 1) {
    const chunk = await readSseChunk(reader, timeoutMs);
    if (chunk === null) {
      break;
    }
    payload += chunk;
  }

  return payload;
}

function countSseEventType(payload: string, type: string): number {
  return (payload.match(new RegExp(`"type":"${type}"`, "g")) ?? []).length;
}

async function getAvailablePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a bound probe port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function fetchJsonWithRetry(url: string, attempts = 20, delayMs = 25): Promise<any> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`unexpected status ${response.status} for ${url}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function createDashboardScriptHarness({ search = "" }: { search?: string } = {}) {
  const html = renderDashboardPage();
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) {
    throw new Error("expected inline dashboard script");
  }

  function makeElement(initialText = "") {
    let text = initialText;
    let html = "";
    let className = "";

    return {
      scrollTop: 0,
      scrollHeight: 0,
      get className() {
        return className;
      },
      set className(value: string) {
        className = value;
      },
      get textContent() {
        return text;
      },
      set textContent(value: string) {
        text = value;
        html = value;
      },
      get innerHTML() {
        return html;
      },
      set innerHTML(value: string) {
        html = value;
        text = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      },
    };
  }

  const elementEntries: Array<[string, ReturnType<typeof makeElement>]> = [
    ["session-id", makeElement("--")],
    ["health-status", makeElement("Booting")],
    ["ctx-pct", makeElement("--%")],
    ["live-turns", makeElement("--")],
    ["live-tool-calls", makeElement("--")],
    ["ctx-window", makeElement("-- / --")],
    ["session-saved", makeElement("--")],
    ["project-saved", makeElement("--")],
    ["lifetime-saved", makeElement("--")],
    ["impact-count", makeElement("--")],
    ["project-path", makeElement("--")],
    ["impact-ledger", makeElement("")],
    ["scope-chart", makeElement("")],
    ["strategy-chart", makeElement("")],
    ["live-feed", makeElement("")],
  ];

  const elements = new Map<string, ReturnType<typeof makeElement>>(elementEntries);

  const eventSources: Array<{
    url: string;
    closed: boolean;
    onmessage: ((event: { data: string }) => void) | null;
  }> = [];
  const fetchUrls: string[] = [];
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
    Promise,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    fetch(url: string) {
      fetchUrls.push(url);

      if (url === "/snapshot?sessionId=session-a" || url === "/snapshot") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessionId: "session-a",
            projectPath: "/tmp/project-a",
            context: { tokens: 420, percent: 0.375, window: 1000 },
            scopes: {
              session: {
                tokensSavedApprox: 55,
                tokensKeptOutApprox: 144,
                turnCount: 3,
              },
              project: {
                tokensSavedApprox: 120,
                tokensKeptOutApprox: 320,
                turnCount: 8,
              },
              lifetime: {
                tokensSavedApprox: 220,
                tokensKeptOutApprox: 640,
                turnCount: 14,
              },
            },
            live: {
              turnCount: 3,
              toolCallCount: 7,
            },
            strategyTotals: {
              short_circuit: 55,
              deduplication: 34,
              truncation: 18,
              code_filter: 11,
            },
          }),
        });
      }

      if (url === "/history?sessionId=session-a" || url === "/history") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              timestamp: 1713081600000,
              toolName: "read",
              strategy: "short_circuit",
              tokensSavedApprox: 12,
              tokensKeptOutApprox: 24,
              contextPercent: 0.375,
              summary: "Short-circuited repeated read output.",
            },
          ],
        });
      }

      throw new Error(`unexpected fetch url: ${url}`);
    },
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

  return {
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    dispatchSnapshot(data: unknown) {
      eventSources.at(-1)?.onmessage?.({
        data: JSON.stringify({ type: "snapshot", data }),
      });
    },
    dispatchImpact(data: unknown) {
      eventSources.at(-1)?.onmessage?.({
        data: JSON.stringify({ type: "impact", data }),
      });
    },
    getText(id: string) {
      const element = elements.get(id);
      if (!element) {
        throw new Error(`missing test element: ${id}`);
      }
      return element.textContent;
    },
    getHtml(id: string) {
      const element = elements.get(id) as { innerHTML?: string } | undefined;
      if (!element) {
        throw new Error(`missing test element: ${id}`);
      }
      return element.innerHTML ?? "";
    },
    getClassName(id: string) {
      const element = elements.get(id) as { className?: string } | undefined;
      if (!element) {
        throw new Error(`missing test element: ${id}`);
      }
      return element.className ?? "";
    },
    getFetchUrls() {
      return fetchUrls;
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

      const htmlResponse = await fetch(`${baseUrl}/?sessionId=session-a`);
      expect(htmlResponse.headers.get("cache-control")).toBe("no-store");
      const html = await htmlResponse.text();
      expect(html).toContain("Pi Context Ninja");
      expect(html).toContain("Control Tower");
      expect(html).toContain("Impact Ledger");
      expect(html).toContain("Live Feed");
      expect(html).toContain("session-id");
      expect(html).toContain("impact-ledger");
      expect(html).not.toContain("<pre id=\"events\">");

      const response = await fetch(`${baseUrl}/events?sessionId=session-a`);
      expect(response.headers.get("cache-control")).toBe("no-store");
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

    try {
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

      const snapshotA = await fetchJsonWithRetry(`http://127.0.0.1:${port}/snapshot?sessionId=session-a`);
      expect(snapshotA.sessionId).toBe("session-a");
      expect(snapshotA.scopes.session.turnCount).toBe(1);
      expect(snapshotA.context.tokens).toBe(420);

      const snapshotB = await fetchJsonWithRetry(`http://127.0.0.1:${port}/snapshot?sessionId=session-b`);
      expect(snapshotB.sessionId).toBe("session-b");
      expect(snapshotB.scopes.session.turnCount).toBe(1);
      expect(snapshotB.context.tokens).toBe(300);
      expect(snapshotB.scopes.session.tokensKeptOutApprox).toBe(0);

      const defaultRedirect = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
      expect(defaultRedirect.status).toBe(302);
      expect(defaultRedirect.headers.get("location")).toBe("/?sessionId=session-b");

      await expect(callsB.get("session_shutdown")?.({}, ctxB)).resolves.toBeUndefined();

      const fallbackRedirect = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
      expect(fallbackRedirect.status).toBe(302);
      expect(fallbackRedirect.headers.get("location")).toBe("/?sessionId=session-a");

      const fallbackSnapshot = await fetchJsonWithRetry(`http://127.0.0.1:${port}/snapshot?sessionId=session-a`);
      expect(fallbackSnapshot.sessionId).toBe("session-a");
      expect(fallbackSnapshot.scopes.session.turnCount).toBe(1);
      expect(fallbackSnapshot.context.tokens).toBe(420);

      const clearedSnapshot = await fetchJsonWithRetry(`http://127.0.0.1:${port}/snapshot?sessionId=session-b`);
      expect(clearedSnapshot).toBeNull();
    } finally {
      await expect(callsB.get("session_shutdown")?.({}, ctxB)).resolves.toBeUndefined();
      await expect(callsA.get("session_shutdown")?.({}, ctxA)).resolves.toBeUndefined();
    }
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

  it("returns recent dashboard impact history separately from the snapshot", async () => {
    const server = startDashboardServer({ port: 0, host: "127.0.0.1" });
    await once(server.server, "listening");

    try {
      const address = server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      server.publish("session-history", {
        generatedAt: 1713081600000,
        sessionId: "session-history",
        projectPath: "/tmp/project-history",
        context: {
          tokens: 420,
          percent: 0.42,
          window: 1000,
        },
        scopes: {
          session: { scope: "session", tokensSavedApprox: 12, tokensKeptOutApprox: 24, turnCount: 2 },
          project: { scope: "project", tokensSavedApprox: 12, tokensKeptOutApprox: 24, turnCount: 2 },
          lifetime: { scope: "lifetime", tokensSavedApprox: 12, tokensKeptOutApprox: 24, turnCount: 2 },
        },
        live: {
          turnCount: 2,
          toolCallCount: 4,
        },
        strategyTotals: {
          short_circuit: 12,
        },
        recentImpactEvents: [
          {
            timestamp: 1713081600000,
            sessionId: "session-history",
            projectPath: "/tmp/project-history",
            source: "turn_end",
            toolName: "read",
            strategy: "short_circuit",
            tokensSavedApprox: 12,
            tokensKeptOutApprox: 24,
            contextPercent: 0.42,
            summary: "Short-circuited repeated read output.",
          },
          {
            timestamp: 1713081500000,
            sessionId: "session-history",
            projectPath: "/tmp/project-history",
            source: "turn_end",
            toolName: "grep",
            strategy: "deduplication",
            tokensSavedApprox: 5,
            tokensKeptOutApprox: 10,
            contextPercent: 0.38,
            summary: "Deduplicated repeated grep output.",
          },
        ],
      });

      const snapshotResponse = await fetch(`${baseUrl}/snapshot?sessionId=session-history`);
      expect(snapshotResponse.headers.get("cache-control")).toBe("no-store");
      const snapshot = await snapshotResponse.json();
      expect(snapshot).toEqual(
        expect.objectContaining({
          sessionId: "session-history",
        }),
      );

      const historyResponse = await fetch(`${baseUrl}/history?sessionId=session-history`);
      expect(historyResponse.headers.get("cache-control")).toBe("no-store");
      const history = await historyResponse.json();

      expect(history).toEqual([
        expect.objectContaining({
          strategy: "short_circuit",
          tokensSavedApprox: 12,
          summary: "Short-circuited repeated read output.",
        }),
        expect.objectContaining({
          strategy: "deduplication",
          tokensSavedApprox: 5,
          summary: "Deduplicated repeated grep output.",
        }),
      ]);
    } finally {
      await server.close();
    }
  });

  it("sends current snapshot first and then streams live impact events over SSE", async () => {
    const server = startDashboardServer({ port: 0, host: "127.0.0.1" });
    await once(server.server, "listening");

    try {
      const address = server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      server.publish("session-sse-impact", {
        generatedAt: 1713081600000,
        sessionId: "session-sse-impact",
        projectPath: "/tmp/project-sse-impact",
        context: {
          tokens: 420,
          percent: 0.42,
          window: 1000,
        },
        scopes: {
          session: { scope: "session", tokensSavedApprox: 12, tokensKeptOutApprox: 24, turnCount: 2 },
          project: { scope: "project", tokensSavedApprox: 12, tokensKeptOutApprox: 24, turnCount: 2 },
          lifetime: { scope: "lifetime", tokensSavedApprox: 12, tokensKeptOutApprox: 24, turnCount: 2 },
        },
        live: {
          turnCount: 2,
          toolCallCount: 3,
        },
        strategyTotals: {
          short_circuit: 12,
        },
        recentImpactEvents: [
          {
            timestamp: 1713081600000,
            sessionId: "session-sse-impact",
            projectPath: "/tmp/project-sse-impact",
            source: "turn_end",
            toolName: "read",
            strategy: "short_circuit",
            tokensSavedApprox: 12,
            tokensKeptOutApprox: 24,
            contextPercent: 0.42,
            summary: "Short-circuited repeated read output.",
          },
        ],
      });

      const response = await fetch(`${baseUrl}/events?sessionId=session-sse-impact`);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("expected SSE response body");
      }

      const initial = await readSseChunk(reader, 250);
      expect(initial).not.toBeNull();
      expect(initial).toContain('"type":"connected"');
      expect(initial).toContain('"type":"snapshot"');
      expect(initial?.indexOf('"type":"snapshot"')).toBeGreaterThan(initial?.indexOf('"type":"connected"') ?? -1);

      server.publish("session-sse-impact", {
        generatedAt: 1713081700000,
        sessionId: "session-sse-impact",
        projectPath: "/tmp/project-sse-impact",
        context: {
          tokens: 400,
          percent: 0.4,
          window: 1000,
        },
        scopes: {
          session: { scope: "session", tokensSavedApprox: 15, tokensKeptOutApprox: 28, turnCount: 3 },
          project: { scope: "project", tokensSavedApprox: 15, tokensKeptOutApprox: 28, turnCount: 3 },
          lifetime: { scope: "lifetime", tokensSavedApprox: 15, tokensKeptOutApprox: 28, turnCount: 3 },
        },
        live: {
          turnCount: 3,
          toolCallCount: 5,
        },
        strategyTotals: {
          short_circuit: 15,
        },
        recentImpactEvents: [
          {
            timestamp: 1713081700000,
            sessionId: "session-sse-impact",
            projectPath: "/tmp/project-sse-impact",
            source: "turn_end",
            toolName: "grep",
            strategy: "short_circuit",
            tokensSavedApprox: 3,
            tokensKeptOutApprox: 4,
            contextPercent: 0.4,
            summary: "Short-circuited repeated grep output.",
          },
          {
            timestamp: 1713081600000,
            sessionId: "session-sse-impact",
            projectPath: "/tmp/project-sse-impact",
            source: "turn_end",
            toolName: "read",
            strategy: "short_circuit",
            tokensSavedApprox: 12,
            tokensKeptOutApprox: 24,
            contextPercent: 0.42,
            summary: "Short-circuited repeated read output.",
          },
        ],
      });

      const next = await readSsePayload(reader, 3, 250);
      expect(next).toContain('"type":"snapshot"');
      expect(next).toContain('"type":"impact"');
      expect(next).toContain('"summary":"Short-circuited repeated grep output."');
      expect(next).toContain('"tokens":400');
      expect(next).toContain('"turnCount":3');
      expect(countSseEventType(next, "impact")).toBe(1);
      expect(next.indexOf('"type":"snapshot"')).toBeLessThan(next.indexOf('"type":"impact"'));

      await reader.cancel();
    } finally {
      await server.close();
    }
  });

  it("renders scope and strategy chart panels in the control-tower shell", () => {
    const html = renderDashboardPage();

    expect(html).toContain("Health");
    expect(html).toContain("Context %");
    expect(html).toContain("Turns");
    expect(html).toContain("Tool Calls");
    expect(html).toContain('id="health-status"');
    expect(html).toContain('id="live-turns"');
    expect(html).toContain('id="live-tool-calls"');
    expect(html).toContain('id="ctx-window"');
    expect(html).toContain('id="session-saved"');
    expect(html).toContain('id="project-saved"');
    expect(html).toContain('id="lifetime-saved"');
    expect(html).toContain("Scope Comparison");
    expect(html).toContain('id="scope-chart"');
    expect(html).toContain("Strategy Payoff");
    expect(html).toContain('id="strategy-chart"');
  });

  it("bootstraps snapshot and history before subscribing to the scoped SSE stream", async () => {
    const page = createDashboardScriptHarness({ search: "?sessionId=session-a" });

    await page.flush();

    expect(page.getFetchUrls()).toEqual(["/snapshot?sessionId=session-a", "/history?sessionId=session-a"]);
    expect(page.getEventSourceUrls()).toHaveLength(1);
    expect(page.getEventSourceUrls()[0]).toContain("/events?sessionId=session-a&after=");
    expect(page.getText("session-id")).toBe("session-a");
    expect(page.getText("project-path")).toBe("/tmp/project-a");
    expect(page.getText("health-status")).toBe("Live");
    expect(page.getText("ctx-pct")).toBe("37.5%");
    expect(page.getText("live-turns")).toBe("3");
    expect(page.getText("live-tool-calls")).toBe("7");
    expect(page.getText("ctx-window")).toBe("420 / 1,000");
    expect(page.getText("session-saved")).toBe("55");
    expect(page.getText("project-saved")).toBe("120");
    expect(page.getText("lifetime-saved")).toBe("220");
    expect(page.getText("impact-count")).toBe("0");
    expect(page.getHtml("impact-ledger")).toContain('<table class="impact-table">');
    expect(page.getText("impact-ledger")).toContain("Time");
    expect(page.getText("impact-ledger")).toContain("Source");
    expect(page.getText("impact-ledger")).toContain("Strategy");
    expect(page.getText("impact-ledger")).toContain("read");
    expect(page.getText("impact-ledger")).toContain("Short Circuit");
    expect(page.getText("impact-ledger")).toContain("37.5%");
    expect(page.getText("live-feed")).toBe("Waiting for live updates.");
  });

  it("renders scope and strategy charts from the dashboard snapshot", async () => {
    const page = createDashboardScriptHarness({ search: "?sessionId=session-a" });

    await page.flush();

    expect(page.getHtml("scope-chart")).toContain("Session");
    expect(page.getHtml("scope-chart")).toContain("Project");
    expect(page.getHtml("scope-chart")).toContain("Lifetime");
    expect(page.getHtml("scope-chart")).toContain("55");
    expect(page.getHtml("scope-chart")).toContain("120");
    expect(page.getHtml("scope-chart")).toContain("220");
    expect(page.getHtml("scope-chart")).toContain("kept out 144");

    expect(page.getHtml("strategy-chart")).toContain("Short Circuit");
    expect(page.getHtml("strategy-chart")).toContain("Deduplication");
    expect(page.getHtml("strategy-chart")).toContain("Truncation");
    expect(page.getHtml("strategy-chart")).toContain("Code Filter");
    expect(page.getHtml("strategy-chart")).toContain("55");
  });

  it("keeps the scope chart visible when savings exist without kept-out totals", async () => {
    const page = createDashboardScriptHarness();

    await page.flush();
    page.dispatchSnapshot({
      sessionId: "session-b",
      projectPath: "/tmp/project-b",
      context: { percent: 0.2 },
      scopes: {
        session: { tokensSavedApprox: 25, tokensKeptOutApprox: 0, turnCount: 2 },
        project: { tokensSavedApprox: 40, tokensKeptOutApprox: 0, turnCount: 5 },
        lifetime: { tokensSavedApprox: 75, tokensKeptOutApprox: 0, turnCount: 9 },
      },
      live: { turnCount: 2, toolCallCount: 9 },
      strategyTotals: {},
    });

    expect(page.getHtml("scope-chart")).toContain("25");
    expect(page.getHtml("scope-chart")).toContain("40");
    expect(page.getHtml("scope-chart")).toContain("75");
    expect(page.getHtml("scope-chart")).not.toContain("No scope comparison yet.");
  });

  it("falls back to kept-out scope totals when savings stay at zero", async () => {
    const page = createDashboardScriptHarness();

    await page.flush();
    page.dispatchSnapshot({
      sessionId: "session-c",
      projectPath: "/tmp/project-c",
      context: { percent: 0.25, tokens: 250, window: 1000 },
      scopes: {
        session: { tokensSavedApprox: 0, tokensKeptOutApprox: 18, turnCount: 2 },
        project: { tokensSavedApprox: 0, tokensKeptOutApprox: 40, turnCount: 5 },
        lifetime: { tokensSavedApprox: 0, tokensKeptOutApprox: 70, turnCount: 9 },
      },
      live: { turnCount: 2, toolCallCount: 4 },
      strategyTotals: {},
    });

    expect(page.getHtml("scope-chart")).toContain("18 kept out");
    expect(page.getHtml("scope-chart")).toContain("40 kept out");
    expect(page.getHtml("scope-chart")).toContain("70 kept out");
    expect(page.getHtml("scope-chart")).not.toContain("No scope comparison yet.");
  });

  it("locks an initially unscoped page to the bootstrap snapshot before opening SSE", async () => {
    const page = createDashboardScriptHarness();

    await page.flush();

    expect(page.getReplaceStateUrls()).toEqual(["/?sessionId=session-a"]);
    expect(page.getFetchUrls()).toEqual(["/snapshot", "/history?sessionId=session-a"]);
    expect(page.getEventSourceUrls()).toHaveLength(1);
    expect(page.getEventSourceUrls()[0]).toContain("/events?sessionId=session-a&after=");
  });

  it("resets stale dashboard stat fields when the next snapshot omits them", async () => {
    const page = createDashboardScriptHarness();

    await page.flush();
    page.dispatchSnapshot({
      sessionId: "session-a",
      projectPath: "/tmp/project-a",
      context: { percent: 0.42 },
      scopes: {
        session: { tokensSavedApprox: 55, tokensKeptOutApprox: 144, turnCount: 3 },
        project: { tokensSavedApprox: 120, tokensKeptOutApprox: 320, turnCount: 8 },
        lifetime: { tokensSavedApprox: 220, tokensKeptOutApprox: 640, turnCount: 14 },
      },
      live: { turnCount: 3, toolCallCount: 7 },
      strategyTotals: { short_circuit: 55, truncation: 18 },
    });

    expect(page.getText("session-id")).toBe("session-a");
    expect(page.getText("project-path")).toBe("/tmp/project-a");
    expect(page.getText("health-status")).toBe("Live");
    expect(page.getText("ctx-pct")).toBe("42.0%");
    expect(page.getText("live-turns")).toBe("3");
    expect(page.getText("live-tool-calls")).toBe("7");
    expect(page.getText("ctx-window")).toBe("-- / --");
    expect(page.getText("session-saved")).toBe("55");
    expect(page.getText("project-saved")).toBe("120");
    expect(page.getText("lifetime-saved")).toBe("220");
    expect(page.getText("impact-count")).toBe("0");
    expect(page.getText("impact-ledger")).toBe("No recent impact yet.");
    expect(page.getHtml("scope-chart")).toContain("Session");
    expect(page.getHtml("strategy-chart")).toContain("Short Circuit");

    page.dispatchSnapshot(null);

    expect(page.getText("session-id")).toBe("--");
    expect(page.getText("project-path")).toBe("--");
    expect(page.getText("health-status")).toBe("--");
    expect(page.getText("ctx-pct")).toBe("--%");
    expect(page.getText("live-turns")).toBe("--");
    expect(page.getText("live-tool-calls")).toBe("--");
    expect(page.getText("ctx-window")).toBe("-- / --");
    expect(page.getText("session-saved")).toBe("--");
    expect(page.getText("project-saved")).toBe("--");
    expect(page.getText("lifetime-saved")).toBe("--");
    expect(page.getText("impact-count")).toBe("--");
    expect(page.getText("impact-ledger")).toBe("No recent impact yet.");
    expect(page.getText("live-feed")).toBe("Waiting for live updates.");
    expect(page.getHtml("scope-chart")).toContain("No scope comparison yet.");
    expect(page.getHtml("strategy-chart")).toContain("No strategy payoff yet.");
  });

  it("renders live impact updates as a human-readable feed", async () => {
    const page = createDashboardScriptHarness({ search: "?sessionId=session-a" });

    await page.flush();
    page.dispatchImpact({
      timestamp: 1713081700000,
      toolName: "grep",
      strategy: "short_circuit",
      tokensSavedApprox: 3,
      tokensKeptOutApprox: 4,
      contextPercent: 0.4,
      summary: "Short-circuited repeated grep output.",
    });

    expect(page.getText("live-feed")).toContain("Skipped repeated grep output");
    expect(page.getText("live-feed")).toContain("ctx 40.0%");
    expect(page.getText("live-feed")).not.toContain("\"strategy\"");

    page.dispatchImpact({
      timestamp: 1713081705000,
      toolName: "hashline_read",
      strategy: "background_index",
      tokensSavedApprox: 0,
      tokensKeptOutApprox: 97805,
      contextPercent: 0.23,
      summary: "background_index on hashline_read saved 0 token(s) and kept 97805 token(s) out of context",
    });

    expect(page.getText("live-feed")).toContain("Indexed older hashline read output");
    expect(page.getText("live-feed")).toContain("97.8k kept out of context");
    expect(page.getText("live-feed")).not.toContain("background_index on");
    expect(page.getText("live-feed")).not.toContain("token(s)");

    page.dispatchImpact({
      timestamp: 1713081710000,
      toolName: "bash",
      strategy: "error_purge",
      tokensSavedApprox: 701,
      tokensKeptOutApprox: 701,
      contextPercent: 0.203,
      summary: "error_purge on bash saved 701 token(s) and kept 701 token(s) out of context",
    });

    page.dispatchImpact({
      timestamp: 1713081715000,
      toolName: "bash",
      strategy: "dedup",
      tokensSavedApprox: 133,
      tokensKeptOutApprox: 133,
      contextPercent: 0.206,
      summary: "dedup on bash saved 133 token(s) and kept 133 token(s) out of context",
    });

    expect(page.getText("live-feed")).toContain("Cleared stale bash error output");
    expect(page.getText("live-feed")).toContain("Collapsed repeated bash output");
    expect(page.getText("live-feed")).not.toContain("error_purge on");
    expect(page.getText("live-feed")).not.toContain("dedup on");
  });

  it("renders the impact ledger inside a bounded scroll container", async () => {
    const page = createDashboardScriptHarness({ search: "?sessionId=session-a" });

    await page.flush();

    expect(page.getHtml("impact-ledger")).toContain('<table class="impact-table">');
    expect(page.getClassName("impact-ledger")).toContain("ledger-scroll");
  });
});

describe("runtime integration", () => {
  it.each(["disable", "disable dashboard"])(
    "revokes the published dashboard snapshot immediately when `/pcn %s` runs",
    async (command) => {
      const port = await getAvailablePort();
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-command-disable-dashboard-"));
      const configPath = path.join(projectDir, "pcn-config.yaml");
      const sessionId = `session-command-${command.replace(/\s+/g, "-")}`;
      fs.writeFileSync(
        configPath,
        [
          "analytics:",
          "  enabled: true",
          `  dbPath: ${JSON.stringify(path.join(tmpDir, `${sessionId}.sqlite`))}`,
          "dashboard:",
          "  enabled: true",
          `  port: ${port}`,
          '  bindHost: "127.0.0.1"',
        ].join("\n"),
        "utf8",
      );
      process.env.PCN_CONFIG_PATH = configPath;

      const piCalls = new Map<string, (...args: any[]) => unknown>();
      const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
      const pi = {
        on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
          piCalls.set(name, handler);
        }),
        registerCommand: vi.fn((name: string, options: { handler: (...args: any[]) => unknown }) => {
          commands.set(name, options);
        }),
      } as unknown as ExtensionAPI;

      const ctx = {
        cwd: projectDir,
        sessionManager: {
          getSessionId: () => sessionId,
          getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
        getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
        ui: { notify: vi.fn() },
      } as any;

      let runtimeStarted = false;

      try {
        registerExtension(pi);
        runtimeStarted = true;

        await piCalls.get("turn_end")?.(
          {
            turnIndex: 0,
            message: { role: "assistant", content: "first turn" },
            toolResults: [],
          },
          ctx,
        );

        const firstSnapshot = await fetchJsonWithRetry(`http://127.0.0.1:${port}/snapshot?sessionId=${sessionId}`);
        expect(firstSnapshot.scopes.session.turnCount).toBe(1);

        await commands.get("pcn")?.handler(command, ctx);

        await expect(fetch(`http://127.0.0.1:${port}/snapshot?sessionId=${sessionId}`)).rejects.toThrow();
      } finally {
        if (runtimeStarted) {
          await piCalls.get("session_shutdown")?.({}, ctx);
        }
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["disable", "disable dashboard"])(
    "revokes all published dashboard snapshots for the same project when `/pcn %s` runs",
    async (command) => {
      const port = await getAvailablePort();
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-command-disable-dashboard-project-"));
      const configPath = path.join(projectDir, "pcn-config.yaml");
      fs.writeFileSync(
        configPath,
        [
          "analytics:",
          "  enabled: true",
          `  dbPath: ${JSON.stringify(path.join(tmpDir, `${command.replace(/\s+/g, "-")}.sqlite`))}`,
          "dashboard:",
          "  enabled: true",
          `  port: ${port}`,
          '  bindHost: "127.0.0.1"',
        ].join("\n"),
        "utf8",
      );
      process.env.PCN_CONFIG_PATH = configPath;

      const piCalls = new Map<string, (...args: any[]) => unknown>();
      const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
      const pi = {
        on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
          piCalls.set(name, handler);
        }),
        registerCommand: vi.fn((name: string, options: { handler: (...args: any[]) => unknown }) => {
          commands.set(name, options);
        }),
      } as unknown as ExtensionAPI;

      const ctxA = {
        cwd: projectDir,
        sessionManager: {
          getSessionId: () => `session-project-a-${command.replace(/\s+/g, "-")}`,
          getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
        getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
        ui: { notify: vi.fn() },
      } as any;
      const ctxB = {
        cwd: projectDir,
        sessionManager: {
          getSessionId: () => `session-project-b-${command.replace(/\s+/g, "-")}`,
          getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
        getContextUsage: () => ({ tokens: 360, percent: 0.36, contextWindow: 1000 }),
        ui: { notify: vi.fn() },
      } as any;

      let runtimeStarted = false;

      try {
        registerExtension(pi);
        runtimeStarted = true;

        await piCalls.get("turn_end")?.(
          {
            turnIndex: 0,
            message: { role: "assistant", content: "first turn" },
            toolResults: [],
          },
          ctxA,
        );
        await piCalls.get("turn_end")?.(
          {
            turnIndex: 1,
            message: { role: "assistant", content: "second turn" },
            toolResults: [],
          },
          ctxB,
        );

        const firstSnapshot = await fetchJsonWithRetry(
          `http://127.0.0.1:${port}/snapshot?sessionId=${ctxA.sessionManager.getSessionId()}`,
        );
        const secondSnapshot = await fetchJsonWithRetry(
          `http://127.0.0.1:${port}/snapshot?sessionId=${ctxB.sessionManager.getSessionId()}`,
        );
        expect(firstSnapshot.scopes.session.turnCount).toBe(1);
        expect(secondSnapshot.scopes.session.turnCount).toBe(1);

        await commands.get("pcn")?.handler(command, ctxA);

        await expect(
          fetch(`http://127.0.0.1:${port}/snapshot?sessionId=${ctxA.sessionManager.getSessionId()}`),
        ).rejects.toThrow();
        await expect(
          fetch(`http://127.0.0.1:${port}/snapshot?sessionId=${ctxB.sessionManager.getSessionId()}`),
        ).rejects.toThrow();
      } finally {
        if (runtimeStarted) {
          await piCalls.get("session_shutdown")?.({}, ctxA);
          await piCalls.get("session_shutdown")?.({}, ctxB);
        }
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["disable", "disable dashboard"])(
    "revokes all published dashboard snapshots across equivalent project path variants when `/pcn %s` runs",
    async (command) => {
      const port = await getAvailablePort();
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-command-disable-dashboard-project-variants-"));
      const projectDirWithTrailingSlash = `${projectDir}${path.sep}`;
      const configPath = path.join(projectDir, "pcn-config.yaml");
      fs.writeFileSync(
        configPath,
        [
          "analytics:",
          "  enabled: true",
          `  dbPath: ${JSON.stringify(path.join(tmpDir, `${command.replace(/\s+/g, "-")}-variants.sqlite`))}`,
          "dashboard:",
          "  enabled: true",
          `  port: ${port}`,
          '  bindHost: "127.0.0.1"',
        ].join("\n"),
        "utf8",
      );
      process.env.PCN_CONFIG_PATH = configPath;

      const piCalls = new Map<string, (...args: any[]) => unknown>();
      const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
      const pi = {
        on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
          piCalls.set(name, handler);
        }),
        registerCommand: vi.fn((name: string, options: { handler: (...args: any[]) => unknown }) => {
          commands.set(name, options);
        }),
      } as unknown as ExtensionAPI;

      const ctxA = {
        cwd: projectDir,
        sessionManager: {
          getSessionId: () => `session-project-variant-a-${command.replace(/\s+/g, "-")}`,
          getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
        getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
        ui: { notify: vi.fn() },
      } as any;
      const ctxB = {
        cwd: projectDirWithTrailingSlash,
        sessionManager: {
          getSessionId: () => `session-project-variant-b-${command.replace(/\s+/g, "-")}`,
          getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
        getContextUsage: () => ({ tokens: 360, percent: 0.36, contextWindow: 1000 }),
        ui: { notify: vi.fn() },
      } as any;

      let runtimeStarted = false;

      try {
        registerExtension(pi);
        runtimeStarted = true;

        await piCalls.get("turn_end")?.(
          {
            turnIndex: 0,
            message: { role: "assistant", content: "first turn" },
            toolResults: [],
          },
          ctxA,
        );
        await piCalls.get("turn_end")?.(
          {
            turnIndex: 1,
            message: { role: "assistant", content: "second turn" },
            toolResults: [],
          },
          ctxB,
        );

        const firstSnapshot = await fetchJsonWithRetry(
          `http://127.0.0.1:${port}/snapshot?sessionId=${ctxA.sessionManager.getSessionId()}`,
        );
        const secondSnapshot = await fetchJsonWithRetry(
          `http://127.0.0.1:${port}/snapshot?sessionId=${ctxB.sessionManager.getSessionId()}`,
        );
        expect(firstSnapshot.scopes.session.turnCount).toBe(1);
        expect(secondSnapshot.scopes.session.turnCount).toBe(1);

        await commands.get("pcn")?.handler(command, ctxB);

        await expect(
          fetch(`http://127.0.0.1:${port}/snapshot?sessionId=${ctxA.sessionManager.getSessionId()}`),
        ).rejects.toThrow();
        await expect(
          fetch(`http://127.0.0.1:${port}/snapshot?sessionId=${ctxB.sessionManager.getSessionId()}`),
        ).rejects.toThrow();
      } finally {
        if (runtimeStarted) {
          await piCalls.get("session_shutdown")?.({}, ctxA);
          await piCalls.get("session_shutdown")?.({}, ctxB);
        }
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  it("clears a previously published dashboard snapshot after the project is disabled on a later turn", async () => {
    const port = await getAvailablePort();

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-project-disable-transition-"));
    const controlDir = path.join(projectDir, ".pi", ".pi-ninja");
    fs.mkdirSync(controlDir, { recursive: true });

    const piCalls = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        piCalls.set(name, handler);
      }),
    } as unknown as ExtensionAPI;

    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(tmpDir, "analytics-project-disable-transition.sqlite");
    config.dashboard.enabled = true;
    config.dashboard.port = port;
    config.dashboard.bindHost = "127.0.0.1";

    const ctx = {
      cwd: projectDir,
      sessionManager: {
        getSessionId: () => "session-project-disable-transition",
        getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
      getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
    } as any;

    let runtimeStarted = false;

    try {
      createExtensionRuntime(pi, config);
      runtimeStarted = true;

      await piCalls.get("turn_end")?.(
        {
          turnIndex: 0,
          message: { role: "assistant", content: "first turn" },
          toolResults: [],
        },
        ctx,
      );

      const firstSnapshot = await fetchJsonWithRetry(
        `http://127.0.0.1:${port}/snapshot?sessionId=session-project-disable-transition`,
      );
      expect(firstSnapshot.scopes.session.turnCount).toBe(1);

      fs.writeFileSync(path.join(controlDir, ".pcn_disabled"), "", "utf8");

      await piCalls.get("turn_end")?.(
        {
          turnIndex: 1,
          message: { role: "assistant", content: "second turn" },
          toolResults: [],
        },
        ctx,
      );

      await expect(
        fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-project-disable-transition`),
      ).rejects.toThrow();
    } finally {
      if (runtimeStarted) {
        await piCalls.get("session_shutdown")?.({}, ctx);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("clears a previously published dashboard snapshot after dashboard is disabled on a later turn", async () => {
    const port = await getAvailablePort();

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-disable-transition-"));
    const controlDir = path.join(projectDir, ".pi", ".pi-ninja");
    fs.mkdirSync(controlDir, { recursive: true });

    const piCalls = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        piCalls.set(name, handler);
      }),
    } as unknown as ExtensionAPI;

    const config = defaultConfig();
    config.analytics.enabled = true;
    config.analytics.dbPath = path.join(tmpDir, "analytics-dashboard-disable-transition.sqlite");
    config.dashboard.enabled = true;
    config.dashboard.port = port;
    config.dashboard.bindHost = "127.0.0.1";

    const ctx = {
      cwd: projectDir,
      sessionManager: {
        getSessionId: () => "session-dashboard-disable-transition",
        getEntries: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
      getContextUsage: () => ({ tokens: 420, percent: 0.42, contextWindow: 1000 }),
    } as any;

    let runtimeStarted = false;

    try {
      createExtensionRuntime(pi, config);
      runtimeStarted = true;

      await piCalls.get("turn_end")?.(
        {
          turnIndex: 0,
          message: { role: "assistant", content: "first turn" },
          toolResults: [],
        },
        ctx,
      );

      const firstSnapshot = await fetchJsonWithRetry(
        `http://127.0.0.1:${port}/snapshot?sessionId=session-dashboard-disable-transition`,
      );
      expect(firstSnapshot.scopes.session.turnCount).toBe(1);

      fs.writeFileSync(path.join(controlDir, ".pcn_dashboard_disabled"), "", "utf8");

      await piCalls.get("turn_end")?.(
        {
          turnIndex: 1,
          message: { role: "assistant", content: "second turn" },
          toolResults: [],
        },
        ctx,
      );

      await expect(
        fetch(`http://127.0.0.1:${port}/snapshot?sessionId=session-dashboard-disable-transition`),
      ).rejects.toThrow();
    } finally {
      if (runtimeStarted) {
        await piCalls.get("session_shutdown")?.({}, ctx);
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("records analytics but does not publish when only dashboard is disabled for the project", async () => {
    const port = await getAvailablePort();

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
    const port = await getAvailablePort();

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

    const snapshot = await fetchJsonWithRetry(`http://127.0.0.1:${port}/snapshot?sessionId=session-a`);
    expect(snapshot.scopes.session.turnCount).toBe(1);
    expect(snapshot.context.tokens).toBe(420);
    expect(snapshot.scopes.session.tokensSavedApprox).toBeGreaterThanOrEqual(0);

    await piCalls.get("session_shutdown")?.({}, ctx);

    await expect(fetch(`http://127.0.0.1:${port}/snapshot`)).rejects.toThrow();
  });

  it("reports dashboard preference enabled but deferred when the project is globally disabled", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcn-dashboard-enable-deferred-"));
    const notify = vi.fn();
    const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn((name: string, options: { handler: (...args: unknown[]) => unknown }) => {
        commands.set(name, options);
      }),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: projectDir,
      sessionManager: {
        getSessionId: () => "session-dashboard-enable-deferred",
        getEntries: () => [{ id: "m1" }, { id: "m2" }],
      },
      getContextUsage: () => ({ tokens: 300, percent: 0.3, contextWindow: 1000 }),
      ui: { notify },
    } as any;

    try {
      const { default: registerExtension } = await import("../src/index.js");
      registerExtension(pi);

      await commands.get("pcn")?.handler("disable", ctx);
      await commands.get("pcn")?.handler("disable dashboard", ctx);

      notify.mockClear();
      await commands.get("pcn")?.handler("enable dashboard", ctx);

      expect(fs.existsSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_disabled"))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, ".pi", ".pi-ninja", ".pcn_dashboard_disabled"))).toBe(false);
      expect(notify).toHaveBeenCalledWith(
        "Pi Context Ninja dashboard enabled for this project, but Pi Context Ninja remains disabled until /pcn enable.",
        "info",
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
