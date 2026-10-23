#!/bin/sh
set -eu
taste_source=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
taste_destination="${TASTE_CLIENT_DIR:-$HOME/.local/share/taste-client}"
taste_bin_dir="${TASTE_BIN_DIR:-$HOME/.local/bin}"
if [ ! -f "$taste_source/app/dist-node/cli/index.js" ] || [ ! -f "$taste_source/app/dist-node/cli/client.js" ]; then
  echo '请先在 app/ 执行 pnpm build，或使用已构建的客户端分发包。' >&2
  exit 1
fi
if [ "$taste_source" = "$taste_destination" ]; then
  echo '安装目录应与安装来源目录分开。' >&2
  exit 1
fi
mkdir -p "$taste_destination/app/dist-node/cli" "$taste_destination/app/bin" "$taste_bin_dir"
taste_destination=$(CDPATH= cd -- "$taste_destination" && pwd)
taste_bin_dir=$(CDPATH= cd -- "$taste_bin_dir" && pwd)
if [ "$taste_source" = "$taste_destination" ]; then
  echo '安装目录应与安装来源目录分开。' >&2
  exit 1
fi
cp "$taste_source/app/dist-node/cli/index.js" "$taste_source/app/dist-node/cli/client.js" "$taste_destination/app/dist-node/cli/"
printf '%s\n' '{"type":"module"}' > "$taste_destination/app/package.json"
cp "$taste_source/app/bin/taste" "$taste_destination/app/bin/taste"
chmod 755 "$taste_destination/app/bin/taste"
ln -sfn "$taste_destination/app/bin/taste" "$taste_bin_dir/taste"
"$taste_bin_dir/taste" help >/dev/null
echo 'Taste 客户端已安装。配置 url 和 token 后运行 taste doctor。'
