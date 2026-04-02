# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [c64-debug-mcp
v0.1.2

up to date in 323ms

71 packages are looking for funding
  run `npm fund` for details] - 2026-04-02

### Changed
- Renamed project from `vice-debug-mcp` to `c64-debug-mcp`
- Renamed all environment variables from `VICE_DEBUG_*` to `C64_DEBUG_*`
- Renamed exported variables `viceDebugServer` → `c64DebugServer`, `viceSession` → `c64Session`
- Updated all external references to use C64 branding

## [0.1.0] - 2025-03-25

### Added
- Initial release of C64 Debug MCP server
- Full MCP tools for C64 debugging via VICE emulator
- Execution control: pause, resume, step, step_over, step_out, reset
- Memory operations: read, write
- Register access: get and set CPU registers
- Breakpoint management: set, clear, list
- Display operations: capture screen, get display state, get text
- Input control: keyboard and joystick input
- Program loading with auto-start support
- Session state monitoring
- HTTP server mode for web-based MCP clients
- Comprehensive chaos testing (58/58 tests passing)

### Fixed
- Duration clamping for joystick tap operations
- Race conditions in pause/resume state management
- Breakpoint array initialization crashes
- Reset state preservation and stability
- Double pause idempotency
- Display capture concurrency issues

[Unreleased]: https://github.com/henols/c64-debug-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/henols/c64-debug-mcp/releases/tag/v0.1.0
