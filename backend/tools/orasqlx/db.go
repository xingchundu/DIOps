package main

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DB 是采集层对数据库的最小抽象：只读查询，结果统一成字符串表。
type DB interface {
	Query(ctx context.Context, q string, args ...any) (cols []string, rows [][]string, err error)
	Close() error
}

type sqlDB struct{ db *sql.DB }

func (d *sqlDB) Close() error { return d.db.Close() }

func (d *sqlDB) Query(ctx context.Context, q string, args ...any) ([]string, [][]string, error) {
	rs, err := d.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rs.Close()
	cols, err := rs.Columns()
	if err != nil {
		return nil, nil, err
	}
	for i := range cols {
		cols[i] = strings.ToUpper(cols[i])
	}
	var out [][]string
	for rs.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rs.Scan(ptrs...); err != nil {
			return cols, out, err
		}
		row := make([]string, len(cols))
		for i, v := range vals {
			row[i] = cell(v)
		}
		out = append(out, row)
	}
	return cols, out, rs.Err()
}

func cell(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []byte:
		return string(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'f', -1, 32)
	case bool:
		if x {
			return "TRUE"
		}
		return "FALSE"
	case time.Time:
		return x.Format("2006-01-02 15:04:05")
	default:
		return fmt.Sprint(x)
	}
}
