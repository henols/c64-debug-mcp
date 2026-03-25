import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const packageRoot = path.join(repoRoot, 'packages/c64-debug-mcp');
const serverPath = path.join(packageRoot, 'dist/stdio.js');
const fixturePath = path.join(repoRoot, 'achtung_russia.prg');
const missingFixturePath = path.join(packageRoot, '.c64-debug-mcp-artifacts', 'does-not-exist.prg');
const fixtureBreakpointAddress = 0x141c;
const minimumNodeMajor = 22;
const pausePollMs = 100;
const pauseTimeoutMs = 5000;
const reexecFlag = '--vice-debug-smoke-reexec';
const maxSmokeAttempts = 3;

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

  addCandidate(process.env.C64_DEBUG_SERVER_NODE);

  if (parseMajor(process.version) >= minimumNodeMajor) {
    addCandidate(process.execPath);
  }

  const nvmVersionsDir = path.join(os.homedir(), '.nvm/versions/node');
  addCandidate(path.join(nvmVersionsDir, 'v22.13.0', 'bin/node'));
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

async function selectServerNode() {
  for (const candidate of await listNodeCandidates()) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find a Node >=${minimumNodeMajor} binary for the MCP server. ` +
      'Set C64_DEBUG_SERVER_NODE to a suitable executable and rerun the smoke test.',
  );
}

async function ensureMinimumNodeVersion() {
  if (parseMajor(process.version) >= minimumNodeMajor) {
    return;
  }

  if (process.argv.includes(reexecFlag)) {
    throw new Error(`Smoke test requires Node >=${minimumNodeMajor}, but re-exec still ran on ${process.version}.`);
  }

  const nodePath = await selectServerNode();
  const args = [...process.argv.slice(1), reexecFlag];
  const result = spawnSync(nodePath, args, { stdio: 'inherit' });

  process.exit(result.status ?? 1);
}

function unwrap(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  return result;
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function expectToolFailure(call) {
  try {
    const result = await call();
    if (result && typeof result === 'object' && 'isError' in result && result.isError) {
      return;
    }
  } catch (error) {
    assert.ok(error);
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

async function waitForPaused(client) {
  const deadline = Date.now() + pauseTimeoutMs;

  while (Date.now() < deadline) {
    const monitorState = await getMonitorState(client);
    if (monitorState.data.executionState === 'stopped') {
      return monitorState;
    }
    await sleep(pausePollMs);
  }

  const lastState = await getMonitorState(client);
  assert.fail(
    `Expected emulator to reach a paused monitor state within ${pauseTimeoutMs}ms, got ${lastState.data.executionState}`,
  );
}

function isRetriableSmokeError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return /connection closed/i.test(error.message);
}

async function runSmokeAttempt() {
  await ensureMinimumNodeVersion();
  assert.ok(await exists(serverPath), `Built server not found at ${serverPath}. Run npm run build first.`);
  assert.ok(await exists(fixturePath), `Smoke fixture not found at ${fixturePath}.`);

  const serverNode = await selectServerNode();
  const client = new Client({ name: 'c64debug-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: serverNode,
    args: [serverPath],
    cwd: repoRoot,
    stderr: 'inherit',
  });

  await client.connect(transport);

  try {
    const monitorState = await ensureRunning(client);

    assert.equal(typeof monitorState.data.executionState, 'string');
    assert.equal(typeof monitorState.data.runtimeKnown, 'boolean');

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

    await expectToolFailure(
      () =>
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
      assert.equal(autostart.data.autoStart, false);
      assert.equal(autostart.data.fileIndex, 0);

    await expectToolFailure(
      () =>
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
          label: 'smoke_test_breakpoint',
          length: 1,
          enabled: true,
        },
      }),
    );
    assert.equal(createdBreakpoint.data.breakpoint.address, fixtureBreakpointAddress);
    assert.equal(createdBreakpoint.data.breakpoint.label, 'smoke_test_breakpoint');

    await waitForPaused(client);

    const stepped = unwrap(
      await client.callTool({
        name: 'execute',
        arguments: { action: 'step', count: 1 },
      }),
    );

    assert.equal(stepped.data.executionState, 'stopped');
    assert.equal(stepped.data.lastStopReason, 'step_complete');
    assert.equal(stepped.data.stepsExecuted, 1);
    assert.ok(stepped.data.registers);
    assert.equal(typeof stepped.data.programCounter, 'number');

    const registers = unwrap(
      await client.callTool({
        name: 'get_registers',
        arguments: {},
      }),
    );
    assert.equal(typeof registers.data.registers.PC, 'number');

    const memoryAddress = 0x0801;
    const originalBytes = unwrap(
      await client.callTool({
        name: 'memory_read',
        arguments: { address: memoryAddress, length: 8 },
      }),
    );

    assert.equal(originalBytes.data.length, 8);
    assert.equal(originalBytes.data.data.length, 8);

    try {
      const replacementBytes = [1, 2, 3, 4, 5, 6, 7, 8];
      const writeResult = unwrap(
        await client.callTool({
          name: 'memory_write',
          arguments: { address: memoryAddress, data: replacementBytes },
        }),
      );
      assert.equal(writeResult.data.worked, true);
      assert.equal(writeResult.data.length, replacementBytes.length);

      const updatedBytes = unwrap(
        await client.callTool({
          name: 'memory_read',
          arguments: { address: memoryAddress, length: 8 },
        }),
      );
      assert.deepEqual(updatedBytes.data.data, replacementBytes);
    } finally {
      await client.callTool({
        name: 'memory_write',
        arguments: { address: memoryAddress, data: originalBytes.data.data },
      });
    }

    const listedBreakpoints = unwrap(
      await client.callTool({
        name: 'list_breakpoints',
        arguments: { includeDisabled: true },
      }),
    );
    assert.ok(
      listedBreakpoints.data.breakpoints.some((breakpoint) => breakpoint.id === createdBreakpoint.data.breakpoint.id),
      'Expected created breakpoint to appear in list_breakpoints',
    );

    const clearedBreakpoint = unwrap(
      await client.callTool({
        name: 'breakpoint_clear',
        arguments: { breakpointId: createdBreakpoint.data.breakpoint.id },
      }),
    );
    assert.equal(clearedBreakpoint.data.cleared, true);

    const breakpointsAfterClear = unwrap(
      await client.callTool({
        name: 'list_breakpoints',
        arguments: { includeDisabled: true },
      }),
    );
    assert.ok(
      breakpointsAfterClear.data.breakpoints.every((breakpoint) => breakpoint.id !== createdBreakpoint.data.breakpoint.id),
      'Expected cleared breakpoint to be absent from list_breakpoints',
    );

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

    console.log(`Smoke test passed using server Node ${serverNode}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  for (let attempt = 1; attempt <= maxSmokeAttempts; attempt += 1) {
    try {
      await runSmokeAttempt();
      return;
    } catch (error) {
      if (attempt < maxSmokeAttempts && isRetriableSmokeError(error)) {
        console.error(`Smoke attempt ${attempt} failed with a transient stdio connection error; retrying.`);
        continue;
      }
      throw error;
    }
  }
}

await main();
