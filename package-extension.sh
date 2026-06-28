#!/bin/bash
# package-extension.sh — Creates a clean ZIP for Chrome Web Store submission

EXTENSION_NAME="browser-agent-guide"
VERSION=$(node -p "require('./manifest.json').version")
OUTPUT="${EXTENSION_NAME}-v${VERSION}.zip"

# Remove old package
rm -f "$OUTPUT"

# Create ZIP excluding dev files
zip -r "$OUTPUT" . \
  -x ".git/*" \
  -x "node_modules/*" \
  -x ".claude/*" \
  -x ".env" \
  -x "*.map" \
  -x "test/*" \
  -x "scripts/*" \
  -x "daemon/*" \
  -x "docs/*" \
  -x "glossary/*" \
  -x ".github/*" \
  -x "nanobanana-output/*" \
  -x ".tmp/*" \
  -x ".gitignore" \
  -x "CLAUDE.md" \
  -x "CHROMEWEBSTORE.md" \
  -x "CHROMEWEBSTORE.*.md" \
  -x "PRIVACY.md" \
  -x "README.md" \
  -x "README.*.md" \
  -x "LICENSE" \
  -x "package-extension.sh" \
  -x "package.json" \
  -x "package-lock.json" \
  -x "playwright.config.mjs" \
  -x "*.zip" \
  -x ".DS_Store" \
  -x "**/Thumbs.db" \
  -x "test-results/*" \
  -x "playwright-report/*"

echo "--------------------------------------------------"
echo "Packaged: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "--------------------------------------------------"
