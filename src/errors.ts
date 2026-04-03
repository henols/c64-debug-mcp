import { ZodError } from 'zod';

import { type ToolError } from './contracts.js';
import { toolErrorSchema } from './schemas.js';

export class ViceMcpError extends Error {
  readonly code: string;
  readonly category: ToolError['category'];
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    category: ToolError['category'],
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ViceMcpError';
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.details = details;
  }
}

export function validationError(message: string, details?: Record<string, unknown>): never {
  throw new ViceMcpError('validation_error', message, 'validation', false, details);
}

export function debuggerNotPausedError(commandName: string, details?: Record<string, unknown>): never {
  throw new ViceMcpError(
    'debugger_not_paused',
    `${commandName} can only be executed when the emulator is stopped.`,
    'session_state',
    false,
    { commandName, requiredState: 'stopped', ...details },
  );
}

export function emulatorNotRunningError(commandName: string, details?: Record<string, unknown>): never {
  throw new ViceMcpError(
    'emulator_not_running',
    `${commandName} can only be executed when the emulator is running.`,
    'session_state',
    false,
    { commandName, requiredState: 'running', ...details },
  );
}

export function unsupportedError(message: string, details?: Record<string, unknown>): never {
  throw new ViceMcpError('unsupported', message, 'unsupported', false, details);
}

function asToolError(error: ViceMcpError): ToolError {
  return toolErrorSchema.parse({
    code: error.code,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    details: error.details,
  });
}

function zodDetails(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
    })),
  };
}

function publicMessageFor(error: ViceMcpError): string {
  switch (error.code) {
    case 'debugger_not_paused':
      return error.message;
    case 'emulator_not_running':
      return error.message;
    case 'validation_error':
    case 'invalid_prg':
    case 'unsupported':
    case 'program_file_missing':
    case 'program_file_invalid':
      return error.message;
    case 'binary_not_found':
    case 'spawn_failed':
    case 'emulator_crashed_on_startup':
      return error.message;
    case 'port_allocation_failed':
    case 'port_in_use':
      return 'The server could not start a usable emulator session. Check the emulator configuration and try again.';
    case 'monitor_timeout':
      return error.message;
    case 'not_connected':
    case 'connection_closed':
    case 'socket_write_failed':
    case 'timeout':
      return 'The server could not communicate with the emulator. Try the request again.';
    case 'protocol_invalid_stx':
    case 'emulator_protocol_error':
      return 'The emulator returned an unexpected debugger response. Try the request again.';
    default:
      switch (error.category) {
        case 'validation':
        case 'session_state':
        case 'unsupported':
          return error.message;
        case 'configuration':
        case 'process_launch':
          return 'The server could not start the emulator with the current configuration.';
        case 'connection':
        case 'timeout':
          return 'The server could not communicate with the emulator. Try the request again.';
        case 'protocol':
          return 'The emulator returned an unexpected debugger response. Try the request again.';
        case 'io':
          return 'The requested file operation could not be completed.';
        case 'internal':
          return 'The server hit an unexpected error.';
      }
  }
}

function publicDetailsFor(error: ViceMcpError): Record<string, unknown> | undefined {
  switch (error.code) {
    case 'binary_not_found':
    case 'spawn_failed':
    case 'emulator_crashed_on_startup':
      return error.details;
    default:
      switch (error.category) {
        case 'validation':
        case 'session_state':
        case 'unsupported':
        case 'io':
          return error.details;
        default:
          return undefined;
      }
  }
}

export function normalizeToolError(error: unknown): ViceMcpError {
  if (error instanceof ViceMcpError) {
    const normalized = asToolError(error);
    return new ViceMcpError(
      normalized.code,
      publicMessageFor(error),
      normalized.category,
      normalized.retryable,
      publicDetailsFor(error),
    );
  }

  if (error instanceof ZodError) {
    return new ViceMcpError(
      'validation_error',
      error.issues.map((issue) => issue.message).join('; ') || 'Validation failed',
      'validation',
      false,
      zodDetails(error),
    );
  }

  if (error instanceof Error) {
    return new ViceMcpError('internal_error', 'The server hit an unexpected error.', 'internal', false);
  }

  return new ViceMcpError('internal_error', 'The server hit an unexpected error.', 'internal', false);
}
