#!/bin/bash
# Double-click this file in Finder to build Hark and install it into Applications
# (replacing any older version). Needs Node.js: https://nodejs.org
set -e
cd "$(dirname "$0")"

echo ""
echo "  Hark installer"
echo "  =============="
echo ""

# Node.js installed from nodejs.org lives here; Terminal may not have it on PATH yet.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is needed first. Opening the download page…"
  echo "Install the LTS version, then double-click this file again."
  open "https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

echo "1/4  Closing Hark if it's open…"
osascript -e 'tell application "Hark" to quit' >/dev/null 2>&1 || true
sleep 1

echo "2/4  Downloading what the app needs (about 600 MB, a few minutes)…"
# Use the ready-made AI engine for this Mac; never try to compile one.
export NODE_LLAMA_CPP_SKIP_DOWNLOAD=true
npm install --no-audit --no-fund --loglevel=error

echo "3/4  Building the app…"
npm run build --silent
npx electron-builder --mac dir --publish never >/dev/null

APP="$(ls -d dist/mac*/Hark.app | head -n 1)"
if [ ! -d "$APP" ]; then
  echo "The build didn't produce the app. Copy everything above and send it for help."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

echo "4/4  Installing into Applications…"
rm -rf "/Applications/Hark.app"
cp -R "$APP" "/Applications/"
# Tell Hark where Node.js lives: its AI language engine runs best under plain Node.
command -v node > "/Applications/Hark.app/Contents/Resources/node-path.txt" 2>/dev/null || true
# Not signed with an Apple developer certificate: clear the download flag and
# sign it locally so macOS lets it open and can remember microphone permission.
xattr -cr "/Applications/Hark.app" 2>/dev/null || true
codesign --force --deep -s - "/Applications/Hark.app" >/dev/null 2>&1 || true

echo ""
echo "Done! Opening Hark…"
echo "(Your recordings and AI models are kept when you update.)"
open "/Applications/Hark.app"
sleep 2
