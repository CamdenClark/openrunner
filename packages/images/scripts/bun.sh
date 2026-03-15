#!/bin/bash
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.2.14}"
ARCH=$(dpkg --print-architecture)

case "$ARCH" in
  amd64) BUN_ARCH="x64" ;;
  arm64) BUN_ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" -o /tmp/bun.zip
unzip -o /tmp/bun.zip -d /tmp/bun
mv "/tmp/bun/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun
chmod +x /usr/local/bin/bun
rm -rf /tmp/bun /tmp/bun.zip

bun --version
