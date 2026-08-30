#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
if [[ -d "$SCRIPT_DIR/repository/app" ]]; then
  SCRIPT_DIR="$SCRIPT_DIR/repository"
fi
exec "$SCRIPT_DIR/app/bin/taste" start --open
