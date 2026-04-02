# C64 Debug MCP

[![npm version](https://badge.fury.io/js/c64-debug-mcp.svg)](https://www.npmjs.com/package/c64-debug-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/henols/c64-debug-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/henols/c64-debug-mcp/actions/workflows/ci.yml)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that enables AI assistants like Claude to debug and interact with Commodore 64 programs running in the VICE emulator.

> 🎮 **Bridge the gap between modern AI and retro computing!**

## What is this?

This MCP server allows Claude (or any MCP-compatible AI assistant) to:
- Debug 6502 assembly code running on a C64 emulator
- Inspect and modify memory in real-time
- Set breakpoints and step through code
- Capture screen output and send input
- Load and run C64 programs

Think of it as giving Claude a direct connection to your C64's brain through VICE's binary monitor protocol.

## Quick Start

```bash
# 1. Start VICE with remote monitor
x64sc -remotemonitor -remotemonitoraddress 127.0.0.1:6502

# 2. Add to Claude Desktop config (no installation needed!)
#    See config below

# 3. Ask Claude: "What's at memory address $D000?"
```

## Installation & Configuration

See [packages/c64-debug-mcp/README.md](packages/c64-debug-mcp/README.md) for detailed installation and usage instructions.

### Claude Desktop Setup (Recommended)

Add to your Claude Desktop config - uses `npx` to automatically run the latest version:

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

**Benefits:**
- ✅ No installation required
- ✅ Always uses latest version
- ✅ Works immediately after restart

**Alternative:** If you prefer global installation:
```bash
npm install -g c64-debug-mcp
```
Then use: `"command": "c64-debug-mcp"`

## Features

✅ **Execution Control** - Pause, resume, step through code, reset emulator
✅ **Memory Operations** - Read/write memory, search patterns
✅ **Breakpoints** - Set execution and watchpoint breakpoints
✅ **Register Access** - Inspect and modify CPU registers
✅ **Display Capture** - Screenshot and text extraction
✅ **Input Control** - Send keyboard and joystick commands
✅ **Program Loading** - Load PRG files with auto-start

## Example Use Cases

### AI-Assisted Debugging
```
You: "My sprite isn't appearing. Can you check the VIC-II registers?"

Claude:
1. Reads memory at $D000-$D02E (VIC-II registers)
2. Checks sprite enable register ($D015)
3. Verifies sprite data pointer
4. Suggests fixes
```

### Automated Testing
```
You: "Load test.prg and verify it prints HELLO"

Claude:
1. Loads test.prg
2. Waits for program to run
3. Captures screen text
4. Verifies output
```

### Memory Analysis
```
You: "Find all JSR $FFD2 calls in memory"

Claude:
1. Searches memory for pattern [0x20, 0xD2, 0xFF]
2. Lists all locations
3. Disassembles surrounding code
```

## Repository Structure

```
c64-debug-mcp/
├── packages/
│   └── c64-debug-mcp/     # Main MCP server package
│       ├── src/           # TypeScript source
│       ├── tests/         # Chaos and smoke tests
│       └── README.md      # Package documentation
├── .github/
│   └── workflows/         # CI/CD automation
├── CHANGELOG.md           # Version history
├── PUBLISHING.md          # Publishing guide
└── README.md             # This file
```

## Development

```bash
# Clone repository
git clone https://github.com/henols/c64-debug-mcp.git
cd c64-debug-mcp

# Install dependencies
npm install

# Build
npm run build

# Run tests
cd packages/c64-debug-mcp
npm run smoke:http
```

## Requirements

- **Node.js** >= 22.13.0
- **VICE Emulator** (any recent version)
- **Claude Desktop** or other MCP-compatible client

## Documentation

- [Package README](packages/c64-debug-mcp/README.md) - Installation and usage
- [Publishing Guide](PUBLISHING.md) - How to publish new versions
- [Changelog](CHANGELOG.md) - Version history
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [VICE Monitor Protocol](https://vice-emu.sourceforge.io/vice_13.html#SEC338)

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Write tests for new features
4. Submit a pull request

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines (coming soon).

## Testing

The project includes comprehensive test suites:

- **Chaos Test**: 58 stress tests covering edge cases and race conditions
- **Smoke Tests**: Basic functionality verification
- **CI Pipeline**: Automated testing on every push

All tests currently passing ✅

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Model Context Protocol](https://modelcontextprotocol.io) by Anthropic
- Powered by [VICE](https://vice-emu.sourceforge.io/) emulator
- Uses [Mastra MCP](https://github.com/mastra-ai/mastra) framework

## Support

- 🐛 [Report Issues](https://github.com/henols/c64-debug-mcp/issues)
- 💬 [Discussions](https://github.com/henols/c64-debug-mcp/discussions)
- 📧 Contact: Create an issue for support

## Related Projects

- [vice-bridge-net](https://github.com/rosc77/vice-bridge) - .NET VICE monitor library
- [Smithery](https://smithery.ai/) - MCP server registry
- [MCP Servers](https://github.com/modelcontextprotocol/servers) - Official MCP examples

---

**Made with ❤️ for retro computing enthusiasts and AI-assisted development**

*"The C64 never gets old, it just gets smarter" 🎮*
