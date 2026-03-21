import { z } from 'zod';

import {
  C64_REGISTER_DEFINITIONS,
  breakpointKindSchema,
  executionStateSchema,
  inputActionSchema,
  joystickControlSchema,
  joystickPortSchema,
  programLoadModeSchema,
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
  mode: programLoadModeSchema.describe('Program loading mode used for this request'),
  start: address16Schema.nullable().describe('Memory-mode load address, or null for autostart'),
  length: z.number().int().min(0).nullable().describe('Program byte length written in memory mode, or null for autostart'),
  written: z.boolean().nullable().describe('Whether the program bytes were written directly into memory, or null for autostart'),
  runAfterLoading: z.boolean().nullable().describe('Autostart run flag, or null for memory mode'),
  fileIndex: z.number().int().nonnegative().nullable().describe('Autostart file index, or null for memory mode'),
  executionState: executionStateSchema.nullable().describe('Execution state after autostart, or null for memory mode'),
});

export const keyboardInputResultSchema = z.object({
  action: inputActionSchema.describe('Keyboard action that was applied'),
  key: z.string().describe('Normalized symbolic key name'),
  applied: z.boolean().describe('Whether the request was accepted and applied'),
  held: z.boolean().describe('Whether the key is still treated as held after this request'),
  mode: z.enum(['buffered_text', 'buffered_text_repeat']).describe('Keyboard delivery mode supported by the VICE protocol'),
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
