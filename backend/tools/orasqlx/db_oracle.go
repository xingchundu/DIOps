//go:build !nodriver

package main

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	// 纯 Go Oracle 驱动：不依赖 Oracle Instant Client，可静态编译。
	_ "github.com/sijms/go-ora/v2"
)

// parseConnect 解析 user/pwd@host:port/service（密码可含 @，按最后一个 @ 切分）。
func parseConnect(s string) (user, pwd, host, service string, err error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", "", "", "", fmt.Errorf("缺少 --connect（或环境变量 ORASQLX_CONNECT）")
	}
	if strings.HasPrefix(s, "oracle://") {
		u, e := url.Parse(s)
		if e != nil {
			return "", "", "", "", e
		}
		p, _ := u.User.Password()
		return u.User.Username(), p, u.Host, strings.TrimPrefix(u.Path, "/"), nil
	}
	at := strings.LastIndex(s, "@")
	if at < 0 {
		return "", "", "", "", fmt.Errorf("连接串格式应为 user/pwd@host:1521/service")
	}
	cred, addr := s[:at], s[at+1:]
	if i := strings.Index(cred, "/"); i >= 0 {
		user, pwd = cred[:i], cred[i+1:]
	} else {
		user = cred
	}
	slash := strings.Index(addr, "/")
	if slash < 0 {
		return "", "", "", "", fmt.Errorf("连接串缺少服务名：host:1521/service")
	}
	host, service = addr[:slash], addr[slash+1:]
	if !strings.Contains(host, ":") {
		host += ":1521"
	}
	return
}

func buildDSN(o Options) (string, error) {
	user, pwd, host, svc, err := parseConnect(o.Connect)
	if err != nil {
		return "", err
	}
	if pwd == "" {
		pwd = os.Getenv("ORASQLX_PWD")
	}
	if pwd == "" {
		fmt.Fprintf(os.Stderr, "请输入 %s 的密码（输入可见，建议改用 ORASQLX_PWD 环境变量）: ", user)
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		pwd = strings.TrimRight(line, "\r\n")
	}
	u := &url.URL{Scheme: "oracle", User: url.UserPassword(user, pwd), Host: host, Path: "/" + svc}
	return u.String(), nil
}

func openDB(o Options) (DB, error) {
	dsn, err := buildDSN(o)
	if err != nil {
		return nil, err
	}
	raw, err := sql.Open("oracle", dsn)
	if err != nil {
		return nil, err
	}
	// 单连接：ALTER SESSION SET CONTAINER 等会话级状态必须在同一连接上生效。
	raw.SetMaxOpenConns(1)
	raw.SetMaxIdleConns(1)
	raw.SetConnMaxLifetime(2 * time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(o.TimeoutSec)*time.Second)
	defer cancel()
	if err := raw.PingContext(ctx); err != nil {
		raw.Close()
		return nil, fmt.Errorf("连接失败: %w", err)
	}
	d := &sqlDB{db: raw}
	if o.PDB != "" {
		pdb, e := lit(strings.ToUpper(o.PDB))
		if e != nil {
			raw.Close()
			return nil, e
		}
		if _, err := raw.ExecContext(ctx, "ALTER SESSION SET CONTAINER = "+strings.Trim(pdb, "'")); err != nil {
			raw.Close()
			return nil, fmt.Errorf("切换 PDB %s 失败（需要 SET CONTAINER 权限）: %w", o.PDB, err)
		}
	}
	return d, nil
}
