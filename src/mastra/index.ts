import { Mastra } from '@mastra/core';

import { viceDebugServer } from '../../packages/vice-debug-mcp/src/server.js';

export const mastra = new Mastra({
  server: {
    port: 4111,
    host: 'localhost',
  },
  mcpServers: {
    viceDebug: viceDebugServer,
  },
});
