import { z } from 'zod';

export const VICE_API_VERSION = 0x02;
export const VICE_STX = 0x02;
export const VICE_BROADCAST_REQUEST_ID = 0xffffffff;
export const DEFAULT_MONITOR_HOST = '127.0.0.1';
export const DEFAULT_RESUME_POLICY = 'preserve_pause_state' as const;
export const DEFAULT_MACHINE_TYPE = 'c64' as const;
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

export const emulatorOwnershipSchema = z.enum(['external', 'managed', 'unknown']);
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
export const resumePolicySchema = z.enum(['preserve_pause_state', 'resume_after_mutation', 'always_resume']);
export const breakpointKindSchema = z.enum(['exec', 'read', 'write', 'read_write']);
export const resetModeSchema = z.enum(['soft', 'hard']);
export const memSpaceSchema = z.enum(['main', 'drive8', 'drive9', 'drive10', 'drive11']);
export const emulatorConfigSchema = z.object({
  emulatorType: z.string().min(1).default(DEFAULT_MACHINE_TYPE),
  binaryPath: z.string().optional(),
  workingDirectory: z.string().optional(),
  arguments: z.string().optional(),
  resumePolicy: resumePolicySchema.default(DEFAULT_RESUME_POLICY),
});
export const responseMetaSchema = z.object({
  freshEmulator: z.boolean(),
  launchId: z.number().int().nonnegative(),
  restartCount: z.number().int().nonnegative(),
});

export type TransportState = z.infer<typeof transportStateSchema>;
export type EmulatorOwnership = z.infer<typeof emulatorOwnershipSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;
export type SessionHealth = z.infer<typeof sessionHealthSchema>;
export type ResumePolicy = z.infer<typeof resumePolicySchema>;
export type BreakpointKind = z.infer<typeof breakpointKindSchema>;
export type ResetMode = z.infer<typeof resetModeSchema>;
export type MemSpaceName = z.infer<typeof memSpaceSchema>;
export type EmulatorConfig = z.infer<typeof emulatorConfigSchema>;
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

export interface MachineProfile {
  machineType: string;
  cpu: string;
  registerNamespace: string;
}

export interface SessionState {
  sessionId: string | null;
  transportState: TransportState;
  emulatorOwnership: EmulatorOwnership;
  processState: ProcessState;
  executionState: ExecutionState;
  lastStopReason: StopReason;
  machineType: string | null;
  machineProfile: MachineProfile | null;
  binaryMonitorEndpoint: {
    host: string | null;
    port: number | null;
  };
  activePolicies: {
    resumePolicy: ResumePolicy;
  };
  configPresent: boolean;
  managedByServer: boolean;
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
  machineType: string | null;
  executionState: ExecutionState;
  lastStopReason: StopReason;
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
  memSpace: MemSpaceName;
  enabled: boolean;
  stopWhenHit: boolean;
  hitCount: number;
  ignoreCount: number;
  currentlyHit: boolean;
  temporary: boolean;
  hasCondition: boolean;
  kind: BreakpointKind;
}

export interface SymbolItem {
  name: string;
  address: number;
  endAddress?: number;
  source?: string;
  line?: number;
  kind: 'function' | 'global' | 'label';
}

export interface SymbolSource {
  id: string;
  format: 'oscar64-json' | 'oscar64-asm';
  filePath: string;
  symbolCount: number;
  loadedAt: string;
}

export const sessionStatusSchema = z.object({
  configured: z.boolean(),
  status: sessionHealthSchema,
  machineType: z.string().nullable(),
  executionState: executionStateSchema,
  lastStopReason: stopReasonSchema,
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const toolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  category: z.enum([
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
  ]),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

export function memSpaceToProtocol(name: MemSpaceName): number {
  switch (name) {
    case 'main':
      return 0x00;
    case 'drive8':
      return 0x01;
    case 'drive9':
      return 0x02;
    case 'drive10':
      return 0x03;
    case 'drive11':
      return 0x04;
  }
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

export function defaultMachineProfile(machineType: string | null): MachineProfile | null {
  if (!machineType) {
    return null;
  }

  if (machineType.startsWith('x64') || machineType === 'c64') {
    return { machineType: 'c64', cpu: '6502', registerNamespace: '6502' };
  }

  if (machineType === 'x128') {
    return { machineType: 'c128', cpu: '8502', registerNamespace: '6502' };
  }

  return { machineType, cpu: '6502-family', registerNamespace: '6502' };
}
