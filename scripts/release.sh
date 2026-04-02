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
PACKAGE_DIR="$REPO_ROOT/packages/c64-debug-mcp"

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
  NEW_VERSION=$(npm version $BUMP_TYPE --no-git-tag-version)
  NEW_VERSION=${NEW_VERSION#v}  # Remove 'v' prefix
else
  npm version $CUSTOM_VERSION --no-git-tag-version
  NEW_VERSION=$CUSTOM_VERSION
fi

echo -e "${GREEN}Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}${NC}"
echo

# Update CHANGELOG
echo -e "${BLUE}Updating CHANGELOG.md...${NC}"
TODAY=$(date +%Y-%m-%d)
CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"

# Check if changelog has unreleased section
if grep -q "\[Unreleased\]" "$CHANGELOG_FILE"; then
  # Create a temporary file with the updated changelog
  cat > /tmp/changelog_update.txt << EOF

## [${NEW_VERSION}] - ${TODAY}

EOF

  # Extract unreleased content (between [Unreleased] and next ##)
  UNRELEASED=$(sed -n '/## \[Unreleased\]/,/## \[/p' "$CHANGELOG_FILE" | sed '1d;$d' | sed '/^$/d')

  if [ -n "$UNRELEASED" ]; then
    echo -e "${YELLOW}Unreleased changes to be included:${NC}"
    echo "$UNRELEASED"
    echo

    # Auto-update changelog
    # Insert new version section after [Unreleased]
    awk -v new_section="$(<"/tmp/changelog_update.txt")" '
      /## \[Unreleased\]/ {
        print $0
        print ""
        print new_section
        next
      }
      { print }
    ' "$CHANGELOG_FILE" > /tmp/changelog_new.md
    mv /tmp/changelog_new.md "$CHANGELOG_FILE"

    # Update version links at bottom
    PREV_VERSION=$CURRENT_VERSION

    # Replace [Unreleased] link
    sed -i "s#\\[Unreleased\\]:.*#[Unreleased]: https://github.com/henols/c64-debug-mcp/compare/v${NEW_VERSION}...HEAD#" "$CHANGELOG_FILE"

    # Add new version link before [Unreleased] link
    sed -i "/\\[Unreleased\\]:/i\\[${NEW_VERSION}]: https://github.com/henols/c64-debug-mcp/compare/v${PREV_VERSION}...v${NEW_VERSION}" "$CHANGELOG_FILE"
  else
    echo -e "${YELLOW}No unreleased changes found in CHANGELOG.md${NC}"
    echo -e "${YELLOW}Tip: Add changes to [Unreleased] section before releasing${NC}"
  fi
else
  echo -e "${YELLOW}No [Unreleased] section found in CHANGELOG.md${NC}"
  echo -e "${YELLOW}Skipping CHANGELOG update${NC}"
fi

echo -e "${GREEN}CHANGELOG.md updated${NC}"
echo

# Show diff
echo -e "${BLUE}Changes to be committed:${NC}"
cd "$REPO_ROOT"
git diff "$PACKAGE_DIR/package.json" "$CHANGELOG_FILE" | head -40
echo

# Confirm release
echo -e "${YELLOW}Ready to release version ${NEW_VERSION}${NC}"
echo
echo "This will:"
echo "  1. Commit package.json and CHANGELOG.md"
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
  cd "$REPO_ROOT"
  git checkout "$CHANGELOG_FILE"
  exit 1
fi

# Commit and tag
echo
echo -e "${BLUE}Creating release commit and tag...${NC}"
git add "$PACKAGE_DIR/package.json" "$CHANGELOG_FILE"
git commit -m "chore: release v${NEW_VERSION}

Release notes in CHANGELOG.md

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

echo -e "${GREEN}Commit and tag created${NC}"
echo

# Push
echo -e "${BLUE}Pushing to GitHub...${NC}"
git push origin main --tags

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
