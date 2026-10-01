#!/usr/bin/env bash
# 单元测试。被测的 config.ts / events.ts / monitors.ts 不依赖 pi，直接用 node 跑。
# 源码里有构造函数参数属性，需要 --experimental-transform-types（Node 22.7+）。
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
node --experimental-transform-types --no-warnings --test config.test.mjs events.test.mjs monitors.test.mjs
