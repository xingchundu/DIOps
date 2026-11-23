#!/usr/bin/env bash
# 公共函数：凭据只经环境变量 / 权限 600 的临时文件传给客户端工具，不出现在命令行（ps 可见）里。
# 用法：source "$(dirname "$0")/_secret.sh"
umask 077
DIOPS_TMP_FILES=()
diops_cleanup() { for f in "${DIOPS_TMP_FILES[@]:-}"; do [ -n "$f" ] && rm -f "$f"; done; }
trap diops_cleanup EXIT
# 生成一个只有当前用户可读的临时文件，路径写入变量 PAR（不能放进 $(...)，否则退出时清理不到）
diops_tmpfile() { PAR="$(mktemp "${TMPDIR:-/tmp}/diops.XXXXXX")"; chmod 600 "$PAR"; DIOPS_TMP_FILES+=("$PAR"); }
