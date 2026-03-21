import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

import {
  C64_REGISTER_DEFINITIONS,
  breakpointKindSchema,
  emulatorStatusSchema,
  emulatorConfigSchema,
  executionStateSchema,
  resetModeSchema,
  responseMetaSchema,
  stopReasonSchema,
} from './contracts.js';
import { ViceSession } from './session.js';

const viceSession = new ViceSession();

const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const address16Schema = z.number().int().min(0).max(0xffff);

const breakpointSchema = z.object({
  id: z.number().int().describe('Breakpoint identifier'),
  address: address16Schema.describe('Start address of the breakpoint range'),
  length: z.number().int().positive().describe('Size of the breakpoint range in bytes'),
  enabled: z.boolean().describe('Whether the breakpoint is enabled'),
  temporary: z.boolean().describe('Whether the breakpoint is temporary'),
  hasCondition: z.boolean().describe('Whether the breakpoint has a condition expression'),
  kind: breakpointKindSchema.describe('Breakpoint trigger kind'),
  label: z.string().nullable().optional().describe('Optional caller-provided label'),
});

function buildC64RegisterValueSchema() {
  return z.object(
    Object.fromEntries(
      C64_REGISTER_DEFINITIONS.map((register) => [
        register.fieldName,
        z.number().int().min(register.min).max(register.max).describe(register.description),
      ]),
    ) as Record<string, z.ZodNumber>,
  );
}

function buildC64PartialRegisterValueSchema() {
  return z.object(
    Object.fromEntries(
      C64_REGISTER_DEFINITIONS.map((register) => [
        register.fieldName,
        z.number().int().min(register.min).max(register.max).describe(register.description).optional(),
      ]),
    ) as Record<string, z.ZodOptional<z.ZodNumber>>,
  );
}

const c64RegisterValueSchema = buildC64RegisterValueSchema();
const c64PartialRegisterValueSchema = buildC64PartialRegisterValueSchema();
const debugStateSchema = z.object({
  executionState: executionStateSchema.describe('Current execution state of the emulator'),
  lastStopReason: stopReasonSchema.describe('Reason the emulator most recently stopped in the monitor'),
  programCounter: address16Schema.describe('Current program counter'),
  registers: c64RegisterValueSchema,
});

function toolOutputSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    meta: responseMetaSchema,
    data: dataSchema,
  });
}

function createViceTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(options: {
  id: string;
  description: string;
  inputSchema?: TInput;
  dataSchema: TOutput;
  execute: (input: z.infer<TInput>) => Promise<z.infer<TOutput>> | z.infer<TOutput>;
  mcp?: {
    annotations?: {
      title?: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
}) {
  return createTool({
    id: options.id,
    description: options.description,
    ...(options.inputSchema ? { inputSchema: options.inputSchema } : {}),
    outputSchema: toolOutputSchema(options.dataSchema),
    mcp: options.mcp,
    execute: async (input) => {
      const data = await options.execute(input as z.infer<TInput>);
      return {
        meta: viceSession.takeResponseMeta(),
        data,
      };
    },
  });
}

function normalizeBreakpoint(
  breakpoint: {
    id: number;
    start: number;
    end: number;
    enabled: boolean;
    temporary: boolean;
    hasCondition: boolean;
    kind: z.infer<typeof breakpointKindSchema>;
  },
  label: string | null = null,
) {
  return {
    id: breakpoint.id,
    address: breakpoint.start,
    length: breakpoint.end - breakpoint.start + 1,
    enabled: breakpoint.enabled,
    temporary: breakpoint.temporary,
    hasCondition: breakpoint.hasCondition,
    kind: breakpoint.kind,
    label,
  };
}

const getEmulatorStatusTool = createViceTool({
  id: 'get_emulator_status',
  description: 'Returns emulator configuration and readiness state without debugger details.',
  dataSchema: emulatorStatusSchema,
  mcp: {
    annotations: {
      title: 'Emulator Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  execute: async () => viceSession.status(),
});

const setEmulatorConfigTool = createViceTool({
  id: 'set_emulator_config',
  description: 'Sets the managed emulator config and immediately launches or relaunches the emulator.',
  inputSchema: emulatorConfigSchema,
  dataSchema: z.object({
    config: emulatorConfigSchema,
    session: emulatorStatusSchema,
  }),
  execute: async (input) => await viceSession.setEmulatorConfig(input),
});

const getEmulatorConfigTool = createViceTool({
  id: 'get_emulator_config',
  description: 'Returns the current managed emulator config.',
  dataSchema: z.object({
    config: emulatorConfigSchema.nullable(),
  }),
  execute: async () => viceSession.getEmulatorConfig(),
});

const resetConfigTool = createViceTool({
  id: 'reset_config',
  description: 'Clears the managed emulator config and terminates the current emulator instance.',
  dataSchema: z.object({
    cleared: z.boolean(),
    hadConfig: z.boolean(),
    session: emulatorStatusSchema,
  }),
  execute: async () => await viceSession.resetConfig(),
});

const getDebugStateTool = createViceTool({
  id: 'get_debug_state',
  description: 'Returns the current debugger state with program counter and C64 registers.',
  dataSchema: debugStateSchema,
  execute: async () => await viceSession.getDebugState(),
});

const setRegistersTool = createViceTool({
  id: 'set_registers',
  description: 'Sets one or more C64 registers by field name.',
  inputSchema: z.object({
    registers: c64PartialRegisterValueSchema,
  }),
  dataSchema: z.object({
    updated: c64PartialRegisterValueSchema,
    executionState: executionStateSchema,
  }),
  execute: async (input) => await viceSession.setRegisters(input.registers),
});

const readMemoryTool = createViceTool({
  id: 'memory_read',
  description: 'Reads an inclusive memory range and returns raw bytes as a JSON array.',
  inputSchema: z
    .object({
      address: address16Schema.describe('Start address in the 16-bit C64 address space'),
      length: z.number().int().positive().max(0xFFFF).describe('Size of the data chunk to read in bytes'),
    })
    .refine((input) => input.address + input.length <= 0x10000, {
      message: 'address + length must stay within the 64K address space',
      path: ['length'],
    }),
  dataSchema: z.object({
    address: address16Schema.describe('Start address of the returned memory chunk'),
    length: z.number().int().min(0).describe('Number of bytes returned'),
    data: z.array(z.number().int().min(0).max(255)).describe('Raw bytes returned from memory'),
  }),
  execute: async (input) => {
    const result = await viceSession.readMemory(input.address, input.address + input.length - 1);
    return {
      address: input.address,
      length: result.length,
      data: result.data,
    };
  },
});

const writeMemoryTool = createViceTool({
  id: 'memory_write',
  description: 'Writes raw byte values into the active VICE memory space.',
  inputSchema: z
    .object({
      address: address16Schema.describe('Start address in the 16-bit C64 address space'),
      data: z.array(z.number().int().min(0).max(255)).min(1).describe('Raw bytes to write into memory'),
    })
    .refine((input) => input.address + input.data.length - 1 <= 0xffff, {
      message: 'address + data.length must stay within the 16-bit address space',
      path: ['data'],
    }),
  dataSchema: z.object({
    worked: z.boolean().describe('Whether the write operation completed successfully'),
    address: address16Schema.describe('Start address where the bytes were written'),
    length: z.number().int().min(1).describe('Number of bytes written'),
    executionState: executionStateSchema,
    lastStopReason: stopReasonSchema,
    programCounter: address16Schema,
    registers: c64RegisterValueSchema,
  }),
  execute: async (input) => await viceSession.writeMemory(input.address, input.data),
});

const executeTool = createViceTool({
  id: 'execute',
  description: 'Controls execution with pause, resume, step, step_over, step_out, or reset.',
  inputSchema: z.object({
    action: z.enum(['pause', 'resume', 'step', 'step_over', 'step_out', 'reset']),
    count: z.number().int().positive().default(1).describe('Instruction count for step and step_over actions'),
    resetMode: resetModeSchema.default('soft').describe('Reset mode when action is reset'),
  }),
  dataSchema: z.object({
    executionState: executionStateSchema,
    lastStopReason: stopReasonSchema,
    programCounter: address16Schema,
    registers: c64RegisterValueSchema,
    stepsExecuted: z.number().int().positive().optional(),
    warnings: z.array(warningSchema),
  }),
  execute: async (input) => await viceSession.execute(input.action, input.count, input.resetMode),
});

const listBreakpointsTool = createViceTool({
  id: 'list_breakpoints',
  description: 'Lists current breakpoints and watchpoints.',
  inputSchema: z.object({
    includeDisabled: z.boolean().default(true),
  }),
  dataSchema: z.object({
    breakpoints: z.array(breakpointSchema),
  }),
  execute: async (input) => {
    const result = await viceSession.listBreakpoints(input.includeDisabled);
    return {
      breakpoints: result.breakpoints.map((breakpoint) => normalizeBreakpoint(breakpoint)),
    };
  },
});

const getBreakpointTool = createViceTool({
  id: 'get_breakpoint',
  description: 'Returns a single breakpoint or watchpoint by numeric id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  dataSchema: z.object({
    breakpoint: breakpointSchema,
  }),
  execute: async (input) => {
    const result = await viceSession.getBreakpoint(input.breakpointId);
    return {
      breakpoint: normalizeBreakpoint(result.breakpoint),
    };
  },
});

const breakpointSetTool = createViceTool({
  id: 'breakpoint_set',
  description: 'Creates an execution breakpoint or read/write watchpoint.',
  inputSchema: z.object({
    kind: breakpointKindSchema,
    address: address16Schema.describe('Start address of the breakpoint range'),
    length: z.number().int().positive().default(1).describe('Size of the breakpoint range in bytes'),
    condition: z.string().optional(),
    label: z.string().optional(),
    temporary: z.boolean().default(false),
    enabled: z.boolean().default(true),
  }),
  dataSchema: z.object({
    breakpoint: breakpointSchema,
    executionState: executionStateSchema,
    lastStopReason: stopReasonSchema,
    programCounter: address16Schema,
    registers: c64RegisterValueSchema,
  }),
  execute: async (input) => {
    const result = await viceSession.breakpointSet(input);
    return {
      breakpoint: normalizeBreakpoint(result.breakpoint, result.breakpoint.label ?? null),
      executionState: result.executionState,
      lastStopReason: result.lastStopReason,
      programCounter: result.programCounter,
      registers: result.registers,
    };
  },
});

const breakpointClearTool = createViceTool({
  id: 'breakpoint_clear',
  description: 'Deletes a breakpoint by numeric id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  dataSchema: z.object({
    cleared: z.boolean(),
    breakpointId: z.number().int(),
    executionState: executionStateSchema,
    lastStopReason: stopReasonSchema,
    programCounter: address16Schema,
    registers: c64RegisterValueSchema,
  }),
  execute: async (input) => await viceSession.breakpointClear(input.breakpointId),
});

const loadProgramTool = createViceTool({
  id: 'load_program',
  description: 'Loads a PRG into memory using its header load address unless overridden.',
  inputSchema: z.object({
    filePath: z.string(),
    address: address16Schema.optional().describe('Optional override load address in the 16-bit C64 address space'),
  }),
  dataSchema: z.object({
    filePath: z.string(),
    start: address16Schema.describe('Load address used for the program'),
    length: z.number().int().min(0).describe('Number of bytes written'),
    written: z.boolean().describe('Whether the program was loaded successfully'),
  }),
  execute: async (input) => await viceSession.loadProgram(input.filePath, input.address ?? null),
});

const autostartProgramTool = createViceTool({
  id: 'autostart_program',
  description: 'Asks VICE to autostart a program file.',
  inputSchema: z.object({
    filePath: z.string(),
    runAfterLoading: z.boolean().default(true),
    fileIndex: z.number().int().nonnegative().default(0),
  }),
  dataSchema: z.object({
    filePath: z.string(),
    runAfterLoading: z.boolean(),
    fileIndex: z.number().int(),
    executionState: executionStateSchema,
  }),
  execute: async (input) => await viceSession.autostartProgram(input.filePath, input.runAfterLoading, input.fileIndex),
});

const captureDisplayTool = createViceTool({
  id: 'capture_display',
  description: 'Captures the current display and returns indexed pixel data plus a grayscale PNG fallback.',
  inputSchema: z.object({
    useVic: z.boolean().default(true),
  }),
  dataSchema: z.object({
    width: z.number().int(),
    height: z.number().int(),
    bitsPerPixel: z.number().int(),
    debugWidth: z.number().int(),
    debugHeight: z.number().int(),
    debugOffsetX: z.number().int(),
    debugOffsetY: z.number().int(),
    pixelDataBase64: z.string(),
    pngBase64: z.string().nullable(),
    warnings: z.array(warningSchema),
  }),
  execute: async (input) => await viceSession.captureDisplay(input.useVic),
});

const getBanksTool = createViceTool({
  id: 'get_banks',
  description: 'Lists VICE memory banks.',
  dataSchema: z.object({
    banks: z.array(
      z.object({
        id: z.number().int(),
        name: z.string(),
      }),
    ),
  }),
  execute: async () => await viceSession.getBanks(),
});

const getInfoTool = createViceTool({
  id: 'get_info',
  description: 'Returns VICE version information.',
  dataSchema: z.object({
    viceVersion: z.string(),
    versionComponents: z.array(z.number().int()),
    svnVersion: z.number().int(),
  }),
  execute: async () => await viceSession.getInfo(),
});

const sendKeysTool = createViceTool({
  id: 'send_keys',
  description: 'Feeds keys into the emulator keyboard buffer.',
  inputSchema: z.object({
    keys: z.string(),
  }),
  dataSchema: z.object({
    sent: z.boolean(),
    length: z.number().int(),
  }),
  execute: async (input) => await viceSession.sendKeys(input.keys),
});

export const viceDebugServer = new MCPServer({
  id: 'vice-debug-mcp',
  name: 'VICE Debug MCP',
  version: '0.1.0',
  description: 'Structured Mastra MCP server for VICE debugging with a config-driven self-healing managed emulator.',
  instructions:
    'Set emulator config first. After that, use emulator-native debugger tools normally. The server owns emulator launch, restart, connection recovery, and monitor port management.',
  tools: {
    get_emulator_status: getEmulatorStatusTool,
    set_emulator_config: setEmulatorConfigTool,
    get_emulator_config: getEmulatorConfigTool,
    reset_config: resetConfigTool,
    get_debug_state: getDebugStateTool,
    set_registers: setRegistersTool,
    memory_read: readMemoryTool,
    memory_write: writeMemoryTool,
    execute: executeTool,
    list_breakpoints: listBreakpointsTool,
    get_breakpoint: getBreakpointTool,
    breakpoint_set: breakpointSetTool,
    breakpoint_clear: breakpointClearTool,
    load_program: loadProgramTool,
    autostart_program: autostartProgramTool,
    capture_display: captureDisplayTool,
    get_banks: getBanksTool,
    get_info: getInfoTool,
    send_keys: sendKeysTool,
  },
});

export { viceSession };
