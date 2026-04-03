# C64 Debug MCP

[![npm version](https://badge.fury.io/js/c64-debug-mcp.svg)](https://www.npmjs.com/package/c64-debug-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that enables AI assistants like Claude to debug and interact with Commodore 64 programs running in the VICE emulator.

## Features

- Full C64 control (pause, resume, step, reset)
- Memory operations (read, write, search, compare)
- Breakpoints and watchpoints
- CPU register access
- Display capture
- Keyboard and joystick input
- Program loading

## Requirements

- Node.js >= 22.13.0
- VICE Emulator with binary monitor support (https://vice-emu.sourceforge.io/)

## Installation

```bash
claude mcp add c64debug -- npx -y c64-debug-mcp
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

## License

MIT - see [LICENSE](LICENSE) file
