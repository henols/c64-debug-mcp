#!/usr/bin/env node

import { c64DebugServer } from './server.js';
import { c64Session } from './server.js';

let shuttingDown = false;

async function shutdown(exitCode = 0, error?: unknown): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (error) {
    console.error('C64 Debug MCP server failed:', error);
  }

  try {
    await c64Session.shutdown();
  } catch (shutdownError) {
    console.error('C64 Debug MCP shutdown failed:', shutdownError);
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

process.once('beforeExit', () => {
  void shutdown(0);
});

process.once('uncaughtException', (error) => {
  void shutdown(1, error);
});

process.once('unhandledRejection', (reason) => {
  void shutdown(1, reason);
});

process.stdin.once('end', () => {
  void shutdown(0);
});

c64DebugServer.startStdio().catch((error) => {
  void shutdown(1, error);
});
