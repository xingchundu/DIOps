#!/bin/bash
# 项目根目录快捷入口 -> scripts/pack-offline.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/scripts/pack-offline.sh" "$@"
