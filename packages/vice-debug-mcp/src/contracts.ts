import { z } from 'zod';

export const VICE_API_VERSION = 0x02;
export const VICE_STX = 0x02;
export const VICE_BROADCAST_REQUEST_ID = 0xffffffff;
export const DEFAULT_MONITOR_HOST = '127.0.0.1';
export const DEFAULT_RESUME_POLICY = 'preserve_pause_state' as const;
export const DEFAULT_ATTACH_RECONNECT_POLICY = 'never' as const;
export const DEFAULT_MANAGED_RECONNECT_POLICY = 'managed_only' as const;
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
export const reconnectPolicySchema = z.enum(['never', 'always', 'managed_only']);
export const resumePolicySchema = z.enum(['preserve_pause_state', 'resume_after_mutation', 'always_resume']);
export const breakpointKindSchema = z.enum(['exec', 'read', 'write', 'read_write']);
export const resetModeSchema = z.enum(['soft', 'hard']);
export const memSpaceSchema = z.enum(['main', 'drive8', 'drive9', 'drive10', 'drive11']);

export type TransportState = z.infer<typeof transportStateSchema>;
export type EmulatorOwnership = z.infer<typeof emulatorOwnershipSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;
export type ReconnectPolicy = z.infer<typeof reconnectPolicySchema>;
export type ResumePolicy = z.infer<typeof resumePolicySchema>;
export type BreakpointKind = z.infer<typeof breakpointKindSchema>;
export type ResetMode = z.infer<typeof resetModeSchema>;
export type MemSpaceName = z.infer<typeof memSpaceSchema>;

export interface ToolWarning {
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

export interface ViceMachineProfile {
  machineType: string;
  cpu: string;
  registerNamespace: string;
}

export interface SessionSnapshot {
  sessionId: string | null;
  transportState: TransportState;
  emulatorOwnership: EmulatorOwnership;
  processState: ProcessState;
  executionState: ExecutionState;
  lastStopReason: StopReason;
  machineType: string | null;
  machineProfile: ViceMachineProfile | null;
  binaryMonitorEndpoint: {
    host: string | null;
    port: number | null;
  };
  activePolicies: {
    reconnectPolicy: ReconnectPolicy;
    resumePolicy: ResumePolicy;
  };
  connectedSince: string | null;
  lastResponseAt: string | null;
  processId: number | null;
  warnings: ToolWarning[];
}

export interface ProtocolRegisterItem {
  id: number;
  name: string;
  widthBits: number;
  value?: number;
}

export interface BreakpointRecord {
  id: number;
  start: number;
  startHex: string;
  end: number;
  endHex: string;
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

export interface SymbolRecord {
  name: string;
  address: number;
  addressHex: string;
  endAddress?: number;
  endAddressHex?: string;
  source?: string;
  line?: number;
  kind: 'function' | 'global' | 'label';
}

export interface SymbolSourceRecord {
  id: string;
  format: 'oscar64-json' | 'oscar64-asm';
  filePath: string;
  symbolCount: number;
  loadedAt: string;
}

export const sessionStatusSchema = z.object({
  sessionId: z.string().nullable(),
  transportState: transportStateSchema,
  emulatorOwnership: emulatorOwnershipSchema,
  processState: processStateSchema,
  executionState: executionStateSchema,
  lastStopReason: stopReasonSchema,
  machineType: z.string().nullable(),
  machineProfile: z
    .object({
      machineType: z.string(),
      cpu: z.string(),
      registerNamespace: z.string(),
    })
    .nullable(),
  binaryMonitorEndpoint: z.object({
    host: z.string().nullable(),
    port: z.number().int().nullable(),
  }),
  activePolicies: z.object({
    reconnectPolicy: reconnectPolicySchema,
    resumePolicy: resumePolicySchema,
  }),
  connectedSince: z.string().nullable(),
  lastResponseAt: z.string().nullable(),
  processId: z.number().int().nullable(),
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

export function normalizeHex(value: number, width = 4): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

export function parseHexLike(value: string, fieldName: string): number {
  const normalized = value.trim().toLowerCase().startsWith('0x') ? value.trim().slice(2) : value.trim();
  if (!/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error(`${fieldName} must be a hex string`);
  }
  return Number.parseInt(normalized, 16);
}

export function parseOptionalHexLike(value: string | undefined | null, fieldName: string): number | null {
  if (value == null) {
    return null;
  }

  return parseHexLike(value, fieldName);
}

export function parseByteString(data: string): Uint8Array {
  const cleaned = data.trim();
  if (!cleaned) {
    return new Uint8Array();
  }

  const parts = cleaned.split(/[\s,-]+/).filter(Boolean);
  return Uint8Array.from(parts.map((part) => Number.parseInt(part.replace(/^0x/i, ''), 16)));
}

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

export function defaultMachineProfile(machineType: string | null): ViceMachineProfile | null {
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
