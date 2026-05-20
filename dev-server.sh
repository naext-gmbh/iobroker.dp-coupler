#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
source $NVM_DIR/nvm.sh
nvm use 20
npx dev-server watch
