#!/bin/bash
set -euo pipefail

PYTHON_VERSION="${PYTHON_VERSION:-3.12}"

export DEBIAN_FRONTEND=noninteractive

add-apt-repository -y ppa:deadsnakes/ppa
apt-get update
apt-get install -y --no-install-recommends \
  "python${PYTHON_VERSION}" \
  "python${PYTHON_VERSION}-venv"

# Set up alternatives so `python3` and `python` point to the installed version
update-alternatives --install /usr/bin/python3 python3 "/usr/bin/python${PYTHON_VERSION}" 1
update-alternatives --install /usr/bin/python python "/usr/bin/python${PYTHON_VERSION}" 1

# Install pip via ensurepip (avoids distutils issues with deadsnakes python)
"python${PYTHON_VERSION}" -m ensurepip --upgrade
ln -sf /usr/local/bin/pip3 /usr/local/bin/pip || true

python3 --version
pip3 --version
