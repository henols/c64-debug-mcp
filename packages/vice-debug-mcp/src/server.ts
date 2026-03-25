import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

import {
  breakpointKindSchema,
  executionStateSchema,
  inputActionSchema,
  joystickControlSchema,
  joystickPortSchema,
  resetModeSchema,
  stopReasonSchema,
} from './contracts.js';
import { normalizeToolError } from './errors.js';
import {
  address16Schema,
  breakpointSchema,
  byteArraySchema,
  c64RegisterValueSchema,
  c64PartialRegisterValueSchema,
  debugStateSchema,
  displayStateResultSchema,
  displayTextResultSchema,
  joystickInputResultSchema,
  keyboardInputResultSchema,
  monitorStateSchema,
  programLoadResultSchema,
  captureDisplayResultSchema,
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
    label?: string | null;
  },
) {
  return {
    id: breakpoint.id,
    address: breakpoint.start,
    length: breakpoint.end - breakpoint.start + 1,
    enabled: breakpoint.enabled,
    temporary: breakpoint.temporary,
    hasCondition: breakpoint.hasCondition,
    kind: breakpoint.kind,
    label: breakpoint.label ?? null,
  };
}

const getMonitorStateTool = createViceTool({
  id: 'get_monitor_state',
  description: 'Returns the current monitor/runtime state in any connected state.',
  inputSchema: noInputSchema,
  dataSchema: monitorStateSchema,
  execute: async () => await viceSession.getMonitorState(),
});

const getRegistersTool = createViceTool({
  id: 'get_registers',
  description: 'Returns the current C64 register snapshot. This requires the emulator to already be stopped.',
  inputSchema: noInputSchema,
  dataSchema: z.object({
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
  description: 'Writes raw byte values into the active C64 memory space.',
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
  description: 'Controls execution with resume, step, step_over, step_out, or reset.',
  inputSchema: z.object({
    action: z.enum(['resume', 'step', 'step_over', 'step_out', 'reset']),
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
    programCounter: address16Schema.nullable(),
    registers: c64PartialRegisterValueSchema.nullable(),
  }),
  execute: async (input) => {
    const result = await viceSession.breakpointSet(input);
    return {
      breakpoint: normalizeBreakpoint(result.breakpoint),
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
    executionState: executionStateSchema,
    lastStopReason: stopReasonSchema,
    programCounter: address16Schema.nullable(),
    registers: c64PartialRegisterValueSchema.nullable(),
    cleared: z.boolean(),
    breakpointId: z.number().int(),
  }),
  execute: async (input) => await viceSession.breakpointClear(input.breakpointId),
});

const programLoadTool = createViceTool({
  id: 'program_load',
  description: 'Loads a C64 program through the VICE binary monitor autostart command.',
  inputSchema: z.object({
    filePath: z.string(),
    autoStart: z.boolean().default(true).describe('Whether the loaded program should be started immediately after loading'),
    fileIndex: z.number().int().nonnegative().default(0).describe('Autostart file index inside the image, when applicable'),
  }),
  dataSchema: programLoadResultSchema,
  execute: async (input) => await viceSession.programLoad(input),
});

const captureDisplayTool = createViceTool({
  id: 'capture_display',
  description: 'Captures the current display, renders the visible screen to a PNG file, and returns the saved image path. It preserves the running/stopped state it started in.',
  inputSchema: z.object({
    useVic: z.boolean().default(true).describe('Whether to capture the VIC-II display when supported'),
  }),
  dataSchema: captureDisplayResultSchema,
  execute: async (input) => await viceSession.captureDisplay(input.useVic),
});

const getDisplayStateTool = createViceTool({
  id: 'get_display_state',
  description: 'Returns screen RAM, color RAM, active graphics mode, VIC memory pointers, and current background and border colors. It preserves the running/stopped state it started in.',
  inputSchema: noInputSchema,
  dataSchema: displayStateResultSchema,
  execute: async () => await viceSession.getDisplayState(),
});

const getDisplayTextTool = createViceTool({
  id: 'get_display_text',
  description: 'Decodes screen RAM to approximate ASCII text when the current graphics mode is a text mode. It preserves the running/stopped state it started in.',
  inputSchema: noInputSchema,
  dataSchema: displayTextResultSchema,
  execute: async () => await viceSession.getDisplayText(),
});

const writeTextTool = createViceTool({
  id: 'write_text',
  description: 'Writes text to the emulator keyboard buffer while the emulator is running, supporting escaped characters and PETSCII brace tokens like {RETURN}, {CLR}, {HOME}, {PI}, and color names.',
  inputSchema: z.object({
    text: z.string(),
  }),
  dataSchema: z.object({
    sent: z.boolean(),
    length: z.number().int(),
  }),
  execute: async (input) => await viceSession.writeText(input.text),
});

const keyboardInputTool = createViceTool({
  id: 'keyboard_input',
  description: 'Applies buffered keyboard input while the emulator is running using up to four literal keys or PETSCII token names such as RETURN, CLR, HOME, PI, or color names. This is keyboard-buffer input, not real key-matrix control.',
  inputSchema: z.object({
    action: inputActionSchema.describe('Use tap for a single key event or press/release for repeated buffered input'),
    keys: z.array(z.string().min(1)).min(1).max(4).describe('One to four literal keys or PETSCII token names such as RETURN, CLR, HOME, PI, LEFT, RED, or F1'),
    durationMs: z.number().int().positive().optional().describe('Tap duration in milliseconds'),
  }),
  dataSchema: keyboardInputResultSchema,
  execute: async (input) => await viceSession.keyboardInput(input.action, input.keys, input.durationMs),
});

const joystickInputTool = createViceTool({
  id: 'joystick_input',
  description: 'Applies joystick input while the emulator is running on C64 joystick port 1 or 2 with press, release, or tap semantics.',
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
  id: 'c64-debug-mcp',
  name: 'c64 debugger',
  version: '0.1.0',
  description: 'Structured Mastra MCP server for C64 debugging through x64sc with a self-healing managed emulator.',
  instructions:
    'This server is C64-only and always targets x64sc. The server owns emulator launch, restart, connection recovery, and monitor port management; use the debugger tools directly.',
  tools: {
    get_monitor_state: getMonitorStateTool,
    get_registers: getRegistersTool,
    set_registers: setRegistersTool,
    memory_read: readMemoryTool,
    memory_write: writeMemoryTool,
    execute: executeTool,
    list_breakpoints: listBreakpointsTool,
    breakpoint_set: breakpointSetTool,
    breakpoint_clear: breakpointClearTool,
    program_load: programLoadTool,
    capture_display: captureDisplayTool,
    get_display_state: getDisplayStateTool,
    get_display_text: getDisplayTextTool,
    write_text: writeTextTool,
    keyboard_input: keyboardInputTool,
    joystick_input: joystickInputTool,
  },
});

export { viceSession };
