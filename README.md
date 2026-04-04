# C64 Debug MCP

[![npm version](https://badge.fury.io/js/c64-debug-mcp.svg)](https://www.npmjs.com/package/c64-debug-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Debug Commodore 64 programs through conversation - AI-powered control of the VICE emulator for 6502 assembly and BASIC.

## Features

- 🎮 **Full C64 Control**: Pause, resume, step, and reset the emulator
- 🔍 **Memory Operations**: Read, write, search, and compare memory
- 🐛 **Breakpoints**: Set execution breakpoints and watchpoints
- 📊 **Register Access**: Get and set CPU registers (A, X, Y, PC, SP, flags)
- 📸 **Display Capture**: Capture screen state and text content
- ⌨️ **Input Control**: Send keyboard and joystick input
- 📝 **Program Loading**: Load PRG files and manage execution
- 🔢 **Flexible Formats**: Use C64 notation ($D000, $FF, %11111111) or standard formats (0xD000, 255, 0b11111111)

## Address Formats

The MCP server accepts C64 addresses in multiple formats for natural interaction:

- **C64 style**: `$D000` (dollar sign prefix - classic 6502 assembler notation)
- **C style**: `0xD000` (0x prefix - standard programming hex notation)
- **Decimal**: `53248` (traditional decimal format)

**Note**: Bare hex without prefix (e.g., `D000`) is NOT supported to avoid ambiguity with 4-digit decimals.

**Common C64 Addresses**:
- `$D000` - SID chip registers (sound)
- `$D020` - Border color register
- `$D021` - Background color register
- `$0400` - Default screen memory
- `$0800` - Common program start
- `$C000` - BASIC ROM start

## Byte Value Formats

The MCP server accepts byte values (0-255) in multiple formats for natural C64-style input:

- **C64 hex**: `$FF` (dollar sign prefix - classic 6502 notation)
- **C hex**: `0xFF` (0x prefix - standard programming notation)
- **C64 binary**: `%11111111` (percent prefix - classic 6502 bit notation)
- **C binary**: `0b11111111` (0b prefix - standard programming notation)
- **Decimal**: `255` (traditional decimal format)

**Note**: Bare hex/binary without prefix (e.g., `FF`, `11111111`) is NOT supported to avoid ambiguity.

**Mixed formats in arrays**:
```json
[255, "$FF", "0xFF", "%11111111", "0b11111111"]
```

**Common C64 Byte Values**:
- `$00`-`$0F` - Color values (0-15)
- `$20` - PETSCII space character
- `$41` - PETSCII 'A' character
- `%00011011` - VIC-II D011 control register (text mode, 25 rows, screen on)
- `%11111111` - All bits set (enable all sprites, etc.)

**Use Cases**:
```javascript
// Set border to light blue
memory_write(address="$D020", data=["$0E"])

// Enable all 8 sprites
memory_write(address="$D015", data=["%11111111"])

// Write " AB" to screen (PETSCII)
memory_write(address="$0400", data=["$20", "$41", "$42"])

// Set VIC-II control register with bit pattern
memory_write(address="$D011", data=["%00011011"])
```

## Requirements

- Node.js >= 22.13.0
- VICE Emulator (https://vice-emu.sourceforge.io/)
- MCP-compatible AI assistant (Claude Code, Codex, Windsurf, etc.)

## Installation

```bash
claude mcp add c64-dev-tools -- npx -y c64-debug-mcp@latest
```

Or add manually to your MCP client config:

```json
{
  "mcpServers": {
    "c64-dev-tools": {
      "command": "npx",
      "args": ["-y", "c64-debug-mcp@latest"]
    }
  }
}
```

## Quick Start

1. Add MCP server (see Installation above)

2. Ask your AI assistant to interact with C64:
   - "What's in memory at $D000?"
   - "Set a breakpoint at $1000"
   - "Load and run my program.prg"

**Important:** The MCP server launches and controls VICE automatically. Your AI assistant owns the emulator process and can reset or restart it at any time. Don't use VICE manually or create valuable work in the emulator while debugging - any unsaved state may be lost when it resets the machine.

## Example Workflows

### Debugging a Program

```
You: Load examples/hello.prg and set a breakpoint at $1000

AI assistant will:
1. Load the program using program_load
2. Set a breakpoint at $1000 using breakpoint_set
3. Resume execution until breakpoint is hit
4. Show you the register state when stopped
```

### Memory Analysis

```
You: What's the BASIC program in memory?

AI assistant will:
1. Read memory from $0801 (BASIC start)
2. Parse the BASIC tokens
3. Show you the program listing
```

### Screen Capture

```
You: Show me what's on the screen

AI assistant will:
1. Capture the display using capture_display
2. Save a PNG image
3. Describe what's visible
```

## License

MIT - see [LICENSE](LICENSE) file

**Made with ❤️ for C64 developers and AI-assisted retro coding**

*"The C64 never gets old, it just gets smarter" 🎮*
