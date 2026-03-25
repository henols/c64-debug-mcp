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

export const address16Schema = z.number().int().min(0).max(0xffff);

export const byteValueSchema = z.number().int().min(0).max(0xff).describe('Single raw byte value');

export const byteArraySchema = z.array(byteValueSchema).describe('Raw bytes as a JSON array');

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
  lastStopReason: stopReasonSchema.describe('Reason the emulator most recently stopped in the monitor'),
  programCounter: address16Schema.describe('Current program counter'),
  registers: c64RegisterValueSchema,
});

export const monitorStateSchema = z.object({
  executionState: executionStateSchema.describe('Current execution state reported by the monitor'),
  lastStopReason: stopReasonSchema.describe('Reason the monitor most recently reported a stop-like state'),
  runtimeKnown: z.boolean().describe('Whether the monitor has reported a runtime event in this session'),
  programCounter: address16Schema.nullable().describe('Program counter from the latest monitor event, or null if unknown'),
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

export function toolOutputSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    meta: responseMetaSchema,
    data: dataSchema,
  });
}

export { toolErrorSchema };
