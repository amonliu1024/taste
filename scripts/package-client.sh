#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then echo '用法：scripts/package-client.sh <新的 .tar.gz 文件>' >&2; exit 1; fi
taste_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$1" in /*) taste_output="$1" ;; *) taste_output="$(pwd)/$1" ;; esac
if [ -e "$taste_output" ]; then echo '输出文件已存在，请使用新路径。' >&2; exit 1; fi
# Explicit allowlist: no Runtime, dependencies, credentials, tests, or source workspace.
tar -czf "$taste_output" -C "$taste_root" \
  app/bin/taste app/dist-node/cli/index.js app/dist-node/cli/client.js \
  scripts/install-client.sh docs/operations/client-server.md
echo "$taste_output"
