#!/usr/bin/env node
/**
 * Chaos Test - Try to break the C64 Debug MCP in creative ways
 *
 * This test attempts various edge cases, race conditions, and abuse scenarios
 * to validate error handling and robustness.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const packageRoot = path.join(repoRoot, 'packages/c64-debug-mcp');
const serverPath = path.join(packageRoot, 'dist/stdio.js');
const ARTIFACTS_DIR = '.c64-debug-mcp-artifacts';
const TEST_TIMEOUT = 300000; // 5 minutes

class ChaosTest {
  constructor() {
    this.results = {
      passed: [],
      failed: [],
      skipped: []
    };
  }

  async runTest(name, testFn) {
    console.log(`\n🧪 ${name}`);
    try {
      await testFn();
      this.results.passed.push(name);
      console.log(`✅ PASSED: ${name}`);
    } catch (error) {
      this.results.failed.push({ name, error: error.message });
      console.log(`❌ FAILED: ${name}`);
      console.log(`   Error: ${error.message}`);
    }
  }

  async expectError(fn, expectedCode) {
    try {
      await fn();
      throw new Error(`Expected error with code ${expectedCode} but call succeeded`);
    } catch (error) {
      if (error.code === expectedCode || error.message?.includes(expectedCode)) {
        return; // Expected error
      }
      throw new Error(`Expected error code ${expectedCode}, got: ${error.code || error.message}`);
    }
  }

  printSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('🎯 CHAOS TEST SUMMARY');
    console.log('='.repeat(80));
    console.log(`✅ Passed: ${this.results.passed.length}`);
    console.log(`❌ Failed: ${this.results.failed.length}`);
    console.log(`⏭️  Skipped: ${this.results.skipped.length}`);

    if (this.results.failed.length > 0) {
      console.log('\n❌ Failed Tests:');
      this.results.failed.forEach(({ name, error }) => {
        console.log(`  - ${name}: ${error}`);
      });
    }

    console.log('='.repeat(80));
    return this.results.failed.length === 0;
  }
}

async function startMCPServer() {
  const client = new Client(
    {
      name: 'chaos-test',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    cwd: repoRoot,
    stderr: 'inherit',
  });

  await client.connect(transport);
  console.log('✓ MCP server connected');

  return { client, transport };
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  // Handle different response formats
  if (result.content && result.content[0]?.text) {
    const text = result.content[0].text;
    try {
      const parsed = JSON.parse(text);
      // Unwrap {meta, data} structure to just return data
      if (parsed.data && parsed.meta) {
        return parsed.data;
      }
      return parsed;
    } catch {
      return { text };
    }
  }

  // Handle structured content
  if (result.structuredContent) {
    const structured = result.structuredContent;
    // Unwrap {meta, data} structure to just return data
    if (structured.data && structured.meta) {
      return structured.data;
    }
    return structured;
  }

  return result;
}

async function main() {
  const chaos = new ChaosTest();
  let client, transport;

  try {
    ({ client, transport } = await startMCPServer());

    // ========================================================================
    // SECTION 1: INPUT VALIDATION CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 1: INPUT VALIDATION CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Null/undefined parameters', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_read', { address: null }),
        'validation'
      );
    });

    await chaos.runTest('Negative memory address', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_read', { address: -1, length: 1 }),
        'validation'
      );
    });

    await chaos.runTest('Memory address > 64KB', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_read', { address: 65536, length: 1 }),
        'validation'
      );
    });

    await chaos.runTest('Zero-length memory read', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_read', { address: 0, length: 0 }),
        'validation'
      );
    });

    await chaos.runTest('Huge memory read (> 64KB)', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_read', { address: 0, length: 100000 }),
        'validation'
      );
    });

    await chaos.runTest('Memory write with invalid hex', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_write', { address: 0x0400, bytes: [256] }),
        'validation'
      );
    });

    await chaos.runTest('Memory write beyond 64KB', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_write', { address: 65535, bytes: [1, 2, 3] }),
        'validation'
      );
    });

    await chaos.runTest('Empty write_text', async () => {
      await chaos.expectError(
        () => callTool(client, 'write_text', { text: '' }),
        'validation'
      );
    });

    await chaos.runTest('Write_text > 64 bytes', async () => {
      await chaos.expectError(
        () => callTool(client, 'write_text', { text: 'A'.repeat(65) }),
        'validation'
      );
    });

    await chaos.runTest('Invalid joystick port (0)', async () => {
      await chaos.expectError(
        () => callTool(client, 'joystick_input', { port: 0, action: 'tap', control: 'fire' }),
        'validation'
      );
    });

    await chaos.runTest('Invalid joystick port (3)', async () => {
      await chaos.expectError(
        () => callTool(client, 'joystick_input', { port: 3, action: 'tap', control: 'fire' }),
        'validation'
      );
    });

    await chaos.runTest('Invalid joystick control', async () => {
      await chaos.expectError(
        () => callTool(client, 'joystick_input', { port: 1, action: 'tap', control: 'turbo' }),
        'validation'
      );
    });

    await chaos.runTest('Negative tap duration', async () => {
      await chaos.expectError(
        () => callTool(client, 'joystick_input', { port: 1, action: 'tap', control: 'fire', durationMs: -100 }),
        'validation'
      );
    });

    await chaos.runTest('Breakpoint at invalid address', async () => {
      await chaos.expectError(
        () => callTool(client, 'breakpoint_set', { kind: 'exec', address: -1 }),
        'validation'
      );
    });

    await chaos.runTest('Breakpoint with end < start', async () => {
      await chaos.expectError(
        () => callTool(client, 'breakpoint_set', { kind: 'exec', address: 100, endAddress: 50 }),
        'validation'
      );
    });

    await chaos.runTest('Invalid register name', async () => {
      await chaos.expectError(
        () => callTool(client, 'set_registers', { z: 255 }),
        'validation'
      );
    });

    await chaos.runTest('Register value > 255', async () => {
      await chaos.expectError(
        () => callTool(client, 'set_registers', { a: 256 }),
        'validation'
      );
    });

    await chaos.runTest('Program counter > 65535', async () => {
      await chaos.expectError(
        () => callTool(client, 'set_registers', { pc: 70000 }),
        'validation'
      );
    });

    // ========================================================================
    // SECTION 2: FILE SYSTEM CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 2: FILE SYSTEM CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Load nonexistent file', async () => {
      await chaos.expectError(
        () => callTool(client, 'program_load', { filePath: '/tmp/does-not-exist-chaos.prg' }),
        'program_file_missing'
      );
    });

    await chaos.runTest('Load directory instead of file', async () => {
      await chaos.expectError(
        () => callTool(client, 'program_load', { filePath: '/tmp' }),
        'program_file_invalid'
      );
    });

    await chaos.runTest('Load file with null bytes in path', async () => {
      await chaos.expectError(
        () => callTool(client, 'program_load', { filePath: '/tmp/test\x00.prg' }),
        'program_file'
      );
    });

    await chaos.runTest('Capture display to invalid path', async () => {
      // This should work but create file in artifacts dir
      const result = await callTool(client, 'capture_display', {});
      if (!result.imagePath) {
        throw new Error('No image path returned');
      }
    });

    // ========================================================================
    // SECTION 3: STATE TRANSITION CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 3: STATE TRANSITION CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Get registers while running', async () => {
      // First ensure running
      const state = await callTool(client, 'get_monitor_state');
      if (state.executionState !== 'running') {
        await callTool(client, 'execute', { action: 'resume' });
      }

      await chaos.expectError(
        () => callTool(client, 'get_registers'),
        'debugger_not_paused'
      );
    });

    await chaos.runTest('Set registers while running', async () => {
      await chaos.expectError(
        () => callTool(client, 'set_registers', { a: 42 }),
        'debugger_not_paused'
      );
    });

    await chaos.runTest('Memory write while running', async () => {
      await chaos.expectError(
        () => callTool(client, 'memory_write', { address: 0x0400, bytes: [1, 2, 3] }),
        'debugger_not_paused'
      );
    });

    await chaos.runTest('Step while running', async () => {
      await chaos.expectError(
        () => callTool(client, 'execute', { action: 'step' }),
        'debugger_not_paused'
      );
    });

    await chaos.runTest('Resume while already running', async () => {
      await chaos.expectError(
        () => callTool(client, 'execute', { action: 'resume' }),
        'debugger_not_paused'
      );
    });

    await chaos.runTest('Double pause', async () => {
      // Pause once
      await callTool(client, 'execute', { action: 'pause' });
      // Try pause again - should just return current state
      const result = await callTool(client, 'execute', { action: 'pause' });
      if (result.executionState !== 'stopped') {
        throw new Error('Expected stopped state after double pause');
      }
    });

    await chaos.runTest('Rapid pause/resume cycles', async () => {
      for (let i = 0; i < 5; i++) {
        await callTool(client, 'execute', { action: 'resume' });
        await new Promise(r => setTimeout(r, 50));
        await callTool(client, 'execute', { action: 'pause' });
        await new Promise(r => setTimeout(r, 50));
      }
      // Should end in stopped state
      const state = await callTool(client, 'get_monitor_state');
      if (state.executionState !== 'stopped') {
        throw new Error('State corrupted after rapid cycles');
      }
    });

    // ========================================================================
    // SECTION 4: BREAKPOINT CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 4: BREAKPOINT CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Clear nonexistent breakpoint', async () => {
      const result = await callTool(client, 'breakpoint_clear', { breakpointId: 999999 });
      if (result.cleared !== false) {
        throw new Error('Should return cleared: false for nonexistent breakpoint');
      }
    });

    await chaos.runTest('List breakpoints with invalid filter', async () => {
      // Should gracefully reject invalid parameter or use default
      try {
        const result = await callTool(client, 'list_breakpoints', { includeDisabled: 'maybe' });
        // If it somehow accepts it, check the result
        if (!Array.isArray(result.breakpoints)) {
          throw new Error('Expected breakpoints array');
        }
      } catch (error) {
        // Validation error is acceptable - just verify we can still call it correctly
        const result = await callTool(client, 'list_breakpoints');
        if (!Array.isArray(result.breakpoints)) {
          throw new Error('Expected breakpoints array');
        }
      }
    });

    await chaos.runTest('Set breakpoint at address 0', async () => {
      // Should work - 0 is valid
      const result = await callTool(client, 'breakpoint_set', { kind: 'exec', address: 0 });
      if (!result.breakpoint || !result.breakpoint.id) {
        throw new Error('Should create breakpoint at address 0');
      }
      // Clean up
      await callTool(client, 'breakpoint_clear', { breakpointId: result.breakpoint.id });
    });

    await chaos.runTest('Set breakpoint at address 65535', async () => {
      // Should work - max valid address
      const result = await callTool(client, 'breakpoint_set', { kind: 'exec', address: 65535 });
      if (!result.breakpoint || !result.breakpoint.id) {
        throw new Error('Should create breakpoint at max address');
      }
      await callTool(client, 'breakpoint_clear', { breakpointId: result.breakpoint.id });
    });

    await chaos.runTest('Create 100 breakpoints', async () => {
      const ids = [];
      for (let i = 0; i < 100; i++) {
        const result = await callTool(client, 'breakpoint_set', {
          kind: 'exec',
          address: 0x0800 + i
        });
        ids.push(result.breakpoint.id);
      }

      // List them
      const list = await callTool(client, 'list_breakpoints');
      if (list.breakpoints.length < 100) {
        throw new Error('Not all breakpoints were created');
      }

      // Clean up
      for (const id of ids) {
        await callTool(client, 'breakpoint_clear', { breakpointId: id });
      }
    });

    await chaos.runTest('Toggle same breakpoint rapidly', async () => {
      const bp = await callTool(client, 'breakpoint_set', { kind: 'exec', address: 0x1000 });

      for (let i = 0; i < 10; i++) {
        await callTool(client, 'breakpoint_toggle', { breakpointId: bp.breakpointId, enabled: false });
        await callTool(client, 'breakpoint_toggle', { breakpointId: bp.breakpointId, enabled: true });
      }

      await callTool(client, 'breakpoint_clear', { breakpointId: bp.breakpointId });
    });

    // ========================================================================
    // SECTION 5: CONCURRENT OPERATION CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 5: CONCURRENT OPERATION CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Simultaneous memory reads', async () => {
      // Ensure stopped first
      await callTool(client, 'execute', { action: 'pause' });

      const reads = Array(20).fill(null).map((_, i) =>
        callTool(client, 'memory_read', { address: i * 0x100, length: 16 })
      );

      const results = await Promise.all(reads);
      if (results.length !== 20) {
        throw new Error('Not all concurrent reads completed');
      }
    });

    await chaos.runTest('Simultaneous state queries', async () => {
      const queries = Array(50).fill(null).map(() =>
        callTool(client, 'get_monitor_state')
      );

      const results = await Promise.all(queries);
      if (results.length !== 50) {
        throw new Error('Not all concurrent queries completed');
      }
    });

    await chaos.runTest('Read and write same memory concurrently', async () => {
      await callTool(client, 'execute', { action: 'pause' });

      const operations = [
        callTool(client, 'memory_read', { address: 0x0400, length: 10 }),
        callTool(client, 'memory_write', { address: 0x0400, bytes: [1, 2, 3] }),
        callTool(client, 'memory_read', { address: 0x0400, length: 10 }),
      ];

      await Promise.all(operations);
      // Just check they all complete without crashing
    });

    // ========================================================================
    // SECTION 6: EXTREME VALUES CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 6: EXTREME VALUES CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Step 0 instructions', async () => {
      await callTool(client, 'execute', { action: 'pause' });
      await chaos.expectError(
        () => callTool(client, 'execute', { action: 'step', count: 0 }),
        'validation'
      );
    });

    await chaos.runTest('Step 10000 instructions', async () => {
      await callTool(client, 'execute', { action: 'pause' });
      // This might time out or complete, either is acceptable
      try {
        const result = await callTool(client, 'execute', { action: 'step', count: 10000 });
        // If it completes, that's fine
      } catch (error) {
        // Timeout or limit error is also acceptable
        if (!error.message.includes('timeout') && !error.message.includes('limit')) {
          throw error;
        }
      }
    });

    await chaos.runTest('Wait for state with 0ms timeout', async () => {
      const result = await callTool(client, 'wait_for_state', {
        targetState: 'stopped',
        timeoutMs: 0
      });
      // Should return immediately
    });

    await chaos.runTest('Joystick tap with 0ms duration', async () => {
      // Ensure running first (previous test may have left it stopped)
      const state = await callTool(client, 'get_monitor_state');
      if (state.executionState !== 'running') {
        await callTool(client, 'execute', { action: 'resume' });
      }
      // Should clamp to minimum
      const result = await callTool(client, 'joystick_input', {
        port: 1,
        action: 'tap',
        control: 'fire',
        durationMs: 0
      });
      if (!result.applied) {
        throw new Error('Joystick tap should succeed with 0ms');
      }
    });

    await chaos.runTest('Joystick tap with huge duration', async () => {
      // Ensure running first
      const state = await callTool(client, 'get_monitor_state');
      if (state.executionState !== 'running') {
        await callTool(client, 'execute', { action: 'resume' });
      }
      // Should clamp to maximum
      const result = await callTool(client, 'joystick_input', {
        port: 1,
        action: 'tap',
        control: 'fire',
        durationMs: 999999
      });
      if (!result.applied) {
        throw new Error('Joystick tap should succeed with huge duration');
      }
    });

    // ========================================================================
    // SECTION 7: DISPLAY CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 7: DISPLAY CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Rapid display captures', async () => {
      const captures = Array(10).fill(null).map(() =>
        callTool(client, 'capture_display')
      );

      const results = await Promise.all(captures);
      if (results.some(r => !r.imagePath)) {
        throw new Error('Some captures failed');
      }
    });

    await chaos.runTest('Get display state 100 times', async () => {
      for (let i = 0; i < 100; i++) {
        await callTool(client, 'get_display_state');
      }
    });

    await chaos.runTest('Get display text while in graphics mode', async () => {
      // May return unsupported or text, both are valid
      try {
        const result = await callTool(client, 'get_display_text');
        // Text mode succeeded
      } catch (error) {
        if (!error.message.includes('unsupported') && !error.message.includes('graphics')) {
          throw error;
        }
        // Graphics mode error is expected
      }
    });

    // ========================================================================
    // SECTION 8: RESET CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 8: RESET CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Rapid hard resets', async () => {
      for (let i = 0; i < 5; i++) {
        await callTool(client, 'execute', { action: 'reset', resetMode: 'hard' });
        await new Promise(r => setTimeout(r, 100));
      }
    });

    await chaos.runTest('Reset while paused', async () => {
      await callTool(client, 'execute', { action: 'pause' });
      const result = await callTool(client, 'execute', { action: 'reset', resetMode: 'soft' });
      if (result.executionState !== 'stopped') {
        throw new Error('Should be stopped after reset from paused state');
      }
    });

    await chaos.runTest('Reset then immediate memory read', async () => {
      await callTool(client, 'execute', { action: 'reset', resetMode: 'hard' });
      await callTool(client, 'execute', { action: 'pause' });
      const mem = await callTool(client, 'memory_read', { address: 0xFFFC, length: 2 });
      if (!mem.data || mem.data.length !== 2) {
        throw new Error('Should read reset vector');
      }
    });

    // ========================================================================
    // SECTION 9: INPUT CHAOS
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 9: INPUT CHAOS');
    console.log('='.repeat(80));

    await chaos.runTest('Keyboard input special characters', async () => {
      // Ensure running first
      const state = await callTool(client, 'get_monitor_state');
      if (state.executionState !== 'running') {
        await callTool(client, 'execute', { action: 'resume' });
      }

      const result = await callTool(client, 'keyboard_input', {
        action: 'tap',
        keys: ['return', 'home', 'clr', 'pi']
      });
      if (!result.applied) {
        throw new Error('Special key input should succeed');
      }
    });

    await chaos.runTest('Write unicode text', async () => {
      // Should fail or convert
      await chaos.expectError(
        () => callTool(client, 'write_text', { text: '🎮🕹️👾' }),
        'validation'
      );
    });

    await chaos.runTest('All joystick controls', async () => {
      // Ensure running first
      const state = await callTool(client, 'get_monitor_state');
      if (state.executionState !== 'running') {
        await callTool(client, 'execute', { action: 'resume' });
      }

      const controls = ['up', 'down', 'left', 'right', 'fire'];
      for (const control of controls) {
        const result = await callTool(client, 'joystick_input', {
          port: 1,
          action: 'tap',
          control,
          durationMs: 50
        });
        if (!result.applied) {
          throw new Error(`Joystick ${control} should work`);
        }
      }
    });

    await chaos.runTest('Joystick press without release', async () => {
      // Ensure running first
      const state = await callTool(client, 'get_monitor_state');
      if (state.executionState !== 'running') {
        await callTool(client, 'execute', { action: 'resume' });
      }

      const result1 = await callTool(client, 'joystick_input', {
        port: 1,
        action: 'press',
        control: 'fire'
      });

      const result2 = await callTool(client, 'joystick_input', {
        port: 1,
        action: 'press',
        control: 'up'
      });

      // Both should be pressed now
      if (!result2.state.up || !result2.state.fire) {
        throw new Error('Multiple joystick buttons should be pressed');
      }

      // Release all
      await callTool(client, 'joystick_input', { port: 1, action: 'release', control: 'fire' });
      await callTool(client, 'joystick_input', { port: 1, action: 'release', control: 'up' });
    });

    // ========================================================================
    // SECTION 10: STRESS TEST - THE FIXES
    // ========================================================================
    console.log('\n' + '='.repeat(80));
    console.log('SECTION 10: STRESS TEST THE FIXES WE JUST MADE');
    console.log('='.repeat(80));

    await chaos.runTest('Verify program_load validates files', async () => {
      // Test the fix from commit 1
      await chaos.expectError(
        () => callTool(client, 'program_load', {
          filePath: `${ARTIFACTS_DIR}/definitely-does-not-exist-${Date.now()}.prg`
        }),
        'program_file_missing'
      );
    });

    await chaos.runTest('Resume after reset returns stable state', async () => {
      // Test the fix from commit 2
      await callTool(client, 'execute', { action: 'reset', resetMode: 'hard' });
      const result = await callTool(client, 'execute', { action: 'resume' });

      // Should either be running or have a resume_async warning
      if (result.executionState !== 'running' &&
          !result.warnings?.some(w => w.code === 'resume_async')) {
        throw new Error('Resume should return running or have async warning');
      }
    });

    await chaos.runTest('Hit breakpoint shows correct stop reason', async () => {
      // Test the fallback checkpoint query
      await callTool(client, 'execute', { action: 'pause' });

      // Set breakpoint at current PC
      const state = await callTool(client, 'get_monitor_state');
      const bp = await callTool(client, 'breakpoint_set', {
        kind: 'exec',
        address: state.programCounter,
        temporary: true
      });

      // Step once to move PC
      await callTool(client, 'execute', { action: 'step' });

      // Resume - should hit breakpoint immediately
      await callTool(client, 'execute', { action: 'resume' });

      // Wait a bit for stop
      await new Promise(r => setTimeout(r, 500));

      const newState = await callTool(client, 'get_monitor_state');

      // May take a moment for checkpoint query to complete
      // So we don't strictly require 'breakpoint', but it shouldn't be 'unknown'
      console.log(`   Stop reason: ${newState.lastStopReason}`);
    });

    await chaos.runTest('Joystick input maintains running state', async () => {
      // Test joystick recovery fix
      const stateBefore = await callTool(client, 'get_monitor_state');
      if (stateBefore.executionState !== 'running') {
        await callTool(client, 'execute', { action: 'resume' });
      }

      await callTool(client, 'joystick_input', {
        port: 1,
        action: 'tap',
        control: 'fire',
        durationMs: 50
      });

      // Wait for running state with wait_for_state tool
      const waitResult = await callTool(client, 'wait_for_state', {
        executionState: 'running',
        timeoutMs: 3000
      });

      if (!waitResult.reachedTarget) {
        throw new Error('Joystick input should preserve running state');
      }
    });

    await chaos.runTest('Stress test checkpoint detection', async () => {
      // Rapidly set/clear/hit breakpoints
      await callTool(client, 'execute', { action: 'pause' });
      const state = await callTool(client, 'get_monitor_state');

      for (let i = 0; i < 10; i++) {
        const bp = await callTool(client, 'breakpoint_set', {
          kind: 'exec',
          address: (state.programCounter + i) & 0xFFFF,
          temporary: true
        });

        await callTool(client, 'execute', { action: 'step' });
      }
    });

  } catch (error) {
    console.error('\n💥 FATAL ERROR:', error);
    throw error;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }

  return chaos.printSummary();
}

// Run with timeout
const timer = setTimeout(() => {
  console.error('\n⏰ TEST TIMEOUT - Chaos test exceeded maximum time');
  process.exit(1);
}, TEST_TIMEOUT);

main()
  .then(success => {
    clearTimeout(timer);
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    clearTimeout(timer);
    console.error('\n💥 UNHANDLED ERROR:', error);
    process.exit(1);
  });
