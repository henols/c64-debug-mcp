import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

import {
  breakpointKindSchema,
  emulatorStatusSchema,
  emulatorConfigSchema,
  executionStateSchema,
  inputActionSchema,
  joystickControlSchema,
  joystickPortSchema,
  programLoadModeSchema,
  resetModeSchema,
} from './contracts.js';
import { normalizeToolError } from './errors.js';
import {
  address16Schema,
  breakpointSchema,
  byteArraySchema,
  c64PartialRegisterValueSchema,
  c64RegisterValueSchema,
  debugStateSchema,
  joystickInputResultSchema,
  keyboardInputResultSchema,
  programLoadResultSchema,
  toolOutputSchema,
  warningSchema,
} from './schemas.js';
import { ViceSession } from './session.js';

const viceSession = new ViceSession();
const noInputSchema = z.object({}).strict();

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
      try {
        const data = await options.execute(input as z.infer<TInput>);
        return {
          meta: viceSession.takeResponseMeta(),
          data,
        };
      } catch (error) {
        throw normalizeToolError(error);
      }
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
  inputSchema: noInputSchema,
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
  inputSchema: noInputSchema,
  dataSchema: z.object({
    config: emulatorConfigSchema,
  }),
  execute: async () => viceSession.getEmulatorConfig(),
});

const resetConfigTool = createViceTool({
  id: 'reset_config',
  description: 'Clears the managed emulator config and terminates the current emulator instance.',
  inputSchema: noInputSchema,
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
  inputSchema: noInputSchema,
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
    data: byteArraySchema.describe('Raw bytes returned from memory'),
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
      data: byteArraySchema.min(1).describe('Raw bytes to write into memory'),
    })
    .refine((input) => input.address + input.data.length - 1 <= 0xffff, {
      message: 'address + data.length must stay within the 16-bit address space',
      path: ['data'],
    }),
  dataSchema: z.object({
    worked: z.boolean().describe('Whether the write operation completed successfully'),
    address: address16Schema.describe('Start address where the bytes were written'),
    length: z.number().int().min(1).describe('Number of bytes written'),
  }).extend(debugStateSchema.shape),
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
  dataSchema: debugStateSchema.extend({
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
  dataSchema: debugStateSchema.extend({
    breakpoint: breakpointSchema,
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
  dataSchema: debugStateSchema.extend({
    cleared: z.boolean(),
    breakpointId: z.number().int(),
  }),
  execute: async (input) => await viceSession.breakpointClear(input.breakpointId),
});

const programLoadTool = createViceTool({
  id: 'program_load',
  description: 'Loads a program either directly into memory or through VICE autostart.',
  inputSchema: z.object({
    filePath: z.string(),
    mode: programLoadModeSchema.describe('Use memory to insert bytes directly or autostart to delegate loading to VICE'),
    address: address16Schema.optional().describe('Optional override load address for memory mode'),
    runAfterLoading: z.boolean().default(true).describe('Whether autostart should immediately run after loading'),
    fileIndex: z.number().int().nonnegative().default(0).describe('Autostart file index inside the image, when applicable'),
  }),
  dataSchema: programLoadResultSchema,
  execute: async (input) => await viceSession.programLoad(input),
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
  inputSchema: noInputSchema,
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
  inputSchema: noInputSchema,
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

const keyboardInputTool = createViceTool({
  id: 'keyboard_input',
  description: 'Applies low-level keyboard-style input using symbolic key names on top of the VICE keyboard buffer.',
  inputSchema: z.object({
    action: inputActionSchema.describe('Use tap for a single key event or press/release for repeated buffered input'),
    key: z.string().min(1).describe('Single ASCII key or symbolic key name such as SPACE or ENTER'),
    durationMs: z.number().int().positive().optional().describe('Tap duration in milliseconds'),
  }),
  dataSchema: keyboardInputResultSchema,
  execute: async (input) => await viceSession.keyboardInput(input.action, input.key, input.durationMs),
});

const joystickInputTool = createViceTool({
  id: 'joystick_input',
  description: 'Applies joystick input on C64 joystick port 1 or 2 with press, release, or tap semantics.',
  inputSchema: z.object({
    port: joystickPortSchema.describe('Joystick port number'),
    action: inputActionSchema.describe('Joystick action to apply'),
    control: joystickControlSchema.describe('Joystick direction or fire control'),
    durationMs: z.number().int().positive().optional().describe('Tap duration in milliseconds'),
  }),
  dataSchema: joystickInputResultSchema,
  execute: async (input) => await viceSession.joystickInput(input.port, input.action, input.control, input.durationMs),
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
    program_load: programLoadTool,
    capture_display: captureDisplayTool,
    get_banks: getBanksTool,
    get_info: getInfoTool,
    send_keys: sendKeysTool,
    keyboard_input: keyboardInputTool,
    joystick_input: joystickInputTool,
  },
});

export { viceSession };
