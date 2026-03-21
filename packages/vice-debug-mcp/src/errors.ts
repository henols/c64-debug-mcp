import { toolErrorSchema, type ToolError } from './contracts.js';

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

export function sessionStateError(message: string, details?: Record<string, unknown>): never {
  throw new ViceMcpError('session_state_error', message, 'session_state', false, details);
}

export function debuggerNotPausedError(details?: Record<string, unknown>): never {
  throw new ViceMcpError(
    'debugger_not_paused',
    'Debugger tools require the emulator to be paused first. Call execute(action="pause") before reading or mutating debug state.',
    'session_state',
    false,
    details,
  );
}

export function unsupportedError(message: string, details?: Record<string, unknown>): never {
  throw new ViceMcpError('unsupported', message, 'unsupported', false, details);
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof ViceMcpError) {
    return toolErrorSchema.parse({
      code: error.code,
      message: error.message,
      category: error.category,
      retryable: error.retryable,
      details: error.details,
    });
  }

  if (error instanceof Error) {
    return toolErrorSchema.parse({
      code: 'internal_error',
      message: error.message,
      category: 'internal',
      retryable: false,
    });
  }

  return toolErrorSchema.parse({
    code: 'internal_error',
    message: 'Unknown error',
    category: 'internal',
    retryable: false,
  });
}

export async function wrapToolResult<T>(operation: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: ToolError }> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: toToolError(error) };
  }
}
