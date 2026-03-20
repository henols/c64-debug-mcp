import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

import {
  breakpointKindSchema,
  memSpaceSchema,
  normalizeHex,
  parseHexLike,
  resetModeSchema,
  resumePolicySchema,
  sessionStatusSchema,
} from './contracts.js';
import { ViceSessionService } from './session.js';

const viceSession = new ViceSessionService();

const sessionStatusTool = createTool({
  id: 'session_status',
  description: 'Returns explicit VICE session, transport, process, and execution state.',
  inputSchema: z.object({}),
  outputSchema: sessionStatusSchema,
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

const attachSessionTool = createTool({
  id: 'attach_session',
  description: 'Connects to an already-running VICE binary monitor endpoint. Requires an explicit host and port.',
  inputSchema: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535),
    machineType: z.string().optional(),
  }),
  outputSchema: sessionStatusSchema,
  execute: async (input) => await viceSession.attachSession(input.host ?? '127.0.0.1', input.port, input.machineType),
});

const startEmulatorTool = createTool({
  id: 'start_emulator',
  description:
    'Starts a managed VICE emulator on a non-default binary monitor port. If monitorPort is omitted, a safe non-default port is allocated automatically.',
  inputSchema: z.object({
    emulatorType: z.string().default('x64sc'),
    binaryPath: z.string().optional(),
    arguments: z.string().optional(),
    workingDirectory: z.string().optional(),
    monitorHost: z.string().default('127.0.0.1'),
    monitorPort: z.number().int().min(1).max(65535).optional(),
  }),
  outputSchema: sessionStatusSchema,
  execute: async (input) =>
    await viceSession.startEmulator({
      emulatorType: input.emulatorType ?? 'x64sc',
      binaryPath: input.binaryPath,
      arguments: input.arguments,
      workingDirectory: input.workingDirectory,
      monitorHost: input.monitorHost ?? '127.0.0.1',
      monitorPort: input.monitorPort,
    }),
});

const stopEmulatorTool = createTool({
  id: 'stop_emulator',
  description: 'Stops the managed VICE emulator process owned by this session.',
  inputSchema: z.object({
    force: z.boolean().default(false),
  }),
  outputSchema:
    z.object({
      stopped: z.boolean(),
      processId: z.number().int().nullable(),
      ownership: z.enum(['external', 'managed', 'unknown']),
    }),
  execute: async (input) => await viceSession.stopEmulator(input.force),
});

const disconnectSessionTool = createTool({
  id: 'disconnect_session',
  description: 'Disconnects the MCP server from the current VICE monitor session without guessing a new endpoint.',
  inputSchema: z.object({}),
  outputSchema:
    z.object({
      disconnected: z.boolean(),
      sessionId: z.string().nullable(),
    }),
  execute: async () => await viceSession.disconnectSession(),
});

const setResumePolicyTool = createTool({
  id: 'set_resume_policy',
  description: 'Sets the explicit resume policy used after mutating debugger operations.',
  inputSchema: z.object({
    resumePolicy: resumePolicySchema,
  }),
  outputSchema:
    z.object({
      resumePolicy: resumePolicySchema,
    }),
  execute: async (input) => viceSession.setResumePolicy(input.resumePolicy),
});

const getRegistersTool = createTool({
  id: 'get_registers',
  description: 'Returns symbolic register names, widths, and values.',
  inputSchema: z.object({
    registerNames: z.array(z.string()).optional(),
  }),
  outputSchema:
    z.object({
      machine: z.string(),
      registers: z.array(
        z.object({
          name: z.string(),
          id: z.number().int(),
          widthBits: z.number().int(),
          value: z.number().int(),
          valueHex: z.string(),
        }),
      ),
    }),
  execute: async (input) => await viceSession.getRegisters(input.registerNames),
});

const getRegisterMetadataTool = createTool({
  id: 'get_register_metadata',
  description: 'Returns register metadata for the active machine.',
  inputSchema: z.object({
    registerNames: z.array(z.string()).optional(),
  }),
  outputSchema:
    z.object({
      machine: z.string(),
      registers: z.array(
        z.object({
          name: z.string(),
          id: z.number().int(),
          widthBits: z.number().int(),
        }),
      ),
    }),
  execute: async (input) => await viceSession.getRegisterMetadata(input.registerNames),
});

const setRegistersTool = createTool({
  id: 'set_registers',
  description: 'Sets one or more registers by symbolic name.',
  inputSchema: z.object({
    registers: z.array(
      z.object({
        name: z.string(),
        valueHex: z.string(),
      }),
    ),
  }),
  outputSchema:
    z.object({
      updated: z.array(
        z.object({
          name: z.string(),
          value: z.number().int(),
          valueHex: z.string(),
        }),
      ),
      executionState: z.string(),
    }),
  execute: async (input) => await viceSession.setRegisters(input.registers),
});

const readMemoryTool = createTool({
  id: 'read_memory',
  description: 'Reads an inclusive memory range and returns raw bytes as a JSON array.',
  inputSchema: z.object({
    start: z.string(),
    end: z.string(),
    bank: z.number().int().default(0),
    memSpace: memSpaceSchema.default('main'),
  }),
  outputSchema:
    z.object({
      start: z.number().int(),
      startHex: z.string(),
      end: z.number().int(),
      endHex: z.string(),
      length: z.number().int(),
      bank: z.number().int(),
      data: z.array(z.number().int().min(0).max(255)),
    }),
  execute: async (input) => await viceSession.readMemory(parseHexLike(input.start, 'start'), parseHexLike(input.end, 'end'), input.bank, input.memSpace),
});

const writeMemoryTool = createTool({
  id: 'write_memory',
  description: 'Writes raw byte values into the active VICE memory space.',
  inputSchema: z.object({
    start: z.string(),
    data: z.array(z.number().int().min(0).max(255)),
    bank: z.number().int().default(0),
    memSpace: memSpaceSchema.default('main'),
  }),
  outputSchema:
    z.object({
      start: z.number().int(),
      startHex: z.string(),
      length: z.number().int(),
      bank: z.number().int(),
      written: z.boolean(),
    }),
  execute: async (input) => await viceSession.writeMemory(parseHexLike(input.start, 'start'), input.data, input.bank, input.memSpace),
});

const searchMemoryTool = createTool({
  id: 'search_memory',
  description: 'Searches a memory range for a byte pattern.',
  inputSchema: z.object({
    start: z.string(),
    end: z.string(),
    pattern: z.array(z.number().int().min(0).max(255)),
    bank: z.number().int().default(0),
    memSpace: memSpaceSchema.default('main'),
    maxResults: z.number().int().positive().default(10),
  }),
  outputSchema:
    z.object({
      start: z.number().int(),
      end: z.number().int(),
      pattern: z.array(z.number().int().min(0).max(255)),
      bank: z.number().int(),
      matches: z.array(
        z.object({
          address: z.number().int(),
          addressHex: z.string(),
          offset: z.number().int(),
        }),
      ),
      truncated: z.boolean(),
    }),
  execute: async (input) =>
    await viceSession.searchMemory(
      parseHexLike(input.start, 'start'),
      parseHexLike(input.end, 'end'),
      input.pattern,
      input.bank,
      input.memSpace,
      input.maxResults,
    ),
});

const fillMemoryTool = createTool({
  id: 'fill_memory',
  description: 'Fills a memory range by repeating a byte pattern.',
  inputSchema: z.object({
    start: z.string(),
    end: z.string(),
    pattern: z.array(z.number().int().min(0).max(255)),
    bank: z.number().int().default(0),
    memSpace: memSpaceSchema.default('main'),
  }),
  outputSchema:
    z.object({
      start: z.number().int(),
      end: z.number().int(),
      length: z.number().int(),
      bank: z.number().int(),
      pattern: z.array(z.number().int().min(0).max(255)),
    }),
  execute: async (input) =>
    await viceSession.fillMemory(parseHexLike(input.start, 'start'), parseHexLike(input.end, 'end'), input.pattern, input.bank, input.memSpace),
});

const copyMemoryTool = createTool({
  id: 'copy_memory',
  description: 'Copies bytes from one memory region to another.',
  inputSchema: z.object({
    sourceStart: z.string(),
    destStart: z.string(),
    length: z.number().int().positive(),
    sourceBank: z.number().int().default(0),
    destBank: z.number().int().default(0),
    memSpace: memSpaceSchema.default('main'),
  }),
  outputSchema:
    z.object({
      sourceStart: z.number().int(),
      destStart: z.number().int(),
      length: z.number().int(),
      sourceBank: z.number().int(),
      destBank: z.number().int(),
    }),
  execute: async (input) =>
    await viceSession.copyMemory(
      parseHexLike(input.sourceStart, 'sourceStart'),
      parseHexLike(input.destStart, 'destStart'),
      input.length,
      input.sourceBank,
      input.destBank,
      input.memSpace,
    ),
});

const compareMemoryTool = createTool({
  id: 'compare_memory',
  description: 'Compares two memory regions and returns structured differences.',
  inputSchema: z.object({
    firstStart: z.string(),
    secondStart: z.string(),
    length: z.number().int().positive(),
    firstBank: z.number().int().default(0),
    secondBank: z.number().int().default(0),
    memSpace: memSpaceSchema.default('main'),
    maxDifferences: z.number().int().positive().default(25),
  }),
  outputSchema:
    z.object({
      length: z.number().int(),
      equal: z.boolean(),
      differences: z.array(
        z.object({
          offset: z.number().int(),
          firstAddress: z.number().int(),
          secondAddress: z.number().int(),
          firstValue: z.number().int(),
          secondValue: z.number().int(),
        }),
      ),
      truncated: z.boolean(),
    }),
  execute: async (input) =>
    await viceSession.compareMemory(
      parseHexLike(input.firstStart, 'firstStart'),
      parseHexLike(input.secondStart, 'secondStart'),
      input.length,
      input.firstBank,
      input.secondBank,
      input.memSpace,
      input.maxDifferences,
    ),
});

const continueExecutionTool = createTool({
  id: 'continue_execution',
  description: 'Continues execution from the current monitor stop.',
  inputSchema: z.object({}),
  outputSchema:
    z.object({
      executionState: z.string(),
      lastStopReason: z.string(),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  execute: async () => await viceSession.continueExecution(),
});

const stepInstructionTool = createTool({
  id: 'step_instruction',
  description: 'Steps forward by one or more instructions.',
  inputSchema: z.object({
    count: z.number().int().positive().default(1),
  }),
  outputSchema:
    z.object({
      executionState: z.string(),
      lastStopReason: z.string(),
      programCounter: z.number().int().nullable(),
      programCounterHex: z.string().nullable(),
      stepsExecuted: z.number().int(),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  execute: async (input) => await viceSession.stepInstruction(input.count, false),
});

const stepOverTool = createTool({
  id: 'step_over',
  description: 'Steps over the current instruction or subroutine call.',
  inputSchema: z.object({
    count: z.number().int().positive().default(1),
  }),
  outputSchema:
    z.object({
      executionState: z.string(),
      lastStopReason: z.string(),
      programCounter: z.number().int().nullable(),
      programCounterHex: z.string().nullable(),
      stepsExecuted: z.number().int(),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  execute: async (input) => await viceSession.stepInstruction(input.count, true),
});

const stepOutTool = createTool({
  id: 'step_out',
  description: 'Runs until the current subroutine returns.',
  inputSchema: z.object({}),
  outputSchema:
    z.object({
      executionState: z.string(),
      lastStopReason: z.string(),
      programCounter: z.number().int().nullable(),
      programCounterHex: z.string().nullable(),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  execute: async () => await viceSession.stepOut(),
});

const resetMachineTool = createTool({
  id: 'reset_machine',
  description: 'Resets the machine and leaves lifecycle state explicit.',
  inputSchema: z.object({
    mode: resetModeSchema.default('soft'),
  }),
  outputSchema:
    z.object({
      executionState: z.string(),
      lastStopReason: z.string(),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  execute: async (input) => await viceSession.resetMachine(input.mode ?? 'soft'),
});

const listBreakpointsTool = createTool({
  id: 'list_breakpoints',
  description: 'Lists current breakpoints and watchpoints.',
  inputSchema: z.object({
    includeDisabled: z.boolean().default(true),
  }),
  outputSchema:
    z.object({
      breakpoints: z.array(
        z.object({
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
        }),
      ),
    }),
  execute: async (input) => await viceSession.listBreakpoints(input.includeDisabled),
});

const getBreakpointTool = createTool({
  id: 'get_breakpoint',
  description: 'Returns a single breakpoint or watchpoint by numeric id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  outputSchema:
    z.object({
      breakpoint: z.object({
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
      }),
    }),
  execute: async (input) => await viceSession.getBreakpoint(input.breakpointId),
});

const setBreakpointTool = createTool({
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
  outputSchema:
    z.object({
      breakpoint: z.object({
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
        label: z.string().nullable(),
      }),
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

const deleteBreakpointTool = createTool({
  id: 'delete_breakpoint',
  description: 'Deletes a breakpoint by numeric id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  outputSchema:
    z.object({
      deleted: z.boolean(),
      breakpointId: z.number().int(),
    }),
  execute: async (input) => await viceSession.deleteBreakpoint(input.breakpointId),
});

const enableBreakpointTool = createTool({
  id: 'enable_breakpoint',
  description: 'Enables a breakpoint by id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  outputSchema:
    z.object({
      breakpointId: z.number().int(),
      enabled: z.boolean(),
    }),
  execute: async (input) => await viceSession.enableBreakpoint(input.breakpointId, true),
});

const disableBreakpointTool = createTool({
  id: 'disable_breakpoint',
  description: 'Disables a breakpoint by id.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
  }),
  outputSchema:
    z.object({
      breakpointId: z.number().int(),
      enabled: z.boolean(),
    }),
  execute: async (input) => await viceSession.enableBreakpoint(input.breakpointId, false),
});

const setWatchpointTool = createTool({
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
  outputSchema:
    z.object({
      breakpoint: z.object({
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
        label: z.string().nullable(),
      }),
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

const setBreakpointConditionTool = createTool({
  id: 'set_breakpoint_condition',
  description: 'Sets a write-only condition string on an existing breakpoint.',
  inputSchema: z.object({
    breakpointId: z.number().int().nonnegative(),
    condition: z.string().min(1),
  }),
  outputSchema:
    z.object({
      breakpointId: z.number().int(),
      hasCondition: z.boolean(),
      conditionTrackedByServer: z.boolean(),
    }),
  execute: async (input) => await viceSession.setBreakpointCondition(input.breakpointId, input.condition),
});

const loadProgramTool = createTool({
  id: 'load_program',
  description: 'Loads a PRG into memory using its header load address unless overridden.',
  inputSchema: z.object({
    filePath: z.string(),
    addressHex: z.string().optional(),
  }),
  outputSchema:
    z.object({
      filePath: z.string(),
      start: z.number().int(),
      startHex: z.string(),
      length: z.number().int(),
      written: z.boolean(),
    }),
  execute: async (input) => await viceSession.loadProgram(input.filePath, input.addressHex ? parseHexLike(input.addressHex, 'addressHex') : null),
});

const autostartProgramTool = createTool({
  id: 'autostart_program',
  description: 'Asks VICE to autostart a program file.',
  inputSchema: z.object({
    filePath: z.string(),
    runAfterLoading: z.boolean().default(true),
    fileIndex: z.number().int().nonnegative().default(0),
  }),
  outputSchema:
    z.object({
      filePath: z.string(),
      runAfterLoading: z.boolean(),
      fileIndex: z.number().int(),
      executionState: z.string(),
    }),
  execute: async (input) => await viceSession.autostartProgram(input.filePath, input.runAfterLoading, input.fileIndex),
});

const saveMemoryTool = createTool({
  id: 'save_memory',
  description: 'Reads memory from VICE and saves it to a host file as raw bytes or a PRG.',
  inputSchema: z.object({
    filePath: z.string(),
    start: z.string(),
    end: z.string(),
    asPrg: z.boolean().default(true),
    bank: z.number().int().default(0),
    memSpace: memSpaceSchema.default('main'),
  }),
  outputSchema:
    z.object({
      filePath: z.string(),
      start: z.number().int(),
      startHex: z.string(),
      end: z.number().int(),
      endHex: z.string(),
      length: z.number().int(),
      asPrg: z.boolean(),
      bank: z.number().int(),
    }),
  execute: async (input) =>
    await viceSession.saveMemory(
      input.filePath,
      parseHexLike(input.start, 'start'),
      parseHexLike(input.end, 'end'),
      input.asPrg,
      input.bank,
      input.memSpace,
    ),
});

const loadSymbolsTool = createTool({
  id: 'load_symbols',
  description: 'Loads Oscar64 symbols from a JSON debug dump or assembly listing.',
  inputSchema: z.object({
    filePath: z.string(),
  }),
  outputSchema:
    z.object({
      id: z.string(),
      format: z.enum(['oscar64-json', 'oscar64-asm']),
      filePath: z.string(),
      symbolCount: z.number().int(),
      loadedAt: z.string(),
    }),
  execute: async (input) => await viceSession.loadSymbols(input.filePath),
});

const listSymbolSourcesTool = createTool({
  id: 'list_symbol_sources',
  description: 'Lists loaded symbol sources.',
  inputSchema: z.object({}),
  outputSchema:
    z.object({
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

const lookupSymbolTool = createTool({
  id: 'lookup_symbol',
  description: 'Looks up a loaded symbol by exact name.',
  inputSchema: z.object({
    name: z.string(),
  }),
  outputSchema:
    z.object({
      symbol: z.object({
        name: z.string(),
        address: z.number().int(),
        addressHex: z.string(),
        endAddress: z.number().int().optional(),
        endAddressHex: z.string().optional(),
        source: z.string().optional(),
        line: z.number().int().optional(),
        kind: z.enum(['function', 'global', 'label']),
      }),
    }),
  execute: async (input) => viceSession.lookupSymbol(input.name),
});

const setBreakpointAtSymbolTool = createTool({
  id: 'set_breakpoint_at_symbol',
  description: 'Resolves a loaded symbol and creates an execution breakpoint at that address.',
  inputSchema: z.object({
    name: z.string(),
    condition: z.string().optional(),
    temporary: z.boolean().default(false),
  }),
  outputSchema:
    z.object({
      symbol: z.object({
        name: z.string(),
        address: z.number().int(),
        addressHex: z.string(),
        endAddress: z.number().int().optional(),
        endAddressHex: z.string().optional(),
        source: z.string().optional(),
        line: z.number().int().optional(),
        kind: z.enum(['function', 'global', 'label']),
      }),
      breakpoint: z.object({
        id: z.number().int(),
        start: z.number().int(),
        startHex: z.string(),
        end: z.number().int(),
        endHex: z.string(),
        enabled: z.boolean(),
        stopWhenHit: z.boolean(),
        hitCount: z.number().int(),
        currentlyHit: z.boolean(),
        temporary: z.boolean(),
        hasCondition: z.boolean(),
        kind: breakpointKindSchema,
        label: z.string().nullable(),
      }),
    }),
  execute: async (input) => await viceSession.setBreakpointAtSymbol(input.name, input.condition, input.temporary),
});

const captureDisplayTool = createTool({
  id: 'capture_display',
  description: 'Captures the current display and returns indexed pixel data plus a grayscale PNG fallback.',
  inputSchema: z.object({
    useVic: z.boolean().default(true),
  }),
  outputSchema:
    z.object({
      width: z.number().int(),
      height: z.number().int(),
      bitsPerPixel: z.number().int(),
      debugWidth: z.number().int(),
      debugHeight: z.number().int(),
      debugOffsetX: z.number().int(),
      debugOffsetY: z.number().int(),
      pixelDataBase64: z.string(),
      pngBase64: z.string().nullable(),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  execute: async (input) => await viceSession.captureDisplay(input.useVic),
});

const getBanksTool = createTool({
  id: 'get_banks',
  description: 'Lists VICE memory banks.',
  inputSchema: z.object({}),
  outputSchema:
    z.object({
      banks: z.array(
        z.object({
          id: z.number().int(),
          name: z.string(),
        }),
      ),
    }),
  execute: async () => await viceSession.getBanks(),
});

const getInfoTool = createTool({
  id: 'get_info',
  description: 'Returns VICE version information.',
  inputSchema: z.object({}),
  outputSchema:
    z.object({
      viceVersion: z.string(),
      versionComponents: z.array(z.number().int()),
      svnVersion: z.number().int(),
    }),
  execute: async () => await viceSession.getInfo(),
});

const pingTool = createTool({
  id: 'ping',
  description: 'Checks whether the active VICE monitor is responsive.',
  inputSchema: z.object({}),
  outputSchema:
    z.object({
      responsive: z.boolean(),
    }),
  execute: async () => await viceSession.ping(),
});

const sendKeysTool = createTool({
  id: 'send_keys',
  description: 'Feeds keys into the emulator keyboard buffer.',
  inputSchema: z.object({
    keys: z.string(),
  }),
  outputSchema:
    z.object({
      sent: z.boolean(),
      length: z.number().int(),
    }),
  execute: async (input) => await viceSession.sendKeys(input.keys),
});

export const viceDebugServer = new MCPServer({
  id: 'vice-debug-mcp',
  name: 'VICE Debug MCP',
  version: '0.1.0',
  description: 'Structured Mastra MCP server for VICE debugging with explicit lifecycle and non-default managed monitor ports.',
  instructions:
    'Use attach_session to connect to an existing VICE instance or start_emulator to launch a managed instance on a non-default monitor port. Query session_status rather than inferring lifecycle state from tool side effects.',
  tools: {
    session_status: sessionStatusTool,
    attach_session: attachSessionTool,
    start_emulator: startEmulatorTool,
    stop_emulator: stopEmulatorTool,
    disconnect_session: disconnectSessionTool,
    set_resume_policy: setResumePolicyTool,
    get_registers: getRegistersTool,
    get_register_metadata: getRegisterMetadataTool,
    set_registers: setRegistersTool,
    read_memory: readMemoryTool,
    write_memory: writeMemoryTool,
    search_memory: searchMemoryTool,
    fill_memory: fillMemoryTool,
    copy_memory: copyMemoryTool,
    compare_memory: compareMemoryTool,
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
    save_memory: saveMemoryTool,
    load_symbols: loadSymbolsTool,
    list_symbol_sources: listSymbolSourcesTool,
    lookup_symbol: lookupSymbolTool,
    set_breakpoint_at_symbol: setBreakpointAtSymbolTool,
    capture_display: captureDisplayTool,
    get_banks: getBanksTool,
    get_info: getInfoTool,
    ping: pingTool,
    send_keys: sendKeysTool,
  },
});

export { viceSession };
