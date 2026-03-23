import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import zlib from 'node:zlib';

import {
  C64_REGISTER_DEFINITIONS,
  C64_TARGET,
  DEFAULT_C64_BINARY,
  DEFAULT_FORBIDDEN_PORTS,
  DEFAULT_MONITOR_HOST,
  c64ConfigSchema,
  type C64RegisterName,
  type BreakpointKind,
  type C64Config,
  type InputAction,
  type JoystickControl,
  type JoystickPort,
  type ProgramLoadMode,
  type ResponseMeta,
  type SessionState,
  type StopReason,
  type WarningItem,
} from './contracts.js';
import { ViceMcpError, debuggerNotPausedError, unsupportedError, validationError } from './errors.js';
import { ViceMonitorClient } from './vice-protocol.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultC64Config(): C64Config {
  return c64ConfigSchema.parse({});
}

function normalizeConfig(config: C64Config): C64Config {
  const trimmedArguments = config.arguments?.trim() || undefined;
  validateManagedLaunchArguments(trimmedArguments);

  return c64ConfigSchema.parse({
    binaryPath: config.binaryPath?.trim() || undefined,
    workingDirectory: config.workingDirectory?.trim() || undefined,
    arguments: trimmedArguments,
  });
}

function validateManagedLaunchArguments(argumentsString: string | undefined): void {
  if (!argumentsString) {
    return;
  }

  const args = splitCommandLine(argumentsString);
  if (args.includes('-console')) {
    validationError('Managed emulator sessions must run with a graphical C64 emulator window. Headless console mode is not allowed.', {
      argument: '-console',
    });
  }
}

async function buildViceLaunchEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const uid = os.userInfo().uid;
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;

  env.XDG_RUNTIME_DIR ||= runtimeDir;

  if (!env.WAYLAND_DISPLAY) {
    const waylandDisplay = await firstRuntimeEntry(runtimeDir, /^wayland-\d+$/);
    if (waylandDisplay) {
      env.WAYLAND_DISPLAY = waylandDisplay;
    }
  }

  if (!env.XAUTHORITY) {
    const xauthority = await firstRuntimeEntry(runtimeDir, /^\.mutter-Xwaylandauth\./, true);
    if (xauthority) {
      env.XAUTHORITY = xauthority;
    }
  }

  if (!env.DISPLAY) {
    env.DISPLAY = ':0';
  }

  return env;
}

async function firstRuntimeEntry(runtimeDir: string, pattern: RegExp, returnAbsolutePath = false): Promise<string | null> {
  try {
    const entries = await fs.readdir(runtimeDir);
    const match = entries.find((entry) => pattern.test(entry));
    if (!match) {
      return null;
    }
    return returnAbsolutePath ? path.join(runtimeDir, match) : match;
  } catch {
    return null;
  }
}

function encodePngGrayscale(width: number, height: number, pixels: Uint8Array): string {
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width + 1)] = 0;
    Buffer.from(pixels.subarray(y * width, y * width + width)).copy(rows, y * (width + 1) + 1);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    pngChunk(
      'IHDR',
      Buffer.concat([
        uint32(width),
        uint32(height),
        Buffer.from([8, 0, 0, 0, 0]),
      ]),
    ),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat([signature, ...chunks]).toString('base64');
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  return Buffer.concat([uint32(data.length), typeBuffer, data, uint32(crc >>> 0)]);
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeWarning(message: string, code = 'warning'): WarningItem {
  return { code, message };
}

function encodePetscii(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    if (char === '\n' || char === '\r') {
      bytes.push(0x0d);
      continue;
    }

    const code = char.codePointAt(0);
    if (code == null) {
      continue;
    }

    if (code >= 0x61 && code <= 0x7a) {
      bytes.push(code - 0x20);
      continue;
    }

    if ((code >= 0x20 && code <= 0x5f) || (code >= 0x30 && code <= 0x39) || code === 0x5c) {
      bytes.push(code);
      continue;
    }

    validationError('send_keys only supports ASCII text plus newline for PETSCII encoding', { character: char, codePoint: code });
  }

  return Uint8Array.from(bytes);
}

const JOYSTICK_CONTROL_BITS: Record<JoystickControl, number> = {
  up: 0x01,
  down: 0x02,
  left: 0x04,
  right: 0x08,
  fire: 0x10,
};

const JOYSTICK_RELEASED_MASK = 0x1f;
const DEFAULT_INPUT_TAP_MS = 75;
const DEFAULT_KEYBOARD_REPEAT_MS = 100;

function normalizeKeyboardKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    validationError('keyboard_input requires a non-empty key name');
  }

  const symbolic = trimmed.toUpperCase();
  switch (symbolic) {
    case 'SPACE':
      return ' ';
    case 'ENTER':
    case 'RETURN':
      return '\n';
    case 'TAB':
      return ' ';
    default:
      if (trimmed.length === 1) {
        return trimmed;
      }
      unsupportedError(
        'keyboard_input supports single ASCII characters plus the symbolic keys SPACE, ENTER, RETURN, and TAB.',
        { key: trimmed },
      );
  }
}

function clampTapDuration(durationMs: number | undefined): number {
  if (durationMs == null) {
    return DEFAULT_INPUT_TAP_MS;
  }
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    validationError('durationMs must be a positive integer', { durationMs });
  }
  return durationMs;
}

function joystickPortToProtocol(port: JoystickPort): number {
  return port - 1;
}

export class PortAllocator {
  readonly #forbiddenPorts: Set<number>;

  constructor(forbiddenPorts?: Iterable<number>) {
    this.#forbiddenPorts = new Set(forbiddenPorts ?? DEFAULT_FORBIDDEN_PORTS);
  }

  get forbiddenPorts(): number[] {
    return [...this.#forbiddenPorts].sort((left, right) => left - right);
  }

  assertAllowed(port: number): void {
    if (this.#forbiddenPorts.has(port)) {
      validationError('Standard/default debug monitor ports are forbidden in managed mode', {
        port,
        forbiddenPorts: this.forbiddenPorts,
      });
    }
  }

  async allocate(): Promise<number> {
    for (let attempts = 0; attempts < 30; attempts += 1) {
      const candidate = await this.#probeEphemeralPort();
      if (candidate < 1024 || this.#forbiddenPorts.has(candidate)) {
        continue;
      }
      return candidate;
    }

    throw new ViceMcpError('port_allocation_failed', 'Could not allocate a non-default monitor port', 'configuration');
  }

  async ensureFree(port: number, host = DEFAULT_MONITOR_HOST): Promise<void> {
    this.assertAllowed(port);
    const available = await isPortAvailable(host, port);
    if (!available) {
      throw new ViceMcpError('port_in_use', `Monitor port ${port} is already in use`, 'configuration', false, {
        host,
        port,
      });
    }
  }

  async #probeEphemeralPort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, DEFAULT_MONITOR_HOST, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          const port = address.port;
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(port);
          });
          return;
        }
        reject(new Error('Failed to allocate port'));
      });
    });
  }
}

export async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

type LaunchMode = 'initial' | 'config_update' | 'restart';
type C64RegisterValues = Record<C64RegisterName, number>;
type DebugState = {
  executionState: SessionState['executionState'];
  lastStopReason: StopReason;
  programCounter: number;
  registers: C64RegisterValues;
};

type BreakpointWithOptionalLabel = {
  id: number;
  start: number;
  end: number;
  enabled: boolean;
  stopWhenHit: boolean;
  hitCount: number;
  ignoreCount: number;
  currentlyHit: boolean;
  temporary: boolean;
  hasCondition: boolean;
  kind: BreakpointKind;
  label?: string | null;
};

export class ViceSession {
  readonly #client = new ViceMonitorClient();
  readonly #portAllocator: PortAllocator;

  #transportState: SessionState['transportState'] = 'not_started';
  #processState: SessionState['processState'] = 'not_applicable';
  #executionState: SessionState['executionState'] = 'unknown';
  #lastStopReason: StopReason = 'none';
  #host: string | null = null;
  #port: number | null = null;
  #connectedSince: string | null = null;
  #lastResponseAt: string | null = null;
  #process: ChildProcessWithoutNullStreams | null = null;
  #warnings: WarningItem[] = [];
  #lastExecutionIntent: StopReason = 'unknown';
  #lastRegisters: C64RegisterValues | null = null;
  #config: C64Config | null = null;
  #recoveryInProgress = false;
  #recoveryPromise: Promise<void> | null = null;
  #freshEmulatorPending = false;
  #launchId = 0;
  #restartCount = 0;
  #suppressRecovery = false;
  #shuttingDown = false;
  #heldKeyboardIntervals = new Map<string, NodeJS.Timeout>();
  #heldJoystickMasks = new Map<JoystickPort, number>();
  #breakpointLabels = new Map<number, string>();

  constructor(portAllocator = new PortAllocator()) {
    this.#portAllocator = portAllocator;
    this.#client.on('response', () => {
      this.#lastResponseAt = nowIso();
    });
    this.#client.on('event', (event) => {
      if (event.type === 'resumed') {
        this.#executionState = 'running';
        this.#lastStopReason = 'none';
        return;
      }

      if (event.type === 'stopped') {
        this.#executionState = 'stopped_in_monitor';
        this.#lastStopReason = this.#lastExecutionIntent;
        return;
      }

      if (event.type === 'jam') {
        this.#executionState = 'stopped_in_monitor';
        this.#lastStopReason = 'error';
      }
    });
    this.#client.on('close', () => {
      if (this.#transportState !== 'stopped') {
        this.#transportState = 'disconnected';
      }
      if (!this.#suppressRecovery && !this.#shuttingDown && this.#config) {
        void this.#scheduleRecovery();
      }
    });
  }

  snapshot(): SessionState {
    return {
      transportState: this.#transportState,
      processState: this.#processState,
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      recoveryInProgress: this.#recoveryInProgress,
      launchId: this.#launchId,
      restartCount: this.#restartCount,
      freshEmulatorPending: this.#freshEmulatorPending,
      connectedSince: this.#connectedSince,
      lastResponseAt: this.#lastResponseAt,
      processId: this.#process?.pid ?? null,
      warnings: [...this.#warnings],
    };
  }

  async getDebugState(): Promise<DebugState> {
    await this.#ensurePausedForDebug();
    return await this.#readDebugState();
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;
    this.#suppressRecovery = true;
    this.#config = null;
    this.#recoveryPromise = null;
    this.#recoveryInProgress = false;
    this.#freshEmulatorPending = false;
    this.#clearHeldInputState();
    this.#breakpointLabels.clear();

    try {
      await this.#stopManagedProcess(true);
    } finally {
      this.#transportState = 'stopped';
      this.#processState = 'not_applicable';
      this.#executionState = 'unknown';
      this.#lastStopReason = 'none';
      this.#host = null;
      this.#port = null;
      this.#connectedSince = null;
      this.#lastRegisters = null;
    }
  }

  takeResponseMeta(): ResponseMeta {
    const meta = {
      freshEmulator: this.#freshEmulatorPending,
      launchId: this.#launchId,
      restartCount: this.#restartCount,
    };
    this.#freshEmulatorPending = false;
    return meta;
  }

  async execute(action: 'pause' | 'resume' | 'step' | 'step_over' | 'step_out' | 'reset', count = 1, resetMode: 'soft' | 'hard' = 'soft') {
    switch (action) {
      case 'pause':
        return await this.#pauseExecution();
      case 'resume':
        return await this.continueExecution();
      case 'step':
        return await this.stepInstruction(count, false);
      case 'step_over':
        return await this.stepInstruction(count, true);
      case 'step_out':
        return await this.stepOut();
      case 'reset':
        return await this.resetMachine(resetMode);
    }
  }

  async setRegisters(registers: Partial<Record<C64RegisterName, number>>) {
    await this.#ensurePausedForDebug();
    const metadata = await this.#client.getRegistersAvailable();
    const metadataByName = new Map(metadata.registers.map((item) => [item.name.toUpperCase(), item]));

    const payload = Object.entries(registers).map(([fieldName, value]) => {
      const definition = C64_REGISTER_DEFINITIONS.find((item) => item.fieldName === fieldName);
      if (!definition) {
        validationError(`Unknown register ${fieldName}`, { registerName: fieldName });
      }
      if (!Number.isInteger(value)) {
        validationError(`Register ${fieldName} must be an integer`, { registerName: fieldName, value });
      }
      if (value < definition.min || value > definition.max) {
        validationError(`Register ${fieldName} must be between ${definition.min} and ${definition.max}`, {
          registerName: fieldName,
          min: definition.min,
          max: definition.max,
          value,
        });
      }
      const meta = metadataByName.get(definition.viceName.toUpperCase());
      if (!meta) {
        validationError(`Required C64 register is missing from the emulator: ${definition.viceName}`, {
          registerName: definition.fieldName,
          viceName: definition.viceName,
        });
      }
      return {
        id: meta.id,
        value,
      };
    });

    const response = await this.#client.setRegisters(payload);
    const updatedById = new Map(response.registers.map((register) => [register.id, register.value]));
    this.#lastRegisters = this.#mergeRegisters(
      this.#lastRegisters,
      Object.fromEntries(
        C64_REGISTER_DEFINITIONS.flatMap((definition) => {
          const meta = metadataByName.get(definition.viceName.toUpperCase());
          if (!meta) {
            return [];
          }
          const value = updatedById.get(meta.id);
          if (value == null) {
            return [];
          }
          return [[definition.fieldName, value]];
        }),
      ) as Partial<Record<C64RegisterName, number>>,
    );
    return {
      updated: Object.fromEntries(
        C64_REGISTER_DEFINITIONS.flatMap((definition) => {
          const meta = metadataByName.get(definition.viceName.toUpperCase());
          if (!meta) {
            return [];
          }
          const value = updatedById.get(meta.id);
          if (value == null) {
            return [];
          }
          return [[definition.fieldName, value]];
        }),
      ) as Partial<Record<C64RegisterName, number>>,
      executionState: this.#executionState,
    };
  }

  async readMemory(start: number, end: number, bank = 0) {
    await this.#ensurePausedForDebug();
    this.#validateRange(start, end);
    const response = await this.#client.readMemory(start, end, bank);
    return {
      length: response.bytes.length,
      data: Array.from(response.bytes),
    };
  }

  async writeMemory(start: number, data: number[], bank = 0) {
    await this.#ensurePausedForDebug();
    const bytes = Uint8Array.from(data);
    if (bytes.length === 0) {
      validationError('write_memory requires at least one byte');
    }
    if (data.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
      validationError('write_memory data must contain only integer byte values between 0 and 255');
    }
    await this.#client.writeMemory(start, bytes, bank);
    const debugState = await this.#readDebugState();
    return {
      address: start,
      length: bytes.length,
      worked: true,
      executionState: debugState.executionState,
      lastStopReason: debugState.lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
    };
  }

  async continueExecution() {
    await this.#ensureReady();
    if (this.#executionState !== 'stopped_in_monitor' || !this.#lastRegisters) {
      debuggerNotPausedError({
        executionState: this.#executionState,
        lastStopReason: this.#lastStopReason,
      });
    }
    const debugState = this.#buildDebugState(this.#lastRegisters);
    this.#lastExecutionIntent = 'unknown';
    await this.#client.continueExecution();
    this.#executionState = 'running';
    this.#lastStopReason = 'none';
    return {
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
      warnings: [] as WarningItem[],
    };
  }

  async stepInstruction(count = 1, stepOver = false) {
    await this.#ensureReady();
    this.#lastExecutionIntent = 'step_complete';
    await this.#client.stepInstruction(count, stepOver);
    this.#executionState = 'stopped_in_monitor';
    this.#lastStopReason = 'step_complete';
    const debugState = await this.#readDebugState();
    return {
      executionState: debugState.executionState,
      lastStopReason: debugState.lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
      stepsExecuted: count,
      warnings: [] as WarningItem[],
    };
  }

  async stepOut() {
    await this.#ensureReady();
    this.#lastExecutionIntent = 'step_complete';
    await this.#client.stepOut();
    this.#executionState = 'stopped_in_monitor';
    this.#lastStopReason = 'step_complete';
    const debugState = await this.#readDebugState();
    return {
      executionState: debugState.executionState,
      lastStopReason: debugState.lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
      warnings: [] as WarningItem[],
    };
  }

  async resetMachine(mode: 'soft' | 'hard') {
    await this.#ensureReady();
    this.#lastExecutionIntent = 'reset';
    await this.#client.reset(mode);
    this.#executionState = 'stopped_in_monitor';
    this.#lastStopReason = 'reset';
    const debugState = await this.#readDebugState();
    return {
      executionState: debugState.executionState,
      lastStopReason: debugState.lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
      warnings: [] as WarningItem[],
    };
  }

  async listBreakpoints(includeDisabled = true) {
    await this.#ensurePausedForDebug();
    const response = await this.#client.listBreakpoints();
    this.#pruneBreakpointLabels(response.checkpoints.map((breakpoint) => breakpoint.id));
    return {
      breakpoints: response.checkpoints
        .filter((breakpoint) => (includeDisabled ? true : breakpoint.enabled))
        .map((breakpoint) => this.#attachBreakpointLabel(breakpoint)),
    };
  }

  async getBreakpoint(breakpointId: number) {
    await this.#ensurePausedForDebug();
    const response = await this.#client.getBreakpoint(breakpointId);
    return {
      breakpoint: this.#attachBreakpointLabel(response.checkpoint),
    };
  }

  async setBreakpoint(options: {
    kind: BreakpointKind;
    start: number;
    end?: number;
    condition?: string;
    label?: string;
    temporary?: boolean;
    enabled?: boolean;
  }) {
    await this.#ensurePausedForDebug();
    const response = await this.#client.setBreakpoint({
      start: options.start,
      end: options.end,
      kind: options.kind,
      condition: options.condition,
      temporary: options.temporary,
      enabled: options.enabled,
      stopWhenHit: true,
    });
    if (options.label?.trim()) {
      this.#breakpointLabels.set(response.checkpoint.id, options.label.trim());
    } else {
      this.#breakpointLabels.delete(response.checkpoint.id);
    }
    const debugState = await this.#readDebugState();
    return {
      breakpoint: this.#attachBreakpointLabel(response.checkpoint),
      executionState: debugState.executionState,
      lastStopReason: debugState.lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
    };
  }

  async deleteBreakpoint(breakpointId: number) {
    await this.#ensurePausedForDebug();
    await this.#client.deleteBreakpoint(breakpointId);
    this.#breakpointLabels.delete(breakpointId);
    const debugState = await this.#readDebugState();
    return {
      cleared: true,
      breakpointId,
      executionState: debugState.executionState,
      lastStopReason: debugState.lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
    };
  }

  async breakpointSet(options: {
    kind: BreakpointKind;
    address: number;
    length?: number;
    condition?: string;
    label?: string;
    temporary?: boolean;
    enabled?: boolean;
  }) {
    const length = options.length ?? 1;
    if (!Number.isInteger(length) || length <= 0) {
      validationError('Breakpoint length must be a positive integer', { length });
    }
    const end = options.address + length - 1;
    this.#validateRange(options.address, end);
    return await this.setBreakpoint({
      kind: options.kind,
      start: options.address,
      end,
      condition: options.condition,
      label: options.label,
      temporary: options.temporary,
      enabled: options.enabled,
    });
  }

  async breakpointClear(breakpointId: number) {
    return await this.deleteBreakpoint(breakpointId);
  }

  async loadProgram(filePath: string, addressOverride?: number | null) {
    await this.#ensurePausedForDebug();
    const absolutePath = path.resolve(filePath);
    const contents = await fs.readFile(absolutePath);
    if (contents.length < 2) {
      throw new ViceMcpError('invalid_prg', 'PRG file is too small', 'validation');
    }

    const loadAddress = addressOverride ?? contents.readUInt16LE(0);
    const bytes = contents.subarray(2);
    await this.#client.writeMemory(loadAddress, bytes);
    return {
      filePath: absolutePath,
      start: loadAddress,
      length: bytes.length,
      written: true,
    };
  }

  async programLoad(options: {
    filePath: string;
    mode: ProgramLoadMode;
    address?: number | null;
    runAfterLoading?: boolean;
    fileIndex?: number;
  }) {
    const filePath = path.resolve(options.filePath);

    if (options.mode === 'memory') {
      const result = await this.loadProgram(filePath, options.address ?? null);
      return {
        filePath: result.filePath,
        mode: options.mode,
        start: result.start,
        length: result.length,
        written: result.written,
        runAfterLoading: null,
        fileIndex: null,
        executionState: null,
      };
    }

    const result = await this.autostartProgram(filePath, options.runAfterLoading ?? true, options.fileIndex ?? 0);
    return {
      filePath: result.filePath,
      mode: options.mode,
      start: null,
      length: null,
      written: null,
      runAfterLoading: result.runAfterLoading,
      fileIndex: result.fileIndex,
      executionState: result.executionState,
    };
  }

  async autostartProgram(filePath: string, runAfterLoading = true, fileIndex = 0) {
    await this.#ensureReady();
    const absolutePath = path.resolve(filePath);
    const previousExecutionState = this.#executionState;
    const previousStopReason = this.#lastStopReason;
    const executionEvent = this.#waitForExecutionEvent(1000);

    this.#lastExecutionIntent = runAfterLoading ? 'none' : 'monitor_entry';

    try {
      await this.#client.autostartProgram(absolutePath, runAfterLoading, fileIndex);
    } catch (error) {
      const event = await executionEvent;
      const accepted = this.#autostartWasAcceptedAfterError(error, event, previousExecutionState, previousStopReason);
      if (!accepted) {
        throw error;
      }
    }

    const event = await executionEvent;
    if (event) {
      this.#applyExecutionEventState(event.type);
    } else if (this.#executionState === previousExecutionState && this.#lastStopReason === previousStopReason) {
      this.#executionState = runAfterLoading ? 'running' : 'stopped_in_monitor';
      this.#lastStopReason = runAfterLoading ? 'none' : 'monitor_entry';
    }

    return {
      filePath: absolutePath,
      runAfterLoading,
      fileIndex,
      executionState: this.#executionState,
    };
  }

  async captureDisplay(useVic = true) {
    await this.#ensurePausedForDebug();
    const response = await this.#client.captureDisplay(useVic);
    const warnings: WarningItem[] = [];
    let pngBase64: string | null = null;

    if (response.bitsPerPixel === 8) {
      pngBase64 = encodePngGrayscale(response.innerWidth, response.innerHeight, response.imageBytes);
      warnings.push(
        makeWarning(
          'The emulator returned indexed pixel data without palette metadata; pngBase64 uses grayscale mapping of indices.',
          'display_palette_unknown',
        ),
      );
    } else {
      warnings.push(makeWarning(`Unsupported display bit depth ${response.bitsPerPixel}`, 'display_bpp_unsupported'));
    }

    return {
      width: response.innerWidth,
      height: response.innerHeight,
      bitsPerPixel: response.bitsPerPixel,
      debugWidth: response.debugWidth,
      debugHeight: response.debugHeight,
      debugOffsetX: response.debugOffsetX,
      debugOffsetY: response.debugOffsetY,
      pixelDataBase64: Buffer.from(response.imageBytes).toString('base64'),
      pngBase64,
      warnings,
    };
  }

  async getInfo() {
    await this.#ensureReady();
    await this.#client.getInfo();
    return {
      target: C64_TARGET,
    };
  }

  async sendKeys(keys: string) {
    await this.#ensureReady();
    const encoded = encodePetscii(keys);
    await this.#client.sendKeys(Buffer.from(encoded).toString('binary'));
    return {
      sent: true,
      length: encoded.length,
    };
  }

  async keyboardInput(action: InputAction, key: string, durationMs?: number) {
    await this.#ensureReady();
    const text = normalizeKeyboardKey(key);
    const heldKey = key.trim().toUpperCase();

    switch (action) {
      case 'tap': {
        const duration = clampTapDuration(durationMs);
        await this.sendKeys(text);
        await sleep(duration);
        return {
          action,
          key: heldKey,
          applied: true,
          held: false,
          mode: 'buffered_text' as const,
        };
      }
      case 'press': {
        if (!this.#heldKeyboardIntervals.has(heldKey)) {
          await this.sendKeys(text);
          const interval = setInterval(() => {
            void this.#client.sendKeys(Buffer.from(encodePetscii(text)).toString('binary')).catch(() => undefined);
          }, DEFAULT_KEYBOARD_REPEAT_MS);
          this.#heldKeyboardIntervals.set(heldKey, interval);
        }
        return {
          action,
          key: heldKey,
          applied: true,
          held: true,
          mode: 'buffered_text_repeat' as const,
        };
      }
      case 'release': {
        const interval = this.#heldKeyboardIntervals.get(heldKey);
        if (interval) {
          clearInterval(interval);
          this.#heldKeyboardIntervals.delete(heldKey);
        }
        return {
          action,
          key: heldKey,
          applied: true,
          held: false,
          mode: 'buffered_text_repeat' as const,
        };
      }
    }
  }

  async joystickInput(port: JoystickPort, action: InputAction, control: JoystickControl, durationMs?: number) {
    await this.#ensureReady();
    const bit = JOYSTICK_CONTROL_BITS[control];
    if (bit == null) {
      validationError('Unsupported joystick control', { control });
    }

    switch (action) {
      case 'tap': {
        const duration = clampTapDuration(durationMs);
        await this.#applyJoystickMask(port, this.#getJoystickMask(port) & ~bit);
        await sleep(duration);
        await this.#applyJoystickMask(port, this.#getJoystickMask(port) | bit);
        break;
      }
      case 'press':
        await this.#applyJoystickMask(port, this.#getJoystickMask(port) & ~bit);
        break;
      case 'release':
        await this.#applyJoystickMask(port, this.#getJoystickMask(port) | bit);
        break;
    }

    return {
      port,
      action,
      control,
      applied: true,
      state: this.#describeJoystickState(port),
    };
  }

  async #ensureReady(): Promise<void> {
    this.#ensureConfig();
    await this.#ensureHealthyConnection();
  }

  async #ensurePausedForDebug(): Promise<void> {
    await this.#ensureReady();
    if (this.#executionState !== 'stopped_in_monitor') {
      debuggerNotPausedError({
        executionState: this.#executionState,
        lastStopReason: this.#lastStopReason,
      });
    }
  }

  async #ensureHealthyConnection(): Promise<void> {
    if (this.#recoveryPromise) {
      await this.#recoveryPromise;
    }

    const processAlive = this.#process != null && this.#process.exitCode == null && !this.#process.killed;
    if (processAlive && this.#client.connected) {
      return;
    }

    await this.#scheduleRecovery();
  }

  async #scheduleRecovery(): Promise<void> {
    this.#ensureConfig();

    if (this.#recoveryPromise) {
      return await this.#recoveryPromise;
    }

    this.#recoveryPromise = (async () => {
      this.#recoveryInProgress = true;
      try {
        const processAlive = this.#process != null && this.#process.exitCode == null && !this.#process.killed;

        if (processAlive && this.#host && this.#port) {
          this.#transportState = 'reconnecting';
          await this.#client.connect(this.#host, this.#port);
          this.#transportState = 'connected';
          if (!this.#connectedSince) {
            this.#connectedSince = nowIso();
          }
          await this.#hydrateExecutionState();
          return;
        }

        await this.#launchManagedEmulator('restart');
      } finally {
        this.#recoveryInProgress = false;
        this.#recoveryPromise = null;
      }
    })();

    return await this.#recoveryPromise;
  }

  async #replaceManagedEmulator(mode: Exclude<LaunchMode, 'restart'>): Promise<void> {
    await this.#stopManagedProcess(true);
    await this.#launchManagedEmulator(mode);
  }

  async #launchManagedEmulator(mode: LaunchMode): Promise<void> {
    const config = this.#ensureConfig();

    const host = DEFAULT_MONITOR_HOST;
    const port = await this.#portAllocator.allocate();
    await this.#portAllocator.ensureFree(port, host);

    const binary = config.binaryPath ?? DEFAULT_C64_BINARY;
    const args = ['-binarymonitor', '-binarymonitoraddress', `${host}:${port}`];
    if (config.arguments) {
      args.push(...splitCommandLine(config.arguments));
    }

    this.#transportState = 'starting';
    this.#processState = 'launching';
    this.#host = host;
    this.#port = port;
    this.#connectedSince = null;
    this.#executionState = 'unknown';
    this.#breakpointLabels.clear();

    const env = await buildViceLaunchEnv();

    const child = spawn(binary, args, {
      cwd: config.workingDirectory ? path.resolve(config.workingDirectory) : undefined,
      env,
      stdio: 'pipe',
    });
    this.#process = child;
    this.#bindProcessLifecycle(child);

    this.#processState = 'running';
    this.#transportState = 'waiting_for_monitor';

    try {
      await waitForMonitor(host, port, 5000);
      await this.#client.connect(host, port);
      this.#transportState = 'connected';
      this.#connectedSince = nowIso();
      this.#launchId += 1;
      if (mode === 'restart') {
        this.#restartCount += 1;
      }
      this.#freshEmulatorPending = true;
      await this.#hydrateExecutionState();
    } catch (error) {
      this.#processState = 'crashed';
      this.#transportState = 'faulted';
      this.#warnings = [...this.#warnings.filter((warning) => warning.code !== 'launch_failed'), makeWarning(String((error as Error).message ?? error), 'launch_failed')];
      await this.#stopManagedProcess(true);
      throw error;
    }
  }

  #ensureConfig(): C64Config {
    if (!this.#config) {
      this.#config = defaultC64Config();
    }

    return this.#config;
  }

  #bindProcessLifecycle(child: ChildProcessWithoutNullStreams): void {
    child.once('exit', (code, signal) => {
      if (this.#process !== child) {
        return;
      }

      this.#process = null;
      this.#processState = code === 0 ? 'exited' : 'crashed';
      this.#transportState = 'disconnected';
      this.#warnings = [
        ...this.#warnings.filter((warning) => warning.code !== 'process_exit'),
        makeWarning(`C64 emulator process exited (${code ?? 'null'} / ${signal ?? 'null'})`, 'process_exit'),
      ];

      if (!this.#suppressRecovery && !this.#shuttingDown && this.#config) {
        void this.#scheduleRecovery();
      }
    });

    child.once('error', (error) => {
      if (this.#process !== child) {
        return;
      }

      this.#process = null;
      this.#processState = 'crashed';
      this.#transportState = 'faulted';
      this.#warnings = [...this.#warnings.filter((warning) => warning.code !== 'process_error'), makeWarning(error.message, 'process_error')];

      if (!this.#suppressRecovery && !this.#shuttingDown && this.#config) {
        void this.#scheduleRecovery();
      }
    });
  }

  async #stopManagedProcess(fullReset: boolean): Promise<void> {
    this.#suppressRecovery = true;
    try {
      this.#clearHeldInputState();
      const processId = this.#process?.pid ?? null;
      this.#breakpointLabels.clear();

      if (this.#client.connected) {
        try {
          await this.#client.quit();
        } catch {
          if (this.#process) {
            this.#process.kill('SIGTERM');
          }
        }
      } else if (this.#process) {
        this.#process.kill('SIGTERM');
      }

      if (this.#process) {
        await waitForProcessExit(this.#process, 1000).catch(() => {
          this.#process?.kill('SIGKILL');
        });
      }

      await this.#client.disconnect();
      this.#process = null;

      if (fullReset) {
        this.#transportState = 'stopped';
        this.#processState = processId == null ? 'not_applicable' : 'exited';
      }
    } finally {
      this.#suppressRecovery = false;
    }
  }

  async #hydrateExecutionState(): Promise<void> {
    try {
      const registers = await this.#readRegisters();
      if (Object.keys(registers).length > 0) {
        this.#executionState = 'stopped_in_monitor';
        this.#lastStopReason = 'monitor_entry';
        return;
      }
    } catch {
      this.#warnings.push(makeWarning('Could not determine initial execution state', 'execution_state_unknown'));
    }

    this.#executionState = 'unknown';
  }

  async #readRegisters(): Promise<C64RegisterValues> {
    const metadata = await this.#client.getRegistersAvailable();
    const values = await this.#client.getRegisters();
    const registers = this.#mapC64Registers(metadata.registers, values.registers);
    this.#lastRegisters = registers;
    return registers;
  }

  async #readDebugState(): Promise<DebugState> {
    const registers = await this.#readRegisters();
    this.#executionState = 'stopped_in_monitor';
    return this.#buildDebugState(registers);
  }

  async #pauseExecution(): Promise<{
    executionState: SessionState['executionState'];
    lastStopReason: StopReason;
    programCounter: number;
    registers: C64RegisterValues;
    warnings: WarningItem[];
  }> {
    await this.#ensureReady();

    if (this.#executionState === 'stopped_in_monitor') {
      const debugState = this.#lastRegisters ? this.#buildDebugState(this.#lastRegisters) : await this.#readDebugState();
      return {
        ...debugState,
        warnings: [],
      };
    }

    this.#lastExecutionIntent = 'manual_break';
    const debugState = await this.#readDebugState();
    this.#lastStopReason = 'manual_break';
    return {
      ...debugState,
      lastStopReason: 'manual_break',
      warnings: [],
    };
  }

  #buildDebugState(registers: C64RegisterValues): DebugState {
    this.#lastRegisters = registers;
    return {
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      programCounter: registers.PC,
      registers,
    };
  }

  #mergeRegisters(
    current: C64RegisterValues | null,
    updated: Partial<Record<C64RegisterName, number>>,
  ): C64RegisterValues | null {
    if (!current) {
      return null;
    }

    return {
      ...current,
      ...updated,
    };
  }

  #validateRange(start: number, end: number): void {
    if (end < start) {
      validationError('End address must be greater than or equal to start address', { start, end });
    }
    if (start < 0 || end > 0xffff) {
      validationError('Address range must fit in 16-bit address space', { start, end });
    }
  }

  #mapC64Registers(
    metadata: Array<{ id: number; size: number; name: string }>,
    values: Array<{ id: number; value: number }>,
  ): C64RegisterValues {
    const metadataByName = new Map(metadata.map((item) => [item.name.toUpperCase(), item]));
    const valuesById = new Map(values.map((item) => [item.id, item.value]));

    return Object.fromEntries(
      C64_REGISTER_DEFINITIONS.map((definition) => {
        const meta = metadataByName.get(definition.viceName.toUpperCase());
        if (!meta) {
          validationError(`Required C64 register is missing from the emulator: ${definition.viceName}`, {
            registerName: definition.fieldName,
            viceName: definition.viceName,
          });
        }
        const value = valuesById.get(meta.id);
        if (value == null) {
          validationError(`Required C64 register value is missing from the emulator: ${definition.viceName}`, {
            registerName: definition.fieldName,
            viceName: definition.viceName,
          });
        }
        return [definition.fieldName, value];
      }),
    ) as C64RegisterValues;
  }

  #getJoystickMask(port: JoystickPort): number {
    return this.#heldJoystickMasks.get(port) ?? JOYSTICK_RELEASED_MASK;
  }

  async #applyJoystickMask(port: JoystickPort, mask: number): Promise<void> {
    const normalizedMask = mask & JOYSTICK_RELEASED_MASK;
    this.#heldJoystickMasks.set(port, normalizedMask);
    await this.#client.setJoyport(joystickPortToProtocol(port), normalizedMask);
  }

  #describeJoystickState(port: JoystickPort) {
    const mask = this.#getJoystickMask(port);
    return {
      up: (mask & JOYSTICK_CONTROL_BITS.up) === 0,
      down: (mask & JOYSTICK_CONTROL_BITS.down) === 0,
      left: (mask & JOYSTICK_CONTROL_BITS.left) === 0,
      right: (mask & JOYSTICK_CONTROL_BITS.right) === 0,
      fire: (mask & JOYSTICK_CONTROL_BITS.fire) === 0,
    };
  }

  #clearHeldInputState(): void {
    for (const interval of this.#heldKeyboardIntervals.values()) {
      clearInterval(interval);
    }
    this.#heldKeyboardIntervals.clear();
    this.#heldJoystickMasks.clear();
  }

  #attachBreakpointLabel<T extends BreakpointWithOptionalLabel>(breakpoint: T): T {
    return {
      ...breakpoint,
      label: this.#breakpointLabels.get(breakpoint.id) ?? null,
    };
  }

  #pruneBreakpointLabels(activeBreakpointIds: Iterable<number>): void {
    const active = new Set(activeBreakpointIds);
    for (const breakpointId of this.#breakpointLabels.keys()) {
      if (!active.has(breakpointId)) {
        this.#breakpointLabels.delete(breakpointId);
      }
    }
  }

  #applyExecutionEventState(eventType: 'resumed' | 'stopped' | 'jam'): void {
    if (eventType === 'resumed') {
      this.#executionState = 'running';
      this.#lastStopReason = 'none';
      return;
    }

    this.#executionState = 'stopped_in_monitor';
    this.#lastStopReason = eventType === 'jam' ? 'error' : this.#lastExecutionIntent;
  }

  async #waitForExecutionEvent(timeoutMs: number): Promise<{ type: 'resumed' | 'stopped' | 'jam' } | null> {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#client.off('event', onEvent);
        resolve(null);
      }, timeoutMs);

      const onEvent = (event: { type: string }) => {
        if (event.type !== 'resumed' && event.type !== 'stopped' && event.type !== 'jam') {
          return;
        }
        clearTimeout(timer);
        this.#client.off('event', onEvent);
        resolve({ type: event.type });
      };

      this.#client.on('event', onEvent);
    });
  }

  #autostartWasAcceptedAfterError(
    error: unknown,
    event: { type: 'resumed' | 'stopped' | 'jam' } | null,
    previousExecutionState: SessionState['executionState'],
    previousStopReason: StopReason,
  ): boolean {
    if (!(error instanceof ViceMcpError)) {
      return false;
    }

    if (!['emulator_protocol_error', 'timeout', 'connection_closed'].includes(error.code)) {
      return false;
    }

    if (event) {
      return true;
    }

    return this.#executionState !== previousExecutionState || this.#lastStopReason !== previousStopReason;
  }

}

function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    result.push(current);
  }

  return result;
}

async function waitForMonitor(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortAvailable(host, port))) {
      return;
    }
    await sleep(100);
  }

  throw new ViceMcpError('monitor_timeout', `Debugger monitor did not open on ${host}:${port}`, 'timeout', true, {
    host,
    port,
  });
}

async function waitForProcessExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (process.exitCode != null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
