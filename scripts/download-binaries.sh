#!/usr/bin/env bash
# Download static binaries for ripgrep, fd, jq, yq, ast-grep, and tokei
# Supports Windows, macOS, and Linux (both x64 and arm64).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)/bin"

# Directory structure
PLATFORMS=(
  "linux-x64"
  "linux-arm64"
  "darwin-x64"
  "darwin-arm64"
  "win32-x64"
)

for plat in "${PLATFORMS[@]}"; do
  mkdir -p "$BIN_ROOT/$plat"
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

download() {
  local url="$1"
  local dest="$2"
  echo "Downloading $url -> $dest..."
  curl -fsSL -o "$dest" "$url"
}

# --- 1. JQ (1.7.1) ---
download "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux64" "$BIN_ROOT/linux-x64/jq"
download "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64" "$BIN_ROOT/linux-arm64/jq"
download "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-macos-amd64" "$BIN_ROOT/darwin-x64/jq"
download "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-macos-arm64" "$BIN_ROOT/darwin-arm64/jq"
download "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-windows-amd64.exe" "$BIN_ROOT/win32-x64/jq.exe"

# --- 2. YQ (v4.44.2) ---
download "https://github.com/mikefarah/yq/releases/download/v4.44.2/yq_linux_amd64" "$BIN_ROOT/linux-x64/yq"
download "https://github.com/mikefarah/yq/releases/download/v4.44.2/yq_linux_arm64" "$BIN_ROOT/linux-arm64/yq"
download "https://github.com/mikefarah/yq/releases/download/v4.44.2/yq_darwin_amd64" "$BIN_ROOT/darwin-x64/yq"
download "https://github.com/mikefarah/yq/releases/download/v4.44.2/yq_darwin_arm64" "$BIN_ROOT/darwin-arm64/yq"
download "https://github.com/mikefarah/yq/releases/download/v4.44.2/yq_windows_amd64.exe" "$BIN_ROOT/win32-x64/yq.exe"

# --- 3. RIPGREP (14.1.0) ---
# Linux x64
download "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-unknown-linux-musl.tar.gz" "$TMP_DIR/rg-linux-x64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/rg-linux-x64.tar.gz"
mv "$TMP_DIR"/ripgrep-14.1.0-x86_64-unknown-linux-musl/rg "$BIN_ROOT/linux-x64/rg"

# Linux arm64
download "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-aarch64-unknown-linux-gnu.tar.gz" "$TMP_DIR/rg-linux-arm64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/rg-linux-arm64.tar.gz"
mv "$TMP_DIR"/ripgrep-14.1.0-aarch64-unknown-linux-gnu/rg "$BIN_ROOT/linux-arm64/rg"

# Darwin x64
download "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-apple-darwin.tar.gz" "$TMP_DIR/rg-darwin-x64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/rg-darwin-x64.tar.gz"
mv "$TMP_DIR"/ripgrep-14.1.0-x86_64-apple-darwin/rg "$BIN_ROOT/darwin-x64/rg"

# Darwin arm64
download "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-aarch64-apple-darwin.tar.gz" "$TMP_DIR/rg-darwin-arm64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/rg-darwin-arm64.tar.gz"
mv "$TMP_DIR"/ripgrep-14.1.0-aarch64-apple-darwin/rg "$BIN_ROOT/darwin-arm64/rg"

# Windows x64
download "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-pc-windows-msvc.zip" "$TMP_DIR/rg-win32-x64.zip"
unzip -o -d "$TMP_DIR/rg-win" "$TMP_DIR/rg-win32-x64.zip"
mv "$TMP_DIR/rg-win"/ripgrep-*/rg.exe "$BIN_ROOT/win32-x64/rg.exe"

# --- 4. FD (v10.1.0) ---
# Linux x64
download "https://github.com/sharkdp/fd/releases/download/v10.1.0/fd-v10.1.0-x86_64-unknown-linux-musl.tar.gz" "$TMP_DIR/fd-linux-x64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/fd-linux-x64.tar.gz"
mv "$TMP_DIR"/fd-v10.1.0-x86_64-unknown-linux-musl/fd "$BIN_ROOT/linux-x64/fd"

# Linux arm64
download "https://github.com/sharkdp/fd/releases/download/v10.1.0/fd-v10.1.0-aarch64-unknown-linux-gnu.tar.gz" "$TMP_DIR/fd-linux-arm64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/fd-linux-arm64.tar.gz"
mv "$TMP_DIR"/fd-v10.1.0-aarch64-unknown-linux-gnu/fd "$BIN_ROOT/linux-arm64/fd"

# Darwin x64
download "https://github.com/sharkdp/fd/releases/download/v10.1.0/fd-v10.1.0-x86_64-apple-darwin.tar.gz" "$TMP_DIR/fd-darwin-x64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/fd-darwin-x64.tar.gz"
mv "$TMP_DIR"/fd-v10.1.0-x86_64-apple-darwin/fd "$BIN_ROOT/darwin-x64/fd"

# Darwin arm64
download "https://github.com/sharkdp/fd/releases/download/v10.1.0/fd-v10.1.0-aarch64-apple-darwin.tar.gz" "$TMP_DIR/fd-darwin-arm64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/fd-darwin-arm64.tar.gz"
mv "$TMP_DIR"/fd-v10.1.0-aarch64-apple-darwin/fd "$BIN_ROOT/darwin-arm64/fd"

# Windows x64
download "https://github.com/sharkdp/fd/releases/download/v10.1.0/fd-v10.1.0-x86_64-pc-windows-msvc.zip" "$TMP_DIR/fd-win32-x64.zip"
unzip -o -d "$TMP_DIR/fd-win" "$TMP_DIR/fd-win32-x64.zip"
mv "$TMP_DIR/fd-win/fd-v10.1.0-x86_64-pc-windows-msvc/fd.exe" "$BIN_ROOT/win32-x64/fd.exe"

# --- 5. TOKEI (v12.1.2) ---
# Linux x64
download "https://github.com/XAMPPRocky/tokei/releases/download/v12.1.2/tokei-x86_64-unknown-linux-gnu.tar.gz" "$TMP_DIR/tokei-linux-x64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/tokei-linux-x64.tar.gz"
mv "$TMP_DIR"/tokei "$BIN_ROOT/linux-x64/tokei"

# Darwin x64 (Tokei doesn't have official Mac arm64 builds for v12.1.2, x64 runs under Rosetta)
download "https://github.com/XAMPPRocky/tokei/releases/download/v12.1.2/tokei-x86_64-apple-darwin.tar.gz" "$TMP_DIR/tokei-darwin-x64.tar.gz"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/tokei-darwin-x64.tar.gz"
mv "$TMP_DIR"/tokei "$BIN_ROOT/darwin-x64/tokei"
cp "$BIN_ROOT/darwin-x64/tokei" "$BIN_ROOT/darwin-arm64/tokei"

# Windows x64
download "https://github.com/XAMPPRocky/tokei/releases/download/v12.1.2/tokei-x86_64-pc-windows-msvc.exe" "$BIN_ROOT/win32-x64/tokei.exe"

# --- 6. AST-GREP (v0.25.3) ---
# Linux x64
download "https://github.com/ast-grep/ast-grep/releases/download/0.25.3/app-x86_64-unknown-linux-gnu.zip" "$TMP_DIR/astgrep-linux-x64.zip"
unzip -o -d "$TMP_DIR/astgrep-linux-x64" "$TMP_DIR/astgrep-linux-x64.zip"
mv "$TMP_DIR/astgrep-linux-x64/ast-grep" "$BIN_ROOT/linux-x64/ast-grep"
ln -sf "ast-grep" "$BIN_ROOT/linux-x64/sg"

# Linux arm64
download "https://github.com/ast-grep/ast-grep/releases/download/0.25.3/app-aarch64-unknown-linux-gnu.zip" "$TMP_DIR/astgrep-linux-arm64.zip"
unzip -o -d "$TMP_DIR/astgrep-linux-arm64" "$TMP_DIR/astgrep-linux-arm64.zip"
mv "$TMP_DIR/astgrep-linux-arm64/ast-grep" "$BIN_ROOT/linux-arm64/ast-grep"
ln -sf "ast-grep" "$BIN_ROOT/linux-arm64/sg"

# Darwin x64
download "https://github.com/ast-grep/ast-grep/releases/download/0.25.3/app-x86_64-apple-darwin.zip" "$TMP_DIR/astgrep-darwin-x64.zip"
unzip -o -d "$TMP_DIR/astgrep-darwin-x64" "$TMP_DIR/astgrep-darwin-x64.zip"
mv "$TMP_DIR/astgrep-darwin-x64/ast-grep" "$BIN_ROOT/darwin-x64/ast-grep"
ln -sf "ast-grep" "$BIN_ROOT/darwin-x64/sg"

# Darwin arm64
download "https://github.com/ast-grep/ast-grep/releases/download/0.25.3/app-aarch64-apple-darwin.zip" "$TMP_DIR/astgrep-darwin-arm64.zip"
unzip -o -d "$TMP_DIR/astgrep-darwin-arm64" "$TMP_DIR/astgrep-darwin-arm64.zip"
mv "$TMP_DIR/astgrep-darwin-arm64/ast-grep" "$BIN_ROOT/darwin-arm64/ast-grep"
ln -sf "ast-grep" "$BIN_ROOT/darwin-arm64/sg"

# Windows x64
download "https://github.com/ast-grep/ast-grep/releases/download/0.25.3/app-x86_64-pc-windows-msvc.zip" "$TMP_DIR/astgrep-win32-x64.zip"
unzip -o -d "$TMP_DIR/astgrep-win32-x64" "$TMP_DIR/astgrep-win32-x64.zip"
mv "$TMP_DIR/astgrep-win32-x64/ast-grep.exe" "$BIN_ROOT/win32-x64/ast-grep.exe"
cp "$BIN_ROOT/win32-x64/ast-grep.exe" "$BIN_ROOT/win32-x64/sg.exe"

# --- Permissions ---
for plat in "${PLATFORMS[@]}"; do
  if [ "$plat" != "win32-x64" ]; then
    chmod +x "$BIN_ROOT/$plat"/* 2>/dev/null || true
  fi
done

echo "All binaries downloaded successfully to bin/ !"
