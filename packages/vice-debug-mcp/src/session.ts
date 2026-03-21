import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import zlib from 'node:zlib';

import {
  C64_REGISTER_DEFINITIONS,
  DEFAULT_FORBIDDEN_PORTS,
  DEFAULT_MACHINE_TYPE,
  DEFAULT_MONITOR_HOST,
  emulatorConfigSchema,
  type SessionHealth,
  type C64RegisterName,
  type BreakpointKind,
  type EmulatorConfig,
  type MemSpaceName,
  type ResponseMeta,
  type SessionState,
  type SessionStatus,
  type StopReason,
  type WarningItem,
} from './contracts.js';
import { ViceMcpError, debuggerNotPausedError, sessionStateError, validationError } from './errors.js';
import { ViceMonitorClient } from './vice-protocol.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildMachineType(emulatorType: string | null): string | null {
  if (!emulatorType) {
    return null;
  }
  if (emulatorType === 'x64sc' || emulatorType === 'x64') {
    return 'c64';
  }
  return emulatorType;
}

function resolveViceBinary(emulatorType: string): string {
  switch (emulatorType) {
    case 'c64':
      return 'x64sc';
    case 'c128':
      return 'x128';
    default:
      return emulatorType;
  }
}

function defaultEmulatorConfig(): EmulatorConfig {
  return emulatorConfigSchema.parse({
    emulatorType: DEFAULT_MACHINE_TYPE,
  });
}

function normalizeConfig(config: EmulatorConfig): EmulatorConfig {
  return emulatorConfigSchema.parse({
    emulatorType: config.emulatorType ?? DEFAULT_MACHINE_TYPE,
    binaryPath: config.binaryPath?.trim() || undefined,
    workingDirectory: config.workingDirectory?.trim() || undefined,
    arguments: config.arguments?.trim() || undefined,
  });
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
      validationError('Standard/default VICE monitor ports are forbidden in managed mode', {
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
type C64RegisterMetadata = Record<C64RegisterName, { widthBits: 8 | 16; min: number; max: number; description: string }>;
type DebugState = {
  executionState: SessionState['executionState'];
  lastStopReason: StopReason;
  programCounter: number;
  registers: C64RegisterValues;
};

export class ViceSession {
  readonly #client = new ViceMonitorClient();
  readonly #portAllocator: PortAllocator;

  #transportState: SessionState['transportState'] = 'not_started';
  #processState: SessionState['processState'] = 'not_applicable';
  #executionState: SessionState['executionState'] = 'unknown';
  #lastStopReason: StopReason = 'none';
  #machineType: string | null = null;
  #host: string | null = null;
  #port: number | null = null;
  #connectedSince: string | null = null;
  #lastResponseAt: string | null = null;
  #process: ChildProcessWithoutNullStreams | null = null;
  #warnings: WarningItem[] = [];
  #lastExecutionIntent: StopReason = 'unknown';
  #lastRegisters: C64RegisterValues | null = null;
  #config: EmulatorConfig | null = null;
  #recoveryInProgress = false;
  #recoveryPromise: Promise<void> | null = null;
  #freshEmulatorPending = false;
  #launchId = 0;
  #restartCount = 0;
  #suppressRecovery = false;
  #shuttingDown = false;

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
      machineType: this.#machineType,
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

  status(): SessionStatus {
    const configured = this.#config != null;
    let status: SessionHealth;

    if (!configured) {
      status = 'not_configured';
    } else if (this.#recoveryInProgress || this.#transportState === 'reconnecting') {
      status = 'recovering';
    } else if (this.#transportState === 'starting' || this.#transportState === 'waiting_for_monitor' || this.#processState === 'launching') {
      status = 'starting';
    } else if (this.#transportState === 'connected' && this.#processState === 'running') {
      status = 'ready';
    } else if (this.#transportState === 'faulted' || this.#processState === 'crashed') {
      status = 'error';
    } else {
      status = 'stopped';
    }

    return {
      configured,
      status,
      machineType: this.#machineType,
      warnings: [...this.#warnings],
    };
  }

  async getDebugState(): Promise<DebugState> {
    await this.#ensurePausedForDebug();
    return await this.#readDebugState();
  }

  getEmulatorConfig(): { config: EmulatorConfig | null } {
    return {
      config: this.#config ? { ...this.#config } : defaultEmulatorConfig(),
    };
  }

  async setEmulatorConfig(config: EmulatorConfig): Promise<{ config: EmulatorConfig; session: SessionStatus }> {
    const nextConfig = normalizeConfig(config);

    this.#config = nextConfig;
    this.#warnings = this.#warnings.filter((warning) => !warning.code.startsWith('launch_') && !warning.code.startsWith('process_'));

    await this.#replaceManagedEmulator('config_update');

    return {
      config: { ...nextConfig },
      session: this.status(),
    };
  }

  async resetConfig(): Promise<{ cleared: boolean; hadConfig: boolean; session: SessionStatus }> {
    const hadConfig = this.#config != null;

    this.#config = null;
    this.#freshEmulatorPending = false;
    this.#recoveryPromise = null;
    this.#recoveryInProgress = false;
    this.#machineType = null;
    this.#host = null;
    this.#port = null;
    this.#connectedSince = null;
    this.#lastStopReason = 'none';
    this.#executionState = 'unknown';
    this.#warnings = [];

    await this.#stopManagedProcess(true);

    this.#transportState = 'not_started';
    this.#processState = 'not_applicable';

    return {
      cleared: true,
      hadConfig,
      session: this.status(),
    };
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

  async getRegisters() {
    await this.#ensurePausedForDebug();
    const registers = await this.#readRegisters();

    return {
      machine: this.#machineType ?? 'unknown',
      registers,
    };
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

  async getRegisterMetadata() {
    await this.#ensurePausedForDebug();
    return {
      machine: this.#machineType ?? 'unknown',
      registers: this.#getC64RegisterMetadata(),
    };
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
        validationError(`Required C64 register is missing from VICE: ${definition.viceName}`, {
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

  async readMemory(start: number, end: number, bank = 0, memSpace: MemSpaceName = 'main') {
    await this.#ensurePausedForDebug();
    this.#validateRange(start, end);
    const response = await this.#client.readMemory(start, end, memSpace, bank);
    return {
      length: response.bytes.length,
      data: Array.from(response.bytes),
    };
  }

  async writeMemory(start: number, data: number[], bank = 0, memSpace: MemSpaceName = 'main') {
    await this.#ensurePausedForDebug();
    const bytes = Uint8Array.from(data);
    if (bytes.length === 0) {
      validationError('write_memory requires at least one byte');
    }
    if (data.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
      validationError('write_memory data must contain only integer byte values between 0 and 255');
    }
    await this.#client.writeMemory(start, bytes, memSpace, bank);
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

  async searchMemory(start: number, end: number, pattern: number[], bank = 0, memSpace: MemSpaceName = 'main', maxResults = 10) {
    await this.#ensureReady();
    this.#validateRange(start, end);
    const haystack = await this.#client.readMemory(start, end, memSpace, bank);
    const needle = Uint8Array.from(pattern);
    if (needle.length === 0) {
      validationError('search_memory pattern must not be empty');
    }
    if (pattern.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
      validationError('search_memory pattern must contain only integer byte values between 0 and 255');
    }

    const matches: Array<{ address: number; offset: number }> = [];
    for (let offset = 0; offset <= haystack.bytes.length - needle.length; offset += 1) {
      let equal = true;
      for (let index = 0; index < needle.length; index += 1) {
        if (haystack.bytes[offset + index] !== needle[index]) {
          equal = false;
          break;
        }
      }
      if (equal) {
        const address = start + offset;
        matches.push({ address, offset });
        if (matches.length >= maxResults) {
          break;
        }
      }
    }

    return {
      start,
      end,
      pattern: Array.from(needle),
      bank,
      matches,
      truncated: matches.length >= maxResults,
    };
  }

  async fillMemory(start: number, end: number, pattern: number[], bank = 0, memSpace: MemSpaceName = 'main') {
    await this.#ensureReady();
    this.#validateRange(start, end);
    const bytes = Uint8Array.from(pattern);
    if (bytes.length === 0) {
      validationError('fill_memory pattern must not be empty');
    }
    if (pattern.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
      validationError('fill_memory pattern must contain only integer byte values between 0 and 255');
    }
    const result = new Uint8Array(end - start + 1);
    for (let index = 0; index < result.length; index += 1) {
      result[index] = bytes[index % bytes.length]!;
    }
    await this.#client.writeMemory(start, result, memSpace, bank);
    return {
      start,
      end,
      length: result.length,
      bank,
      pattern: Array.from(bytes),
    };
  }

  async copyMemory(sourceStart: number, destStart: number, length: number, sourceBank = 0, destBank = 0, memSpace: MemSpaceName = 'main') {
    await this.#ensureReady();
    if (length <= 0) {
      validationError('copy_memory length must be greater than zero');
    }
    const source = await this.#client.readMemory(sourceStart, sourceStart + length - 1, memSpace, sourceBank);
    await this.#client.writeMemory(destStart, source.bytes, memSpace, destBank);
    return { sourceStart, destStart, length, sourceBank, destBank };
  }

  async compareMemory(firstStart: number, secondStart: number, length: number, firstBank = 0, secondBank = 0, memSpace: MemSpaceName = 'main', maxDifferences = 25) {
    await this.#ensureReady();
    if (length <= 0) {
      validationError('compare_memory length must be greater than zero');
    }
    const [left, right] = await Promise.all([
      this.#client.readMemory(firstStart, firstStart + length - 1, memSpace, firstBank),
      this.#client.readMemory(secondStart, secondStart + length - 1, memSpace, secondBank),
    ]);

    const differences = [];
    for (let offset = 0; offset < length; offset += 1) {
      if (left.bytes[offset] !== right.bytes[offset]) {
        differences.push({
          offset,
          firstAddress: firstStart + offset,
          secondAddress: secondStart + offset,
          firstValue: left.bytes[offset],
          secondValue: right.bytes[offset],
        });
        if (differences.length >= maxDifferences) {
          break;
        }
      }
    }

    return {
      length,
      equal: differences.length === 0,
      differences,
      truncated: differences.length >= maxDifferences,
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
    return {
      breakpoints: response.checkpoints.filter((breakpoint) => (includeDisabled ? true : breakpoint.enabled)),
    };
  }

  async getBreakpoint(breakpointId: number) {
    await this.#ensurePausedForDebug();
    const response = await this.#client.getBreakpoint(breakpointId);
    return {
      breakpoint: response.checkpoint,
    };
  }

  async setBreakpoint(options: {
    kind: BreakpointKind;
    start: number;
    end?: number;
    memSpace?: MemSpaceName;
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
      memSpace: options.memSpace,
      condition: options.condition,
      temporary: options.temporary,
      enabled: options.enabled,
      stopWhenHit: true,
    });
    const debugState = await this.#readDebugState();
    return {
      breakpoint: {
        ...response.checkpoint,
        label: options.label ?? null,
      },
      executionState: debugState.executionState,
      lastStopReason: debugState.lastStopReason,
      programCounter: debugState.programCounter,
      registers: debugState.registers,
    };
  }

  async deleteBreakpoint(breakpointId: number) {
    await this.#ensurePausedForDebug();
    await this.#client.deleteBreakpoint(breakpointId);
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

  async enableBreakpoint(breakpointId: number, enabled: boolean) {
    await this.#ensurePausedForDebug();
    await this.#client.toggleBreakpoint(breakpointId, enabled);
    return {
      breakpointId,
      enabled,
    };
  }

  async setBreakpointCondition(breakpointId: number, condition: string) {
    await this.#ensurePausedForDebug();
    await this.#client.setBreakpointCondition(breakpointId, condition);
    return {
      breakpointId,
      hasCondition: true,
      conditionTrackedByServer: false,
    };
  }

  async setWatchpoint(
    start: number,
    end: number | undefined,
    accessKind: 'read' | 'write' | 'read_write',
    condition?: string,
    label?: string,
    memSpace?: MemSpaceName,
  ) {
    return this.setBreakpoint({
      kind: accessKind,
      start,
      end,
      condition,
      label,
      memSpace,
    });
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
    const bytes = addressOverride == null ? contents.subarray(2) : contents;
    await this.#client.writeMemory(loadAddress, bytes);
    return {
      filePath: absolutePath,
      start: loadAddress,
      length: bytes.length,
      written: true,
    };
  }

  async autostartProgram(filePath: string, runAfterLoading = true, fileIndex = 0) {
    await this.#ensureReady();
    const absolutePath = path.resolve(filePath);
    await this.#client.autostartProgram(absolutePath, runAfterLoading, fileIndex);
    this.#executionState = runAfterLoading ? 'running' : 'stopped_in_monitor';
    this.#lastStopReason = 'none';
    return {
      filePath: absolutePath,
      runAfterLoading,
      fileIndex,
      executionState: this.#executionState,
    };
  }

  async saveMemory(filePath: string, start: number, end: number, asPrg = true, bank = 0, memSpace: MemSpaceName = 'main') {
    await this.#ensurePausedForDebug();
    this.#validateRange(start, end);
    const response = await this.#client.readMemory(start, end, memSpace, bank);
    const absolutePath = path.resolve(filePath);
    const payload = asPrg
      ? Buffer.concat([Buffer.from([start & 0xff, (start >> 8) & 0xff]), Buffer.from(response.bytes)])
      : Buffer.from(response.bytes);
    await fs.writeFile(absolutePath, payload);
    return {
      filePath: absolutePath,
      start,
      end,
      length: response.bytes.length,
      asPrg,
      bank,
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
          'VICE returned indexed pixel data without palette metadata; pngBase64 uses grayscale mapping of indices.',
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

  async getBanks() {
    await this.#ensureReady();
    const response = await this.#client.getBanksAvailable();
    return {
      banks: response.banks,
    };
  }

  async getInfo() {
    await this.#ensureReady();
    const info = await this.#client.getInfo();
    return {
      viceVersion: info.versionString,
      versionComponents: info.version,
      svnVersion: info.svnVersion,
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

    const binary = config.binaryPath ?? resolveViceBinary(config.emulatorType);
    const args = ['-binarymonitor', '-binarymonitoraddress', `${host}:${port}`];
    if (config.arguments) {
      args.push(...splitCommandLine(config.arguments));
    }

    this.#transportState = 'starting';
    this.#processState = 'launching';
    this.#machineType = buildMachineType(config.emulatorType);
    this.#host = host;
    this.#port = port;
    this.#connectedSince = null;
    this.#executionState = 'unknown';

    const child = spawn(binary, args, {
      cwd: config.workingDirectory ? path.resolve(config.workingDirectory) : undefined,
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

  #ensureConfig(): EmulatorConfig {
    if (!this.#config) {
      this.#config = defaultEmulatorConfig();
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
        makeWarning(`VICE process exited (${code ?? 'null'} / ${signal ?? 'null'})`, 'process_exit'),
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
      const processId = this.#process?.pid ?? null;

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
          validationError(`Required C64 register is missing from VICE: ${definition.viceName}`, {
            registerName: definition.fieldName,
            viceName: definition.viceName,
          });
        }
        const value = valuesById.get(meta.id);
        if (value == null) {
          validationError(`Required C64 register value is missing from VICE: ${definition.viceName}`, {
            registerName: definition.fieldName,
            viceName: definition.viceName,
          });
        }
        return [definition.fieldName, value];
      }),
    ) as C64RegisterValues;
  }

  #getC64RegisterMetadata(): C64RegisterMetadata {
    return Object.fromEntries(
      C64_REGISTER_DEFINITIONS.map((definition) => [
        definition.fieldName,
        {
          widthBits: definition.widthBits,
          min: definition.min,
          max: definition.max,
          description: definition.description,
        },
      ]),
    ) as C64RegisterMetadata;
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

  throw new ViceMcpError('monitor_timeout', `VICE monitor did not open on ${host}:${port}`, 'timeout', true, {
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
