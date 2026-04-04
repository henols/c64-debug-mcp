import { z } from 'zod';

import {
  C64_REGISTER_DEFINITIONS,
  breakpointKindSchema,
  executionStateSchema,
  inputActionSchema,
  joystickControlSchema,
  joystickPortSchema,
  responseMetaSchema,
  stopReasonSchema,
  toolErrorSchema,
  warningItemSchema,
} from './contracts.js';

export const warningSchema = warningItemSchema;

/**
 * Parses a C64 memory address from multiple formats:
 * - Decimal number: 53248
 * - Hex string with $: "$D000"
 * - Hex string with 0x: "0xD000" or "0XD000"
 *
 * Bare hex without prefix is NOT supported to avoid ambiguity with 4-digit decimals.
 *
 * @param input - Address as number or string
 * @returns Parsed decimal number (0-65535)
 * @throws ZodError if format is invalid or out of range
 */
function parseAddress16(input: unknown): number {
  // If already a number, validate and return
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xffff) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Address must be an integer between 0 and 65535 (0xFFFF), got ${input}`,
          path: [],
        },
      ]);
    }
    return input;
  }

  // Must be a string for hex parsing
  if (typeof input !== 'string') {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Address must be a number or string, got ${typeof input}`,
        path: [],
      },
    ]);
  }

  const trimmed = input.trim();

  // Try to parse as hex with required prefix
  let hexString: string;
  let format: string;

  if (trimmed.startsWith('$')) {
    // C64/6502 style: $D000
    hexString = trimmed.slice(1);
    format = 'C64 hex ($)';
  } else if (trimmed.toLowerCase().startsWith('0x')) {
    // C-style: 0xD000
    hexString = trimmed.slice(2);
    format = 'C hex (0x)';
  } else {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Invalid address format: "${input}". Expected formats: decimal number (53248), hex with $ ($D000), or hex with 0x (0xD000). Bare hex not supported to avoid ambiguity.`,
        path: [],
      },
    ]);
  }

  // Validate hex string format
  if (!/^[0-9A-Fa-f]{1,4}$/.test(hexString)) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Invalid ${format} address: "${input}". Hex portion must be 1-4 hex digits (0-9, A-F)`,
        path: [],
      },
    ]);
  }

  const parsed = parseInt(hexString, 16);

  if (isNaN(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Address out of range: "${input}" (${parsed}). Must be 0x0000-0xFFFF (0-65535)`,
        path: [],
      },
    ]);
  }

  return parsed;
}

export const address16Schema = z
  .preprocess(parseAddress16, z.number().int().min(0).max(0xffff))
  .describe('16-bit C64 address: decimal (53248) or hex string with prefix ($D000, 0xD000)');

/**
 * Parses a C64 byte value (0-255) from multiple formats:
 * - Decimal number: 255
 * - Hex string with $: "$FF"
 * - Hex string with 0x: "0xFF" or "0XFF"
 * - Binary string with %: "%11111111"
 * - Binary string with 0b: "0b11111111" or "0B11111111"
 *
 * Bare hex/binary without prefix is NOT supported to avoid ambiguity.
 *
 * @param input - Byte value as number or string
 * @returns Parsed decimal number (0-255)
 * @throws ZodError if format is invalid or out of range
 */
function parseByte(input: unknown): number {
  // If already a number, validate and return
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xff) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Byte value must be an integer between 0 and 255 (0xFF), got ${input}`,
          path: [],
        },
      ]);
    }
    return input;
  }

  // Must be a string for hex/binary parsing
  if (typeof input !== 'string') {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Byte value must be a number or string, got ${typeof input}`,
        path: [],
      },
    ]);
  }

  const trimmed = input.trim();

  // Try hex parsing first
  if (trimmed.startsWith('$')) {
    // C64 style: $FF
    const hexString = trimmed.slice(1);
    if (!/^[0-9A-Fa-f]{1,2}$/.test(hexString)) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Invalid C64 hex ($) byte value: "${input}". Hex portion must be 1-2 hex digits (0-9, A-F)`,
          path: [],
        },
      ]);
    }
    const parsed = parseInt(hexString, 16);
    if (isNaN(parsed) || parsed < 0 || parsed > 0xff) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Byte value out of range: "${input}" (${parsed}). Must be 0x00-0xFF (0-255)`,
          path: [],
        },
      ]);
    }
    return parsed;
  }

  if (trimmed.toLowerCase().startsWith('0x')) {
    // C-style hex: 0xFF
    const hexString = trimmed.slice(2);
    if (!/^[0-9A-Fa-f]{1,2}$/.test(hexString)) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Invalid C hex (0x) byte value: "${input}". Hex portion must be 1-2 hex digits (0-9, A-F)`,
          path: [],
        },
      ]);
    }
    const parsed = parseInt(hexString, 16);
    if (isNaN(parsed) || parsed < 0 || parsed > 0xff) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Byte value out of range: "${input}" (${parsed}). Must be 0x00-0xFF (0-255)`,
          path: [],
        },
      ]);
    }
    return parsed;
  }

  // Try binary parsing
  if (trimmed.startsWith('%')) {
    // C64 style: %11111111
    const binString = trimmed.slice(1);
    if (!/^[01]{1,8}$/.test(binString)) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Invalid C64 binary (%) byte value: "${input}". Binary portion must be 1-8 binary digits (0-1)`,
          path: [],
        },
      ]);
    }
    const parsed = parseInt(binString, 2);
    if (isNaN(parsed) || parsed < 0 || parsed > 0xff) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Byte value out of range: "${input}" (${parsed}). Must be 0b00000000-0b11111111 (0-255)`,
          path: [],
        },
      ]);
    }
    return parsed;
  }

  if (trimmed.toLowerCase().startsWith('0b')) {
    // C-style binary: 0b11111111
    const binString = trimmed.slice(2);
    if (!/^[01]{1,8}$/.test(binString)) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Invalid C binary (0b) byte value: "${input}". Binary portion must be 1-8 binary digits (0-1)`,
          path: [],
        },
      ]);
    }
    const parsed = parseInt(binString, 2);
    if (isNaN(parsed) || parsed < 0 || parsed > 0xff) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Byte value out of range: "${input}" (${parsed}). Must be 0b00000000-0b11111111 (0-255)`,
          path: [],
        },
      ]);
    }
    return parsed;
  }

  // No recognized prefix
  throw new z.ZodError([
    {
      code: 'custom',
      message: `Invalid byte format: "${input}". Expected formats: decimal (255), hex with prefix ($FF, 0xFF), or binary with prefix (%11111111, 0b11111111). Bare hex/binary not supported to avoid ambiguity.`,
      path: [],
    },
  ]);
}

export const byteValueSchema = z
  .preprocess(parseByte, z.number().int().min(0).max(0xff))
  .describe('8-bit byte value: decimal (255), hex with prefix ($FF, 0xFF), or binary with prefix (%11111111, 0b11111111)');

export const byteArraySchema = z
  .array(byteValueSchema)
  .describe('Array of byte values in mixed formats: [255, "$FF", "%11111111", 42]');

export const c64RegisterValueSchema = z.object(
  Object.fromEntries(
    C64_REGISTER_DEFINITIONS.map((register) => [
      register.fieldName,
      z.number().int().min(register.min).max(register.max).describe(register.description),
    ]),
  ) as Record<string, z.ZodNumber>,
);

export const c64PartialRegisterValueSchema = z.object(
  Object.fromEntries(
    C64_REGISTER_DEFINITIONS.map((register) => [
      register.fieldName,
      z.number().int().min(register.min).max(register.max).describe(register.description).optional(),
    ]),
  ) as Record<string, z.ZodOptional<z.ZodNumber>>,
);

export const debugStateSchema = z.object({
  executionState: executionStateSchema.describe('Current execution state of the emulator'),
  lastStopReason: stopReasonSchema.describe('Reason the emulator stopped in the monitor'),
  programCounter: address16Schema.describe('Current program counter'),
  registers: c64RegisterValueSchema,
});

export const monitorStateSchema = z.object({
  executionState: executionStateSchema.describe('Current execution state reported by the monitor'),
  lastStopReason: stopReasonSchema.describe('Reason the monitor most recently reported a stop-like state'),
  runtimeKnown: z.boolean().describe('Whether the monitor has reported a runtime event in this session'),
  programCounter: address16Schema.nullable().describe('Program counter from the latest monitor event, or null if unknown'),
});

export const sessionStateResultSchema = z.object({
  transportState: z.enum([
    'not_started',
    'starting',
    'waiting_for_monitor',
    'connecting',
    'connected',
    'reconnecting',
    'disconnected',
    'stopped',
    'faulted',
  ]),
  processState: z.enum(['not_applicable', 'launching', 'running', 'exited', 'crashed']),
  executionState: executionStateSchema.describe('Current execution state of the emulator session'),
  lastStopReason: stopReasonSchema.describe('Reason the emulator most recently stopped in the monitor'),
  idleAutoResumeArmed: z.boolean().describe('Whether the idle auto-resume timer is currently armed'),
  explicitPauseActive: z.boolean().describe('Whether execution was explicitly paused by the caller'),
  lastCheckpointId: z.number().int().nullable().describe('Most recent hit checkpoint/watchpoint id when known'),
  lastCheckpointKind: breakpointKindSchema.nullable().describe('Most recent hit checkpoint/watchpoint kind when known'),
  recoveryInProgress: z.boolean(),
  launchId: z.number().int().nonnegative(),
  restartCount: z.number().int().nonnegative(),
  freshEmulatorPending: z.boolean(),
  connectedSince: z.string().nullable(),
  lastResponseAt: z.string().nullable(),
  processId: z.number().int().nullable(),
  warnings: z.array(warningSchema),
});

export const breakpointSchema = z.object({
  id: z.number().int().describe('Breakpoint identifier'),
  address: address16Schema.describe('Start address of the breakpoint range'),
  length: z.number().int().positive().describe('Size of the breakpoint range in bytes'),
  enabled: z.boolean().describe('Whether the breakpoint is enabled'),
  temporary: z.boolean().describe('Whether the breakpoint is temporary'),
  hasCondition: z.boolean().describe('Whether the breakpoint has a condition expression'),
  kind: breakpointKindSchema.describe('Breakpoint trigger kind'),
  label: z.string().nullable().optional().describe('Optional caller-provided label'),
});

export const joystickStateSchema = z.object({
  up: z.boolean().describe('Whether up is currently held on the selected joystick port'),
  down: z.boolean().describe('Whether down is currently held on the selected joystick port'),
  left: z.boolean().describe('Whether left is currently held on the selected joystick port'),
  right: z.boolean().describe('Whether right is currently held on the selected joystick port'),
  fire: z.boolean().describe('Whether fire is currently held on the selected joystick port'),
});

export const programLoadResultSchema = z.object({
  filePath: z.string().describe('Absolute path to the program file that was loaded'),
  autoStart: z.boolean().describe('Whether the loaded program was requested to start immediately after loading'),
  fileIndex: z.number().int().nonnegative().describe('Autostart file index inside the image, when applicable'),
  executionState: executionStateSchema.describe('Execution state after the monitor-driven load request'),
});

export const captureDisplayResultSchema = z.object({
  imagePath: z.string().describe('Absolute path to the rendered PNG image'),
  width: z.number().int().positive().describe('Width of the visible rendered screen image'),
  height: z.number().int().positive().describe('Height of the visible rendered screen image'),
  debugWidth: z.number().int().positive().describe('Width of the full uncropped debug display buffer'),
  debugHeight: z.number().int().positive().describe('Height of the full uncropped debug display buffer'),
  debugOffsetX: z.number().int().nonnegative().describe('X offset of the visible inner area within the debug display buffer'),
  debugOffsetY: z.number().int().nonnegative().describe('Y offset of the visible inner area within the debug display buffer'),
  bitsPerPixel: z.number().int().positive().describe('Bits per pixel reported by the emulator display payload'),
});

export const graphicsModeSchema = z.enum([
  'standard_text',
  'multicolor_text',
  'standard_bitmap',
  'multicolor_bitmap',
  'extended_background_color_text',
  'invalid_text_mode',
  'invalid_bitmap_mode_1',
  'invalid_bitmap_mode_2',
]);

export const displayStateResultSchema = z.object({
  graphicsMode: graphicsModeSchema.describe('Decoded VIC-II graphics mode from D011/D016'),
  extendedColorMode: z.boolean().describe('Whether extended background color mode is enabled'),
  bitmapMode: z.boolean().describe('Whether bitmap mode is enabled'),
  multicolorMode: z.boolean().describe('Whether multicolor mode is enabled'),
  vicBankAddress: address16Schema.describe('Base address of the active 16K VIC bank'),
  screenRamAddress: address16Schema.describe('Base address of the active 1000-byte screen matrix'),
  characterMemoryAddress: address16Schema.nullable().describe('Base address of the active character memory when the current mode uses character data'),
  bitmapMemoryAddress: address16Schema.nullable().describe('Base address of the active bitmap memory when the current mode uses bitmap data'),
  colorRamAddress: address16Schema.describe('Base address of the 1000-byte color RAM area'),
  borderColor: z.number().int().min(0).max(0x0f).describe('Current border color value'),
  backgroundColor0: z.number().int().min(0).max(0x0f).describe('Current background color 0 value'),
  backgroundColor1: z.number().int().min(0).max(0x0f).describe('Current background color 1 value'),
  backgroundColor2: z.number().int().min(0).max(0x0f).describe('Current background color 2 value'),
  backgroundColor3: z.number().int().min(0).max(0x0f).describe('Current background color 3 value'),
  vicRegisters: z.object({
    d011: byteValueSchema.describe('Raw VIC-II register $D011'),
    d016: byteValueSchema.describe('Raw VIC-II register $D016'),
    d018: byteValueSchema.describe('Raw VIC-II register $D018'),
    dd00: byteValueSchema.describe('Raw CIA2/VIC bank register $DD00'),
    d020: byteValueSchema.describe('Raw border color register $D020'),
    d021: byteValueSchema.describe('Raw background color register $D021'),
    d022: byteValueSchema.describe('Raw background color register $D022'),
    d023: byteValueSchema.describe('Raw background color register $D023'),
    d024: byteValueSchema.describe('Raw background color register $D024'),
  }),
  screenRam: byteArraySchema.describe('Raw 1000-byte screen matrix contents'),
  colorRam: byteArraySchema.describe('Raw 1000-byte color RAM contents, masked to the low nybble'),
});

export const displayTextResultSchema = z.object({
  graphicsMode: graphicsModeSchema.describe('Decoded VIC-II graphics mode from D011/D016'),
  textMode: z.boolean().describe('Whether the current graphics mode supports direct screen-text decoding'),
  lossy: z.boolean().describe('Whether the screen-code to ASCII translation may lose C64-specific glyph information'),
  columns: z.number().int().positive().describe('Number of text columns decoded per row'),
  rows: z.number().int().positive().describe('Number of decoded text rows'),
  screenRamAddress: address16Schema.describe('Base address of the active 1000-byte screen matrix'),
  textLines: z.array(z.string()).describe('Decoded text rows from screen RAM, trimmed on the right'),
  tokenLines: z.array(z.string()).optional().describe('Optional richer tokenized rows, included only when non-ASCII or ambiguous C64 glyphs are present'),
});

export const keyboardInputResultSchema = z.object({
  action: inputActionSchema.describe('Keyboard action that was applied'),
  keys: z.array(z.string()).min(1).max(4).describe('Normalized symbolic key names'),
  applied: z.boolean().describe('Whether the request was accepted and applied'),
  held: z.boolean().describe('Whether the keys are still treated as held after this request'),
  mode: z.enum(['buffered_text', 'buffered_text_repeat']).describe('Keyboard delivery mode supported by the emulator debug connection'),
});

export const joystickInputResultSchema = z.object({
  port: joystickPortSchema.describe('Joystick port that received the input'),
  action: inputActionSchema.describe('Joystick action that was applied'),
  control: joystickControlSchema.describe('Joystick control that was applied'),
  applied: z.boolean().describe('Whether the request was accepted and applied'),
  state: joystickStateSchema,
});

export const waitForStateResultSchema = z.object({
  executionState: executionStateSchema.describe('Current execution state after waiting'),
  lastStopReason: stopReasonSchema.describe('Reason the emulator most recently stopped in the monitor'),
  runtimeKnown: z.boolean().describe('Whether the monitor has reported a runtime event in this session'),
  programCounter: address16Schema.nullable().describe('Program counter from the latest monitor event, or null if unknown'),
  reachedTarget: z.boolean().describe('Whether the requested target state was reached before timeout'),
  waitedMs: z.number().int().nonnegative().describe('Milliseconds spent waiting'),
});

export function toolOutputSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    meta: responseMetaSchema,
    data: dataSchema,
  });
}

export { toolErrorSchema };
