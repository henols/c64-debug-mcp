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

- **Node.js**: >= 22.13.0
- **VICE Emulator**: Any recent version with binary monitor support
  - Download from: https://vice-emu.sourceforge.io/
  - Supports: x64sc (C64), x128 (C128), xvic (VIC-20), xpet (PET), and others

## Installation

### Recommended: No Installation Required

Use `npx` to automatically run the latest version without installing:

**No setup required!** Just configure your MCP client (see below).

### Local Installation (Optional)

```bash
npm install c64-debug-mcp
```

## Usage

### With Claude Code CLI (Recommended)

Add the MCP server with a single command:

```bash
claude mcp add c64debug -- npx -y c64-debug-mcp
```

This automatically configures Claude Code to use the latest version via npx.

### With Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`

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

### With Other MCP Clients

```bash
# STDIO mode (for Claude Desktop and similar clients)
npx c64-debug-mcp

# HTTP mode (for web-based clients)
npx c64-debug-mcp-http
```

### HTTP Server Configuration

The HTTP server can be configured via environment variables:

```bash
C64_DEBUG_HTTP_HOST=127.0.0.1      # Default: 127.0.0.1
C64_DEBUG_HTTP_PORT=39080          # Default: 39080
C64_DEBUG_HTTP_PATH=/mcp           # Default: /mcp
C64_DEBUG_HTTP_HEALTH_PATH=/healthz # Default: /healthz
```

## Quick Start

1. **Start VICE emulator** with binary monitor enabled:
   ```bash
   x64sc -remotemonitor -remotemonitoraddress 127.0.0.1:6502
   ```

2. **Configure Claude Desktop** (add to config file):
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

3. **Restart Claude Desktop**

4. **Ask Claude to interact with C64**:
   - "What's in memory at $D000?"
   - "Set a breakpoint at $1000"
   - "Load and run my program.prg"
   - "Show me the screen content"

## Available Tools

### Execution Control
- `execute` - Pause, resume, step, step_over, step_out, or reset
- `wait_for_state` - Wait for running/stopped state
- `program_load` - Load PRG files with optional auto-start

### Memory Operations
- `memory_read` - Read memory by address and length
- `memory_write` - Write bytes to memory
- `get_registers` - Get CPU register values
- `set_registers` - Set CPU register values

### Breakpoints
- `breakpoint_set` - Create execution or watchpoint breakpoints
- `breakpoint_clear` - Remove a breakpoint
- `list_breakpoints` - List all breakpoints

### Display & Input
- `capture_display` - Capture screen to PNG
- `get_display_state` - Get screen RAM, color RAM, and graphics mode
- `get_display_text` - Get text screen content
- `write_text` - Type text with PETSCII support
- `keyboard_input` - Send key presses/releases/taps
- `joystick_input` - Send joystick commands

### State Monitoring
- `get_monitor_state` - Get execution state and stop reason
- `get_session_state` - Get detailed emulator session state

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

## Configuration

### Environment Variables

- `C64_DEBUG_CONSOLE_LOGS` - Enable verbose logging (1, true, yes, on)
- `C64_DEBUG_SERVER_NODE` - Path to Node.js executable for smoke tests
- `C64_DEBUG_HTTP_*` - HTTP server configuration (see above)

### VICE Connection

The MCP server connects to VICE on `localhost:6502` by default. Ensure VICE is started with:

```bash
x64sc -remotemonitor -remotemonitoraddress 127.0.0.1:6502
```

Or add to your `~/.vice/vicerc`:

```
RemoteMonitor=1
RemoteMonitorAddress=127.0.0.1:6502
```

## Troubleshooting

### "Cannot connect to VICE"
- Ensure VICE is running with `-remotemonitor` flag
- Check that port 6502 is not blocked by firewall
- Verify VICE is listening: `netstat -an | grep 6502`

### "Command not found"
- Use npx to run without installation: `npx c64-debug-mcp`
- For Claude Code CLI: `claude mcp add c64debug -- npx -y c64-debug-mcp`

### Node version errors
- This package requires Node.js >= 22.13.0
- Check version: `node --version`
- Install latest: https://nodejs.org/

## Development

```bash
# Clone repository
git clone https://github.com/henols/c64-debug-mcp.git
cd c64-debug-mcp

# Install dependencies
npm install

# Build
npm run build

# Type check
npm run check
```

## Architecture

- **TypeScript** with strict type checking
- **Zod** for schema validation
- **Mastra MCP** framework for protocol implementation
- **VICE Binary Monitor Protocol** for emulator communication

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details

## Resources

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [VICE Emulator](https://vice-emu.sourceforge.io/)
- [VICE Binary Monitor Protocol](https://vice-emu.sourceforge.io/vice_13.html#SEC338)
- [Smithery MCP Registry](https://smithery.ai/)

## Acknowledgments

Built with the [Model Context Protocol](https://modelcontextprotocol.io) by Anthropic.
Powered by [VICE](https://vice-emu.sourceforge.io/) - the Versatile Commodore Emulator.

---

**Happy C64 debugging! 🎮**
