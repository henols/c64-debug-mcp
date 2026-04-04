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
  sessionStateResultSchema,
  toolOutputSchema,
  waitForStateResultSchema,
  warningSchema,
  parseAddress16,
  parseByte,
} from './schemas.js';
import { ViceSession } from './session.js';

const c64Session = new ViceSession();
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
          meta: c64Session.takeResponseMeta(),
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
  description: 'Returns whether the C64 is running or stopped, along with the current stop reason and program counter when available.',
  inputSchema: noInputSchema,
  dataSchema: monitorStateSchema,
  execute: async () => await c64Session.getMonitorState(),
});

const getSessionStateTool = createViceTool({
  id: 'get_session_state',
  description: 'Returns emulator session state including transport/process status, auto-resume state, and the most recent hit checkpoint.',
  inputSchema: noInputSchema,
  dataSchema: sessionStateResultSchema,
  execute: async () => await c64Session.getSessionState(),
});

const getRegistersTool = createViceTool({
  id: 'get_registers',
  description: 'Returns the current C64 register snapshot. Requires emulator to be stopped - call execute(action="pause") first if running.',
  inputSchema: noInputSchema,
  dataSchema: z.object({
    registers: c64RegisterValueSchema,
  }),
  execute: async () => await c64Session.getRegisters(),
});

const setRegistersTool = createViceTool({
  id: 'set_registers',
  description: 'Sets one or more C64 registers by field name. Requires emulator to be stopped - call execute(action="pause") first if running.',
  inputSchema: z.object({
    registers: c64PartialRegisterValueSchema,
  }),
  dataSchema: z.object({
    updated: c64PartialRegisterValueSchema,
    executionState: executionStateSchema,
  }),
  execute: async (input) => await c64Session.setRegisters(input.registers),
});

const readMemoryTool = createViceTool({
  id: 'memory_read',
  description: 'Reads a memory chunk. Use either (address, length) or (start, end) format. Addresses can be decimal (53248) or hex string with prefix ($D000, 0xD000). Returns byte values as decimal numbers.',
  inputSchema: z.union([
    z.object({
      address: address16Schema.describe('Start address: decimal (53248) or hex string with prefix ($D000, 0xD000)'),
      length: z.number().int().positive().max(0xFFFF).describe('Number of bytes to read'),
    }),
    z.object({
      start: address16Schema.describe('Start address (inclusive): decimal (53248) or hex string with prefix ($D000, 0xD000)'),
      end: address16Schema.describe('End address (inclusive): decimal (53248) or hex string with prefix ($D000, 0xD000)'),
    }),
  ]),
  dataSchema: z.object({
    address: address16Schema.describe('Start address of the returned memory chunk'),
    length: z.number().int().min(0).describe('Number of bytes returned'),
    data: byteArraySchema.describe('Raw bytes returned from memory'),
  }),
  execute: async (input) => {
    // Normalize start/end to address/length and parse addresses
    let address: number;
    let length: number;

    if ('start' in input && 'end' in input) {
      const start = parseAddress16(input.start);
      const end = parseAddress16(input.end);
      if (end < start) {
        throw new Error('End address must be greater than or equal to start address');
      }
      address = start;
      length = end - start + 1;
    } else if ('address' in input && 'length' in input) {
      address = parseAddress16(input.address);
      length = input.length;
    } else {
      throw new Error('Invalid input: must provide either (address, length) or (start, end)');
    }

    // Validate address space
    if (address + length > 0x10000) {
      throw new Error('address + length must stay within the 64K address space');
    }

    const result = await c64Session.readMemory(address, address + length - 1);
    return {
      address,
      length: result.length,
      data: result.data,
    };
  },
});

const writeMemoryTool = createViceTool({
  id: 'memory_write',
  description: 'Writes raw byte values into C64 memory. Address and byte values support decimal, hex ($FF, 0xFF), and binary (%11111111, 0b11111111) formats. Requires emulator to be stopped.',
  inputSchema: z.object({
    address: address16Schema.describe('Start address: decimal (53248) or hex string with prefix ($D000, 0xD000)'),
    data: byteArraySchema.min(1).describe('Bytes to write: decimal (255), hex ($FF, 0xFF), or binary (%11111111, 0b11111111). Mixed formats allowed.'),
  }),
  dataSchema: z.object({
    worked: z.boolean().describe('Whether the write operation completed successfully'),
    address: z.number().int().min(0).max(0xffff).describe('Start address where the bytes were written'),
    length: z.number().int().min(1).describe('Number of bytes written'),
  }).extend(debugStateSchema.shape),
  execute: async (input) => {
    const address = parseAddress16(input.address);
    const data = input.data.map(b => parseByte(b));

    // Validate address space
    if (address + data.length - 1 > 0xffff) {
      throw new Error('address + data.length must stay within the 16-bit address space');
    }

    return await c64Session.writeMemory(address, data);
  },
});

const executeTool = createViceTool({
  id: 'execute',
  description: 'Controls execution with pause, resume, step, step_over, step_out, or reset. Pause and resume are idempotent (safe to call multiple times).',
  inputSchema: z.object({
    action: z.enum(['pause', 'resume', 'step', 'step_over', 'step_out', 'reset']),
    count: z.number().int().positive().default(1).describe('Instruction count for step and step_over actions'),
    resetMode: resetModeSchema.default('soft').describe('Reset mode when action is reset'),
    waitUntilRunningStable: z.boolean().default(false).describe('When action is resume, wait until running becomes stable before returning'),
  }),
  dataSchema: debugStateSchema.extend({
    stepsExecuted: z.number().int().positive().optional(),
    warnings: z.array(warningSchema),
  }),
  execute: async (input) => await c64Session.execute(input.action, input.count, input.resetMode, input.waitUntilRunningStable),
});

const waitForStateTool = createViceTool({
  id: 'wait_for_state',
  description: 'Waits for the emulator to reach a target execution state and optionally remain there for a stability window.',
  inputSchema: z.object({
    executionState: z.enum(['running', 'stopped']).describe('Target execution state to wait for'),
    timeoutMs: z.number().int().positive().default(5000).describe('Maximum time to wait before returning'),
    stableMs: z.number().int().nonnegative().optional().describe('Optional stability window the target state must remain true before returning'),
  }),
  dataSchema: waitForStateResultSchema,
  execute: async (input) => await c64Session.waitForState(input.executionState, input.timeoutMs, input.stableMs),
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
    const result = await c64Session.listBreakpoints(input.includeDisabled);
    return {
      breakpoints: result.breakpoints.map((breakpoint) => normalizeBreakpoint(breakpoint)),
    };
  },
});

const breakpointSetTool = createViceTool({
  id: 'breakpoint_set',
  description: 'Creates an execution breakpoint or read/write watchpoint. Use either (address, length) or (start, end) format. Addresses can be decimal (53248) or hex string with prefix ($D000, 0xD000).',
  inputSchema: z.union([
    z.object({
      kind: breakpointKindSchema,
      address: address16Schema.describe('Start address: decimal (53248) or hex string with prefix ($D000, 0xD000)'),
      length: z.number().int().positive().default(1).describe('Size of the breakpoint range in bytes'),
      condition: z.string().optional(),
      label: z.string().optional(),
      temporary: z.boolean().default(false),
      enabled: z.boolean().default(true),
    }),
    z.object({
      kind: breakpointKindSchema,
      start: address16Schema.describe('Start address (inclusive): decimal (53248) or hex string with prefix ($D000, 0xD000)'),
      end: address16Schema.describe('End address (inclusive): decimal (53248) or hex string with prefix ($D000, 0xD000)'),
      condition: z.string().optional(),
      label: z.string().optional(),
      temporary: z.boolean().default(false),
      enabled: z.boolean().default(true),
    }),
  ]),
  dataSchema: z.object({
    breakpoint: breakpointSchema,
    executionState: executionStateSchema,
    lastStopReason: stopReasonSchema,
    programCounter: address16Schema.nullable(),
    registers: c64PartialRegisterValueSchema.nullable(),
  }),
  execute: async (input) => {
    // Normalize start/end to address/length and parse addresses
    let normalizedInput: {
      kind: z.infer<typeof breakpointKindSchema>;
      address: number;
      length: number;
      condition?: string;
      label?: string;
      temporary: boolean;
      enabled: boolean;
    };

    if ('start' in input && 'end' in input) {
      const start = parseAddress16(input.start);
      const end = parseAddress16(input.end);
      if (end < start) {
        throw new Error('End address must be greater than or equal to start address');
      }
      normalizedInput = {
        kind: input.kind,
        address: start,
        length: end - start + 1,
        condition: input.condition,
        label: input.label,
        temporary: input.temporary,
        enabled: input.enabled,
      };
    } else if ('address' in input && 'length' in input) {
      normalizedInput = {
        kind: input.kind,
        address: parseAddress16(input.address),
        length: input.length,
        condition: input.condition,
        label: input.label,
        temporary: input.temporary,
        enabled: input.enabled,
      };
    } else {
      throw new Error('Invalid input: must provide either (address, length) or (start, end)');
    }

    const result = await c64Session.breakpointSet(normalizedInput);
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
  execute: async (input) => await c64Session.breakpointClear(input.breakpointId),
});

const programLoadTool = createViceTool({
  id: 'program_load',
  description: 'Loads a C64 program and optionally starts it.',
  inputSchema: z.object({
    filePath: z.string(),
    autoStart: z.boolean().default(true).describe('Whether the loaded program should be started immediately after loading'),
    fileIndex: z.number().int().nonnegative().default(0).describe('Autostart file index inside the image, when applicable'),
  }),
  dataSchema: programLoadResultSchema,
  execute: async (input) => await c64Session.programLoad(input),
});

const captureDisplayTool = createViceTool({
  id: 'capture_display',
  description: 'Captures the current screen to a PNG file and returns the saved image path.',
  inputSchema: z.object({
    useVic: z.boolean().default(true).describe('Whether to capture the VIC-II display when supported'),
  }),
  dataSchema: captureDisplayResultSchema,
  execute: async (input) => await c64Session.captureDisplay(input.useVic),
});

const getDisplayStateTool = createViceTool({
  id: 'get_display_state',
  description: 'Returns screen RAM, color RAM, the current graphics mode, screen memory addresses, and the current border and background colors.',
  inputSchema: noInputSchema,
  dataSchema: displayStateResultSchema,
  execute: async () => await c64Session.getDisplayState(),
});

const getDisplayTextTool = createViceTool({
  id: 'get_display_text',
  description: 'Returns the current text screen as readable text when the C64 is in a text mode.',
  inputSchema: noInputSchema,
  dataSchema: displayTextResultSchema,
  execute: async () => await c64Session.getDisplayText(),
});

const writeTextTool = createViceTool({
  id: 'write_text',
  description:
    'Types text into the C64. Automatically resumes if stopped and restores pause state after. Supports escaped characters and PETSCII brace tokens like {RETURN}, {CLR}, {HOME}, {PI}, and color names. Limit 64 bytes per request.',
  inputSchema: z.object({
    text: z.string(),
  }),
  dataSchema: z.object({
    sent: z.boolean(),
    length: z.number().int(),
  }),
  execute: async (input) => await c64Session.writeText(input.text),
});

const keyboardInputTool = createViceTool({
  id: 'keyboard_input',
  description: 'Sends one to four keys or PETSCII tokens to the C64. Automatically resumes if stopped and restores pause state after. Use for key presses, releases, and taps.',
  inputSchema: z.object({
    action: inputActionSchema.describe('Use tap for a single key event or press/release for repeated buffered input'),
    keys: z.array(z.string().min(1)).min(1).max(4).describe('One to four literal keys or PETSCII token names such as RETURN, CLR, HOME, PI, LEFT, RED, or F1'),
    durationMs: z.number().int().positive().optional().describe('Tap duration in milliseconds'),
  }),
  dataSchema: keyboardInputResultSchema,
  execute: async (input) => await c64Session.keyboardInput(input.action, input.keys, input.durationMs),
});

const joystickInputTool = createViceTool({
  id: 'joystick_input',
  description: 'Sends joystick input to C64 joystick port 1 or 2. Automatically resumes if stopped and restores pause state after.',
  inputSchema: z.object({
    port: joystickPortSchema.describe('Joystick port number'),
    action: inputActionSchema.describe('Joystick action to apply'),
    control: joystickControlSchema.describe('Joystick direction or fire control'),
    durationMs: z.number().int().optional().describe('Tap duration in milliseconds (will be clamped to reasonable range)'),
  }),
  dataSchema: joystickInputResultSchema,
  execute: async (input) => await c64Session.joystickInput(input.port, input.action, input.control, input.durationMs),
});

export const c64DebugServer = new MCPServer({
  id: 'c64-debug-mcp',
  name: 'c64 debugger',
  version: '0.1.0',
  description: 'MCP server for C64 debugging and interaction.',
  instructions: 'This server is for C64 debugging. Use the tools directly to inspect, control, and interact with the C64.',
  tools: {
    get_monitor_state: getMonitorStateTool,
    get_session_state: getSessionStateTool,
    get_registers: getRegistersTool,
    set_registers: setRegistersTool,
    memory_read: readMemoryTool,
    memory_write: writeMemoryTool,
    execute: executeTool,
    wait_for_state: waitForStateTool,
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

export { c64Session };
