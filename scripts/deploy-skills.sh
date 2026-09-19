#!/usr/bin/env bash
# 把仓库 skills/ 下的每个 Skill 镜像部署到 cc-switch 与 SmartWork；目标目录与仓库保持一致，多余文件会被删除。
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
targets=("cc-switch:$HOME/.cc-switch/skills" "SmartWork:$HOME/.SmartWork/skills")
skills=("$repo_dir"/skills/*/)

for target in "${targets[@]}"; do
  label="${target%%:*}"
  root="${target#*:}"
  echo "=== Deploy to $label: $root ==="
  for skill in "${skills[@]}"; do
    name="$(basename "$skill")"
    mkdir -p "$root/$name"
    rsync -a --delete --exclude .DS_Store "$skill" "$root/$name/"
    echo "  OK: $name"
  done
done
echo "=== Done: ${#skills[@]} skill(s) deployed to ${#targets[@]} targets ==="
