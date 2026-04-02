# Scripts

This directory contains utility scripts for managing the C64 Debug MCP project.

## Available Scripts

### `release.sh`

Interactive release script that automates the version bumping and release process.

**Usage:**

```bash
# From repository root
npm run release

# Or directly
bash scripts/release.sh
```

**Features:**

- ✅ Interactive version selection (patch/minor/major)
- ✅ Automatic version bumping in package.json
- ✅ CHANGELOG.md updates with new version section
- ✅ Git commit with release message
- ✅ Git tag creation (v0.1.1, v0.2.0, etc.)
- ✅ Automatic push to GitHub
- ✅ Triggers GitHub Actions for npm publishing

**Process:**

1. Shows current version
2. Prompts for version bump type:
   - `patch` - Bug fixes (0.1.0 → 0.1.1)
   - `minor` - New features (0.1.0 → 0.2.0)
   - `major` - Breaking changes (0.1.0 → 1.0.0)
   - `prepatch/preminor/premajor` - Pre-releases
   - `custom` - Manual version entry
3. Updates package.json version
4. Updates CHANGELOG.md (moves [Unreleased] to new version)
5. Shows diff and confirms
6. Creates commit and tag
7. Pushes to GitHub (triggers automated npm publish)

**Requirements:**

- Clean git working directory (or confirmation to proceed)
- npm installed
- Git configured with push access to repository

**Example:**

```bash
$ npm run release

═══════════════════════════════════════════════════════
   C64 Debug MCP - Release Script
═══════════════════════════════════════════════════════

Current version: 0.1.0

Select version bump type:
  1) patch   - Bug fixes only       (0.1.0 → 0.1.1)
  2) minor   - New features          (0.1.0 → 0.2.0)
  3) major   - Breaking changes      (0.1.0 → 1.0.0)
  ...

Enter choice (1-7): 1

Updating version...
Version bumped: 0.1.0 → 0.1.1

...

Ready to release version 0.1.1

Continue with release? (y/N) y

═══════════════════════════════════════════════════════
   Release v0.1.1 initiated! 🚀
═══════════════════════════════════════════════════════
```

**After Release:**

- Monitor GitHub Actions: https://github.com/henols/c64-debug-mcp/actions
- Check npm package: https://www.npmjs.com/package/c64-debug-mcp
- View GitHub release: https://github.com/henols/c64-debug-mcp/releases

## Adding New Scripts

When adding new scripts to this directory:

1. Make them executable: `chmod +x scripts/your-script.sh`
2. Add usage documentation here
3. Consider adding an npm script alias in root `package.json`
4. Follow the existing error handling patterns

## Development

All scripts use `set -e` to exit on errors and provide colored output for better UX.

Color codes:
- 🔴 RED - Errors
- 🟢 GREEN - Success
- 🟡 YELLOW - Warnings
- 🔵 BLUE - Info
