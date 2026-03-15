#!/bin/bash
set -euo pipefail

GH_CLI_VERSION="${GH_CLI_VERSION:-2.74.1}"
ARCH=$(dpkg --print-architecture)

curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${ARCH}.deb" -o /tmp/gh.deb
dpkg -i /tmp/gh.deb
rm /tmp/gh.deb

gh --version
