#!/usr/bin/env bash
# 类型检查。src 依赖 pi 自带的包，本仓库不装依赖，所以把本机 pi 的
# node_modules 和 pi-coding-agent 本身临时软链进来，再用 npx 拉 typescript。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="${PI_ROOT:-}"
if [ -z "$pkg" ]; then
	bin="$(type -P pi)" || { echo "找不到 pi，可以用 PI_ROOT 指向 pi-coding-agent 包目录" >&2; exit 1; }
	# 从 pi 可执行文件的真实路径往上找包根目录。
	pkg="$(dirname "$(readlink -f "$bin")")"
	while [ "$pkg" != / ] && [ ! -d "$pkg/node_modules/typebox" ]; do pkg="$(dirname "$pkg")"; done
fi
[ -d "$pkg/node_modules/typebox" ] || { echo "$pkg 不像 pi-coding-agent 包目录" >&2; exit 1; }

nm="$root/node_modules"
[ -e "$nm" ] && { echo "$nm 已存在，先删掉再跑" >&2; exit 1; }
mkdir -p "$nm/@earendil-works"
trap 'rm -rf "$nm"' EXIT
for entry in "$pkg"/node_modules/*; do
	name="$(basename "$entry")"
	[ "$name" = "@earendil-works" ] && continue
	ln -s "$entry" "$nm/$name"
done
for entry in "$pkg"/node_modules/@earendil-works/*; do
	ln -s "$entry" "$nm/@earendil-works/$(basename "$entry")"
done
ln -s "$pkg" "$nm/@earendil-works/pi-coding-agent"

cd "$root"
npx -y -p typescript@5 tsc -p tsconfig.json
echo "typecheck ok"
