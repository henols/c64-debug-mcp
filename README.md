# C64 Debug MCP

[![npm version](https://badge.fury.io/js/c64-debug-mcp.svg)](https://www.npmjs.com/package/c64-debug-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that enables AI assistants like Claude to debug and interact with Commodore 64 programs running in the VICE emulator.

## Features

- 🎮 **Full C64 Control**: Pause, resume, step, and reset the emulator
- 🔍 **Memory Operations**: Read, write, search, and compare memory
- 🐛 **Breakpoints**: Set execution breakpoints and watchpoints
- 📊 **Register Access**: Get and set CPU registers (A, X, Y, PC, SP, flags)
- 📸 **Display Capture**: Capture screen state and text content
- ⌨️ **Input Control**: Send keyboard and joystick input
- 📝 **Program Loading**: Load PRG files and manage execution

## Requirements

- Node.js >= 22.13.0
- VICE Emulator with binary monitor support (https://vice-emu.sourceforge.io/)

## Installation

```bash
claude mcp add c64debug -- npx -y c64-debug-mcp
```

Or add manually to your MCP client config:

```json
{
  "mcpServers": {
    "c64-debug": {
      "command": "npx",
      "args": ["-y", "c64-debug-mcp"]
    }
  }
}
```

## Quick Start

1. Start VICE with binary monitor:
   ```bash
   x64sc -remotemonitor -remotemonitoraddress 127.0.0.1:6502
   ```

2. Add MCP server (see Installation above)

3. Ask Claude to interact with C64:
   - "What's in memory at $D000?"
   - "Set a breakpoint at $1000"
   - "Load and run my program.prg"

## Example Workflows

### Debugging a Program

```
You: Load examples/hello.prg and set a breakpoint at $1000

Claude will:
1. Load the program using program_load
2. Set a breakpoint at $1000 using breakpoint_set
3. Resume execution until breakpoint is hit
4. Show you the register state when stopped
```

### Memory Analysis

```
You: What's the BASIC program in memory?

Claude will:
1. Read memory from $0801 (BASIC start)
2. Parse the BASIC tokens
3. Show you the program listing
```

### Screen Capture

```
You: Show me what's on the screen

Claude will:
1. Capture the display using capture_display
2. Save a PNG image
3. Describe what's visible
```

## License

MIT - see [LICENSE](LICENSE) file
