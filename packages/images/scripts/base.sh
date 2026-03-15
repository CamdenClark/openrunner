#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  unzip \
  wget \
  xz-utils \
  zip \
  sudo \
  locales \
  software-properties-common \
  gnupg2

# Set up locale
locale-gen en_US.UTF-8

# Create runner user
useradd -m -s /bin/bash runner
echo "runner ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/runner
