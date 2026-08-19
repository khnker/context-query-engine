#!/usr/bin/env bash
# Detect OS and Architecture to prepend local bin/ to PATH
OS=""
ARCH=""

case "$(uname -s)" in
  Linux*)   OS="linux" ;;
  Darwin*)  OS="darwin" ;;
  CYGWIN*|MINGW*|MSYS*) OS="win32" ;;
  *)        OS="linux" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)            ARCH="x64" ;;
esac

# Find project root bin directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_BIN="$SCRIPT_DIR/../bin/${OS}-${ARCH}"

# Fallback without arch if specific one doesn't exist
if [ ! -d "$LOCAL_BIN" ] && [ -d "$SCRIPT_DIR/../bin/${OS}" ]; then
  LOCAL_BIN="$SCRIPT_DIR/../bin/${OS}"
fi

if [ -d "$LOCAL_BIN" ]; then
  export PATH="$LOCAL_BIN:$PATH"
fi

export PATH="$HOME/.local/bin:$PATH"
