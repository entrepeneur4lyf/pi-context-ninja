import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { renderDashboardPage } from "./pages.js";
import type { AnalyticsSnapshot } from "../analytics/types.js";

export interface DashboardServerOptions {
  port: number;
  host: string;
}

export interface DashboardServerHandle {
  server: Server;
  ready: Promise<void>;
  publish(snapshot: AnalyticsSnapshot): void;
  close(): Promise<void>;
  snapshot(): AnalyticsSnapshot | null;
}

type SseClient = ServerResponse;

function writeSse(res: ServerResponse, type: string, data: unknown): void {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
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
  let latestSnapshot: AnalyticsSnapshot | null = null;
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboardPage());
      return;
    }

    if (req.url === "/snapshot") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(latestSnapshot));
      return;
    }

    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 1000\n");
      writeSse(res, "connected", {});
      if (latestSnapshot) {
        writeSse(res, "snapshot", latestSnapshot);
      }
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
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
  });

  return {
    server,
    ready,
    publish(snapshot: AnalyticsSnapshot): void {
      latestSnapshot = snapshot;
      for (const client of clients) {
        try {
          writeSse(client, "snapshot", snapshot);
        } catch {
          clients.delete(client);
        }
      }
    },
    snapshot(): AnalyticsSnapshot | null {
      return latestSnapshot;
    },
    close(): Promise<void> {
      for (const client of clients) {
        try {
          client.end();
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
