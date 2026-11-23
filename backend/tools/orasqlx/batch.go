package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

func saveSnapshot(path string, s *Snapshot) error {
	b, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	if dir := filepath.Dir(path); dir != "." {
		_ = os.MkdirAll(dir, 0o755)
	}
	return os.WriteFile(path, b, 0o600) // 快照可能含业务 SQL，权限收紧
}

func loadSnapshot(path string) (*Snapshot, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Snapshot
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("%s 不是有效的快照 JSON: %w", path, err)
	}
	if s.Schema == 0 || s.Schema > snapSchema {
		return nil, fmt.Errorf("%s 的快照 schema=%d 与当前版本(%d)不兼容", path, s.Schema, snapSchema)
	}
	return &s, nil
}

func loadBatchFiles(o Options) ([]BatchItem, error) {
	var files []string
	for _, f := range strings.Split(o.Input, ",") {
		if f = strings.TrimSpace(f); f != "" {
			files = append(files, f)
		}
	}
	if o.InputDir != "" {
		m, err := filepath.Glob(filepath.Join(o.InputDir, "*.json"))
		if err != nil {
			return nil, err
		}
		sort.Strings(m)
		files = append(files, m...)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("没有找到可读取的快照文件")
	}
	var items []BatchItem
	for _, f := range files {
		s, err := loadSnapshot(f)
		id := strings.TrimSuffix(filepath.Base(f), filepath.Ext(f))
		if s != nil {
			id = s.Meta.SQLID
			s.Meta.Mode = "offline"
		}
		items = append(items, BatchItem{SQLID: id, Snap: s, Err: err})
	}
	return items, nil
}

// runBatch 保序并发执行，单个 SQL_ID 失败不影响其它。
func runBatch(ids []string, parallel int, fn func(id string) (*Snapshot, error)) []BatchItem {
	if parallel < 1 {
		parallel = 1
	}
	out := make([]BatchItem, len(ids))
	var wg sync.WaitGroup
	sem := make(chan struct{}, parallel)
	for i, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, id string) {
			defer wg.Done()
			defer func() { <-sem }()
			defer func() {
				if r := recover(); r != nil {
					out[i] = BatchItem{SQLID: id, Err: fmt.Errorf("内部错误: %v", r)}
				}
			}()
			s, err := fn(id)
			out[i] = BatchItem{SQLID: id, Snap: s, Err: err}
		}(i, id)
	}
	wg.Wait()
	return out
}

func buildBatchReport(items []BatchItem, o Options) *BatchReport {
	return &BatchReport{Items: items, Generated: time.Now().Format("2006-01-02 15:04:05"), Opts: o}
}

func batchRow(it BatchItem) []string {
	if it.Err != nil || it.Snap == nil {
		return []string{it.SQLID, "采集失败", "", "", "", "", "", truncate(fmt.Sprint(it.Err), 60)}
	}
	s := it.Snap
	cnt := countSev(s.Findings)
	top := ""
	if len(s.Findings) > 0 {
		top = s.Findings[0].ID + " " + s.Findings[0].Problem
	}
	return []string{it.SQLID, fmtSec(s.Metrics.ElapsedUS, s.Metrics.Execs), fmtInt(div(s.Metrics.RowsProc, s.Metrics.Execs)),
		fmtInt(div(s.Metrics.LIO, s.Metrics.Execs)), fmtTwo(s.Metrics.HitRatio()),
		fmt.Sprintf("%d / %d / %d", cnt[0], cnt[1], cnt[2]), fmt.Sprint(s.Meta.Instances), top}
}

var batchCols = []string{"SQL_ID", "单次耗时(s)", "单次返回行", "单次逻辑读", "命中率%", "严重/警告/提示", "实例数", "首要问题"}

func renderBatchRulesOnly(br *BatchReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, "批量诊断（%d 个 SQL_ID）\n\n", len(br.Items))
	for _, it := range br.Items {
		r := batchRow(it)
		fmt.Fprintf(&b, "%-14s 耗时 %ss  返回 %s 行  命中率 %s%%  [%s]  %s\n", r[0], r[1], r[2], r[4], r[5], r[7])
	}
	return b.String()
}

func printBatchSummary(br *BatchReport, out string) {
	ok, bad := 0, 0
	for _, it := range br.Items {
		if it.Err != nil || it.Snap == nil {
			bad++
		} else {
			ok++
		}
	}
	fmt.Printf("\n批量诊断完成  成功 %d / 失败 %d\n", ok, bad)
	for _, it := range br.Items {
		if it.Err != nil {
			fmt.Printf("  %s 失败: %v\n", it.SQLID, it.Err)
			continue
		}
		cnt := countSev(it.Snap.Findings)
		fmt.Printf("  %s  单次 %s s  严重 %d / 警告 %d / 提示 %d\n", it.SQLID, fmtSec(it.Snap.Metrics.ElapsedUS, it.Snap.Metrics.Execs), cnt[0], cnt[1], len(it.Snap.Findings)-cnt[0]-cnt[1])
	}
	fmt.Printf("对比报告已生成: %s\n", out)
}
