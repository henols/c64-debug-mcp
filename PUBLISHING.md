# Publishing Guide for C64 Debug MCP

This guide explains how to publish new versions of `@c64mcp/c64-debug-mcp` to npm.

## Prerequisites

1. **npm Account**: Create an account at https://www.npmjs.com/signup
2. **npm Login**: Run `npm login` and enter your credentials
3. **npm Token**: Create an automation token at https://www.npmjs.com/settings/[username]/tokens
4. **GitHub Secret**: Add your npm token as `NPM_TOKEN` in GitHub repository secrets
   - Go to: Repository → Settings → Secrets and variables → Actions → New repository secret
   - Name: `NPM_TOKEN`
   - Value: Your npm automation token

## Publishing Process

### Automated Publishing (Recommended)

The repository is configured for automated publishing via GitHub Actions:

1. **Update version in package.json**:
   ```bash
   cd packages/c64-debug-mcp
   npm version patch  # or minor, or major
   ```

2. **Update CHANGELOG.md** with new version changes

3. **Commit changes**:
   ```bash
   git add .
   git commit -m "chore: release v0.1.1"
   ```

4. **Create and push git tag**:
   ```bash
   git tag v0.1.1
   git push origin main --tags
   ```

5. **GitHub Actions will automatically**:
   - Build the package
   - Run type checks
   - Publish to npm with provenance
   - Create a GitHub release

### Manual Publishing

If you need to publish manually:

1. **Build and test**:
   ```bash
   cd packages/c64-debug-mcp
   npm run build
   npm run check
   ```

2. **Verify package contents**:
   ```bash
   npm pack --dry-run
   ```

3. **Publish**:
   ```bash
   npm publish --access public
   ```

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

- **Major (1.0.0)**: Breaking changes
- **Minor (0.1.0)**: New features, backwards compatible
- **Patch (0.0.1)**: Bug fixes, backwards compatible

Example version progression:
- `0.1.0` → Initial release
- `0.1.1` → Bug fix
- `0.2.0` → New feature (display text capture)
- `1.0.0` → First stable release

## Pre-release Versions

For beta testing:

```bash
npm version prerelease --preid=beta
# Creates: 0.1.1-beta.0

npm publish --tag beta
```

Users install with:
```bash
npm install @c64mcp/c64-debug-mcp@beta
```

## Checklist Before Publishing

- [ ] All tests pass
- [ ] CHANGELOG.md updated
- [ ] Version number bumped in package.json
- [ ] README.md accurate and up-to-date
- [ ] dist/ directory built and contains latest changes
- [ ] No uncommitted changes in git
- [ ] Git tag created matching version

## Verifying Published Package

After publishing, verify:

1. **Package page**: https://www.npmjs.com/package/@c64mcp/c64-debug-mcp
2. **Test installation**:
   ```bash
   npm install -g @c64mcp/c64-debug-mcp
   c64-debug-mcp --help
   ```
3. **Test with Claude Desktop**: Update config and restart

## Troubleshooting

### "You do not have permission to publish"
- Ensure you're logged in: `npm whoami`
- Check if you have access to `@c64mcp` scope
- Use `--access public` flag for scoped packages

### "Version already exists"
- Version numbers cannot be reused
- Bump version: `npm version patch`
- Delete and recreate git tag if needed

### "prepublishOnly script failed"
- Build error: Check TypeScript compilation
- Type check error: Fix type issues in source
- Run manually: `npm run build && npm run check`

## Publishing to Smithery (MCP Registry)

After npm publishing, also publish to Smithery:

```bash
# Install Smithery CLI
npm install -g @smithery/cli

# Login
smithery login

# Publish
cd packages/c64-debug-mcp
smithery publish
```

## Unpublishing (Emergency Only)

⚠️ **Warning**: Unpublishing is discouraged and has a 24-hour window.

```bash
npm unpublish @c64mcp/c64-debug-mcp@0.1.1
```

Instead, publish a fixed version:
```bash
npm version patch
npm publish --access public
```

## Support

If you encounter issues:
1. Check npm status: https://status.npmjs.org/
2. Review npm documentation: https://docs.npmjs.com/
3. Contact npm support: https://www.npmjs.com/support
