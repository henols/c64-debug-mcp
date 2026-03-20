import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import zlib from 'node:zlib';

import {
  DEFAULT_ATTACH_RECONNECT_POLICY,
  DEFAULT_FORBIDDEN_PORTS,
  DEFAULT_MANAGED_RECONNECT_POLICY,
  DEFAULT_MONITOR_HOST,
  DEFAULT_RESUME_POLICY,
  defaultMachineProfile,
  normalizeHex,
  type BreakpointRecord,
  type BreakpointKind,
  type MemSpaceName,
  type ReconnectPolicy,
  type ResumePolicy,
  type SessionSnapshot,
  type StopReason,
  type ToolWarning,
} from './contracts.js';
import { ViceMcpError, sessionStateError, validationError } from './errors.js';
import { SymbolService } from './symbols.js';
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

function normalizeRegistersMetadata(items: Array<{ id: number; size: number; name: string }>) {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    widthBits: item.size,
  }));
}

function selectWarning(message: string, code = 'warning'): ToolWarning {
  return { code, message };
}

function encodePetscii(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    if (char === '\n') {
      bytes.push(0x0d);
      continue;
    }

    if (char === '\r') {
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

    if (code >= 0x20 && code <= 0x5f) {
      bytes.push(code);
      continue;
    }

    if (code >= 0x30 && code <= 0x39) {
      bytes.push(code);
      continue;
    }

    if (code === 0x5c) {
      bytes.push(code);
      continue;
    }

    validationError('send_keys only supports ASCII text plus newline for PETSCII encoding', { character: char, codePoint: code });
  }

  return Uint8Array.from(bytes);
}

export class PortAllocatorService {
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

export class ViceSessionService {
  readonly #client = new ViceMonitorClient();
  readonly #portAllocator: PortAllocatorService;
  readonly #symbols = new SymbolService();

  #sessionId: string | null = null;
  #transportState: SessionSnapshot['transportState'] = 'not_started';
  #ownership: SessionSnapshot['emulatorOwnership'] = 'unknown';
  #processState: SessionSnapshot['processState'] = 'not_applicable';
  #executionState: SessionSnapshot['executionState'] = 'unknown';
  #lastStopReason: StopReason = 'none';
  #reconnectPolicy: ReconnectPolicy = DEFAULT_ATTACH_RECONNECT_POLICY;
  #resumePolicy: ResumePolicy = DEFAULT_RESUME_POLICY;
  #machineType: string | null = null;
  #host: string | null = null;
  #port: number | null = null;
  #connectedSince: string | null = null;
  #lastResponseAt: string | null = null;
  #process: ChildProcessWithoutNullStreams | null = null;
  #warnings: ToolWarning[] = [];
  #lastExecutionIntent: StopReason = 'unknown';

  constructor(portAllocator = new PortAllocatorService()) {
    this.#portAllocator = portAllocator;
    this.#client.on('response', () => {
      this.#lastResponseAt = nowIso();
    });
    this.#client.on('event', async (event) => {
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
    });
  }

  get symbolService(): SymbolService {
    return this.#symbols;
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.#sessionId,
      transportState: this.#transportState,
      emulatorOwnership: this.#ownership,
      processState: this.#processState,
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      machineType: this.#machineType,
      machineProfile: defaultMachineProfile(this.#machineType),
      binaryMonitorEndpoint: {
        host: this.#host,
        port: this.#port,
      },
      activePolicies: {
        reconnectPolicy: this.#reconnectPolicy,
        resumePolicy: this.#resumePolicy,
      },
      connectedSince: this.#connectedSince,
      lastResponseAt: this.#lastResponseAt,
      processId: this.#process?.pid ?? null,
      warnings: [...this.#warnings],
    };
  }

  async attachSession(host: string, port: number, machineType?: string): Promise<SessionSnapshot> {
    if (!port) {
      validationError('Attach mode requires an explicit monitor port', { host, port });
    }

    this.#sessionId = randomUUID();
    this.#transportState = 'connecting';
    this.#ownership = 'external';
    this.#processState = 'not_applicable';
    this.#machineType = machineType ?? null;
    this.#reconnectPolicy = DEFAULT_ATTACH_RECONNECT_POLICY;
    this.#host = host;
    this.#port = port;
    this.#warnings = [];

    await this.#client.connect(host, port);
    this.#transportState = 'connected';
    this.#connectedSince = nowIso();
    await this.#hydrateExecutionState();
    return this.snapshot();
  }

  async startEmulator(options: {
    emulatorType: string;
    binaryPath?: string;
    arguments?: string;
    workingDirectory?: string;
    monitorHost?: string;
    monitorPort?: number;
  }): Promise<SessionSnapshot> {
    if (this.#process) {
      sessionStateError('A managed emulator process is already active');
    }

    const host = options.monitorHost ?? DEFAULT_MONITOR_HOST;
    const port = options.monitorPort ?? (await this.#portAllocator.allocate());
    await this.#portAllocator.ensureFree(port, host);

    const binary = options.binaryPath ?? options.emulatorType;
    const args = ['-binarymonitor', '-binarymonitoraddress', `${host}:${port}`];
    if (options.arguments) {
      args.push(...splitCommandLine(options.arguments));
    }

    this.#sessionId = randomUUID();
    this.#transportState = 'starting';
    this.#ownership = 'managed';
    this.#processState = 'launching';
    this.#machineType = buildMachineType(options.emulatorType);
    this.#reconnectPolicy = DEFAULT_MANAGED_RECONNECT_POLICY;
    this.#host = host;
    this.#port = port;
    this.#warnings = [];

    const child = spawn(binary, args, {
      cwd: options.workingDirectory ? path.resolve(options.workingDirectory) : undefined,
      stdio: 'pipe',
    });
    this.#process = child;
    child.once('exit', (code, signal) => {
      this.#processState = code === 0 ? 'exited' : 'crashed';
      this.#warnings = [
        ...this.#warnings.filter((warning) => warning.code !== 'process_exit'),
        selectWarning(`VICE process exited (${code ?? 'null'} / ${signal ?? 'null'})`, 'process_exit'),
      ];
    });
    child.once('error', (error) => {
      this.#processState = 'crashed';
      this.#transportState = 'faulted';
      this.#warnings = [...this.#warnings, selectWarning(error.message, 'process_error')];
    });

    this.#processState = 'running';
    this.#transportState = 'waiting_for_monitor';

    await waitForMonitor(host, port, 5000);
    await this.#client.connect(host, port);
    this.#transportState = 'connected';
    this.#connectedSince = nowIso();
    await this.#hydrateExecutionState();
    return this.snapshot();
  }

  async stopEmulator(force = false): Promise<{ stopped: boolean; processId: number | null; ownership: SessionSnapshot['emulatorOwnership'] }> {
    if (this.#ownership !== 'managed' || !this.#process) {
      sessionStateError('No managed emulator process is active');
    }

    const processId = this.#process.pid ?? null;
    if (!force) {
      try {
        await this.#client.quit();
      } catch {
        this.#process.kill('SIGTERM');
      }
    } else {
      this.#process.kill('SIGKILL');
    }

    await sleep(250);
    await this.#client.disconnect();
    this.#transportState = 'stopped';
    this.#executionState = 'unknown';
    this.#process = null;
    return { stopped: true, processId, ownership: 'managed' };
  }

  async disconnectSession(): Promise<{ disconnected: boolean; sessionId: string | null }> {
    await this.#client.disconnect();
    this.#transportState = 'disconnected';
    this.#executionState = 'unknown';
    return { disconnected: true, sessionId: this.#sessionId };
  }

  setResumePolicy(resumePolicy: ResumePolicy): { resumePolicy: ResumePolicy } {
    this.#resumePolicy = resumePolicy;
    return { resumePolicy };
  }

  async getRegisters(registerNames?: string[]) {
    await this.#ensureConnected();
    const metadata = await this.#client.getRegistersAvailable();
    const values = await this.#client.getRegisters();
    const metadataById = new Map(metadata.registers.map((item) => [item.id, item]));
    const nameFilter = registerNames ? new Set(registerNames.map((item) => item.toUpperCase())) : null;
    const registers = values.registers
      .map((register) => {
        const meta = metadataById.get(register.id);
        return {
          name: meta?.name ?? `R${register.id}`,
          id: register.id,
          widthBits: meta?.size ?? 16,
          value: register.value,
          valueHex: normalizeHex(register.value),
        };
      })
      .filter((register) => (nameFilter ? nameFilter.has(register.name.toUpperCase()) : true));

    return {
      machine: this.#machineType ?? 'unknown',
      registers,
    };
  }

  async getRegisterMetadata(registerNames?: string[]) {
    await this.#ensureConnected();
    const metadata = await this.#client.getRegistersAvailable();
    const nameFilter = registerNames ? new Set(registerNames.map((item) => item.toUpperCase())) : null;
    return {
      machine: this.#machineType ?? 'unknown',
      registers: normalizeRegistersMetadata(metadata.registers).filter((register) =>
        nameFilter ? nameFilter.has(register.name.toUpperCase()) : true,
      ),
    };
  }

  async setRegisters(registers: Array<{ name: string; valueHex: string }>) {
    await this.#ensureConnected();
    const metadata = await this.#client.getRegistersAvailable();
    const metadataByName = new Map(metadata.registers.map((item) => [item.name.toUpperCase(), item]));

    const payload = registers.map((register) => {
      const meta = metadataByName.get(register.name.toUpperCase());
      if (!meta) {
        validationError(`Unknown register ${register.name}`, { registerName: register.name });
      }
      return {
        id: meta.id,
        value: Number.parseInt(register.valueHex.replace(/^0x/i, ''), 16),
      };
    });

    const response = await this.#client.setRegisters(payload);
    this.#applyResumePolicy(true);
    return {
      updated: response.registers.map((register) => {
        const meta = metadata.registers.find((item) => item.id === register.id);
        return {
          name: meta?.name ?? `R${register.id}`,
          value: register.value,
          valueHex: normalizeHex(register.value),
        };
      }),
      executionState: this.#executionState,
    };
  }

  async readMemory(start: number, end: number, bank = 0, memSpace: MemSpaceName = 'main') {
    await this.#ensureConnected();
    this.#validateRange(start, end);
    const response = await this.#client.readMemory(start, end, memSpace, bank);
    return {
      start,
      startHex: normalizeHex(start),
      end,
      endHex: normalizeHex(end),
      length: response.bytes.length,
      bank,
      data: Array.from(response.bytes),
    };
  }

  async writeMemory(start: number, data: number[], bank = 0, memSpace: MemSpaceName = 'main') {
    await this.#ensureConnected();
    const bytes = Uint8Array.from(data);
    if (bytes.length === 0) {
      validationError('write_memory requires at least one byte');
    }
    if (data.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
      validationError('write_memory data must contain only integer byte values between 0 and 255');
    }
    await this.#client.writeMemory(start, bytes, memSpace, bank);
    this.#applyResumePolicy(true);
    return {
      start,
      startHex: normalizeHex(start),
      length: bytes.length,
      bank,
      written: true,
    };
  }

  async searchMemory(start: number, end: number, pattern: number[], bank = 0, memSpace: MemSpaceName = 'main', maxResults = 10) {
    this.#validateRange(start, end);
    const haystack = await this.#client.readMemory(start, end, memSpace, bank);
    const needle = Uint8Array.from(pattern);
    if (needle.length === 0) {
      validationError('search_memory pattern must not be empty');
    }
    if (pattern.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
      validationError('search_memory pattern must contain only integer byte values between 0 and 255');
    }

    const matches: Array<{ address: number; addressHex: string; offset: number }> = [];
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
        matches.push({ address, addressHex: normalizeHex(address), offset });
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
    this.#applyResumePolicy(true);
    return {
      start,
      end,
      length: result.length,
      bank,
      pattern: Array.from(bytes),
    };
  }

  async copyMemory(sourceStart: number, destStart: number, length: number, sourceBank = 0, destBank = 0, memSpace: MemSpaceName = 'main') {
    if (length <= 0) {
      validationError('copy_memory length must be greater than zero');
    }
    const source = await this.#client.readMemory(sourceStart, sourceStart + length - 1, memSpace, sourceBank);
    await this.#client.writeMemory(destStart, source.bytes, memSpace, destBank);
    this.#applyResumePolicy(true);
    return { sourceStart, destStart, length, sourceBank, destBank };
  }

  async compareMemory(firstStart: number, secondStart: number, length: number, firstBank = 0, secondBank = 0, memSpace: MemSpaceName = 'main', maxDifferences = 25) {
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
    await this.#ensureConnected();
    this.#lastExecutionIntent = 'unknown';
    await this.#client.continueExecution();
    this.#executionState = 'running';
    this.#lastStopReason = 'none';
    return {
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      warnings: [] as ToolWarning[],
    };
  }

  async stepInstruction(count = 1, stepOver = false) {
    await this.#ensureConnected();
    this.#lastExecutionIntent = 'step_complete';
    await this.#client.stepInstruction(count, stepOver);
    this.#executionState = 'stopped_in_monitor';
    this.#lastStopReason = 'step_complete';
    const registers = await this.getRegisters(['PC']);
    const programCounter = registers.registers[0]?.value ?? null;
    return {
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      programCounter,
      programCounterHex: programCounter == null ? null : normalizeHex(programCounter),
      stepsExecuted: count,
      warnings: [] as ToolWarning[],
    };
  }

  async stepOut() {
    await this.#ensureConnected();
    this.#lastExecutionIntent = 'step_complete';
    await this.#client.stepOut();
    this.#executionState = 'stopped_in_monitor';
    this.#lastStopReason = 'step_complete';
    const registers = await this.getRegisters(['PC']);
    const programCounter = registers.registers[0]?.value ?? null;
    return {
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      programCounter,
      programCounterHex: programCounter == null ? null : normalizeHex(programCounter),
      warnings: [] as ToolWarning[],
    };
  }

  async resetMachine(mode: 'soft' | 'hard') {
    await this.#ensureConnected();
    this.#lastExecutionIntent = 'reset';
    await this.#client.reset(mode);
    this.#executionState = 'stopped_in_monitor';
    this.#lastStopReason = 'reset';
    return {
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      warnings: [] as ToolWarning[],
    };
  }

  async listBreakpoints(includeDisabled = true) {
    await this.#ensureConnected();
    const response = await this.#client.listBreakpoints();
    return {
      breakpoints: response.checkpoints.filter((breakpoint) => (includeDisabled ? true : breakpoint.enabled)),
    };
  }

  async getBreakpoint(breakpointId: number) {
    await this.#ensureConnected();
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
    await this.#ensureConnected();
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
    return {
      breakpoint: {
        ...response.checkpoint,
        label: options.label ?? null,
      },
    };
  }

  async deleteBreakpoint(breakpointId: number) {
    await this.#ensureConnected();
    await this.#client.deleteBreakpoint(breakpointId);
    return {
      deleted: true,
      breakpointId,
    };
  }

  async enableBreakpoint(breakpointId: number, enabled: boolean) {
    await this.#ensureConnected();
    await this.#client.toggleBreakpoint(breakpointId, enabled);
    return {
      breakpointId,
      enabled,
    };
  }

  async setBreakpointCondition(breakpointId: number, condition: string) {
    await this.#ensureConnected();
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

  async loadProgram(filePath: string, addressOverride?: number | null) {
    await this.#ensureConnected();
    const absolutePath = path.resolve(filePath);
    const contents = await fs.readFile(absolutePath);
    if (contents.length < 2) {
      throw new ViceMcpError('invalid_prg', 'PRG file is too small', 'validation');
    }

    const loadAddress = addressOverride ?? contents.readUInt16LE(0);
    const bytes = addressOverride == null ? contents.subarray(2) : contents;
    await this.#client.writeMemory(loadAddress, bytes);
    this.#applyResumePolicy(true);
    return {
      filePath: absolutePath,
      start: loadAddress,
      startHex: normalizeHex(loadAddress),
      length: bytes.length,
      written: true,
    };
  }

  async autostartProgram(filePath: string, runAfterLoading = true, fileIndex = 0) {
    await this.#ensureConnected();
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
    await this.#ensureConnected();
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
      startHex: normalizeHex(start),
      end,
      endHex: normalizeHex(end),
      length: response.bytes.length,
      asPrg,
      bank,
    };
  }

  async captureDisplay(useVic = true) {
    await this.#ensureConnected();
    const response = await this.#client.captureDisplay(useVic);
    const warnings: ToolWarning[] = [];
    let pngBase64: string | null = null;

    if (response.bitsPerPixel === 8) {
      pngBase64 = encodePngGrayscale(response.innerWidth, response.innerHeight, response.imageBytes);
      warnings.push(
        selectWarning(
          'VICE returned indexed pixel data without palette metadata; pngBase64 uses grayscale mapping of indices.',
          'display_palette_unknown',
        ),
      );
    } else {
      warnings.push(selectWarning(`Unsupported display bit depth ${response.bitsPerPixel}`, 'display_bpp_unsupported'));
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

  async loadSymbols(filePath: string) {
    return await this.#symbols.loadOscar64Symbols(filePath);
  }

  listSymbolSources() {
    return {
      sources: this.#symbols.listSources(),
    };
  }

  lookupSymbol(name: string) {
    const symbol = this.#symbols.lookup(name);
    if (!symbol) {
      throw new ViceMcpError('symbol_not_found', `Symbol not found: ${name}`, 'validation', false, { name });
    }
    return {
      symbol,
    };
  }

  async setBreakpointAtSymbol(name: string, condition?: string, temporary = false) {
    const symbol = this.#symbols.lookup(name);
    if (!symbol) {
      throw new ViceMcpError('symbol_not_found', `Symbol not found: ${name}`, 'validation', false, { name });
    }

    const result = await this.setBreakpoint({
      kind: 'exec',
      start: symbol.address,
      end: symbol.endAddress,
      condition,
      temporary,
      label: symbol.name,
    });
    return {
      symbol,
      breakpoint: result.breakpoint,
    };
  }

  async getBanks() {
    await this.#ensureConnected();
    const response = await this.#client.getBanksAvailable();
    return {
      banks: response.banks,
    };
  }

  async getInfo() {
    await this.#ensureConnected();
    const info = await this.#client.getInfo();
    return {
      viceVersion: info.versionString,
      versionComponents: info.version,
      svnVersion: info.svnVersion,
    };
  }

  async ping() {
    await this.#ensureConnected();
    await this.#client.ping();
    return {
      responsive: true,
    };
  }

  async sendKeys(keys: string) {
    await this.#ensureConnected();
    const encoded = encodePetscii(keys);
    await this.#client.sendKeys(Buffer.from(encoded).toString('binary'));
    this.#applyResumePolicy(true);
    return {
      sent: true,
      length: encoded.length,
    };
  }

  async #ensureConnected(): Promise<void> {
    if (!this.#host || !this.#port) {
      sessionStateError('No active VICE session');
    }

    if (this.#transportState === 'connected' && this.#client.connected) {
      return;
    }

    this.#transportState = 'connecting';
    await this.#client.connect(this.#host, this.#port);
    this.#transportState = 'connected';
    if (!this.#connectedSince) {
      this.#connectedSince = nowIso();
    }
  }

  async #hydrateExecutionState(): Promise<void> {
    try {
      const registers = await this.getRegisters(['PC']);
      if (registers.registers.length > 0) {
        this.#executionState = 'stopped_in_monitor';
        this.#lastStopReason = 'monitor_entry';
        return;
      }
    } catch {
      this.#warnings.push(selectWarning('Could not determine initial execution state', 'execution_state_unknown'));
    }
    this.#executionState = 'unknown';
  }

  #applyResumePolicy(mutating: boolean): void {
    if (this.#resumePolicy === 'preserve_pause_state') {
      return;
    }
    if (this.#resumePolicy === 'resume_after_mutation' && !mutating) {
      return;
    }
    void this.#client.continueExecution().then(() => {
      this.#executionState = 'running';
      this.#lastStopReason = 'none';
    });
  }

  #validateRange(start: number, end: number): void {
    if (end < start) {
      validationError('End address must be greater than or equal to start address', { start, end });
    }
    if (start < 0 || end > 0xffff) {
      validationError('Address range must fit in 16-bit address space', { start, end });
    }
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
    timeoutMs,
  });
}
