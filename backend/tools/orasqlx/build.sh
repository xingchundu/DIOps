#!/usr/bin/env bash
# 构建纯 Go 静态二进制（无需 Oracle Instant Client）。需要 Go >= 1.21；首次构建需联网拉取驱动 go-ora。
# 内网离线：在有网机器上 `go mod vendor` 后把整个目录拷过去，再 `GOFLAGS=-mod=vendor ./build.sh`。
set -euo pipefail
cd "$(dirname "$0")"
[ -f go.sum ] || go mod tidy
mkdir -p dist
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags "-s -w" -o dist/orasqlx-linux-$arch .
  echo "OK  dist/orasqlx-linux-$arch"
done
go test ./... >/dev/null && echo "单元测试通过"
