#!/bin/bash
set -euo pipefail

# Clean apt caches
apt-get clean
rm -rf /var/lib/apt/lists/*

# Remove temp files
rm -rf /tmp/* /var/tmp/*

# Remove apt package cache
rm -rf /var/cache/apt/archives/*.deb
