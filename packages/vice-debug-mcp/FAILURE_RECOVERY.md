# Connection Loss & Process Termination Recovery

This document explains what happens when the VICE connection is lost or the VICE process terminates unexpectedly.

## Scenario 1: TCP Connection Lost (VICE Still Running)

**Example**: Network hiccup, VICE temporarily stops accepting connections, firewall blocks port

### What Happens

1. **Immediate Detection**
   - TCP socket emits `'close'` event ([vice-protocol.ts:710](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/vice-protocol.ts#L710))
   - All pending operations immediately reject with `connection_closed` error ([vice-protocol.ts:711-714](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/vice-protocol.ts#L711-L714))
   - `transportState` changes from `'connected'` → `'disconnected'` ([session.ts:764](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L764))

2. **Automatic Recovery Triggered**
   - Close handler checks: `!suppressRecovery && !shuttingDown && config exists` ([session.ts:767](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L767))
   - If conditions met → `#scheduleRecovery()` called ([session.ts:768](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L768))
   - Recovery runs asynchronously (doesn't block the close event)

3. **Recovery Process** ([session.ts:1772-1803](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L1772-L1803))
   ```
   ┌─ Check if recovery already in progress ─────────────────┐
   │  If yes: Wait for existing recovery to complete         │
   │  If no: Start new recovery                              │
   └──────────────────────────────────────────────────────────┘
                           ↓
   ┌─ Check VICE process state ───────────────────────────────┐
   │  Is process alive? (exitCode == null && !killed)        │
   └──────────────────────────────────────────────────────────┘
                           ↓
              ┌────────────┴────────────┐
              ↓                         ↓
   ┌─────────────────┐      ┌──────────────────────┐
   │ Process ALIVE   │      │ Process DEAD/MISSING │
   └─────────────────┘      └──────────────────────┘
              ↓                         ↓
   ┌─ Reconnect TCP ─────┐   ┌─ Restart VICE ──────┐
   │ State: reconnecting │   │ Launch new process  │
   │ client.connect()    │   │ Wait for monitor    │
   │ State: connected    │   │ State: connected    │
   │ Hydrate exec state  │   └─────────────────────┘
   └─────────────────────┘
              ↓
   ┌─ Recovery Complete ─────────────────────────────────────┐
   │ recoveryInProgress = false                              │
   │ recoveryPromise = null                                  │
   └─────────────────────────────────────────────────────────┘
   ```

4. **User Experience**
   - **During connection loss**: In-flight operations fail with `connection_closed` error
   - **During recovery**: New operations are queued, waiting for `#ensureHealthyConnection()`
   - **After recovery**: Operations resume normally, execution state is re-synchronized

### Error Behavior

```javascript
// If user calls a tool during disconnection:
await callTool(client, 'get_monitor_state');

// They get:
{
  code: 'connection_closed',
  message: 'Emulator debug connection closed',
  category: 'connection',
  retryable: true  // ← Important! User can retry
}
```

### Timeline Example

```
t=0ms    Connection lost
t=0ms    transportState: connected → disconnected
t=0ms    All pending operations reject with connection_closed
t=0ms    Recovery scheduled (async)
t=1ms    New tool call → waits for recovery via #ensureHealthyConnection()
t=50ms   Recovery starts: transportState → reconnecting
t=100ms  TCP reconnect attempt
t=150ms  Reconnected! transportState → connected
t=160ms  Execution state hydrated from VICE
t=170ms  Recovery complete, queued tool calls proceed
```

## Scenario 2: VICE GUI Closed by User

**Example**: User clicks "Quit" in VICE window, closes window with X button, kills process

### What Happens

1. **Process Exit Detection**
   - Child process emits `'exit'` event with code & signal ([session.ts:1879-1896](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L1879-L1896))
   - Code 0 = clean exit, non-zero = crash
   - `processState`: `'running'` → `'exited'` or `'crashed'`
   - `transportState`: `'connected'` → `'disconnected'`
   - Warning added: "C64 emulator process exited (code / signal)"

2. **TCP Connection Also Closes**
   - VICE closing → TCP socket closes
   - Same `'close'` event as Scenario 1
   - Dual recovery trigger: process exit handler AND connection close handler

3. **Recovery Strategy** ([session.ts:1782-1795](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L1782-L1795))
   - Process is dead → can't reconnect TCP
   - Falls through to `#launchManagedEmulator('restart')` ([session.ts:1795](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L1795))
   - Spawns new VICE process with same configuration
   - Waits for VICE monitor to become available
   - Connects to new process
   - `restartCount++` (tracked in session state)

4. **User Experience**
   - **Brief interruption**: All in-flight operations fail
   - **Automatic restart**: New VICE window opens automatically
   - **State loss**: Memory contents reset, execution starts fresh
   - **Session preserved**: MCP session continues, users don't need to reconnect

### Error Behavior

```javascript
// During the window where VICE is dead but MCP server is restarting:
await callTool(client, 'memory_read', { address: 0x0400, length: 10 });

// User temporarily gets:
{
  code: 'connection_closed',
  message: 'The server could not communicate with the emulator. Try the request again.',
  category: 'connection',
  retryable: true
}

// After ~2 seconds (default VICE_STARTUP_TIMEOUT):
// Same call succeeds with new VICE instance
```

### Timeline Example

```
t=0ms    User clicks "Quit" in VICE
t=10ms   VICE process exits (code 0)
t=10ms   Process 'exit' event: processState → exited
t=10ms   Warning added: "emulator process exited (0 / null)"
t=10ms   Recovery triggered from process exit handler
t=15ms   TCP connection closes
t=15ms   Connection 'close' event: transportState → disconnected
t=15ms   Recovery triggered again (deduplicated by #recoveryPromise check)
t=20ms   Recovery detects dead process
t=20ms   New VICE process spawned
t=500ms  VICE GUI appears on screen
t=1200ms VICE monitor port opens
t=1250ms TCP connection established
t=1260ms transportState → connected
t=1270ms Execution state hydrated
t=1280ms Recovery complete, restartCount incremented
t=1290ms Queued tool calls proceed with fresh VICE
```

## Scenario 3: VICE Crashes

**Example**: Segfault, assertion failure, OOM kill

### What Happens

Same as Scenario 2, but:
- `processState` = `'crashed'` instead of `'exited'` ([session.ts:1886](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L1886))
- Warning includes non-zero exit code ([session.ts:1890](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L1890))
- Process 'error' event may also fire ([session.ts:1898-1912](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L1898-L1912))
  - Additional warning with error message
  - `transportState` → `'faulted'`

## Configuration: When Recovery is Disabled

Recovery is **suppressed** in these cases:

1. **During shutdown** - `#shuttingDown === true`
   - Set when `close()` is called ([session.ts:832](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L832))
   - Prevents restart during intentional teardown

2. **Recovery explicitly disabled** - `#suppressRecovery === true`
   - Set during shutdown ([session.ts:834](file:///home/henrik/dev/henrik/git/ViceMCP/ViceMCP/packages/vice-debug-mcp/src/session.ts#L834))
   - Can be set by internal error handlers

3. **No configuration** - `#config === null`
   - If VICE was never started via `start()` method
   - External VICE connections don't auto-restart

## Monitoring Session Health

Users can check recovery status via `get_session_state`:

```javascript
const state = await callTool(client, 'get_session_state');

console.log({
  transportState: state.transportState,    // 'reconnecting', 'connected', 'disconnected', etc.
  processState: state.processState,        // 'running', 'exited', 'crashed'
  executionState: state.executionState,    // 'running', 'stopped', 'unknown'
  recoveryInProgress: state.recoveryInProgress,  // true during recovery
  restartCount: state.restartCount,        // how many times VICE was restarted
  launchId: state.launchId,                // increments each launch
  connectedSince: state.connectedSince,    // ISO timestamp of connection
  warnings: state.warnings                 // active warnings including process_exit
});
```

## Best Practices for Tool Users (LLMs/Clients)

### 1. Handle Retryable Errors

```javascript
async function robustToolCall(name, args, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callTool(client, name, args);
    } catch (error) {
      if (!error.retryable || attempt === maxRetries) {
        throw error;
      }
      // Wait with exponential backoff
      await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 5000));
    }
  }
}
```

### 2. Check Session State After Errors

```javascript
try {
  await callTool(client, 'memory_read', { address: 0x0400, length: 10 });
} catch (error) {
  if (error.code === 'connection_closed') {
    const state = await callTool(client, 'get_session_state');
    if (state.recoveryInProgress) {
      console.log('Recovery in progress, waiting...');
      await sleep(2000);
      // Retry after recovery
    }
  }
}
```

### 3. Monitor Warnings

```javascript
const state = await callTool(client, 'get_session_state');

if (state.warnings.some(w => w.code === 'process_exit')) {
  console.log('VICE was restarted - memory state is fresh');
  // Re-load programs, re-set breakpoints, etc.
}
```

### 4. Use `wait_for_state` After Recovery

```javascript
// After detecting a restart:
await callTool(client, 'wait_for_state', {
  targetState: 'running',
  timeoutMs: 5000
});
// Now safe to proceed with debugging
```

## Recovery Limitations

### What's Preserved
- ✅ MCP client connection (stdio/HTTP transport stays alive)
- ✅ Session configuration (emulator type, settings)
- ✅ Breakpoint labels (stored in MCP server)
- ✅ Tool call queue (operations wait for recovery)

### What's Lost
- ❌ Emulator memory contents
- ❌ CPU register values
- ❌ Execution position (PC resets)
- ❌ Active breakpoints (VICE loses them)
- ❌ Held keyboard/joystick state
- ❌ Loaded programs

### What Needs Re-initialization

After VICE restart, users should:
1. Reload programs with `program_load`
2. Re-set breakpoints with `breakpoint_set`
3. Re-configure execution state (pause if needed)
4. Re-apply any memory modifications

## Error Codes Reference

| Code | Retryable | Meaning | Common Cause |
|------|-----------|---------|--------------|
| `connection_closed` | ✅ Yes | TCP connection lost | Network issue, VICE quit, VICE crash |
| `not_connected` | ✅ Yes | Not connected yet | Called before VICE started |
| `timeout` | ✅ Yes | Operation timed out | VICE frozen, network delay |
| `socket_write_failed` | ✅ Yes | Can't write to socket | Connection dying |
| `monitor_timeout` | ❌ No | Can't establish monitor | VICE startup failed |
| `debugger_not_paused` | ❌ No | Need stopped state | Wrong execution state |
| `emulator_not_running` | ❌ No | Need running state | Wrong execution state |

## Advanced: Disabling Auto-Recovery

For testing or debugging, you can disable recovery:

```javascript
// Option 1: Call close() to suppress recovery
await session.close();

// Option 2: Set suppressRecovery flag before connection loss
// (No public API - internal only)

// Option 3: Don't provide config (external VICE mode)
// Recovery only works for managed VICE processes
```

## Summary

**Connection Lost (VICE alive)**:
- Reconnects TCP automatically
- No VICE restart needed
- Very fast recovery (~100-200ms)
- No state loss

**VICE Closed/Crashed**:
- Restarts VICE automatically
- Spawns new window
- Slower recovery (~1-2 seconds)
- **All emulator state lost**

**Both scenarios**:
- Operations marked `retryable: true` can be retried
- Recovery happens asynchronously
- MCP session stays alive
- Users should re-initialize after VICE restart

The system is designed for **maximum resilience** - connections can drop and VICE can crash, but the MCP server keeps working and automatically recovers.
