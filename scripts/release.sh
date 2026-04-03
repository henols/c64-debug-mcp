#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$REPO_ROOT"

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   C64 Debug MCP - Release Script${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo

# Check we're in the right place
if [ ! -f "$PACKAGE_DIR/package.json" ]; then
  echo -e "${RED}Error: Could not find package.json in $PACKAGE_DIR${NC}"
  exit 1
fi

# Check git status
cd "$REPO_ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${YELLOW}Warning: You have uncommitted changes:${NC}"
  git status --short
  echo
  read -p "Do you want to continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# Get current version
cd "$PACKAGE_DIR"
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${GREEN}Current version: ${CURRENT_VERSION}${NC}"
echo

# Prompt for version bump type
echo -e "${YELLOW}Select version bump type:${NC}"
echo "  1) patch   - Bug fixes only       (${CURRENT_VERSION} → $(npx --yes semver -i patch ${CURRENT_VERSION}))"
echo "  2) minor   - New features          (${CURRENT_VERSION} → $(npx --yes semver -i minor ${CURRENT_VERSION}))"
echo "  3) major   - Breaking changes      (${CURRENT_VERSION} → $(npx --yes semver -i major ${CURRENT_VERSION}))"
echo "  4) custom  - Enter version manually"
echo

read -p "Enter choice (1-4): " choice

case $choice in
  1) BUMP_TYPE="patch" ;;
  2) BUMP_TYPE="minor" ;;
  3) BUMP_TYPE="major" ;;
  4)
    read -p "Enter version number (e.g., 1.2.3): " CUSTOM_VERSION
    BUMP_TYPE=""
    ;;
  *)
    echo -e "${RED}Invalid choice${NC}"
    exit 1
    ;;
esac

# Bump version
echo
echo -e "${BLUE}Updating version...${NC}"
if [ -n "$BUMP_TYPE" ]; then
  NEW_VERSION=$(npm version $BUMP_TYPE --no-git-tag-version 2>&1 | head -n 1 | tr -d '\n')
  NEW_VERSION=${NEW_VERSION#v}  # Remove 'v' prefix
else
  npm version $CUSTOM_VERSION --no-git-tag-version >/dev/null 2>&1
  NEW_VERSION=$CUSTOM_VERSION
fi

echo -e "${GREEN}Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}${NC}"
echo

# Show diff
echo -e "${BLUE}Changes to be committed:${NC}"
cd "$REPO_ROOT"
git diff "$PACKAGE_DIR/package.json" | head -40
echo

# Confirm release
echo -e "${YELLOW}Ready to release version ${NEW_VERSION}${NC}"
echo
echo "This will:"
echo "  1. Commit package.json"
echo "  2. Create git tag v${NEW_VERSION}"
echo "  3. Push to GitHub (main + tags)"
echo "  4. Trigger automated npm publish via GitHub Actions"
echo
read -p "Continue with release? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted. Rolling back version change..."
  cd "$PACKAGE_DIR"
  npm version $CURRENT_VERSION --no-git-tag-version
  exit 1
fi

# Commit and tag
echo
echo -e "${BLUE}Creating release commit and tag...${NC}"
git add "$PACKAGE_DIR/package.json" "$REPO_ROOT/package-lock.json"
git commit -m "chore: release v${NEW_VERSION}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

echo -e "${GREEN}Commit and tag created${NC}"
echo

# Push
echo -e "${BLUE}Pushing to GitHub...${NC}"
git push origin main
git push origin "v${NEW_VERSION}"
echo -e "${GREEN}Pushed commit and tag to GitHub${NC}"

echo
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Release v${NEW_VERSION} initiated! 🚀${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo
echo "Next steps:"
echo "  • Monitor GitHub Actions: https://github.com/henols/c64-debug-mcp/actions"
echo "  • Check npm package: https://www.npmjs.com/package/c64-debug-mcp"
echo "  • View release: https://github.com/henols/c64-debug-mcp/releases/tag/v${NEW_VERSION}"
echo
echo "The package will be published automatically via GitHub Actions."
echo
