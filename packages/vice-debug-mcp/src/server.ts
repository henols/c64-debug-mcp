import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

import {
  C64_REGISTER_DEFINITIONS,
  breakpointKindSchema,
  emulatorConfigSchema,
  memSpaceSchema,
  resetModeSchema,
  responseMetaSchema,
  sessionStatusSchema,
} from './contracts.js';
import { parseHexLike } from './contracts.js';
import { ViceSession } from './session.js';

const viceSession = new ViceSession();

const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const breakpointSchema = z.object({
  id: z.number().int(),
  start: z.number().int(),
  startHex: z.string(),
  end: z.number().int(),
  endHex: z.string(),
  memSpace: memSpaceSchema,
  enabled: z.boolean(),
  stopWhenHit: z.boolean(),
  hitCount: z.number().int(),
  ignoreCount: z.number().int(),
  currentlyHit: z.boolean(),
  temporary: z.boolean(),
  hasCondition: z.boolean(),
  kind: breakpointKindSchema,
});

const labeledBreakpointSchema = breakpointSchema.extend({
  label: z.string().nullable(),
});

const symbolSchema = z.object({
  name: z.string(),
  address: z.number().int(),
  addressHex: z.string(),
  endAddress: z.number().int().optional(),
  endAddressHex: z.string().optional(),
  source: z.string().optional(),
  line: z.number().int().optional(),
  kind: z.enum(['function', 'global', 'label']),
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

function buildC64RegisterMetadataSchema() {
  return z.object(
    Object.fromEntries(
      C64_REGISTER_DEFINITIONS.map((register) => [
        register.fieldName,
        z.object({
          widthBits: z.literal(register.widthBits),
          min: z.literal(register.min),
          max: z.literal(register.max),
          description: z.literal(register.description),
        }),
      ]),
    ) as Record<string, z.ZodObject<any>>,
  );
}

const c64RegisterValueSchema = buildC64RegisterValueSchema();
const c64PartialRegisterValueSchema = buildC64PartialRegisterValueSchema();
const c64RegisterMetadataSchema = buildC64RegisterMetadataSchema();
const address16Schema = z.number().int().min(0).max(0xffff);

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

const sessionStatusTool = createViceTool({
  id: 'session_status',
  description: 'Returns explicit VICE session, process, recovery, and execution state.',
  dataSchema: sessionStatusSchema,
  mcp: {
    annotations: {
      title: 'Session Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  execute: async () => viceSession.snapshot(),
});

const setEmulatorConfigTool = createViceTool({
  id: 'set_emulator_config',
  description: 'Sets the managed emulator config and immediately launches or relaunches the emulator.',
  inputSchema: emulatorConfigSchema,
  dataSchema: z.object({
    config: emulatorConfigSchema,
    session: sessionStatusSchema,
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
    session: sessionStatusSchema,
  }),
  execute: async () => await viceSession.resetConfig(),
});

const getRegistersTool = createViceTool({
  id: 'get_registers',
  description: 'Returns C64 register values as a keyed object.',
  dataSchema: z.object({
    machine: z.string(),
    registers: c64RegisterValueSchema,
  }),
  execute: async () => await viceSession.getRegisters(),
});

const setRegistersTool = createViceTool({
  id: 'set_registers',
  description: 'Sets one or more C64 registers by field name.',
  inputSchema: z.object({
    registers: c64PartialRegisterValueSchema,
  }),
  dataSchema: z.object({
    updated: c64PartialRegisterValueSchema,
    executionState: z.string(),
  }),
  execute: async (input) => await viceSession.setRegisters(input.registers),
});

const readMemoryTool = createViceTool({
  id: 'read_memory',
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
    length: z.number().int().min(0).describe('Number of bytes returned'),
    data: z.array(z.number().int().min(0).max(255)).describe('Raw bytes returned from memory'),
  }),
  execute: async (input) => {
    const result = await viceSession.readMemory(input.address, input.address + input.length - 1);
    return {
      length: result.length,
      data: result.data,
    };
  },
});

const writeMemoryTool = createViceTool({
  id: 'write_memory',
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
  }),
  execute: async (input) => {
    await viceSession.writeMemory(input.address, input.data);
    return {
      worked: true,
    };
  },
});


const continueExecutionTool = createViceTool({
  id: 'continue_execution',
  description: 'Continues execution from the current monitor stop.',
  dataSchema: z.object({
    executionState: z.string(),
    lastStopReason: z.string(),
    warnings: z.array(warningSchema),
  }),
  execute: async () => await viceSession.continueExecution(),
});

const stepInstructionTool = createViceTool({
  id: 'step_instruction',
  description: 'Steps forward by one or more instructions.',
  inputSchema: z.object({
    count: z.number().int().positive().default(1),
  }),
  dataSchema: z.object({
    executionState: z.string(),
    lastStopReason: z.string(),
    programCounter: z.number().int().nullable(),
    programCounterHex: z.string().nullable(),
    stepsExecuted: z.number().int(),
    warnings: z.array(warningSchema),
  }),
  execute: async (input) => await viceSession.stepInstruction(input.count, false),
});

const stepOverTool = createViceTool({
  id: 'step_over',
  description: 'Steps over the current instruction or subroutine call.',
  inputSchema: z.object({
    count: z.number().int().positive().default(1),
  }),
  dataSchema: z.object({
    executionState: z.string(),
    lastStopReason: z.string(),
    programCounter: z.number().int().nullable(),
    programCounterHex: z.string().nullable(),
    stepsExecuted: z.number().int(),
    warnings: z.array(warningSchema),
  }),
  execute: async (input) => await viceSession.stepInstruction(input.count, true),
});

const stepOutTool = createViceTool({
  id: 'step_out',
  description: 'Runs until the current subroutine returns.',
  dataSchema: z.object({
    executionState: z.string(),
    lastStopReason: z.string(),
    programCounter: z.number().int().nullable(),
    programCounterHex: z.string().nullable(),
    warnings: z.array(warningSchema),
  }),
  execute: async () => await viceSession.stepOut(),
});

const resetMachineTool = createViceTool({
  id: 'reset_machine',
  description: 'Resets the machine.',
  inputSchema: z.object({
    mode: resetModeSchema.default('soft'),
  }),
  dataSchema: z.object({
    executionState: z.string(),
    lastStopReason: z.string(),
    warnings: z.array(warningSchema),
  }),
  execute: async (input) => await viceSession.resetMachine(input.mode ?? 'soft'),
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
  execute: async (input) => await viceSession.listBreakpoints(input.includeDisabled),
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
  execute: async (input) => await viceSession.getBreakpoint(input.breakpointId),
});

const setBreakpointTool = createViceTool({
  id: 'set_breakpoint',
  description: 'Creates an execution or memory-access breakpoint.',
  inputSchema: z.object({
    kind: breakpointKindSchema,
    start: z.string(),
    end: z.string().optional(),
    memSpace: memSpaceSchema.default('main'),
    condition: z.string().optional(),
    label: z.string().optional(),
    temporary: z.boolean().default(false),
    enabled: z.boolean().default(true),
  }),
  dataSchema: z.object({
    breakpoint: labeledBreakpointSchema,
  }),
  execute: async (input) =>
    await viceSession.setBreakpoint({
      kind: input.kind,
      start: parseHexLike(input.start, 'start'),
      end: input.end ? parseHexLike(input.end, 'end') : undefined,
      memSpace: input.memSpace,
      condition: input.condition,
      label: input.label,
      temporary: input.temporary,
      enabled: input.enabled,
    }),
});

const deleteBreakpointTool = createViceTool({
  id: 'delete_breakpoint',
  description: 'Deletes a breakpoint by numeric id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  dataSchema: z.object({
    deleted: z.boolean(),
    breakpointId: z.number().int(),
  }),
  execute: async (input) => await viceSession.deleteBreakpoint(input.breakpointId),
});

const enableBreakpointTool = createViceTool({
  id: 'enable_breakpoint',
  description: 'Enables a breakpoint by id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  dataSchema: z.object({
    breakpointId: z.number().int(),
    enabled: z.boolean(),
  }),
  execute: async (input) => await viceSession.enableBreakpoint(input.breakpointId, true),
});

const disableBreakpointTool = createViceTool({
  id: 'disable_breakpoint',
  description: 'Disables a breakpoint by id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  dataSchema: z.object({
    breakpointId: z.number().int(),
    enabled: z.boolean(),
  }),
  execute: async (input) => await viceSession.enableBreakpoint(input.breakpointId, false),
});

const setWatchpointTool = createViceTool({
  id: 'set_watchpoint',
  description: 'Creates a read/write watchpoint.',
  inputSchema: z.object({
    start: z.string(),
    end: z.string().optional(),
    accessKind: z.enum(['read', 'write', 'read_write']),
    memSpace: memSpaceSchema.default('main'),
    condition: z.string().optional(),
    label: z.string().optional(),
  }),
  dataSchema: z.object({
    breakpoint: labeledBreakpointSchema,
  }),
  execute: async (input) =>
    await viceSession.setWatchpoint(
      parseHexLike(input.start, 'start'),
      input.end ? parseHexLike(input.end, 'end') : undefined,
      input.accessKind,
      input.condition,
      input.label,
      input.memSpace,
    ),
});

const setBreakpointConditionTool = createViceTool({
  id: 'set_breakpoint_condition',
  description: 'Sets a write-only condition string on an existing breakpoint.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
    condition: z.string().min(1),
  }),
  dataSchema: z.object({
    breakpointId: z.number().int(),
    hasCondition: z.boolean(),
    conditionTrackedByServer: z.boolean(),
  }),
  execute: async (input) => await viceSession.setBreakpointCondition(input.breakpointId, input.condition),
});

const loadProgramTool = createViceTool({
  id: 'load_program',
  description: 'Loads a PRG into memory using its header load address unless overridden.',
  inputSchema: z.object({
    filePath: z.string(),
    addressHex: z.string().optional(),
  }),
  dataSchema: z.object({
    filePath: z.string(),
    start: z.number().int(),
    startHex: z.string(),
    length: z.number().int(),
    written: z.boolean(),
  }),
  execute: async (input) => await viceSession.loadProgram(input.filePath, input.addressHex ? parseHexLike(input.addressHex, 'addressHex') : null),
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
    executionState: z.string(),
  }),
  execute: async (input) => await viceSession.autostartProgram(input.filePath, input.runAfterLoading, input.fileIndex),
});

const loadSymbolsTool = createViceTool({
  id: 'load_symbols',
  description: 'Loads Oscar64 symbols from a JSON debug dump or assembly listing.',
  inputSchema: z.object({
    filePath: z.string(),
  }),
  dataSchema: z.object({
    id: z.string(),
    format: z.enum(['oscar64-json', 'oscar64-asm']),
    filePath: z.string(),
    symbolCount: z.number().int(),
    loadedAt: z.string(),
  }),
  execute: async (input) => await viceSession.loadSymbols(input.filePath),
});

const listSymbolSourcesTool = createViceTool({
  id: 'list_symbol_sources',
  description: 'Lists loaded symbol sources.',
  dataSchema: z.object({
    sources: z.array(
      z.object({
        id: z.string(),
        format: z.enum(['oscar64-json', 'oscar64-asm']),
        filePath: z.string(),
        symbolCount: z.number().int(),
        loadedAt: z.string(),
      }),
    ),
  }),
  execute: async () => viceSession.listSymbolSources(),
});

const lookupSymbolTool = createViceTool({
  id: 'lookup_symbol',
  description: 'Looks up a loaded symbol by exact name.',
  inputSchema: z.object({
    name: z.string(),
  }),
  dataSchema: z.object({
    symbol: symbolSchema,
  }),
  execute: async (input) => viceSession.lookupSymbol(input.name),
});

const setBreakpointAtSymbolTool = createViceTool({
  id: 'set_breakpoint_at_symbol',
  description: 'Resolves a loaded symbol and creates an execution breakpoint at that address.',
  inputSchema: z.object({
    name: z.string(),
    condition: z.string().optional(),
    temporary: z.boolean().default(false),
  }),
  dataSchema: z.object({
    symbol: symbolSchema,
    breakpoint: labeledBreakpointSchema,
  }),
  execute: async (input) => await viceSession.setBreakpointAtSymbol(input.name, input.condition, input.temporary),
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
    'Set emulator config first. After that, use debugger tools normally. The server owns emulator launch, restart, connection recovery, and monitor port management.',
  tools: {
    session_status: sessionStatusTool,
    set_emulator_config: setEmulatorConfigTool,
    get_emulator_config: getEmulatorConfigTool,
    reset_config: resetConfigTool,
    get_registers: getRegistersTool,
    set_registers: setRegistersTool,
    read_memory: readMemoryTool,
    write_memory: writeMemoryTool,
    continue_execution: continueExecutionTool,
    step_instruction: stepInstructionTool,
    step_over: stepOverTool,
    step_out: stepOutTool,
    reset_machine: resetMachineTool,
    list_breakpoints: listBreakpointsTool,
    get_breakpoint: getBreakpointTool,
    set_breakpoint: setBreakpointTool,
    delete_breakpoint: deleteBreakpointTool,
    enable_breakpoint: enableBreakpointTool,
    disable_breakpoint: disableBreakpointTool,
    set_watchpoint: setWatchpointTool,
    set_breakpoint_condition: setBreakpointConditionTool,
    load_program: loadProgramTool,
    autostart_program: autostartProgramTool,
    load_symbols: loadSymbolsTool,
    list_symbol_sources: listSymbolSourcesTool,
    lookup_symbol: lookupSymbolTool,
    set_breakpoint_at_symbol: setBreakpointAtSymbolTool,
    capture_display: captureDisplayTool,
    get_banks: getBanksTool,
    get_info: getInfoTool,
    send_keys: sendKeysTool,
  },
});

export { viceSession };
