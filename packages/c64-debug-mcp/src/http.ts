#!/usr/bin/env node

import http from 'node:http';

import { c64DebugServer } from './server.js';
import { c64Session } from './server.js';

const host = process.env.C64_DEBUG_HTTP_HOST?.trim() || '127.0.0.1';
const port = Number.parseInt(process.env.C64_DEBUG_HTTP_PORT?.trim() || '39080', 10);
const mcpPath = process.env.C64_DEBUG_HTTP_PATH?.trim() || '/mcp';
const healthPath = process.env.C64_DEBUG_HTTP_HEALTH_PATH?.trim() || '/healthz';

let shuttingDown = false;

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${host}:${port}`);

  if (url.pathname === healthPath) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname !== mcpPath) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  try {
    await c64DebugServer.startHTTP({
      url,
      httpPath: mcpPath,
      req,
      res,
      options: {
        enableJsonResponse: true,
      },
    });
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'mcp_http_start_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    res.end();
  }
});

async function closeHttpServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function shutdown(exitCode = 0, error?: unknown): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (error) {
    console.error('C64 Debug MCP HTTP server failed:', error);
  }

  try {
    await closeHttpServer().catch(() => undefined);
    await c64DebugServer.close().catch(() => undefined);
    await c64Session.shutdown();
  } catch (shutdownError) {
    console.error('C64 Debug MCP HTTP shutdown failed:', shutdownError);
    exitCode = exitCode === 0 ? 1 : exitCode;
  } finally {
    process.exit(exitCode);
  }
}

process.once('SIGINT', () => {
  void shutdown(0);
});

process.once('SIGTERM', () => {
  void shutdown(0);
});

process.once('uncaughtException', (error) => {
  void shutdown(1, error);
});

process.once('unhandledRejection', (reason) => {
  void shutdown(1, reason);
});

httpServer.listen(port, host, () => {
  console.error(`C64 Debug MCP HTTP listening on http://${host}:${port}${mcpPath}`);
});
