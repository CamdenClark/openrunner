#!/bin/bash
set -euo pipefail

DOCKER_VERSION="${DOCKER_VERSION:-27.5.1}"
ARCH=$(dpkg --print-architecture)

curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_VERSION}.tgz" \
  | tar -xz -C /tmp

mv /tmp/docker/docker /usr/local/bin/docker
chmod +x /usr/local/bin/docker
rm -rf /tmp/docker

docker --version
