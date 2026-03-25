import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const packageRoot = path.join(repoRoot, 'packages/c64-debug-mcp');
const serverPath = path.join(packageRoot, 'dist/http.js');
const fixturePath = path.join(repoRoot, 'achtung_russia.prg');
const missingFixturePath = path.join(packageRoot, '.c64-debug-mcp-artifacts', 'does-not-exist.prg');
const fixtureBreakpointAddress = 0x141c;
const minimumNodeMajor = 22;
const reexecFlag = '--vice-debug-smoke-http-reexec';
const startupTimeoutMs = 15000;
const pollIntervalMs = 150;
const defaultDevHttpUrl = 'http://127.0.0.1:39080/mcp';

function parseMajor(version) {
  const major = Number.parseInt(String(version).replace(/^v/, '').split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listNodeCandidates() {
  const candidates = [];
  const seen = new Set();

  function addCandidate(candidatePath) {
    if (!candidatePath || seen.has(candidatePath)) {
      return;
    }
    seen.add(candidatePath);
    candidates.push(candidatePath);
  }

  addCandidate(path.join(os.homedir(), '.nvm/versions/node/v22.13.0/bin/node'));
  addCandidate(process.execPath);

  const nvmVersionsDir = path.join(os.homedir(), '.nvm/versions/node');
  try {
    const versionDirs = await fs.readdir(nvmVersionsDir, { withFileTypes: true });
    const sorted = versionDirs
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }));
    for (const versionDir of sorted) {
      if (parseMajor(versionDir) >= minimumNodeMajor) {
        addCandidate(path.join(nvmVersionsDir, versionDir, 'bin/node'));
      }
    }
  } catch {
    // Ignore missing nvm installs.
  }

  return candidates;
}

async function selectNodeBinary() {
  for (const candidate of await listNodeCandidates()) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find a Node >=${minimumNodeMajor} binary for the HTTP smoke test.`);
}

async function ensureMinimumNodeVersion() {
  if (parseMajor(process.version) >= minimumNodeMajor) {
    return;
  }

  if (process.argv.includes(reexecFlag)) {
    throw new Error(`HTTP smoke test requires Node >=${minimumNodeMajor}, but re-exec still ran on ${process.version}.`);
  }

  const nodePath = await selectNodeBinary();
  const args = [...process.argv.slice(1), reexecFlag];
  const result = spawnSync(nodePath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function unwrap(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  return result;
}

async function expectToolFailure(call) {
  const result = await call();
  if (result && typeof result === 'object' && 'isError' in result && result.isError) {
    return;
  }
  assert.fail('Expected tool call to fail');
}

async function getMonitorState(client) {
  return unwrap(
    await client.callTool({
      name: 'get_monitor_state',
      arguments: {},
    }),
  );
}

async function ensureRunning(client) {
  const state = await getMonitorState(client);
  if (state.data.executionState === 'running') {
    return state;
  }

  if (state.data.executionState === 'stopped') {
    await client.callTool({
      name: 'execute',
      arguments: { action: 'resume', waitUntilRunningStable: true },
    });
    await sleep(1000);
    return await getMonitorState(client);
  }

  await sleep(1000);
  return await getMonitorState(client);
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`HTTP MCP server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for HTTP MCP server health endpoint ${url}`);
}

async function terminateChild(child) {
  if (child.exitCode != null) {
    return;
  }

  child.kill('SIGTERM');

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
      resolve(undefined);
    }, 3000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

async function main() {
  await ensureMinimumNodeVersion();
  assert.ok(await exists(serverPath), `Built HTTP server not found at ${serverPath}. Run npm run build first.`);
  assert.ok(await exists(fixturePath), `Smoke fixture not found at ${fixturePath}.`);

  const externalUrl = process.env.C64_DEBUG_HTTP_URL?.trim();
  const usingExternalServer = Boolean(externalUrl);
  const mcpUrl = new URL(externalUrl || defaultDevHttpUrl);

  let child = null;
  let stderr = '';

  if (!usingExternalServer) {
    const port = await allocatePort();
    const host = '127.0.0.1';
    const healthUrl = `http://${host}:${port}/healthz`;
    const nodePath = process.execPath;

    mcpUrl.host = `${host}:${port}`;
    mcpUrl.pathname = '/mcp';

    child = spawn(nodePath, [serverPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        C64_DEBUG_HTTP_HOST: host,
        C64_DEBUG_HTTP_PORT: String(port),
        C64_DEBUG_HTTP_PATH: '/mcp',
        C64_DEBUG_HTTP_HEALTH_PATH: '/healthz',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });

    await waitForHealth(healthUrl, child);
  }

  try {
    const client = new Client({ name: 'c64debug-http-smoke', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(mcpUrl);

    await client.connect(transport);

    try {
      await ensureRunning(client);

      const sessionState = unwrap(
        await client.callTool({
          name: 'get_session_state',
          arguments: {},
        }),
      );
      assert.equal(typeof sessionState.data.idleAutoResumeArmed, 'boolean');
      assert.equal(typeof sessionState.data.explicitPauseActive, 'boolean');

      const capturedDisplay = unwrap(
        await client.callTool({
          name: 'capture_display',
          arguments: { useVic: true },
        }),
      );
      assert.ok(path.isAbsolute(capturedDisplay.data.imagePath));
      assert.equal(capturedDisplay.data.width, 320);
      assert.equal(capturedDisplay.data.height, 200);
      assert.equal(capturedDisplay.data.bitsPerPixel, 8);
      const capturedPng = await fs.readFile(capturedDisplay.data.imagePath);
      assert.equal(capturedPng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

      await ensureRunning(client);

      await expectToolFailure(() =>
        client.callTool({
          name: 'program_load',
          arguments: {
            filePath: missingFixturePath,
            autoStart: false,
            fileIndex: 0,
          },
        }),
      );

      const paused = unwrap(
        await client.callTool({
          name: 'execute',
          arguments: { action: 'pause' },
        }),
      );
      assert.equal(paused.data.executionState, 'stopped');

      const pausedRegisters = unwrap(
        await client.callTool({
          name: 'get_registers',
          arguments: {},
        }),
      );
      assert.equal(typeof pausedRegisters.data.registers.PC, 'number');

      const resumedStable = unwrap(
        await client.callTool({
          name: 'execute',
          arguments: { action: 'resume', waitUntilRunningStable: true },
        }),
      );
      assert.equal(resumedStable.data.executionState, 'running');

      const waitedRunning = unwrap(
        await client.callTool({
          name: 'wait_for_state',
          arguments: { executionState: 'running', timeoutMs: 5000 },
        }),
      );
      assert.equal(waitedRunning.data.reachedTarget, true);

      const autostart = unwrap(
        await client.callTool({
          name: 'program_load',
          arguments: {
            filePath: fixturePath,
            autoStart: false,
            fileIndex: 0,
          },
        }),
      );
      assert.equal(autostart.data.filePath, fixturePath);

      await expectToolFailure(() =>
        client.callTool({
          name: 'get_registers',
          arguments: {},
        }),
      );

      const createdBreakpoint = unwrap(
        await client.callTool({
          name: 'breakpoint_set',
          arguments: {
            address: fixtureBreakpointAddress,
            kind: 'exec',
            temporary: false,
            label: 'http_smoke_breakpoint',
            length: 1,
            enabled: true,
          },
        }),
      );
      assert.equal(createdBreakpoint.data.breakpoint.address, fixtureBreakpointAddress);

      const registers = unwrap(
        await client.callTool({
          name: 'get_registers',
          arguments: {},
        }),
      );
      assert.equal(typeof registers.data.registers.PC, 'number');

      const originalBytes = unwrap(
        await client.callTool({
          name: 'memory_read',
          arguments: { address: 0x0801, length: 8 },
        }),
      );

      try {
        const replacementBytes = [1, 2, 3, 4, 5, 6, 7, 8];
        const writeResult = unwrap(
          await client.callTool({
            name: 'memory_write',
            arguments: { address: 0x0801, data: replacementBytes },
          }),
        );
        assert.equal(writeResult.data.worked, true);

        const updatedBytes = unwrap(
          await client.callTool({
            name: 'memory_read',
            arguments: { address: 0x0801, length: 8 },
          }),
        );
        assert.deepEqual(updatedBytes.data.data, replacementBytes);
      } finally {
        await client.callTool({
          name: 'memory_write',
          arguments: { address: 0x0801, data: originalBytes.data.data },
        });
      }

      const stepped = unwrap(
        await client.callTool({
          name: 'execute',
          arguments: { action: 'step', count: 1 },
        }),
      );
      assert.equal(stepped.data.executionState, 'stopped');
      assert.equal(stepped.data.stepsExecuted, 1);

      const listedBreakpoints = unwrap(
        await client.callTool({
          name: 'list_breakpoints',
          arguments: { includeDisabled: true },
        }),
      );
      assert.ok(listedBreakpoints.data.breakpoints.some((bp) => bp.id === createdBreakpoint.data.breakpoint.id));

      const clearedBreakpoint = unwrap(
        await client.callTool({
          name: 'breakpoint_clear',
          arguments: { breakpointId: createdBreakpoint.data.breakpoint.id },
        }),
      );
      assert.equal(clearedBreakpoint.data.cleared, true);

      const resumed = unwrap(
        await client.callTool({
          name: 'execute',
          arguments: { action: 'resume', waitUntilRunningStable: true },
        }),
      );
      assert.equal(resumed.data.executionState, 'running');

      const joystickInput = unwrap(
        await client.callTool({
          name: 'joystick_input',
          arguments: { port: 2, action: 'tap', control: 'fire', durationMs: 50 },
        }),
      );
      assert.equal(joystickInput.data.applied, true);

      const runningAfterJoystick = unwrap(
        await client.callTool({
          name: 'wait_for_state',
          arguments: { executionState: 'running', timeoutMs: 5000 },
        }),
      );
      assert.equal(runningAfterJoystick.data.reachedTarget, true);

      console.log(`HTTP smoke test passed on ${mcpUrl.href}`);
    } finally {
      await client.close().catch(() => undefined);
      await transport.terminateSession().catch(() => undefined);
    }
  } finally {
    if (child) {
      await terminateChild(child);
    }
    if (child?.exitCode && child.exitCode !== 0) {
      throw new Error(`HTTP MCP server exited with code ${child.exitCode}\n${stderr}`);
    }
  }
}

await main();
