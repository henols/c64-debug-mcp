import fs from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import zlib from 'node:zlib';

import {
  C64_REGISTER_DEFINITIONS,
  DEFAULT_C64_BINARY,
  DEFAULT_FORBIDDEN_PORTS,
  DEFAULT_MONITOR_HOST,
  c64ConfigSchema,
  type C64RegisterName,
  type BreakpointKind,
  type C64Config,
  type ExecutionState,
  type InputAction,
  type JoystickControl,
  type JoystickPort,
  type ResponseMeta,
  type SessionState,
  type StopReason,
  type WarningItem,
} from './contracts.js';
import { ViceMcpError, debuggerNotPausedError, emulatorNotRunningError, unsupportedError, validationError } from './errors.js';
import { ViceMonitorClient, type MonitorRuntimeEventType } from './vice-protocol.js';

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

function makeWarning(message: string, code = 'warning'): WarningItem {
  return { code, message };
}

function lowNibble(value: number): number {
  return value & 0x0f;
}

function decodeVicBankAddress(dd00: number): number {
  return ((dd00 ^ 0x03) & 0x03) * 0x4000;
}

function decodeGraphicsMode(d011: number, d016: number) {
  const extendedColorMode = (d011 & 0x40) !== 0;
  const bitmapMode = (d011 & 0x20) !== 0;
  const multicolorMode = (d016 & 0x10) !== 0;

  let graphicsMode:
    | 'standard_text'
    | 'multicolor_text'
    | 'standard_bitmap'
    | 'multicolor_bitmap'
    | 'extended_background_color_text'
    | 'invalid_text_mode'
    | 'invalid_bitmap_mode_1'
    | 'invalid_bitmap_mode_2';

  if (!extendedColorMode && !bitmapMode && !multicolorMode) {
    graphicsMode = 'standard_text';
  } else if (!extendedColorMode && !bitmapMode && multicolorMode) {
    graphicsMode = 'multicolor_text';
  } else if (!extendedColorMode && bitmapMode && !multicolorMode) {
    graphicsMode = 'standard_bitmap';
  } else if (!extendedColorMode && bitmapMode && multicolorMode) {
    graphicsMode = 'multicolor_bitmap';
  } else if (extendedColorMode && !bitmapMode && !multicolorMode) {
    graphicsMode = 'extended_background_color_text';
  } else if (extendedColorMode && !bitmapMode && multicolorMode) {
    graphicsMode = 'invalid_text_mode';
  } else if (extendedColorMode && bitmapMode && !multicolorMode) {
    graphicsMode = 'invalid_bitmap_mode_1';
  } else {
    graphicsMode = 'invalid_bitmap_mode_2';
  }

  return {
    graphicsMode,
    extendedColorMode,
    bitmapMode,
    multicolorMode,
  };
}

function isTextGraphicsMode(
  graphicsMode:
    | 'standard_text'
    | 'multicolor_text'
    | 'standard_bitmap'
    | 'multicolor_bitmap'
    | 'extended_background_color_text'
    | 'invalid_text_mode'
    | 'invalid_bitmap_mode_1'
    | 'invalid_bitmap_mode_2',
): boolean {
  return (
    graphicsMode === 'standard_text' ||
    graphicsMode === 'multicolor_text' ||
    graphicsMode === 'extended_background_color_text' ||
    graphicsMode === 'invalid_text_mode'
  );
}

function petsciiToScreenCode(value: number): number {
  if (value === 0xff) {
    return 0x5e;
  }
  if (value < 0x20) {
    return value ^ 0x80;
  }
  if (value < 0x60) {
    return value & 0x3f;
  }
  if (value < 0x80) {
    return value & 0x5f;
  }
  if (value < 0xa0) {
    return value | 0x40;
  }
  if (value < 0xc0) {
    return value ^ 0xc0;
  }
  if (value < 0xff) {
    return value ^ 0x80;
  }
  return 0x5e;
}

function decodeScreenCodeCell(code: number): { ascii: string; token?: string; lossy: boolean } {
  if (code === 32 || code === 160) {
    return { ascii: ' ', lossy: false };
  }
  if (code >= 1 && code <= 26) {
    return { ascii: String.fromCharCode(64 + code), lossy: false };
  }
  if (code >= 48 && code <= 57) {
    return { ascii: String.fromCharCode(code), lossy: false };
  }
  switch (code) {
    case 0:
      return { ascii: '@', lossy: false };
    case 27:
      return { ascii: '[', lossy: false };
    case 28:
      return { ascii: '£', lossy: false };
    case 29:
      return { ascii: ']', lossy: false };
    case 34:
      return { ascii: '"', lossy: false };
    case 35:
      return { ascii: '#', lossy: false };
    case 36:
      return { ascii: '$', lossy: false };
    case 37:
      return { ascii: '%', lossy: false };
    case 38:
      return { ascii: '&', lossy: false };
    case 39:
      return { ascii: '\'', lossy: false };
    case 40:
      return { ascii: '(', lossy: false };
    case 41:
      return { ascii: ')', lossy: false };
    case 42:
      return { ascii: '*', lossy: false };
    case 43:
      return { ascii: '+', lossy: false };
    case 44:
      return { ascii: ',', lossy: false };
    case 45:
      return { ascii: '-', lossy: false };
    case 46:
      return { ascii: '.', lossy: false };
    case 47:
      return { ascii: '/', lossy: false };
    case 58:
      return { ascii: ':', lossy: false };
    case 59:
      return { ascii: ';', lossy: false };
    case 60:
      return { ascii: '↑', lossy: false };
    case 61:
      return { ascii: '=', lossy: false };
    case 62:
      return { ascii: '←', lossy: false };
    case 63:
      return { ascii: '?', lossy: false };
    case 94:
      return { ascii: 'π', lossy: false };
    default:
      return {
        ascii: '�',
        token: SCREEN_CODE_TOKEN_MAP.get(code) ?? `<SC:${code}>`,
        lossy: true,
      };
  }
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
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

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  return Buffer.concat([uint32(data.length), typeBuffer, data, uint32(crc >>> 0)]);
}

function encodePngRgb(width: number, height: number, pixels: Uint8Array): Buffer {
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    rows[rowOffset] = 0;
    Buffer.from(pixels.subarray(y * stride, y * stride + stride)).copy(rows, rowOffset + 1);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    pngChunk(
      'IHDR',
      Buffer.concat([
        uint32(width),
        uint32(height),
        Buffer.from([8, 2, 0, 0, 0]),
      ]),
    ),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ];

  return Buffer.concat([signature, ...chunks]);
}

type PetsciiTokenDefinition = {
  canonical: string;
  bytes: readonly number[];
  aliases: readonly string[];
};

const PETSCII_TOKEN_DEFINITIONS: readonly PetsciiTokenDefinition[] = [
  { canonical: 'RETURN', bytes: [0x0d], aliases: ['ENTER'] },
  { canonical: 'SHIFT RETURN', bytes: [0x8d], aliases: ['SHIFT ENTER', 'SH RETURN', 'SH ENTER', 'STRET'] },
  { canonical: 'SPACE', bytes: [0x20], aliases: ['SPC'] },
  { canonical: 'SHIFT SPACE', bytes: [0xa0], aliases: ['SH SPACE'] },
  { canonical: 'HOME', bytes: [0x13], aliases: ['CURSOR HOME', 'CUR HOME'] },
  { canonical: 'CLEAR', bytes: [0x93], aliases: ['CLR', 'CLEAR SCREEN'] },
  { canonical: 'DELETE', bytes: [0x14], aliases: ['DEL', 'BACKSPACE'] },
  { canonical: 'INSERT', bytes: [0x94], aliases: ['INST', 'INS'] },
  { canonical: 'DOWN', bytes: [0x11], aliases: ['CURSOR DOWN', 'CUR DOWN'] },
  { canonical: 'UP', bytes: [0x91], aliases: ['CURSOR UP', 'CUR UP'] },
  { canonical: 'LEFT', bytes: [0x9d], aliases: ['CURSOR LEFT', 'CUR LEFT'] },
  { canonical: 'RIGHT', bytes: [0x1d], aliases: ['CURSOR RIGHT', 'CUR RIGHT'] },
  { canonical: 'REVERSE ON', bytes: [0x12], aliases: ['RVS ON', 'RVON', 'RVRS ON'] },
  { canonical: 'REVERSE OFF', bytes: [0x92], aliases: ['RVS OFF', 'RVOF', 'RVRS OFF'] },
  { canonical: 'BLACK', bytes: [0x90], aliases: ['BLK'] },
  { canonical: 'WHITE', bytes: [0x05], aliases: ['WHT'] },
  { canonical: 'RED', bytes: [0x1c], aliases: [] },
  { canonical: 'CYAN', bytes: [0x9f], aliases: ['CYN'] },
  { canonical: 'PURPLE', bytes: [0x9c], aliases: ['PUR'] },
  { canonical: 'GREEN', bytes: [0x1e], aliases: ['GRN'] },
  { canonical: 'BLUE', bytes: [0x1f], aliases: ['BLU'] },
  { canonical: 'YELLOW', bytes: [0x9e], aliases: ['YEL'] },
  { canonical: 'ORANGE', bytes: [0x81], aliases: ['ORNG'] },
  { canonical: 'BROWN', bytes: [0x95], aliases: ['BRN'] },
  { canonical: 'LIGHT RED', bytes: [0x96], aliases: ['LRED', 'PINK', 'LT RED'] },
  { canonical: 'DARK GRAY', bytes: [0x97], aliases: ['DARK GREY', 'GRAY1', 'GREY1', 'GRY1'] },
  { canonical: 'GRAY', bytes: [0x98], aliases: ['GREY', 'GRAY2', 'GREY2', 'GRY2', 'MEDIUM GRAY', 'MEDIUM GREY'] },
  { canonical: 'LIGHT GREEN', bytes: [0x99], aliases: ['LGRN', 'LT GREEN'] },
  { canonical: 'LIGHT BLUE', bytes: [0x9a], aliases: ['LBLU', 'LT BLUE'] },
  { canonical: 'LIGHT GRAY', bytes: [0x9b], aliases: ['LIGHT GREY', 'GRAY3', 'GREY3', 'GRY3'] },
  { canonical: 'F1', bytes: [0x85], aliases: [] },
  { canonical: 'F2', bytes: [0x89], aliases: [] },
  { canonical: 'F3', bytes: [0x86], aliases: [] },
  { canonical: 'F4', bytes: [0x8a], aliases: [] },
  { canonical: 'F5', bytes: [0x87], aliases: [] },
  { canonical: 'F6', bytes: [0x8b], aliases: [] },
  { canonical: 'F7', bytes: [0x88], aliases: [] },
  { canonical: 'F8', bytes: [0x8c], aliases: [] },
  { canonical: 'STOP', bytes: [0x03], aliases: ['RUN STOP', 'RUNSTOP'] },
  { canonical: 'LOWER', bytes: [0x0e], aliases: ['LOWERCASE', 'SWLC'] },
  { canonical: 'UPPER', bytes: [0x8e], aliases: ['UPPERCASE', 'SWUC'] },
  { canonical: 'POUND', bytes: [0x5c], aliases: ['GBP', 'UK POUND'] },
  { canonical: 'UP ARROW', bytes: [0x5e], aliases: ['ARROW UP'] },
  { canonical: 'LEFT ARROW', bytes: [0x5f], aliases: ['ARROW LEFT', 'BACK ARROW'] },
  { canonical: 'PI', bytes: [0xff], aliases: [] },
] as const;

const PETSCII_TOKEN_MAP = new Map<string, PetsciiTokenDefinition>();
for (const definition of PETSCII_TOKEN_DEFINITIONS) {
  PETSCII_TOKEN_MAP.set(definition.canonical, definition);
  for (const alias of definition.aliases) {
    PETSCII_TOKEN_MAP.set(alias, definition);
  }
}

const SCREEN_CODE_TOKEN_MAP = new Map<number, string>();
for (const definition of PETSCII_TOKEN_DEFINITIONS) {
  for (const byte of definition.bytes) {
    const screenCode = petsciiToScreenCode(byte);
    if (!SCREEN_CODE_TOKEN_MAP.has(screenCode)) {
      SCREEN_CODE_TOKEN_MAP.set(screenCode, `<${definition.canonical}>`);
    }
  }
}

const DIRECT_PETSCII_CHAR_BYTES = new Map<string, number>([
  ['£', 0x5c],
  ['↑', 0x5e],
  ['←', 0x5f],
  ['π', 0xff],
  ['Π', 0xff],
]);

type ResolvedPetsciiKey = {
  canonical: string;
  bytes: Uint8Array;
};

function normalizePetsciiTokenName(token: string): string {
  return token.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
}

function lookupPetsciiToken(token: string): PetsciiTokenDefinition {
  const normalized = normalizePetsciiTokenName(token);
  const definition = PETSCII_TOKEN_MAP.get(normalized);
  if (!definition) {
    unsupportedError('Requested keyboard token is not representable through PETSCII keyboard-buffer input.', {
      token,
      normalizedToken: normalized,
    });
  }
  return definition;
}

function encodeLiteralPetsciiChar(char: string): number {
  if (char === '\n' || char === '\r') {
    return 0x0d;
  }

  if (char === '\t') {
    return 0x20;
  }

  const direct = DIRECT_PETSCII_CHAR_BYTES.get(char);
  if (direct != null) {
    return direct;
  }

  const code = char.codePointAt(0);
  if (code == null) {
    validationError('write_text received an empty character while encoding PETSCII');
  }

  if (code >= 0x61 && code <= 0x7a) {
    return code - 0x20;
  }

  if (code >= 0x20 && code <= 0x5d) {
    return code;
  }

  validationError('write_text only supports characters representable in the supported PETSCII subset', {
    character: char,
    codePoint: code,
  });
}

function decodeWriteTextToPetscii(input: string): Uint8Array {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (char === '\\') {
      const next = input[index + 1];
      if (next == null) {
        validationError('write_text received a trailing backslash escape with no character after it');
      }

      switch (next) {
        case 'n':
          bytes.push(0x0d);
          break;
        case 'r':
          bytes.push(0x0d);
          break;
        case 't':
          bytes.push(0x20);
          break;
        case '\\':
          bytes.push(encodeLiteralPetsciiChar('\\'));
          break;
        case '"':
          bytes.push(encodeLiteralPetsciiChar('"'));
          break;
        case "'":
          bytes.push(encodeLiteralPetsciiChar("'"));
          break;
        default:
          validationError('write_text received an unsupported escape sequence', {
            escape: `\\${next}`,
          });
      }

      index += 1;
      continue;
    }

    if (char === '{') {
      const end = input.indexOf('}', index + 1);
      if (end === -1) {
        validationError('write_text received an opening brace without a closing brace', {
          position: index,
        });
      }

      const rawToken = input.slice(index + 1, end);
      if (!rawToken.trim()) {
        validationError('write_text received an empty brace token', {
          position: index,
        });
      }

      const definition = lookupPetsciiToken(rawToken);
      bytes.push(...definition.bytes);
      index = end;
      continue;
    }

    bytes.push(encodeLiteralPetsciiChar(char));
  }

  return Uint8Array.from(bytes);
}

function resolveKeyboardInputKey(key: string): ResolvedPetsciiKey {
  const trimmed = key.trim();
  if (!trimmed) {
    validationError('keyboard_input requires a non-empty key name');
  }

  if (trimmed.length === 1) {
    return {
      canonical: normalizePetsciiTokenName(trimmed),
      bytes: Uint8Array.from([encodeLiteralPetsciiChar(trimmed)]),
    };
  }

  const definition = lookupPetsciiToken(trimmed);
  return {
    canonical: definition.canonical,
    bytes: Uint8Array.from(definition.bytes),
  };
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
const VICE_PROCESS_LOG_PATH = path.join(os.tmpdir(), 'c64-debug-mcp-x64sc.log');
const DISPLAY_CAPTURE_DIR = path.resolve(process.cwd(), '.vice-debug-mcp-artifacts');
const CLEANUP_ENABLED = !/^(0|false|no|off)$/i.test(process.env.C64_CLEANUP_SCREENSHOTS ?? '');
const CLEANUP_MAX_AGE_MINUTES = Number.parseInt(process.env.C64_CLEANUP_MAX_AGE_MINUTES ?? '20', 10);
const MIRROR_EMULATOR_LOGS_TO_STDERR = /^(1|true|yes|on)$/i.test(process.env.C64_DEBUG_CONSOLE_LOGS ?? '');
const EXECUTION_EVENT_WAIT_MS = 1000;
const EXECUTION_SETTLE_DELAY_MS = 2000;
const BOOTSTRAP_INITIAL_DELAY_MS = 2000;
const BOOTSTRAP_SETTLE_TIMEOUT_MS = 15000;
const BOOTSTRAP_POLL_MS = 250;
const BOOTSTRAP_RUNNING_STABLE_MS = 3000;
const BOOTSTRAP_RESUME_COOLDOWN_MS = 500;
const PROGRAM_LOAD_SETTLE_TIMEOUT_MS = 15000;
const PROGRAM_LOAD_SETTLE_POLL_MS = 250;
const PROGRAM_LOAD_RUNNING_STABLE_MS = 3000;
const PROGRAM_LOAD_RESUME_COOLDOWN_MS = 500;
const DISPLAY_SETTLE_TIMEOUT_MS = 5000;
const DISPLAY_SETTLE_POLL_MS = 100;
const DISPLAY_PAUSE_TIMEOUT_MS = 5000;
const DISPLAY_RUNNING_STABLE_MS = 750;
const MAX_WRITE_TEXT_BYTES = 64;
const DISPLAY_RESUME_COOLDOWN_MS = 250;
const INPUT_SETTLE_TIMEOUT_MS = 5000;
const INPUT_SETTLE_POLL_MS = 100;
const INPUT_RUNNING_STABLE_MS = 750;
const INPUT_RESUME_COOLDOWN_MS = 250;
const CHECKPOINT_HIT_SETTLE_MS = 1000;
const STOPPED_IDLE_TIMEOUT_MS = 20_000;
const MIN_TAP_DURATION_MS = 10;
const MAX_TAP_DURATION_MS = 10000;
const RESET_GRACE_PERIOD_MS = 150;

function clampTapDuration(durationMs: number | undefined): number {
  if (durationMs == null) {
    return DEFAULT_INPUT_TAP_MS;
  }
  if (!Number.isInteger(durationMs)) {
    validationError('durationMs must be an integer', { durationMs });
  }
  // Clamp to reasonable range instead of throwing
  return Math.max(MIN_TAP_DURATION_MS, Math.min(MAX_TAP_DURATION_MS, durationMs));
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

type MonitorState = {
  executionState: SessionState['executionState'];
  lastStopReason: StopReason;
  runtimeKnown: boolean;
  programCounter: number | null;
};

type CheckpointHitState = {
  id: number;
  kind: BreakpointKind;
  observedAt: number;
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
  #process: ChildProcess | null = null;
  #processLogStream: WriteStream | null = null;
  #stdoutMirrorBuffer = '';
  #stderrMirrorBuffer = '';
  #warnings: WarningItem[] = [];
  #lastExecutionIntent: StopReason = 'unknown';
  #lastRegisters: C64RegisterValues | null = null;
  #lastRuntimeEventType: MonitorRuntimeEventType = 'unknown';
  #lastRuntimeProgramCounter: number | null = null;
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
  #stoppedAt: number | null = null;
  #autoResumeTimer: NodeJS.Timeout | null = null;
  #explicitPauseActive = false;
  #pendingCheckpointHit: CheckpointHitState | null = null;
  #lastCheckpointHit: CheckpointHitState | null = null;
  #checkpointQueryPending = false;
  #executionOperationLock: Promise<void> | null = null;
  #displayOperationLock: Promise<void> | null = null;

  constructor(portAllocator = new PortAllocator()) {
    this.#portAllocator = portAllocator;
    void this.#cleanupOldScreenshots();
    this.#client.on('response', (response) => {
      this.#lastResponseAt = nowIso();
      this.#writeProcessLogLine(`[monitor-response] type=${response.type} requestId=${response.requestId} errorCode=${response.errorCode}`);
    });
    this.#client.on('close', () => {
      this.#writeProcessLogLine('[monitor-close] debugger connection closed');
      if (this.#transportState !== 'stopped') {
        this.#transportState = 'disconnected';
      }
      this.#syncMonitorRuntimeState();
      if (!this.#suppressRecovery && !this.#shuttingDown && this.#config) {
        void this.#scheduleRecovery();
      }
    });
    this.#client.on('event', (event) => {
      if (event.type === 'checkpoint_info' && event.checkpoint.currentlyHit) {
        this.#pendingCheckpointHit = {
          id: event.checkpoint.id,
          kind: event.checkpoint.kind,
          observedAt: Date.now(),
        };
      }
      const programCounter = 'programCounter' in event && typeof event.programCounter === 'number' ? event.programCounter : null;
      this.#writeProcessLogLine(
        `[monitor-event] type=${event.type}${programCounter == null ? '' : ` pc=$${programCounter.toString(16).padStart(4, '0')}`}`,
      );
      this.#syncMonitorRuntimeState();
    });
  }

  snapshot(): SessionState {
    return {
      transportState: this.#transportState,
      processState: this.#processState,
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      idleAutoResumeArmed: this.#autoResumeTimer != null,
      explicitPauseActive: this.#explicitPauseActive,
      lastCheckpointId: this.#lastCheckpointHit?.id ?? null,
      lastCheckpointKind: this.#lastCheckpointHit?.kind ?? null,
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

  async getMonitorState(): Promise<MonitorState> {
    await this.#ensureReady();
    this.#syncMonitorRuntimeState();
    const runtime = this.#client.runtimeState();
    return {
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      runtimeKnown: runtime.runtimeKnown,
      programCounter: runtime.programCounter,
    };
  }

  async getRegisters(): Promise<{ registers: C64RegisterValues }> {
    await this.#ensurePausedForDebug('get_registers');
    return {
      registers: await this.#readRegisters(),
    };
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;
    this.#clearIdleAutoResume();
    this.#suppressRecovery = true;
    this.#config = null;
    this.#recoveryPromise = null;
    this.#recoveryInProgress = false;
    this.#freshEmulatorPending = false;
    this.#clearHeldInputState();
    this.#breakpointLabels.clear();

    try {
      await this.#resumeBeforeShutdown();
      await this.#stopManagedProcess(true);
    } finally {
      this.#transportState = 'stopped';
      this.#processState = 'not_applicable';
      this.#executionState = 'unknown';
      this.#lastStopReason = 'none';
      this.#explicitPauseActive = false;
      this.#pendingCheckpointHit = null;
      this.#lastCheckpointHit = null;
      this.#lastRuntimeEventType = 'unknown';
      this.#lastRuntimeProgramCounter = null;
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

  async execute(
    action: 'pause' | 'resume' | 'step' | 'step_over' | 'step_out' | 'reset',
    count = 1,
    resetMode: 'soft' | 'hard' = 'soft',
    waitUntilRunningStable = false,
  ) {
    switch (action) {
      case 'pause':
        return await this.pauseExecution();
      case 'resume':
        return await this.continueExecution(waitUntilRunningStable);
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
    await this.#ensurePausedForDebug('set_registers');
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
    await this.#ensureReady();
    this.#validateRange(start, end);
    const response = await this.#client.readMemory(start, end, bank);
    return {
      length: response.bytes.length,
      data: Array.from(response.bytes),
    };
  }

  async writeMemory(start: number, data: number[], bank = 0) {
    await this.#ensurePausedForDebug('memory_write');
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

  async pauseExecution() {
    return this.#withExecutionLock(async () => {
      await this.#ensureReady();
      this.#syncMonitorRuntimeState();

      if (this.#executionState === 'stopped') {
        this.#explicitPauseActive = true;
        const debugState = await this.#readDebugState();
        return {
          executionState: debugState.executionState,
          lastStopReason: debugState.lastStopReason,
          programCounter: debugState.programCounter,
          registers: debugState.registers,
          warnings: [] as WarningItem[],
        };
      }

      if (this.#executionState !== 'running') {
        emulatorNotRunningError('execute pause', {
          executionState: this.#executionState,
          lastStopReason: this.#lastStopReason,
        });
      }

      this.#explicitPauseActive = true;
      this.#lastExecutionIntent = 'monitor_entry';
      this.#writeProcessLogLine('[tx] execute pause');
      await this.#client.ping();
      const paused = await this.waitForState('stopped', 5000, 0);
      if (!paused.reachedTarget) {
        throw new ViceMcpError('pause_timeout', 'execute pause could not reach a stopped state before timeout.', 'timeout', true, {
          executionState: paused.executionState,
          lastStopReason: paused.lastStopReason,
        });
      }
      const debugState = await this.#readDebugState();
      return {
        executionState: debugState.executionState,
        lastStopReason: debugState.lastStopReason,
        programCounter: debugState.programCounter,
        registers: debugState.registers,
        warnings: [] as WarningItem[],
      };
    });
  }

  async continueExecution(waitUntilRunningStable = false) {
    return this.#withExecutionLock(async () => {
      await this.#ensureReady();
      if (this.#executionState !== 'stopped') {
        debuggerNotPausedError('execute resume', {
          executionState: this.#executionState,
          lastStopReason: this.#lastStopReason,
        });
      }
      const debugState = this.#lastRegisters == null ? await this.#readDebugState() : this.#buildDebugState(this.#lastRegisters);
      this.#lastExecutionIntent = 'unknown';
      this.#writeProcessLogLine('[tx] execute resume');

      // Wait for execution event to confirm resume
      const executionEvent = this.#waitForExecutionEvent(1000);
      await this.#client.continueExecution();
      const event = await executionEvent;

      if (!event || event.type !== 'resumed') {
        this.#writeProcessLogLine(`[execute-resume] no resumed event within 1000ms (got ${event?.type ?? 'nothing'})`);
      }

      if (waitUntilRunningStable) {
        await this.waitForState('running', 5000, INPUT_RUNNING_STABLE_MS);
      } else {
        this.#syncMonitorRuntimeState();
      }

      // Clear explicit pause flag AFTER successful resume and state sync
      this.#explicitPauseActive = false;

      const runtime = this.#client.runtimeState();
      const warnings: WarningItem[] = [];

      // After syncMonitorRuntimeState or waitForState, execution state may have changed
      // TypeScript doesn't track mutations through method calls, so we read the current value
      const currentExecutionState = this.#executionState as ExecutionState;
      if (!waitUntilRunningStable && currentExecutionState !== 'running') {
        warnings.push(
          makeWarning('Resume acknowledged but state transition not yet confirmed; use wait_for_state for authoritative state.', 'resume_async'),
        );
      }

      return {
        executionState: currentExecutionState,
        lastStopReason: this.#lastStopReason,
        programCounter: runtime.programCounter ?? debugState.programCounter,
        registers: debugState.registers,
        warnings,
      };
    });
  }

  async stepInstruction(count = 1, stepOver = false) {
    await this.#ensurePausedForDebug(stepOver ? 'execute step_over' : 'execute step');
    this.#lastExecutionIntent = 'step_complete';
    this.#writeProcessLogLine(`[tx] ${stepOver ? 'execute step_over' : 'execute step'} count=${count}`);
    await this.#client.stepInstruction(count, stepOver);
    this.#syncMonitorRuntimeState();
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
    await this.#ensurePausedForDebug('execute step_out');
    this.#lastExecutionIntent = 'step_complete';
    this.#writeProcessLogLine('[tx] execute step_out');
    await this.#client.stepOut();
    this.#syncMonitorRuntimeState();
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
    return this.#withExecutionLock(async () => {
      await this.#ensureReady();
      // Save pause intent before reset
      const wasPaused = this.#explicitPauseActive;
      this.#lastExecutionIntent = 'reset';
      this.#writeProcessLogLine(`[tx] execute reset mode=${mode}`);
      await this.#client.reset(mode);

      // Grace period: let emulator settle before continuing
      await sleep(RESET_GRACE_PERIOD_MS);

      // Restore pause intent
      this.#explicitPauseActive = wasPaused;

      // Double sync to ensure state is truly stable
      this.#syncMonitorRuntimeState();
      await sleep(50);
      this.#syncMonitorRuntimeState();

      const debugState = await this.#readDebugState();
      return {
        executionState: debugState.executionState,
        lastStopReason: debugState.lastStopReason,
        programCounter: debugState.programCounter,
        registers: debugState.registers,
        warnings: [] as WarningItem[],
      };
    });
  }

  async listBreakpoints(includeDisabled = true) {
    await this.#ensureReady();
    this.#writeProcessLogLine(`[tx] breakpoint_list includeDisabled=${includeDisabled}`);
    const response = await this.#client.listBreakpoints();
    this.#pruneBreakpointLabels(response.checkpoints.map((breakpoint) => breakpoint.id));
    return {
      breakpoints: response.checkpoints
        .filter((breakpoint) => (includeDisabled ? true : breakpoint.enabled))
        .map((breakpoint) => this.#attachBreakpointLabel(breakpoint)),
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
    await this.#ensureReady();
    this.#writeProcessLogLine(
      `[tx] breakpoint_set kind=${options.kind} start=$${options.start.toString(16).padStart(4, '0')}${options.end == null ? '' : ` end=$${options.end.toString(16).padStart(4, '0')}`}${options.temporary ? ' temporary=true' : ''}${options.enabled === false ? ' enabled=false' : ''}`,
    );
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
    return {
      breakpoint: this.#attachBreakpointLabel(response.checkpoint),
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      programCounter: this.#lastRegisters?.PC ?? null,
      registers: this.#lastRegisters,
    };
  }

  async deleteBreakpoint(breakpointId: number) {
    await this.#ensureReady();
    this.#writeProcessLogLine(`[tx] breakpoint_clear id=${breakpointId}`);
    try {
      await this.#client.deleteBreakpoint(breakpointId);
    } catch (error) {
      if (
        error instanceof ViceMcpError &&
        error.code === 'emulator_protocol_error' &&
        error.details?.emulatorErrorCode === 0x01
      ) {
        return {
          cleared: false,
          breakpointId,
          executionState: this.#executionState,
          lastStopReason: this.#lastStopReason,
          programCounter: this.#lastRegisters?.PC ?? null,
          registers: this.#lastRegisters,
        };
      }
      throw error;
    }
    this.#breakpointLabels.delete(breakpointId);
    return {
      cleared: true,
      breakpointId,
      executionState: this.#executionState,
      lastStopReason: this.#lastStopReason,
      programCounter: this.#lastRegisters?.PC ?? null,
      registers: this.#lastRegisters,
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

  async programLoad(options: {
    filePath: string;
    autoStart?: boolean;
    fileIndex?: number;
  }) {
    const filePath = path.resolve(options.filePath);
    await this.#assertReadableProgramFile(filePath);
    await this.#ensureRunning('program_load');
    this.#explicitPauseActive = false;

    const result = await this.autostartProgram(filePath, options.autoStart ?? true, options.fileIndex ?? 0);
    return {
      filePath: result.filePath,
      autoStart: result.autoStart,
      fileIndex: result.fileIndex,
      executionState: result.executionState,
    };
  }

  async captureDisplay(useVic = true) {
    return this.#withDisplayLock(async () => {
      await this.#ensureReady();
      this.#syncMonitorRuntimeState();
      const previousExecutionState = this.#executionState;
      this.#writeProcessLogLine(`[tx] capture_display useVic=${useVic}`);

      const display = await this.#client.captureDisplay(useVic);
      const palette = await this.#client.getPalette(useVic);

      if (display.bitsPerPixel !== 8) {
        throw new ViceMcpError(
          'display_bpp_unsupported',
          `capture_display only supports 8-bit indexed display payloads, got ${display.bitsPerPixel}.`,
          'unsupported',
          false,
          { bitsPerPixel: display.bitsPerPixel },
        );
      }

      const expectedLength = display.debugWidth * display.debugHeight;
      if (display.imageBytes.length !== expectedLength) {
        throw new ViceMcpError(
          'display_payload_invalid',
          'capture_display received a display payload whose length does not match the reported debug dimensions.',
          'protocol',
          false,
          {
            debugWidth: display.debugWidth,
            debugHeight: display.debugHeight,
            expectedLength,
            actualLength: display.imageBytes.length,
          },
        );
      }

      if (palette.items.length === 0) {
        throw new ViceMcpError('display_palette_missing', 'capture_display received an empty display palette.', 'protocol', false);
      }

      if (
        display.debugOffsetX + display.innerWidth > display.debugWidth ||
        display.debugOffsetY + display.innerHeight > display.debugHeight
      ) {
        throw new ViceMcpError(
          'display_crop_invalid',
          'capture_display received crop geometry outside the display buffer bounds.',
          'protocol',
          false,
          {
            debugWidth: display.debugWidth,
            debugHeight: display.debugHeight,
            debugOffsetX: display.debugOffsetX,
            debugOffsetY: display.debugOffsetY,
            innerWidth: display.innerWidth,
            innerHeight: display.innerHeight,
          },
        );
      }

      const rgbPixels = new Uint8Array(display.innerWidth * display.innerHeight * 3);
      for (let y = 0; y < display.innerHeight; y += 1) {
        for (let x = 0; x < display.innerWidth; x += 1) {
          const sourceX = display.debugOffsetX + x;
          const sourceY = display.debugOffsetY + y;
          const sourceIndex = sourceY * display.debugWidth + sourceX;
          const paletteIndex = display.imageBytes[sourceIndex]!;
          const color = palette.items[paletteIndex];
          if (!color) {
            throw new ViceMcpError(
              'display_palette_index_invalid',
              'capture_display encountered a pixel index that is outside the current palette.',
              'protocol',
              false,
              { paletteIndex, paletteSize: palette.items.length },
            );
          }
          const targetIndex = (y * display.innerWidth + x) * 3;
          rgbPixels[targetIndex] = color.red;
          rgbPixels[targetIndex + 1] = color.green;
          rgbPixels[targetIndex + 2] = color.blue;
        }
      }

      await fs.mkdir(DISPLAY_CAPTURE_DIR, { recursive: true });
      const imagePath = path.join(DISPLAY_CAPTURE_DIR, `capture-${Date.now()}-${process.pid}.png`);
      await fs.writeFile(imagePath, encodePngRgb(display.innerWidth, display.innerHeight, rgbPixels));
      await this.#settleDisplayToolState('capture_display', previousExecutionState);

      return {
        imagePath,
        width: display.innerWidth,
        height: display.innerHeight,
        debugWidth: display.debugWidth,
        debugHeight: display.debugHeight,
        debugOffsetX: display.debugOffsetX,
        debugOffsetY: display.debugOffsetY,
        bitsPerPixel: display.bitsPerPixel,
      };
    });
  }

  async getDisplayState() {
    await this.#ensureReady();
    this.#syncMonitorRuntimeState();
    const previousExecutionState = this.#executionState;
    await this.#pauseForDisplayInspection('get_display_state', previousExecutionState);

    try {
      this.#writeProcessLogLine('[tx] get_display_state');

      const vicPrimary = await this.#client.readMemory(0xd011, 0xd018, 0);
      const cia2Bank = await this.#client.readMemory(0xdd00, 0xdd00, 0);
      const colors = await this.#client.readMemory(0xd020, 0xd024, 0);

      const d011 = vicPrimary.bytes[0] ?? 0;
      const d016 = vicPrimary.bytes[5] ?? 0;
      const d018 = vicPrimary.bytes[7] ?? 0;
      const dd00 = cia2Bank.bytes[0] ?? 0;
      const d020 = colors.bytes[0] ?? 0;
      const d021 = colors.bytes[1] ?? 0;
      const d022 = colors.bytes[2] ?? 0;
      const d023 = colors.bytes[3] ?? 0;
      const d024 = colors.bytes[4] ?? 0;

      const vicBankAddress = decodeVicBankAddress(dd00);
      const screenRamAddress = vicBankAddress + (((d018 >> 4) & 0x0f) * 0x0400);
      const characterMemoryAddress = vicBankAddress + (((d018 >> 1) & 0x07) * 0x0800);
      const bitmapMemoryAddress = vicBankAddress + (((d018 >> 3) & 0x01) * 0x2000);
      const { graphicsMode, extendedColorMode, bitmapMode, multicolorMode } = decodeGraphicsMode(d011, d016);

      const screenRam = await this.#client.readMemory(screenRamAddress, screenRamAddress + 999, 0);
      const colorRam = await this.#client.readMemory(0xd800, 0xd800 + 999, 0);

      return {
        graphicsMode,
        extendedColorMode,
        bitmapMode,
        multicolorMode,
        vicBankAddress,
        screenRamAddress,
        characterMemoryAddress: bitmapMode ? null : characterMemoryAddress,
        bitmapMemoryAddress: bitmapMode ? bitmapMemoryAddress : null,
        colorRamAddress: 0xd800,
        borderColor: lowNibble(d020),
        backgroundColor0: lowNibble(d021),
        backgroundColor1: lowNibble(d022),
        backgroundColor2: lowNibble(d023),
        backgroundColor3: lowNibble(d024),
        vicRegisters: {
          d011,
          d016,
          d018,
          dd00,
          d020,
          d021,
          d022,
          d023,
          d024,
        },
        screenRam: Array.from(screenRam.bytes),
        colorRam: Array.from(colorRam.bytes, (value) => lowNibble(value)),
      };
    } finally {
      await this.#settleDisplayToolState('get_display_state', previousExecutionState);
    }
  }

  async getDisplayText() {
    let displayState = await this.getDisplayState();
    if (displayState.screenRamAddress === 0 && displayState.graphicsMode === 'standard_text') {
      this.#writeProcessLogLine('[display] screen RAM address still zero in text mode, retrying display state after short settle');
      await sleep(250);
      displayState = await this.getDisplayState();
    }
    if (!isTextGraphicsMode(displayState.graphicsMode)) {
      unsupportedError('get_display_text is only available when the current graphics mode is a text mode.', {
        graphicsMode: displayState.graphicsMode,
      });
    }

    const columns = 40;
    const rows = 25;
    let hasDetailedTokens = false;
    const textLines = Array.from({ length: rows }, (_, row) => {
      const start = row * columns;
      return displayState.screenRam
        .slice(start, start + columns)
        .map((code) => {
          const decoded = decodeScreenCodeCell(code);
          hasDetailedTokens ||= decoded.lossy;
          return decoded.ascii;
        })
        .join('')
        .replace(/\s+$/, '');
    });
    const tokenLines = hasDetailedTokens
      ? Array.from({ length: rows }, (_, row) => {
          const start = row * columns;
          return displayState.screenRam
            .slice(start, start + columns)
            .map((code) => {
              const decoded = decodeScreenCodeCell(code);
              return decoded.token ?? decoded.ascii;
            })
            .join('')
            .replace(/\s+$/, '');
        })
      : undefined;

    return {
      graphicsMode: displayState.graphicsMode,
      textMode: true,
      lossy: hasDetailedTokens,
      columns,
      rows,
      screenRamAddress: displayState.screenRamAddress,
      textLines,
      ...(tokenLines ? { tokenLines } : {}),
    };
  }

  async autostartProgram(filePath: string, autoStart = true, fileIndex = 0) {
    await this.#ensureReady();
    const absolutePath = path.resolve(filePath);
    const previousExecutionState = this.#executionState;
    const previousStopReason = this.#lastStopReason;
    const executionEvent = this.#waitForExecutionEvent(EXECUTION_EVENT_WAIT_MS);

    this.#lastExecutionIntent = autoStart ? 'none' : 'monitor_entry';

    try {
      this.#writeProcessLogLine(`[tx] program_load filePath=${absolutePath} autoStart=${autoStart} fileIndex=${fileIndex}`);
      await this.#client.autostartProgram(absolutePath, autoStart, fileIndex);
    } catch (error) {
      const event = await executionEvent;
      const accepted = this.#autostartWasAcceptedAfterError(error, event, previousExecutionState, previousStopReason);
      if (!accepted) {
        throw error;
      }
    }

    const event = await executionEvent;
    if (event) {
    } else {
      this.#writeProcessLogLine(
        `[autostart] no runtime event observed within ${EXECUTION_EVENT_WAIT_MS}ms, waiting ${EXECUTION_SETTLE_DELAY_MS}ms for emulator settle`,
      );
      await sleep(EXECUTION_SETTLE_DELAY_MS);
    }
    await this.#settleProgramLoadState(autoStart);

    return {
      filePath: absolutePath,
      autoStart,
      fileIndex,
      executionState: this.#executionState,
    };
  }

  async #assertReadableProgramFile(filePath: string): Promise<void> {
    let stats;
    try {
      await fs.access(filePath);
      stats = await fs.stat(filePath);
    } catch (error) {
      throw new ViceMcpError('program_file_missing', `Program file does not exist or is not readable: ${filePath}`, 'io', false, {
        filePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!stats.isFile()) {
      throw new ViceMcpError('program_file_invalid', `Program path is not a regular file: ${filePath}`, 'io', false, {
        filePath,
      });
    }
  }

  async writeText(text: string) {
    await this.#ensureRunning('write_text');
    const encoded = decodeWriteTextToPetscii(text);
    if (encoded.length > MAX_WRITE_TEXT_BYTES) {
      validationError('write_text exceeds the maximum allowed byte length for one request', {
        length: encoded.length,
        max: MAX_WRITE_TEXT_BYTES,
      });
    }
    this.#writeProcessLogLine(`[tx] write_text length=${encoded.length} text=${JSON.stringify(text)}`);
    await this.#client.sendKeys(Buffer.from(encoded).toString('binary'));
    await this.#settleInputState('write_text', 'running');
    return {
      sent: true,
      length: encoded.length,
    };
  }

  async keyboardInput(action: InputAction, keys: string[], durationMs?: number) {
    await this.#ensureRunning('keyboard_input');
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 4) {
      validationError('keyboard_input requires between 1 and 4 keys', { keys });
    }

    const resolvedKeys = keys.map((key) => resolveKeyboardInputKey(key));
    const normalizedKeys = resolvedKeys.map((key) => key.canonical);
    this.#writeProcessLogLine(
      `[tx] keyboard_input action=${action} keys=${normalizedKeys.join(',')}${durationMs == null ? '' : ` durationMs=${durationMs}`}`,
    );

    switch (action) {
      case 'tap': {
        const duration = clampTapDuration(durationMs);
        const bytes = Uint8Array.from(resolvedKeys.flatMap((key) => Array.from(key.bytes)));
        await this.#client.sendKeys(Buffer.from(bytes).toString('binary'));
        await this.#settleInputState('keyboard_input', 'running');
        await sleep(duration);
        return {
          action,
          keys: normalizedKeys,
          applied: true,
          held: false,
          mode: 'buffered_text' as const,
        };
      }
      case 'press': {
        const singleByteKeys = resolvedKeys.map((key) => {
          if (key.bytes.length !== 1) {
            unsupportedError('keyboard_input press/release only supports keys that map to a single PETSCII byte.', {
              key: key.canonical,
            });
          }
          return key.bytes[0]!;
        });
        for (let index = 0; index < normalizedKeys.length; index += 1) {
          const heldKey = normalizedKeys[index]!;
          const byte = singleByteKeys[index]!;
          if (!this.#heldKeyboardIntervals.has(heldKey)) {
            await this.#client.sendKeys(Buffer.from([byte]).toString('binary'));
            await this.#settleInputState('keyboard_input', 'running');
            const interval = setInterval(() => {
              void this.#client
                .sendKeys(Buffer.from([byte]).toString('binary'))
                .then(() => this.#settleInputState('keyboard_input', 'running'))
                .catch(() => undefined);
            }, DEFAULT_KEYBOARD_REPEAT_MS);
            this.#heldKeyboardIntervals.set(heldKey, interval);
          }
        }
        return {
          action,
          keys: normalizedKeys,
          applied: true,
          held: true,
          mode: 'buffered_text_repeat' as const,
        };
      }
      case 'release': {
        for (const key of resolvedKeys) {
          if (key.bytes.length !== 1) {
            unsupportedError('keyboard_input press/release only supports keys that map to a single PETSCII byte.', {
              key: key.canonical,
            });
          }
        }
        for (const heldKey of normalizedKeys) {
          const interval = this.#heldKeyboardIntervals.get(heldKey);
          if (interval) {
            clearInterval(interval);
            this.#heldKeyboardIntervals.delete(heldKey);
          }
        }
        return {
          action,
          keys: normalizedKeys,
          applied: true,
          held: false,
          mode: 'buffered_text_repeat' as const,
        };
      }
    }
  }

  async joystickInput(port: JoystickPort, action: InputAction, control: JoystickControl, durationMs?: number) {
    await this.#ensureRunning('joystick_input');
    const previousExecutionState = this.#executionState;
    const bit = JOYSTICK_CONTROL_BITS[control];
    if (bit == null) {
      validationError('Unsupported joystick control', { control });
    }
    this.#writeProcessLogLine(
      `[tx] joystick_input port=${port} action=${action} control=${control}${durationMs == null ? '' : ` durationMs=${durationMs}`}`,
    );

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
    await this.#settleInputState('joystick_input', previousExecutionState);

    return {
      port,
      action,
      control,
      applied: true,
      state: this.#describeJoystickState(port),
    };
  }

  async waitForState(
    targetState: Extract<SessionState['executionState'], 'running' | 'stopped'>,
    timeoutMs = 5000,
    stableMs = targetState === 'running' ? INPUT_RUNNING_STABLE_MS : 0,
  ) {
    await this.#ensureReady();
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let matchingSince: number | null = null;

    while (true) {
      this.#syncMonitorRuntimeState();
      if (this.#executionState === targetState) {
        matchingSince ??= Date.now();
        if (Date.now() - matchingSince >= stableMs) {
          const runtime = this.#client.runtimeState();
          return {
            executionState: this.#executionState,
            lastStopReason: this.#lastStopReason,
            runtimeKnown: runtime.runtimeKnown,
            programCounter: runtime.programCounter,
            reachedTarget: true,
            waitedMs: Date.now() - startedAt,
          };
        }
      } else {
        matchingSince = null;
      }

      if (Date.now() >= deadline) {
        const runtime = this.#client.runtimeState();
        return {
          executionState: this.#executionState,
          lastStopReason: this.#lastStopReason,
          runtimeKnown: runtime.runtimeKnown,
          programCounter: runtime.programCounter,
          reachedTarget: false,
          waitedMs: Date.now() - startedAt,
        };
      }

      await sleep(INPUT_SETTLE_POLL_MS);
    }
  }

  async #ensureReady(): Promise<void> {
    this.#ensureConfig();
    await this.#ensureHealthyConnection();
  }

  async #ensurePausedForDebug(commandName: string): Promise<void> {
    await this.#ensureReady();
    this.#syncMonitorRuntimeState();
    if (this.#executionState !== 'stopped') {
      debuggerNotPausedError(commandName, {
        executionState: this.#executionState,
        lastStopReason: this.#lastStopReason,
      });
    }
  }

  async #ensureRunning(commandName: string): Promise<void> {
    await this.#ensureReady();
    this.#syncMonitorRuntimeState();
    if (this.#executionState !== 'running') {
      emulatorNotRunningError(commandName, {
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
      this.#syncMonitorRuntimeState();
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

    // Check if binary exists before attempting to spawn
    const binaryCheck = await checkBinaryExists(binary);
    if (!binaryCheck.exists) {
      throw new ViceMcpError(
        'binary_not_found',
        `VICE emulator binary '${binary}' not found. Please install VICE or configure the correct path using the 'binaryPath' setting.`,
        'process_launch',
        false,
        { binary, searchedPath: process.env.PATH }
      );
    }

    const args = ['-autostartprgmode', '1', '-binarymonitor', '-binarymonitoraddress', `${host}:${port}`];
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
    this.#explicitPauseActive = false;
    this.#pendingCheckpointHit = null;
    this.#lastCheckpointHit = null;
    this.#lastRuntimeEventType = 'unknown';
    this.#lastRuntimeProgramCounter = null;

    const env = await buildViceLaunchEnv();

    let spawnError: Error | undefined = undefined;
    const child = spawn(binary, args, {
      cwd: config.workingDirectory ? path.resolve(config.workingDirectory) : undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Capture spawn errors immediately
    child.once('error', (err: Error) => {
      spawnError = err;
    });

    this.#process = child;
    this.#attachProcessLogging(child, binary, args);
    this.#bindProcessLifecycle(child);

    this.#processState = 'running';
    this.#transportState = 'waiting_for_monitor';

    try {
      await waitForMonitor(host, port, 5000);

      // Check if spawn failed while we were waiting
      if (spawnError !== undefined) {
        throw new ViceMcpError(
          'spawn_failed',
          `Failed to start VICE emulator '${binary}': ${spawnError.message}`,
          'process_launch',
          false,
          { binary, error: spawnError.message, resolvedPath: binaryCheck.path }
        );
      }

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

      // Enhance timeout errors with spawn error context if available
      if (error instanceof ViceMcpError && error.code === 'monitor_timeout' && spawnError !== undefined) {
        const enhancedError = new ViceMcpError(
          'emulator_crashed_on_startup',
          `VICE emulator '${binary}' crashed during startup: ${spawnError.message}`,
          'process_launch',
          false,
          { binary, error: spawnError.message, resolvedPath: binaryCheck.path }
        );
        this.#warnings = [...this.#warnings.filter((warning) => warning.code !== 'launch_failed'), makeWarning(enhancedError.message, 'launch_failed')];
        await this.#stopManagedProcess(true);
        throw enhancedError;
      }

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

  #bindProcessLifecycle(child: ChildProcess): void {
    child.once('exit', (code, signal) => {
      if (this.#process !== child) {
        return;
      }

      this.#closeProcessLog(child, `process exit (${code ?? 'null'} / ${signal ?? 'null'})`);
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

      this.#closeProcessLog(child, `process error (${error.message})`);
      this.#process = null;
      this.#processState = 'crashed';
      this.#transportState = 'faulted';
      this.#warnings = [...this.#warnings.filter((warning) => warning.code !== 'process_error'), makeWarning(error.message, 'process_error')];

      if (!this.#suppressRecovery && !this.#shuttingDown && this.#config) {
        void this.#scheduleRecovery();
      }
    });
  }

  #attachProcessLogging(child: ChildProcess, binary: string, args: string[]): void {
    const logStream = createWriteStream(VICE_PROCESS_LOG_PATH, { flags: 'a' });
    this.#processLogStream = logStream;
    this.#stdoutMirrorBuffer = '';
    this.#stderrMirrorBuffer = '';

    logStream.write(`\n=== Emulator launch ${nowIso()} ===\n`);
    logStream.write(`binary: ${binary}\n`);
    logStream.write(`args: ${args.join(' ')}\n`);

    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });

    if (MIRROR_EMULATOR_LOGS_TO_STDERR) {
      child.stdout?.on('data', (chunk) => {
        this.#mirrorViceOutputChunk('stdout', chunk);
      });
      child.stderr?.on('data', (chunk) => {
        this.#mirrorViceOutputChunk('stderr', chunk);
      });
    }
  }

  #closeProcessLog(child: ChildProcess, reason: string): void {
    const logStream = this.#processLogStream;
    if (!logStream) {
      return;
    }

    child.stdout?.unpipe(logStream);
    child.stderr?.unpipe(logStream);
    this.#flushViceOutputMirror('stdout');
    this.#flushViceOutputMirror('stderr');
    logStream.write(`\n=== Emulator stream closed ${nowIso()} (${reason}) ===\n`);
    logStream.end();
    this.#processLogStream = null;
  }

  #mirrorViceOutputChunk(stream: 'stdout' | 'stderr', chunk: unknown): void {
    const text = String(chunk);
    const buffer = stream === 'stdout' ? this.#stdoutMirrorBuffer : this.#stderrMirrorBuffer;
    const combined = buffer + text;
    const lines = combined.split(/\r?\n/);
    const remainder = lines.pop() ?? '';

    for (const line of lines) {
      process.stderr.write(`[vice ${stream}] ${line}\n`);
    }

    if (stream === 'stdout') {
      this.#stdoutMirrorBuffer = remainder;
    } else {
      this.#stderrMirrorBuffer = remainder;
    }
  }

  #flushViceOutputMirror(stream: 'stdout' | 'stderr'): void {
    const remainder = stream === 'stdout' ? this.#stdoutMirrorBuffer : this.#stderrMirrorBuffer;
    if (!remainder) {
      return;
    }

    process.stderr.write(`[vice ${stream}] ${remainder}\n`);
    if (stream === 'stdout') {
      this.#stdoutMirrorBuffer = '';
    } else {
      this.#stderrMirrorBuffer = '';
    }
  }

  #writeProcessLogLine(line: string): void {
    this.#processLogStream?.write(`${nowIso()} ${line}\n`);
    if (MIRROR_EMULATOR_LOGS_TO_STDERR) {
      process.stderr.write(`[vice monitor] ${line}\n`);
    }
  }

  async #stopManagedProcess(fullReset: boolean): Promise<void> {
    this.#suppressRecovery = true;
    try {
      this.#clearHeldInputState();
      const processId = this.#process?.pid ?? null;
      this.#breakpointLabels.clear();
      this.#explicitPauseActive = false;
      this.#pendingCheckpointHit = null;
      this.#lastCheckpointHit = null;

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

  async #resumeBeforeShutdown(): Promise<void> {
    if (!this.#client.connected) {
      return;
    }

    this.#syncMonitorRuntimeState();
    if (this.#executionState !== 'stopped') {
      return;
    }

    this.#writeProcessLogLine('[shutdown] emulator stopped in monitor, resuming before quit');
    try {
      this.#lastExecutionIntent = 'unknown';
      await this.#client.continueExecution();
      await this.#waitForExecutionEvent(1000);
      this.#syncMonitorRuntimeState();
    } catch (error) {
      this.#writeProcessLogLine(
        `[shutdown] resume before quit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #hydrateExecutionState(): Promise<void> {
    await this.#stabilizeLaunchExecutionState();
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
    return this.#buildDebugState(registers);
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

  async #stabilizeLaunchExecutionState(): Promise<void> {
    this.#writeProcessLogLine(`[bootstrap] waiting ${BOOTSTRAP_INITIAL_DELAY_MS}ms before probing launch state`);
    await sleep(BOOTSTRAP_INITIAL_DELAY_MS);

    const deadline = Date.now() + BOOTSTRAP_SETTLE_TIMEOUT_MS;
    let runningSince: number | null = null;
    let lastResumeAt = 0;

    while (true) {
      this.#syncMonitorRuntimeState();

      if (this.#executionState === 'running') {
        runningSince ??= Date.now();
        if (Date.now() - runningSince >= BOOTSTRAP_RUNNING_STABLE_MS) {
          this.#writeProcessLogLine('[bootstrap] emulator reached stable running state after launch');
          return;
        }
      } else {
        runningSince = null;
      }

      if (this.#executionState !== 'running' && Date.now() - lastResumeAt >= BOOTSTRAP_RESUME_COOLDOWN_MS) {
        this.#writeProcessLogLine(`[bootstrap] observed ${this.#executionState} state after launch, sending resume`);
        const previousExecutionState = this.#executionState;
        const previousStopReason = this.#lastStopReason;
        const executionEvent = this.#waitForExecutionEvent(EXECUTION_EVENT_WAIT_MS);

        this.#lastExecutionIntent = 'unknown';

        try {
          await this.#client.continueExecution();
        } catch (error) {
          const event = await executionEvent;
          const accepted = this.#resumeWasAcceptedAfterError(error, event, previousExecutionState, previousStopReason);
          if (!accepted) {
            this.#writeProcessLogLine(
              `[bootstrap] resume after launch failed without runtime transition: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        }

        const event = await executionEvent;
        if (!event) {
          this.#writeProcessLogLine(
            `[bootstrap] no runtime event observed within ${EXECUTION_EVENT_WAIT_MS}ms after resume, waiting ${BOOTSTRAP_POLL_MS}ms`,
          );
          await sleep(BOOTSTRAP_POLL_MS);
        }
        lastResumeAt = Date.now();
        continue;
      }

      if (Date.now() >= deadline) {
        this.#writeProcessLogLine(
          `[bootstrap] settle timeout reached after ${BOOTSTRAP_SETTLE_TIMEOUT_MS}ms with executionState=${this.#executionState}`,
        );
        throw new ViceMcpError(
          'bootstrap_timeout',
          'Emulator launch did not reach a stable running state before timeout.',
          'timeout',
          true,
          {
            executionState: this.#executionState,
            lastStopReason: this.#lastStopReason,
          },
        );
      }

      await sleep(BOOTSTRAP_POLL_MS);
    }
  }

  async #withExecutionLock<T>(operation: () => Promise<T>): Promise<T> {
    while (this.#executionOperationLock) {
      await this.#executionOperationLock;
    }
    let resolve: () => void;
    this.#executionOperationLock = new Promise((r) => (resolve = r));
    try {
      return await operation();
    } finally {
      this.#executionOperationLock = null;
      resolve!();
    }
  }

  async #withDisplayLock<T>(operation: () => Promise<T>): Promise<T> {
    while (this.#displayOperationLock) {
      await this.#displayOperationLock;
    }
    let resolve: () => void;
    this.#displayOperationLock = new Promise((r) => (resolve = r));
    try {
      return await operation();
    } finally {
      this.#displayOperationLock = null;
      resolve!();
    }
  }

  async #settleProgramLoadState(autoStart: boolean): Promise<void> {
    const deadline = Date.now() + PROGRAM_LOAD_SETTLE_TIMEOUT_MS;
    let runningSince: number | null = null;
    let lastResumeAt = 0;

    while (true) {
      this.#syncMonitorRuntimeState();

      if (this.#executionState === 'running') {
        runningSince ??= Date.now();
        if (Date.now() - runningSince >= PROGRAM_LOAD_RUNNING_STABLE_MS) {
          return;
        }
      } else {
        runningSince = null;
      }

      if (this.#executionState === 'stopped' && Date.now() - lastResumeAt >= PROGRAM_LOAD_RESUME_COOLDOWN_MS) {
        this.#writeProcessLogLine(
          `[autostart] observed stopped state after load with autoStart=${autoStart}, sending resume`,
        );
        this.#explicitPauseActive = false;
        this.#lastExecutionIntent = 'unknown';
        await this.#client.continueExecution();
        lastResumeAt = Date.now();
      }

      if (Date.now() >= deadline) {
        this.#writeProcessLogLine(
          `[autostart] settle timeout reached after ${PROGRAM_LOAD_SETTLE_TIMEOUT_MS}ms with executionState=${this.#executionState}`,
        );
        return;
      }

      await sleep(PROGRAM_LOAD_SETTLE_POLL_MS);
    }
  }

  async #pauseForDisplayInspection(commandName: string, previousExecutionState: SessionState['executionState']): Promise<void> {
    if (previousExecutionState === 'stopped') {
      return;
    }

    if (previousExecutionState !== 'running') {
      emulatorNotRunningError(commandName, {
        executionState: previousExecutionState,
        lastStopReason: this.#lastStopReason,
      });
    }

    this.#writeProcessLogLine(`[display] ${commandName} started while running, waiting for a temporary stop`);
    await this.#client.setBreakpoint({
      start: 0x0000,
      end: 0xffff,
      kind: 'exec',
      temporary: true,
      enabled: true,
      stopWhenHit: true,
    });

    const deadline = Date.now() + DISPLAY_PAUSE_TIMEOUT_MS;
    while (true) {
      this.#syncMonitorRuntimeState();
      if (this.#executionState === 'stopped') {
        return;
      }
      if (Date.now() >= deadline) {
        throw new ViceMcpError(
          'display_pause_timeout',
          `${commandName} could not reach a temporary stopped state before timeout.`,
          'timeout',
          true,
          {
            commandName,
            executionState: this.#executionState,
            lastStopReason: this.#lastStopReason,
          },
        );
      }
      await sleep(DISPLAY_SETTLE_POLL_MS);
    }
  }

  async #settleDisplayToolState(commandName: string, previousExecutionState: SessionState['executionState']): Promise<void> {
    this.#syncMonitorRuntimeState();
    if (previousExecutionState !== 'running') {
      return;
    }

    const deadline = Date.now() + DISPLAY_SETTLE_TIMEOUT_MS;
    let runningSince: number | null = null;
    let lastResumeAt = 0;

    while (true) {
      this.#syncMonitorRuntimeState();

      if (this.#executionState === 'running') {
        runningSince ??= Date.now();
        if (Date.now() - runningSince >= DISPLAY_RUNNING_STABLE_MS) {
          return;
        }
      } else {
        runningSince = null;
      }

      if (this.#executionState === 'stopped' && Date.now() - lastResumeAt >= DISPLAY_RESUME_COOLDOWN_MS) {
        this.#writeProcessLogLine(`[display] observed stopped state after ${commandName}, sending resume`);
        this.#lastExecutionIntent = 'unknown';
        await this.#client.continueExecution();
        lastResumeAt = Date.now();
      }

      if (Date.now() >= deadline) {
        this.#writeProcessLogLine(
          `[display] settle timeout reached after ${DISPLAY_SETTLE_TIMEOUT_MS}ms after ${commandName} with executionState=${this.#executionState}`,
        );
        if (this.#executionState !== 'running') {
          emulatorNotRunningError(commandName, {
            executionState: this.#executionState,
            lastStopReason: this.#lastStopReason,
          });
        }
        return;
      }

      await sleep(DISPLAY_SETTLE_POLL_MS);
    }
  }

  async #settleInputState(commandName: string, previousExecutionState: SessionState['executionState']): Promise<void> {
    if (previousExecutionState !== 'running') {
      return;
    }
    const deadline = Date.now() + INPUT_SETTLE_TIMEOUT_MS;
    let runningSince: number | null = null;
    let lastResumeAt = 0;

    while (true) {
      this.#syncMonitorRuntimeState();

      if (this.#executionState === 'running') {
        runningSince ??= Date.now();
        if (Date.now() - runningSince >= INPUT_RUNNING_STABLE_MS) {
          return;
        }
      } else {
        runningSince = null;
      }

      if (this.#executionState === 'stopped' && Date.now() - lastResumeAt >= INPUT_RESUME_COOLDOWN_MS) {
        this.#writeProcessLogLine(`[input] observed stopped state after ${commandName}, sending resume`);
        this.#explicitPauseActive = false;
        this.#lastExecutionIntent = 'unknown';
        await this.#client.continueExecution();
        lastResumeAt = Date.now();
      }

      if (Date.now() >= deadline) {
        this.#writeProcessLogLine(
          `[input] settle timeout reached after ${INPUT_SETTLE_TIMEOUT_MS}ms with executionState=${this.#executionState}`,
        );
        if (this.#executionState !== 'running') {
          emulatorNotRunningError(commandName, {
            executionState: this.#executionState,
            lastStopReason: this.#lastStopReason,
          });
        }
        return;
      }

      await sleep(INPUT_SETTLE_POLL_MS);
    }
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

    return (
      this.#executionState !== previousExecutionState &&
      (this.#executionState === 'running' || this.#executionState === 'stopped') &&
      this.#lastStopReason !== previousStopReason &&
      event != null
    );
  }

  #resumeWasAcceptedAfterError(
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
      this.#writeProcessLogLine(
        `[bootstrap] resume probe accepted after ${error.code} because monitor reported ${event.type}`,
      );
      return true;
    }

    return this.#executionState !== previousExecutionState || this.#lastStopReason !== previousStopReason;
  }

  #syncMonitorRuntimeState(): void {
    const runtime = this.#client.runtimeState();
    const eventType = runtime.lastEventType;

    this.#executionState = runtime.runtimeKnown && eventType === 'resumed' ? 'running' : runtime.runtimeKnown ? 'stopped' : 'unknown';
    if (eventType !== this.#lastRuntimeEventType || runtime.programCounter !== this.#lastRuntimeProgramCounter) {
      this.#lastStopReason = this.#stopReasonFromMonitorEvent(eventType);
      this.#lastRuntimeEventType = eventType;
      this.#lastRuntimeProgramCounter = runtime.programCounter;
    }
    this.#writeProcessLogLine(
      `[monitor-state] executionState=${this.#executionState} lastStopReason=${this.#lastStopReason} runtimeKnown=${runtime.runtimeKnown} lastEventType=${eventType}${runtime.programCounter == null ? '' : ` pc=$${runtime.programCounter.toString(16).padStart(4, '0')}`}`,
    );
    this.#scheduleIdleAutoResume();
  }

  #stopReasonFromMonitorEvent(eventType: MonitorRuntimeEventType): StopReason {
    switch (eventType) {
      case 'resumed':
        this.#pendingCheckpointHit = null;
        return 'none';
      case 'stopped':
        if (this.#pendingCheckpointHit && Date.now() - this.#pendingCheckpointHit.observedAt <= CHECKPOINT_HIT_SETTLE_MS) {
          this.#lastCheckpointHit = this.#pendingCheckpointHit;
          const checkpointReason =
            this.#pendingCheckpointHit.kind === 'exec'
              ? 'breakpoint'
              : this.#pendingCheckpointHit.kind === 'read'
                ? 'watchpoint_read'
                : 'watchpoint_write';
          this.#pendingCheckpointHit = null;
          return checkpointReason;
        }
        // Schedule fallback query when stop reason is ambiguous
        if (this.#lastExecutionIntent === 'unknown' && !this.#checkpointQueryPending) {
          void this.#scheduleCheckpointHitQuery();
        }
        return this.#lastExecutionIntent;
      case 'jam':
        this.#pendingCheckpointHit = null;
        return 'error';
      case 'unknown':
        this.#pendingCheckpointHit = null;
        return 'unknown';
    }
  }

  async #scheduleCheckpointHitQuery(): Promise<void> {
    if (this.#checkpointQueryPending) {
      return;
    }
    this.#checkpointQueryPending = true;

    try {
      // Wait a short window for checkpoint_info to arrive naturally
      await sleep(200);

      // If we already got checkpoint correlation, skip query
      if (this.#lastStopReason !== 'unknown' && this.#lastStopReason !== this.#lastExecutionIntent) {
        return;
      }

      this.#writeProcessLogLine('[checkpoint-query] probing for hit checkpoint after ambiguous stop');
      const response = await this.#client.listBreakpoints();
      const hit = response.checkpoints.find((cp) => cp.currentlyHit);

      if (hit) {
        this.#lastCheckpointHit = {
          id: hit.id,
          kind: hit.kind,
          observedAt: Date.now(),
        };
        const reason = hit.kind === 'exec' ? 'breakpoint' : hit.kind === 'read' ? 'watchpoint_read' : 'watchpoint_write';

        this.#lastStopReason = reason;
        this.#writeProcessLogLine(`[checkpoint-query] retroactively identified stop reason: ${reason} (id=${hit.id})`);
      }
    } catch (error) {
      this.#writeProcessLogLine(`[checkpoint-query] failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#checkpointQueryPending = false;
    }
  }

  #autoResumeAllowed(): boolean {
    return !this.#shuttingDown && this.#client.connected && !this.#explicitPauseActive;
  }

  #scheduleIdleAutoResume(): void {
    if (this.#executionState !== 'stopped' || !this.#autoResumeAllowed()) {
      this.#clearIdleAutoResume();
      return;
    }
    this.#stoppedAt = Date.now();
    if (this.#autoResumeTimer) {
      clearTimeout(this.#autoResumeTimer);
    }
    this.#autoResumeTimer = setTimeout(() => {
      this.#autoResumeTimer = null;
      void this.#autoResumeDueToIdle();
    }, STOPPED_IDLE_TIMEOUT_MS);
  }

  #clearIdleAutoResume(): void {
    this.#stoppedAt = null;
    if (this.#autoResumeTimer) {
      clearTimeout(this.#autoResumeTimer);
      this.#autoResumeTimer = null;
    }
  }

  async #autoResumeDueToIdle(): Promise<void> {
    if (!this.#autoResumeAllowed() || this.#executionState !== 'stopped') {
      this.#stoppedAt = null;
      return;
    }

    const stoppedMs = this.#stoppedAt ? Date.now() - this.#stoppedAt : STOPPED_IDLE_TIMEOUT_MS;
    if (stoppedMs < STOPPED_IDLE_TIMEOUT_MS) {
      this.#scheduleIdleAutoResume();
      return;
    }

    this.#writeProcessLogLine(`[auto-resume] emulator stopped for ${STOPPED_IDLE_TIMEOUT_MS}ms, resuming to stay responsive`);
    try {
      this.#lastExecutionIntent = 'unknown';
      await this.#client.continueExecution();
    } catch (error) {
      this.#writeProcessLogLine(
        `[auto-resume] resume attempt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#stoppedAt = null;
    }

    this.#syncMonitorRuntimeState();
  }

  async #cleanupOldScreenshots(): Promise<void> {
    if (!CLEANUP_ENABLED) {
      return;
    }

    try {
      const maxAgeMinutes = Math.max(1, Math.min(525600, CLEANUP_MAX_AGE_MINUTES)); // 1 min to 1 year
      const maxAgeMs = maxAgeMinutes * 60 * 1000;
      const cutoffTime = Date.now() - maxAgeMs;

      this.#writeProcessLogLine(`[cleanup] scanning ${DISPLAY_CAPTURE_DIR} for screenshots older than ${maxAgeMinutes}m`);

      let entries;
      try {
        entries = await fs.readdir(DISPLAY_CAPTURE_DIR);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return; // Directory doesn't exist yet - nothing to clean
        }
        throw error;
      }

      const pngFiles = entries.filter(name => name.endsWith('.png') && name.startsWith('capture-'));
      let deletedCount = 0;
      let errorCount = 0;

      for (const filename of pngFiles) {
        try {
          const filePath = path.join(DISPLAY_CAPTURE_DIR, filename);
          const stats = await fs.stat(filePath);

          if (stats.mtime.getTime() < cutoffTime) {
            await fs.unlink(filePath);
            deletedCount++;
          }
        } catch (error) {
          errorCount++;
          this.#writeProcessLogLine(`[cleanup] failed to delete ${filename}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      this.#writeProcessLogLine(`[cleanup] completed: ${deletedCount} deleted, ${errorCount} errors, ${pngFiles.length - deletedCount - errorCount} retained`);

    } catch (error) {
      this.#writeProcessLogLine(`[cleanup] failed: ${error instanceof Error ? error.message : String(error)}`);
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

async function checkBinaryExists(binaryPath: string): Promise<{ exists: boolean; path?: string }> {
  // If it's an absolute path, check directly
  if (path.isAbsolute(binaryPath)) {
    try {
      await fs.access(binaryPath, fs.constants.X_OK);
      return { exists: true, path: binaryPath };
    } catch {
      return { exists: false };
    }
  }

  // Check if binary is in PATH
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);

  for (const dir of pathDirs) {
    const fullPath = path.join(dir, binaryPath);
    try {
      await fs.access(fullPath, fs.constants.X_OK);
      return { exists: true, path: fullPath };
    } catch {
      // Continue checking other directories
    }
  }

  return { exists: false };
}

async function waitForMonitor(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortAvailable(host, port))) {
      return;
    }
    await sleep(100);
  }

  throw new ViceMcpError('monitor_timeout', `Debugger monitor did not open on ${host}:${port}. The emulator may have failed to start or crashed during startup.`, 'timeout', true, {
    host,
    port,
  });
}

async function waitForProcessExit(process: ChildProcess, timeoutMs: number): Promise<void> {
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
