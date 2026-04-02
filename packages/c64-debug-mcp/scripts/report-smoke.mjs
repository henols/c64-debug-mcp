import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const serverPath = path.join(repoRoot, 'packages/c64-debug-mcp/dist/stdio.js');
const targetPrg = process.argv[2] ?? '/home/henrik/dev/henrik/git/heliovault/build/heliovault.prg';
const breakpointAddress = Number.parseInt(process.argv[3] ?? '0x141c', 16);

const client = new Client({ name: 'c64debug-report-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: repoRoot,
  stderr: 'inherit',
});

function unwrap(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  return result;
}

try {
  await client.connect(transport);

  const autostart = unwrap(
    await client.callTool({
      name: 'program_load',
      arguments: { filePath: targetPrg, autoStart: false, fileIndex: 0 },
    }),
  );

  const createdBreakpoint = unwrap(
    await client.callTool({
      name: 'breakpoint_set',
      arguments: { address: breakpointAddress, kind: 'exec', temporary: true, label: 'report_breakpoint', length: 1, enabled: true },
    }),
  );

  const listedBreakpoints = unwrap(
    await client.callTool({
      name: 'list_breakpoints',
      arguments: { includeDisabled: true },
    }),
  );

  const step = unwrap(
    await client.callTool({
      name: 'execute',
      arguments: { action: 'step', count: 1, resetMode: 'soft' },
    }),
  );

  const clearedBreakpoint = unwrap(
    await client.callTool({
      name: 'breakpoint_clear',
      arguments: { breakpointId: createdBreakpoint.data.breakpoint.id },
    }),
  );

  const breakpointsAfterClear = unwrap(
    await client.callTool({
      name: 'list_breakpoints',
      arguments: { includeDisabled: true },
    }),
  );

  const resumed = unwrap(
    await client.callTool({
      name: 'execute',
      arguments: { action: 'resume', count: 1, resetMode: 'soft' },
    }),
  );

  console.log(
    JSON.stringify(
      {
        autostart,
        createdBreakpoint,
        listedBreakpoints,
        step,
        clearedBreakpoint,
        breakpointsAfterClear,
        resumed,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
}
