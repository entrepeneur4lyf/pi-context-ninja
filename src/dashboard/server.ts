import http, { Server, IncomingMessage, ServerResponse } from 'http';
import { DASHBOARD_HTML } from './pages.js';

const sseClients = new Set<ServerResponse>();

export function startDashboardServer(port = 48900, host = '127.0.0.1'): Server {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1000\n');
      res.write('data: ' + JSON.stringify({ type: 'connected', data: {} }) + '\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, host, () => console.log(`[PCN] Dashboard at http://${host}:${port}`));
  return server;
}

export function broadcastEvent(type: string, data: Record<string, unknown>): void {
  const msg = 'data: ' + JSON.stringify({ type, data }) + '\n\n';
  for (const c of sseClients) { try { c.write(msg); } catch {} }
}

export function stopDashboardServer(): void {
  for (const c of sseClients) { try { c.end(); } catch {} }
  sseClients.clear();
}
