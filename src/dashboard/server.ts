import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { renderDashboardPage } from "./pages.js";
import type { AnalyticsSnapshot, DashboardImpactEvent, DashboardSnapshot } from "../analytics/types.js";

export interface DashboardServerOptions {
  port: number;
  host: string;
}

export interface DashboardServerHandle {
  server: Server;
  ready: Promise<void>;
  publish(sessionId: string, snapshot: AnalyticsSnapshot): void;
  clearSession(sessionId: string): void;
  close(): Promise<void>;
  snapshot(sessionId?: string): AnalyticsSnapshot | null;
  history(sessionId?: string): DashboardImpactEvent[];
}

interface SseClient {
  res: ServerResponse;
  sessionId: string | null;
}

function normalizeSessionId(sessionId: string | null): string | null {
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function writeSse(res: ServerResponse, type: string, data: unknown): void {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

function isDashboardSnapshot(snapshot: AnalyticsSnapshot | null): snapshot is DashboardSnapshot {
  return Array.isArray((snapshot as DashboardSnapshot | null)?.recentImpactEvents);
}

function getSnapshotHistory(snapshot: AnalyticsSnapshot | null): DashboardImpactEvent[] {
  if (!isDashboardSnapshot(snapshot)) {
    return [];
  }

  return snapshot.recentImpactEvents.map((event) => ({ ...event }));
}

function getImpactEventKey(event: DashboardImpactEvent): string {
  return [
    event.timestamp,
    event.sessionId,
    event.projectPath,
    event.source,
    event.toolName ?? "",
    event.strategy,
    event.tokensSavedApprox,
    event.tokensKeptOutApprox,
    event.contextPercent ?? "",
    event.summary,
  ].join("\u0000");
}

function getImpactEventsAfter(events: DashboardImpactEvent[], afterKey: string | null): DashboardImpactEvent[] {
  if (events.length === 0) {
    return [];
  }
  if (afterKey === null) {
    return events;
  }

  const cutoffIndex = events.findIndex((event) => getImpactEventKey(event) === afterKey);
  if (cutoffIndex === -1) {
    return events;
  }

  return events.slice(0, cutoffIndex);
}

function normalizeOptions(
  optionsOrPort: DashboardServerOptions | number = 48900,
  host = "127.0.0.1",
): DashboardServerOptions {
  if (typeof optionsOrPort === "number") {
    return { port: optionsOrPort, host };
  }
  return optionsOrPort;
}

export function startDashboardServer(
  optionsOrPort: DashboardServerOptions | number = 48900,
  host = "127.0.0.1",
): DashboardServerHandle {
  const options = normalizeOptions(optionsOrPort, host);
  const clients = new Set<SseClient>();
  const snapshotsBySession = new Map<string, AnalyticsSnapshot>();
  let activeSessionId: string | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function getSnapshot(sessionId?: string): AnalyticsSnapshot | null {
    if (sessionId) {
      return snapshotsBySession.get(sessionId) ?? null;
    }
    if (!activeSessionId) {
      return null;
    }
    return snapshotsBySession.get(activeSessionId) ?? null;
  }

  function getLastSessionId(): string | null {
    let lastSessionId: string | null = null;
    for (const sessionId of snapshotsBySession.keys()) {
      lastSessionId = sessionId;
    }
    return lastSessionId;
  }

  function getDefaultSessionId(): string | null {
    return activeSessionId ?? getLastSessionId();
  }

  function getHistory(sessionId?: string): DashboardImpactEvent[] {
    return getSnapshotHistory(getSnapshot(sessionId));
  }

  function broadcastSnapshot(snapshot: AnalyticsSnapshot | null): void {
    for (const client of clients) {
      if (client.sessionId !== null) {
        continue;
      }
      try {
        writeSse(client.res, "snapshot", snapshot);
      } catch {
        clients.delete(client);
      }
    }
  }

  function broadcastSessionSnapshot(sessionId: string, snapshot: AnalyticsSnapshot | null): void {
    for (const client of clients) {
      if (client.sessionId !== sessionId) {
        continue;
      }
      try {
        writeSse(client.res, "snapshot", snapshot);
      } catch {
        clients.delete(client);
      }
    }
  }

  function broadcastImpactEvents(sessionId: string, impactEvents: DashboardImpactEvent[]): void {
    if (impactEvents.length === 0) {
      return;
    }

    for (const client of clients) {
      if (client.sessionId !== null && client.sessionId !== sessionId) {
        continue;
      }

      try {
        for (const event of impactEvents) {
          writeSse(client.res, "impact", event);
        }
      } catch {
        clients.delete(client);
      }
    }
  }

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${options.host}:${options.port}`}`);

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      const requestedSessionId = normalizeSessionId(requestUrl.searchParams.get("sessionId"));
      if (!requestedSessionId) {
        const defaultSessionId = getDefaultSessionId();
        if (defaultSessionId) {
          const redirectUrl = new URL(requestUrl.pathname, requestUrl);
          redirectUrl.searchParams.set("sessionId", defaultSessionId);
          res.writeHead(302, { Location: `${redirectUrl.pathname}${redirectUrl.search}` });
          res.end();
          return;
        }
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(renderDashboardPage());
      return;
    }

    if (requestUrl.pathname === "/snapshot") {
      const sessionId = normalizeSessionId(requestUrl.searchParams.get("sessionId"));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(getSnapshot(sessionId ?? undefined)));
      return;
    }

    if (requestUrl.pathname === "/history") {
      const sessionId = normalizeSessionId(requestUrl.searchParams.get("sessionId"));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(getHistory(sessionId ?? undefined)));
      return;
    }

    if (requestUrl.pathname === "/events") {
      const sessionId = normalizeSessionId(requestUrl.searchParams.get("sessionId"));
      const afterKey = requestUrl.searchParams.get("after");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write("retry: 1000\n");
      writeSse(res, "connected", {});
      const snapshot = getSnapshot(sessionId ?? undefined);
      if (snapshot !== null) {
        writeSse(res, "snapshot", snapshot);
        for (const event of getImpactEventsAfter(getSnapshotHistory(snapshot), afterKey)) {
          writeSse(res, "impact", event);
        }
      }
      const client: SseClient = { res, sessionId };
      clients.add(client);
      req.on("close", () => clients.delete(client));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.once("error", (error: Error) => {
    rejectReady?.(error);
    resolveReady = null;
    rejectReady = null;
  });

  server.listen(options.port, options.host, () => {
    const address = server.address();
    const bound =
      typeof address === "string"
        ? address
        : `${options.host}:${typeof address === "object" && address ? address.port : options.port}`;
    console.log(`[PCN] Dashboard at http://${bound}`);
    resolveReady?.();
    resolveReady = null;
    rejectReady = null;
  });

  return {
    server,
    ready,
    publish(sessionId: string, snapshot: AnalyticsSnapshot): void {
      const previousHistoryKeys = new Set(getHistory(sessionId).map(getImpactEventKey));
      const nextHistory = getSnapshotHistory(snapshot);
      const newImpactEvents = nextHistory.filter((event) => !previousHistoryKeys.has(getImpactEventKey(event)));

      activeSessionId = sessionId;
      snapshotsBySession.delete(sessionId);
      snapshotsBySession.set(sessionId, snapshot);
      broadcastSnapshot(snapshot);
      broadcastSessionSnapshot(sessionId, snapshot);
      broadcastImpactEvents(sessionId, newImpactEvents);
    },
    clearSession(sessionId: string): void {
      const removedSnapshot = snapshotsBySession.get(sessionId) ?? null;
      snapshotsBySession.delete(sessionId);

      if (activeSessionId === sessionId) {
        activeSessionId = getLastSessionId();
        broadcastSnapshot(getSnapshot());
      }

      if (removedSnapshot) {
        broadcastSessionSnapshot(sessionId, null);
      }
    },
    snapshot(sessionId?: string): AnalyticsSnapshot | null {
      return getSnapshot(sessionId);
    },
    history(sessionId?: string): DashboardImpactEvent[] {
      return getHistory(sessionId);
    },
    close(): Promise<void> {
      for (const client of clients) {
        try {
          client.res.end();
        } catch {
          // Ignore shutdown races from disconnected clients.
        }
      }
      clients.clear();

      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
