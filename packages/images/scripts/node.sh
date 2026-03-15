#!/bin/bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-20.19.0}"
ARCH=$(dpkg --print-architecture)

case "$ARCH" in
  amd64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1

node --version
npm --version
