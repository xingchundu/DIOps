//go:build nodriver

package main

import "fmt"

// 仅用于在无法下载 Oracle 驱动的环境里编译/自测（go build -tags nodriver）。
func openDB(o Options) (DB, error) {
	return nil, fmt.Errorf("本二进制以 -tags nodriver 构建，未包含 Oracle 驱动；请用 build.sh 正式构建")
}
