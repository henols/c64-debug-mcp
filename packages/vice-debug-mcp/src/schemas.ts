import { z } from 'zod';

import {
  C64_REGISTER_DEFINITIONS,
  breakpointKindSchema,
  executionStateSchema,
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

export function toolOutputSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    meta: responseMetaSchema,
    data: dataSchema,
  });
}

export { toolErrorSchema };
