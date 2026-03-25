import { EventEmitter } from 'node:events';
import net from 'node:net';

import {
  VICE_API_VERSION,
  VICE_BROADCAST_REQUEST_ID,
  VICE_STX,
  breakpointKindToOperation,
  cpuOperationToBreakpointKind,
  mainMemSpaceToProtocol,
  type BreakpointKind,
  type Breakpoint,
} from './contracts.js';
import { ViceMcpError } from './errors.js';

export const enum CommandType {
  MemoryGet = 0x01,
  MemorySet = 0x02,
  CheckpointGet = 0x11,
  CheckpointSet = 0x12,
  CheckpointDelete = 0x13,
  CheckpointList = 0x14,
  CheckpointToggle = 0x15,
  ConditionSet = 0x22,
  RegistersGet = 0x31,
  RegistersSet = 0x32,
  Dump = 0x41,
  Undump = 0x42,
  AdvanceInstruction = 0x71,
  KeyboardFeed = 0x72,
  ExecuteUntilReturn = 0x73,
  Ping = 0x81,
  BanksAvailable = 0x82,
  RegistersAvailable = 0x83,
  DisplayGet = 0x84,
  Info = 0x85,
  PaletteGet = 0x91,
  JoyportSet = 0xa2,
  Exit = 0xaa,
  Quit = 0xbb,
  Reset = 0xcc,
  AutoStart = 0xdd,
}

const enum ResponseType {
  MemoryGet = 0x01,
  MemorySet = 0x02,
  CheckpointInfo = 0x11,
  CheckpointList = 0x14,
  CheckpointToggle = 0x15,
  ConditionSet = 0x22,
  RegisterInfo = 0x31,
  Dump = 0x41,
  Undump = 0x42,
  Jam = 0x61,
  Stopped = 0x62,
  Resumed = 0x63,
  AdvanceInstruction = 0x71,
  KeyboardFeed = 0x72,
  ExecuteUntilReturn = 0x73,
  Ping = 0x81,
  BanksAvailable = 0x82,
  RegistersAvailable = 0x83,
  DisplayGet = 0x84,
  Info = 0x85,
  PaletteGet = 0x91,
  JoyportSet = 0xa2,
  Exit = 0xaa,
  Quit = 0xbb,
  Reset = 0xcc,
  AutoStart = 0xdd,
}

const enum ErrorCode {
  OK = 0x00,
  ObjectDoesNotExist = 0x01,
  InvalidMemSpace = 0x02,
  IncorrectCommandLength = 0x80,
  InvalidParameterValue = 0x81,
  UnknownApiVersion = 0x82,
  UnknownCommandType = 0x83,
  GeneralFailure = 0x8f,
}

type PendingCommand = {
  type: CommandType;
  resolve: (value: ParsedResponse) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
  linkedCheckpointInfo?: ParsedCheckpointInfoResponse[];
};

export type ParsedResponse =
  | ParsedEmptyResponse
  | ParsedMemoryGetResponse
  | ParsedRegistersResponse
  | ParsedRegistersAvailableResponse
  | ParsedInfoResponse
  | ParsedBreakpointInfoResponse
  | ParsedBreakpointListResponse
  | ParsedDisplayResponse
  | ParsedPaletteResponse
  | ParsedStoppedEvent
  | ParsedResumedEvent
  | ParsedJamEvent
  | ParsedUndumpResponse;

export interface ParsedBaseResponse {
  requestId: number;
  errorCode: number;
}

export interface ParsedEmptyResponse extends ParsedBaseResponse {
  type: 'empty';
  responseType: number;
}

export interface ParsedMemoryGetResponse extends ParsedBaseResponse {
  type: 'memory_get';
  bytes: Uint8Array;
}

export interface ParsedRegistersResponse extends ParsedBaseResponse {
  type: 'registers';
  registers: Array<{ id: number; value: number }>;
}

export interface ParsedRegistersAvailableResponse extends ParsedBaseResponse {
  type: 'registers_available';
  registers: Array<{ id: number; size: number; name: string }>;
}

export interface ParsedInfoResponse extends ParsedBaseResponse {
  type: 'info';
  version: number[];
  versionString: string;
  svnVersion: number;
}

export interface ParsedBreakpointInfoResponse extends ParsedBaseResponse {
  type: 'checkpoint_info';
  checkpoint: Breakpoint;
}

type ParsedCheckpointInfoResponse = ParsedBreakpointInfoResponse;

export interface ParsedBreakpointListResponse extends ParsedBaseResponse {
  type: 'checkpoint_list';
  total: number;
  checkpoints: Breakpoint[];
}

export interface ParsedDisplayResponse extends ParsedBaseResponse {
  type: 'display';
  debugWidth: number;
  debugHeight: number;
  debugOffsetX: number;
  debugOffsetY: number;
  innerWidth: number;
  innerHeight: number;
  bitsPerPixel: number;
  imageBytes: Uint8Array;
}

export interface ParsedPaletteItem {
  index: number;
  red: number;
  green: number;
  blue: number;
}

export interface ParsedPaletteResponse extends ParsedBaseResponse {
  type: 'palette';
  items: ParsedPaletteItem[];
}

export interface ParsedStoppedEvent extends ParsedBaseResponse {
  type: 'stopped';
  programCounter: number;
}

export interface ParsedResumedEvent extends ParsedBaseResponse {
  type: 'resumed';
  programCounter: number;
}

export interface ParsedJamEvent extends ParsedBaseResponse {
  type: 'jam';
  programCounter: number;
}

export interface ParsedUndumpResponse extends ParsedBaseResponse {
  type: 'undump';
  programCounter: number;
}

export type MonitorRuntimeEventType = 'unknown' | 'resumed' | 'stopped' | 'jam';

export interface MonitorRuntimeState {
  connected: boolean;
  runtimeKnown: boolean;
  lastEventType: MonitorRuntimeEventType;
  programCounter: number | null;
}

function parseLittleEndianVariableWidth(bytes: Uint8Array): number {
  let value = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    value += (bytes[index] ?? 0) * 2 ** (index * 8);
  }
  return value;
}

function encodeHeader(commandType: number, requestId: number, body: Buffer): Buffer {
  const header = Buffer.alloc(11);
  header[0] = VICE_STX;
  header[1] = VICE_API_VERSION;
  header.writeUInt32LE(body.length, 2);
  header.writeUInt32LE(requestId, 6);
  header[10] = commandType;
  return Buffer.concat([header, body]);
}

function parseBuffer(buffer: Buffer): { responses: ParsedResponse[]; remainder: Buffer } {
  const responses: ParsedResponse[] = [];
  let offset = 0;

  while (offset + 12 <= buffer.length) {
    if (buffer[offset] !== VICE_STX) {
      throw new ViceMcpError('protocol_invalid_stx', 'Invalid response prefix from emulator debug connection', 'protocol');
    }

    const bodyLength = buffer.readUInt32LE(offset + 2);
    const frameLength = 12 + bodyLength;
    if (offset + frameLength > buffer.length) {
      break;
    }

    const body = buffer.subarray(offset + 12, offset + frameLength);
    const responseType = buffer[offset + 6]!;
    const errorCode = buffer[offset + 7]!;
    const requestId = buffer.readUInt32LE(offset + 8);
    responses.push(parseResponse(responseType, errorCode, requestId, body));
    offset += frameLength;
  }

  return { responses, remainder: buffer.subarray(offset) };
}

function parseResponse(responseType: number, errorCode: number, requestId: number, body: Buffer): ParsedResponse {
  switch (responseType) {
    case ResponseType.MemoryGet: {
      const length = errorCode === ErrorCode.OK ? body.readUInt16LE(0) : 0;
      return { type: 'memory_get', requestId, errorCode, bytes: body.subarray(2, 2 + length) };
    }
    case ResponseType.RegisterInfo: {
      const count = errorCode === ErrorCode.OK ? body.readUInt16LE(0) : 0;
      const registers = Array.from({ length: count }, (_, index) => {
        const start = 2 + index * 4;
        return { id: body[start + 1]!, value: body.readUInt16LE(start + 2) };
      });
      return { type: 'registers', requestId, errorCode, registers };
    }
    case ResponseType.RegistersAvailable: {
      const count = errorCode === ErrorCode.OK ? body.readUInt16LE(0) : 0;
      let offset = 2;
      const registers = [];
      for (let index = 0; index < count; index += 1) {
        const itemSize = body[offset]!;
        const id = body[offset + 1]!;
        const size = body[offset + 2]!;
        const nameLength = body[offset + 3]!;
        const name = body.subarray(offset + 4, offset + 4 + nameLength).toString('ascii');
        registers.push({ id, size, name });
        offset += itemSize + 1;
      }
      return { type: 'registers_available', requestId, errorCode, registers };
    }
    case ResponseType.Info: {
      const mainVersionLength = body[0] ?? 0;
      const version = Array.from(body.subarray(1, 1 + mainVersionLength));
      const svnLengthOffset = 1 + mainVersionLength;
      const svnLength = body[svnLengthOffset] ?? 0;
      const svnBytes = body.subarray(svnLengthOffset + 1, svnLengthOffset + 1 + svnLength);
      return {
        type: 'info',
        requestId,
        errorCode,
        version,
        versionString: version.join('.'),
        svnVersion: parseLittleEndianVariableWidth(svnBytes),
      };
    }
    case ResponseType.CheckpointInfo: {
      const operation = body[11] ?? 0x04;
      const checkpoint: Breakpoint = {
        id: body.readUInt32LE(0),
        currentlyHit: body[4] === 1,
        start: body.readUInt16LE(5),
        end: body.readUInt16LE(7),
        stopWhenHit: body[9] === 1,
        enabled: body[10] === 1,
        kind: cpuOperationToBreakpointKind(operation),
        temporary: body[12] === 1,
        hitCount: body.readUInt32LE(13),
        ignoreCount: body.readUInt32LE(17),
        hasCondition: body[21] === 1,
      };
      return { type: 'checkpoint_info', requestId, errorCode, checkpoint };
    }
    case ResponseType.CheckpointList: {
      return {
        type: 'checkpoint_list',
        requestId,
        errorCode,
        total: errorCode === ErrorCode.OK ? body.readUInt32LE(0) : 0,
        checkpoints: [],
      };
    }
    case ResponseType.DisplayGet: {
      const infoLength = errorCode === ErrorCode.OK ? body.readUInt32LE(0) : 0;
      const imageLength = errorCode === ErrorCode.OK ? body.readUInt32LE(17) : 0;
      return {
        type: 'display',
        requestId,
        errorCode,
        debugWidth: body.readUInt16LE(4),
        debugHeight: body.readUInt16LE(6),
        debugOffsetX: body.readUInt16LE(8),
        debugOffsetY: body.readUInt16LE(10),
        innerWidth: body.readUInt16LE(12),
        innerHeight: body.readUInt16LE(14),
        bitsPerPixel: body[16] ?? 0,
        imageBytes: body.subarray(infoLength + 4, infoLength + 4 + imageLength),
      };
    }
    case ResponseType.PaletteGet: {
      const count = errorCode === ErrorCode.OK ? body.readUInt16LE(0) : 0;
      let offset = 2;
      const items: ParsedPaletteItem[] = [];
      for (let index = 0; index < count; index += 1) {
        const itemSize = body[offset] ?? 0;
        items.push({
          index,
          red: body[offset + 1] ?? 0,
          green: body[offset + 2] ?? 0,
          blue: body[offset + 3] ?? 0,
        });
        offset += itemSize + 1;
      }
      return { type: 'palette', requestId, errorCode, items };
    }
    case ResponseType.Stopped:
      return { type: 'stopped', requestId, errorCode, programCounter: body.readUInt16LE(0) };
    case ResponseType.Resumed:
      return { type: 'resumed', requestId, errorCode, programCounter: body.readUInt16LE(0) };
    case ResponseType.Jam:
      return { type: 'jam', requestId, errorCode, programCounter: body.readUInt16LE(0) };
    case ResponseType.Undump:
      return { type: 'undump', requestId, errorCode, programCounter: body.readUInt16LE(0) };
    default:
      return { type: 'empty', requestId, errorCode, responseType };
  }
}

export class ViceMonitorClient extends EventEmitter {
  #socket: net.Socket | null = null;
  #buffer = Buffer.alloc(0);
  #nextRequestId = 1;
  #pending = new Map<number, PendingCommand>();
  #chain = Promise.resolve();
  #host: string | null = null;
  #port: number | null = null;
  #runtimeState: MonitorRuntimeState = {
    connected: false,
    runtimeKnown: false,
    lastEventType: 'unknown',
    programCounter: null,
  };

  get connected(): boolean {
    return this.#socket != null && !this.#socket.destroyed;
  }

  runtimeState(): MonitorRuntimeState {
    return { ...this.#runtimeState };
  }

  async connect(host: string, port: number): Promise<void> {
    if (this.connected && this.#host === host && this.#port === port) {
      return;
    }

    await this.disconnect();

    this.#host = host;
    this.#port = port;
    this.#buffer = Buffer.alloc(0);

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        this.#socket = socket;
        this.#runtimeState = {
          connected: true,
          runtimeKnown: false,
          lastEventType: 'unknown',
          programCounter: null,
        };
        resolve();
      });

      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('close', () => this.#onClose());
      socket.on('error', (error) => {
        if (!this.#socket) {
          reject(error);
          return;
        }
        this.emit('transport-error', error);
      });
    });
  }

  async disconnect(): Promise<void> {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ViceMcpError('connection_closed', 'Emulator debug connection closed', 'connection', true));
    }
    this.#pending.clear();

    if (!this.#socket) {
      return;
    }

    const socket = this.#socket;
    this.#socket = null;
    this.#runtimeState = {
      connected: false,
      runtimeKnown: false,
      lastEventType: 'unknown',
      programCounter: null,
    };
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  async ping(timeoutMs = 2000): Promise<void> {
    await this.send(CommandType.Ping, Buffer.alloc(0), timeoutMs);
  }

  async getInfo(): Promise<ParsedInfoResponse> {
    return this.send(CommandType.Info, Buffer.alloc(0));
  }

  async captureDisplay(useVic = true): Promise<ParsedDisplayResponse> {
    return this.send(CommandType.DisplayGet, Buffer.from([useVic ? 1 : 0, 0x00]));
  }

  async getPalette(useVic = true): Promise<ParsedPaletteResponse> {
    return this.send(CommandType.PaletteGet, Buffer.from([useVic ? 1 : 0]));
  }

  async getRegistersAvailable(): Promise<ParsedRegistersAvailableResponse> {
    return this.send(CommandType.RegistersAvailable, Buffer.from([mainMemSpaceToProtocol()]));
  }

  async getRegisters(): Promise<ParsedRegistersResponse> {
    return this.send(CommandType.RegistersGet, Buffer.from([mainMemSpaceToProtocol()]));
  }

  async setRegisters(registers: Array<{ id: number; value: number }>): Promise<ParsedRegistersResponse> {
    const body = Buffer.alloc(3 + registers.length * 4);
    body[0] = mainMemSpaceToProtocol();
    body.writeUInt16LE(registers.length, 1);
    registers.forEach((register, index) => {
      const offset = 3 + index * 4;
      body[offset] = 3;
      body[offset + 1] = register.id;
      body.writeUInt16LE(register.value, offset + 2);
    });
    return this.send(CommandType.RegistersSet, body);
  }

  async readMemory(start: number, end: number, bankId = 0): Promise<ParsedMemoryGetResponse> {
    const body = Buffer.alloc(8);
    body[0] = 0;
    body.writeUInt16LE(start, 1);
    body.writeUInt16LE(end, 3);
    body[5] = mainMemSpaceToProtocol();
    body.writeUInt16LE(bankId, 6);
    return this.send(CommandType.MemoryGet, body);
  }

  async writeMemory(start: number, bytes: Uint8Array, bankId = 0): Promise<ParsedEmptyResponse> {
    const body = Buffer.alloc(8 + bytes.length);
    body[0] = 0;
    body.writeUInt16LE(start, 1);
    body.writeUInt16LE(start + bytes.length - 1, 3);
    body[5] = mainMemSpaceToProtocol();
    body.writeUInt16LE(bankId, 6);
    Buffer.from(bytes).copy(body, 8);
    return this.send(CommandType.MemorySet, body);
  }

  async continueExecution(): Promise<ParsedEmptyResponse> {
    return this.send(CommandType.Exit, Buffer.alloc(0));
  }

  async stepInstruction(count = 1, stepOver = false): Promise<ParsedEmptyResponse> {
    const body = Buffer.alloc(3);
    body[0] = stepOver ? 1 : 0;
    body.writeUInt16LE(count, 1);
    return this.send(CommandType.AdvanceInstruction, body);
  }

  async stepOut(): Promise<ParsedEmptyResponse> {
    return this.send(CommandType.ExecuteUntilReturn, Buffer.alloc(0));
  }

  async reset(mode: 'soft' | 'hard'): Promise<ParsedEmptyResponse> {
    const body = Buffer.from([mode === 'hard' ? 1 : 0]);
    return this.send(CommandType.Reset, body);
  }

  async setBreakpoint(options: {
    start: number;
    end?: number;
    kind: BreakpointKind;
    enabled?: boolean;
    stopWhenHit?: boolean;
    temporary?: boolean;
    condition?: string;
  }): Promise<ParsedBreakpointInfoResponse> {
    const body = Buffer.alloc(8);
    body.writeUInt16LE(options.start, 0);
    body.writeUInt16LE(options.end ?? options.start, 2);
    body[4] = options.stopWhenHit === false ? 0 : 1;
    body[5] = options.enabled === false ? 0 : 1;
    body[6] = breakpointKindToOperation(options.kind);
    body[7] = options.temporary ? 1 : 0;

    const response = await this.send(CommandType.CheckpointSet, body);
    if (options.condition && response.type === 'checkpoint_info') {
      const conditionBody = Buffer.alloc(5 + options.condition.length);
      conditionBody.writeUInt32LE(response.checkpoint.id, 0);
      conditionBody[4] = options.condition.length;
      conditionBody.write(options.condition, 5, 'ascii');
      await this.send(CommandType.ConditionSet, conditionBody);
      return {
        ...response,
        checkpoint: {
          ...response.checkpoint,
          hasCondition: true,
        },
      };
    }

    return response as ParsedBreakpointInfoResponse;
  }

  async getBreakpoint(id: number): Promise<ParsedBreakpointInfoResponse> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(id, 0);
    return this.send(CommandType.CheckpointGet, body);
  }

  async listBreakpoints(): Promise<ParsedBreakpointListResponse> {
    return this.send(CommandType.CheckpointList, Buffer.alloc(0));
  }

  async deleteBreakpoint(id: number): Promise<ParsedEmptyResponse> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(id, 0);
    return this.send(CommandType.CheckpointDelete, body);
  }

  async toggleBreakpoint(id: number, enabled: boolean): Promise<ParsedEmptyResponse> {
    const body = Buffer.alloc(5);
    body.writeUInt32LE(id, 0);
    body[4] = enabled ? 1 : 0;
    return this.send(CommandType.CheckpointToggle, body);
  }

  async setBreakpointCondition(id: number, condition: string): Promise<ParsedEmptyResponse> {
    const conditionBytes = Buffer.from(condition, 'ascii');
    const body = Buffer.alloc(5 + conditionBytes.length);
    body.writeUInt32LE(id, 0);
    body[4] = conditionBytes.length;
    conditionBytes.copy(body, 5);
    return this.send(CommandType.ConditionSet, body);
  }

  async autostartProgram(filename: string, autoStart: boolean, fileIndex = 0): Promise<ParsedEmptyResponse> {
    const body = Buffer.alloc(4 + Buffer.byteLength(filename));
    body[0] = autoStart ? 1 : 0;
    body.writeUInt16LE(fileIndex, 1);
    body[3] = Buffer.byteLength(filename);
    body.write(filename, 4, 'ascii');
    return this.send(CommandType.AutoStart, body);
  }

  async quit(): Promise<ParsedEmptyResponse> {
    return this.send(CommandType.Quit, Buffer.alloc(0));
  }

  async sendKeys(text: string): Promise<ParsedEmptyResponse> {
    const encoded = Buffer.from(text, 'binary');
    const body = Buffer.alloc(1 + encoded.length);
    body[0] = encoded.length;
    encoded.copy(body, 1);
    return this.send(CommandType.KeyboardFeed, body);
  }

  async setJoyport(port: number, value: number): Promise<ParsedEmptyResponse> {
    const body = Buffer.alloc(4);
    body.writeUInt16LE(port, 0);
    body.writeUInt16LE(value, 2);
    return this.send(CommandType.JoyportSet, body);
  }

  async send<T extends ParsedResponse>(commandType: CommandType, body: Buffer, timeoutMs = 5000): Promise<T> {
    const next = this.#chain.catch(() => undefined).then(async () => this.#execute<T>(commandType, body, timeoutMs));
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #execute<T extends ParsedResponse>(commandType: CommandType, body: Buffer, timeoutMs: number): Promise<T> {
    if (!this.#socket || this.#socket.destroyed) {
      throw new ViceMcpError('not_connected', 'Emulator debug connection is not connected', 'connection', true);
    }

    const requestId = this.#nextRequestId++;
    const packet = encodeHeader(commandType, requestId, body);

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ViceMcpError('timeout', `Emulator debug command timed out (0x${commandType.toString(16)})`, 'timeout', true));
      }, timeoutMs);

      this.#pending.set(requestId, {
        type: commandType,
        timer,
        resolve: (response) => resolve(response as T),
        reject,
        linkedCheckpointInfo: commandType === CommandType.CheckpointList ? [] : undefined,
      });

      this.#socket!.write(packet, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(requestId);
          reject(new ViceMcpError('socket_write_failed', error.message, 'connection', true));
        }
      });
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const { responses, remainder } = parseBuffer(this.#buffer);
    this.#buffer = Buffer.from(remainder);

    for (const response of responses) {
      this.emit('response', response);
      if (response.requestId === VICE_BROADCAST_REQUEST_ID) {
        this.#applyRuntimeResponse(response);
        this.emit('event', response);
        continue;
      }

      const pending = this.#pending.get(response.requestId);
      if (!pending) {
        this.emit('event', response);
        continue;
      }

      if (pending.type === CommandType.CheckpointList && response.type === 'checkpoint_info') {
        pending.linkedCheckpointInfo?.push(response);
        continue;
      }

      clearTimeout(pending.timer);
      this.#pending.delete(response.requestId);

      if (response.errorCode !== ErrorCode.OK) {
        pending.reject(
          new ViceMcpError('emulator_protocol_error', `Emulator returned error ${response.errorCode}`, 'protocol', false, {
            commandType: pending.type,
            requestId: response.requestId,
            emulatorErrorCode: response.errorCode,
          }),
        );
        continue;
      }

      if (pending.type === CommandType.CheckpointList && response.type === 'checkpoint_list') {
        // Defensive check: ensure linkedCheckpointInfo is always an array
        if (!pending.linkedCheckpointInfo) {
          pending.linkedCheckpointInfo = [];
        }
        response.checkpoints = pending.linkedCheckpointInfo.map((entry) => entry.checkpoint);
      }

      pending.resolve(response);
    }
  }

  #onClose(): void {
    const pendingError = new ViceMcpError('connection_closed', 'Emulator debug connection closed', 'connection', true);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pendingError);
    }
    this.#pending.clear();
    this.#socket = null;
    this.#runtimeState = {
      connected: false,
      runtimeKnown: false,
      lastEventType: 'unknown',
      programCounter: null,
    };
    this.emit('close');
  }

  #applyRuntimeResponse(response: ParsedResponse): void {
    switch (response.type) {
      case 'resumed':
      case 'stopped':
      case 'jam':
        this.#runtimeState = {
          connected: this.connected,
          runtimeKnown: true,
          lastEventType: response.type,
          programCounter: response.programCounter,
        };
        break;
      default:
        break;
    }
  }
}
