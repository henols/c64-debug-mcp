import { z } from 'zod';

export const VICE_API_VERSION = 0x02;
export const VICE_STX = 0x02;
export const VICE_BROADCAST_REQUEST_ID = 0xffffffff;
export const DEFAULT_MONITOR_HOST = '127.0.0.1';
export const C64_TARGET = 'c64' as const;
export const DEFAULT_C64_BINARY = 'x64sc' as const;
export const DEFAULT_FORBIDDEN_PORTS = new Set([6502]);

export const transportStateSchema = z.enum([
  'not_started',
  'starting',
  'waiting_for_monitor',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'stopped',
  'faulted',
]);

export const processStateSchema = z.enum(['not_applicable', 'launching', 'running', 'exited', 'crashed']);
export const executionStateSchema = z.enum(['unknown', 'running', 'paused', 'stopped_in_monitor']);
export const stopReasonSchema = z.enum([
  'none',
  'breakpoint',
  'watchpoint_read',
  'watchpoint_write',
  'step_complete',
  'manual_break',
  'reset',
  'monitor_entry',
  'program_end',
  'error',
  'unknown',
]);
export const sessionHealthSchema = z.enum(['not_configured', 'starting', 'ready', 'recovering', 'stopped', 'error']);
export const breakpointKindSchema = z.enum(['exec', 'read', 'write', 'read_write']);
export const resetModeSchema = z.enum(['soft', 'hard']);
export const programLoadModeSchema = z.enum(['memory', 'autostart']);
export const inputActionSchema = z.enum(['press', 'release', 'tap']);
export const joystickControlSchema = z.enum(['up', 'down', 'left', 'right', 'fire']);
export const joystickPortSchema = z.union([z.literal(1), z.literal(2)]);
export const toolErrorCategorySchema = z.enum([
  'validation',
  'configuration',
  'session_state',
  'process_launch',
  'connection',
  'protocol',
  'timeout',
  'io',
  'unsupported',
  'internal',
]);
export const warningItemSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export const c64ConfigSchema = z.object({
  binaryPath: z.string().optional(),
  workingDirectory: z.string().optional(),
  arguments: z.string().optional(),
});
export const responseMetaSchema = z.object({
  freshEmulator: z.boolean(),
  launchId: z.number().int().nonnegative(),
  restartCount: z.number().int().nonnegative(),
});

export type TransportState = z.infer<typeof transportStateSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;
export type SessionHealth = z.infer<typeof sessionHealthSchema>;
export type BreakpointKind = z.infer<typeof breakpointKindSchema>;
export type ResetMode = z.infer<typeof resetModeSchema>;
export type ProgramLoadMode = z.infer<typeof programLoadModeSchema>;
export type InputAction = z.infer<typeof inputActionSchema>;
export type JoystickControl = z.infer<typeof joystickControlSchema>;
export type JoystickPort = z.infer<typeof joystickPortSchema>;
export type C64Config = z.infer<typeof c64ConfigSchema>;
export type ResponseMeta = z.infer<typeof responseMetaSchema>;
export type C64RegisterName = 'PC' | 'A' | 'X' | 'Y' | 'SP' | 'FL' | '00' | '01' | 'LIN' | 'CYC';

export interface WarningItem {
  code: string;
  message: string;
}

export interface ToolError {
  code: string;
  message: string;
  category:
    | 'validation'
    | 'configuration'
    | 'session_state'
    | 'process_launch'
    | 'connection'
    | 'protocol'
    | 'timeout'
    | 'io'
    | 'unsupported'
    | 'internal';
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface SessionState {
  transportState: TransportState;
  processState: ProcessState;
  executionState: ExecutionState;
  lastStopReason: StopReason;
  recoveryInProgress: boolean;
  launchId: number;
  restartCount: number;
  freshEmulatorPending: boolean;
  connectedSince: string | null;
  lastResponseAt: string | null;
  processId: number | null;
  warnings: WarningItem[];
}

export interface SessionStatus {
  configured: boolean;
  status: SessionHealth;
  target: typeof C64_TARGET;
  warnings: WarningItem[];
}

export interface ProtocolRegisterItem {
  id: number;
  name: string;
  widthBits: number;
  value?: number;
}

export interface C64RegisterDefinition {
  fieldName: C64RegisterName;
  viceName: string;
  widthBits: 8 | 16;
  min: number;
  max: number;
  description: string;
}

export const C64_REGISTER_DEFINITIONS: readonly C64RegisterDefinition[] = [
  { fieldName: 'PC', viceName: 'PC', widthBits: 16, min: 0, max: 0xffff, description: 'Program counter register' },
  { fieldName: 'A', viceName: 'A', widthBits: 8, min: 0, max: 0xff, description: 'Accumulator register' },
  { fieldName: 'X', viceName: 'X', widthBits: 8, min: 0, max: 0xff, description: 'X index register' },
  { fieldName: 'Y', viceName: 'Y', widthBits: 8, min: 0, max: 0xff, description: 'Y index register' },
  { fieldName: 'SP', viceName: 'SP', widthBits: 8, min: 0, max: 0xff, description: 'Stack pointer register' },
  { fieldName: 'FL', viceName: 'FL', widthBits: 8, min: 0, max: 0xff, description: 'CPU flags register' },
  { fieldName: '00', viceName: '00', widthBits: 8, min: 0, max: 0xff, description: 'Zero-page processor port register 00' },
  { fieldName: '01', viceName: '01', widthBits: 8, min: 0, max: 0xff, description: 'Zero-page processor port register 01' },
  { fieldName: 'LIN', viceName: 'LIN', widthBits: 16, min: 0, max: 0xffff, description: 'Current raster line register' },
  { fieldName: 'CYC', viceName: 'CYC', widthBits: 16, min: 0, max: 0xffff, description: 'Current cycle position register' },
] as const;

export interface Breakpoint {
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
}

export const c64StatusSchema = z.object({
  configured: z.boolean(),
  status: sessionHealthSchema,
  target: z.literal(C64_TARGET),
  warnings: z.array(warningItemSchema),
});

export const toolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  category: toolErrorCategorySchema,
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

export function mainMemSpaceToProtocol(): number {
  return 0x00;
}

export function breakpointKindToOperation(kind: BreakpointKind): number {
  switch (kind) {
    case 'read':
      return 0x01;
    case 'write':
      return 0x02;
    case 'read_write':
      return 0x03;
    case 'exec':
      return 0x04;
  }
}

export function cpuOperationToBreakpointKind(operation: number): BreakpointKind {
  if ((operation & 0x04) === 0x04) {
    return 'exec';
  }
  if ((operation & 0x01) === 0x01 && (operation & 0x02) === 0x02) {
    return 'read_write';
  }
  if ((operation & 0x01) === 0x01) {
    return 'read';
  }
  if ((operation & 0x02) === 0x02) {
    return 'write';
  }
  return 'exec';
}
