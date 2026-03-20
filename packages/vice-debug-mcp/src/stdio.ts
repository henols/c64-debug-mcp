#!/usr/bin/env node

import { viceDebugServer } from './server.js';

viceDebugServer.startStdio().catch((error) => {
  console.error('VICE Debug MCP server failed:', error);
  process.exit(1);
});
