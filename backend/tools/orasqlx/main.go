package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func fail(err error) {
	fmt.Fprintf(os.Stderr, "\n错误: %v\n", err)
	os.Exit(2)
}

func main() {
	o, err := parseCLI(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fail(err)
	}
	if o.ShowVer {
		fmt.Printf("%s %s  (Go / 独立 Linux 二进制 / CDB+非CDB / 单机+RAC / 多 SQL_ID 对比 / 默认 DOCX 报告 / 规则引擎独立 / AI 可选)\n",
			toolName, toolVersion)
		return
	}
	if o.ListRules {
		fmt.Print(listRules(o.Rules))
		return
	}
	if o.Demo && (o.Input != "" || o.InputDir != "") {
		fail(fmt.Errorf("--demo 与 --input / --input-dir 不能同时使用"))
	}
	if o.DryRun {
		if err := printDryRun(o); err != nil {
			fail(err)
		}
		return
	}
	if o.Check {
		if err := runConnCheck(o); err != nil {
			fail(err)
		}
		return
	}

	// ---------- 1. 取快照：实时连库 / 离线快照 / 内置样例 ----------
	items, isBatch, cleanup, err := obtainSnapshots(o)
	if err != nil {
		fail(err)
	}
	defer cleanup()

	// ---------- 2. 规则引擎：每个 SQL_ID 独立重算，完全不依赖 AI ----------
	for _, it := range items {
		if it.Err == nil && it.Snap != nil && !o.KeepFind {
			it.Snap.Findings = RunRules(it.Snap, o.Rules)
		}
	}

	if !isBatch {
		if len(items) == 0 {
			fail(fmt.Errorf("没有可用的诊断结果"))
		}
		runSingle(o, items[0])
		return
	}
	runBatchMode(o, items)
}

// obtainSnapshots 统一三种数据来源，返回按输入顺序排列的结果。
// 批量连库时 parallel=1 复用单连接，parallel>1 时每个 SQL_ID 独立建连（各自探测架构、必要时切 PDB）。
func obtainSnapshots(o Options) ([]BatchItem, bool, func(), error) {
	noop := func() {}
	switch {
	case o.Demo:
		ids := o.SQLIDs
		if len(ids) == 0 {
			ids = []string{"2jqdamknrmm6r"}
		}
		items := runBatch(ids, 1, func(id string) (*Snapshot, error) {
			idx := 0
			for i, x := range ids {
				if x == id {
					idx = i
					break
				}
			}
			s := demoVariantSnapshot(id, idx)
			if bad := demoSanity(s); len(bad) > 0 {
				return nil, fmt.Errorf("内置样例数据异常: %s", strings.Join(bad, "; "))
			}
			if o.NoAWR {
				markAWRDemo(s)
			}
			return s, nil
		})
		return items, len(items) > 1, noop, nil

	case o.Input != "" || o.InputDir != "":
		items, err := loadBatchFiles(o)
		if err != nil {
			return nil, false, noop, err
		}
		isBatch := len(items) > 1 || o.InputDir != "" || strings.Contains(o.Input, ",")
		return items, isBatch, noop, nil

	default: // 实时连库
		if len(o.SQLIDs) == 0 {
			return nil, false, noop, fmt.Errorf("缺少 SQL_ID；用法: %s <SQL_ID[,SQL_ID...]> --connect user/pwd@host:1521/service", toolName)
		}
		ids := o.SQLIDs
		if len(ids) == 1 {
			db, err := openDB(o)
			if err != nil {
				return nil, false, noop, err
			}
			s, err := collect(context.Background(), db, o, ids[0])
			if err != nil {
				db.Close()
				return nil, false, noop, err
			}
			return []BatchItem{{SQLID: ids[0], Snap: s}}, false, func() { db.Close() }, nil
		}
		var shared DB
		cleanup := noop
		if o.Parallel <= 1 {
			d, err := openDB(o)
			if err != nil {
				return nil, true, noop, err
			}
			shared = d
			cleanup = func() { shared.Close() }
		}
		items := runBatch(ids, o.Parallel, func(id string) (*Snapshot, error) {
			if shared != nil {
				return collect(context.Background(), shared, o, id)
			}
			d, err := openDB(o)
			if err != nil {
				return nil, err
			}
			defer d.Close()
			return collect(context.Background(), d, o, id)
		})
		return items, true, cleanup, nil
	}
}

func markAWRDemo(s *Snapshot) {
	for i := range s.Sections {
		if isAWRKey(s.Sections[i].Key) {
			s.Sections[i].Note = strings.TrimSpace(s.Sections[i].Note +
				" [已通过 --no-awr 跳过：AWR/ASH 需 Diagnostics Pack 授权]")
			s.Sections[i].Rows = nil
		}
	}
	s.Meta.AWREnabled = false
}

// runSingle 保持 v1.0 的单 SQL_ID 完整报告流程。
func runSingle(o Options, item BatchItem) {
	if item.Err != nil || item.Snap == nil {
		fail(fmt.Errorf("诊断失败: %v", item.Err))
	}
	s := item.Snap
	if o.SQLID == "" {
		o.SQLID = s.Meta.SQLID
	}

	if o.Compare != "" {
		base, e := loadSnapshot(o.Compare)
		if e != nil {
			fail(fmt.Errorf("加载对比基线失败: %w", e))
		}
		cmp := buildCompare(base, s)
		s.Sections = append([]Section{cmp}, s.Sections...)
	}

	s.Meta.AIEnabled = o.AI.Enabled
	if o.AI.Enabled {
		s.Meta.AIProvider = o.AI.Provider
		summary, e := runAI(s, o.AI)
		if e != nil {
			s.AIError = e.Error()
		} else {
			s.AISummary = summary
		}
	}
	if o.Snapshot != "" {
		if e := saveSnapshot(o.Snapshot, s); e != nil {
			fmt.Fprintf(os.Stderr, "警告: 保存快照失败: %v\n", e)
		} else {
			fmt.Printf("快照已保存: %s\n", o.Snapshot)
		}
	}
	if o.RulesOnly {
		fmt.Print(renderRulesOnly(s))
		return
	}
	report, e := encodeSingleReport(s, o.Format)
	if e != nil {
		fail(fmt.Errorf("生成报告失败: %w", e))
	}
	out := o.Out
	if out == "" {
		id := blankTo(blankTo(o.SQLID, s.Meta.SQLID), "orasqlx")
		out = fmt.Sprintf("%s_diag.%s", id, reportExt[o.Format])
	}
	if out == "-" {
		if _, e := os.Stdout.Write(report); e != nil {
			fail(fmt.Errorf("写出报告失败: %w", e))
		}
		return
	}
	if e := writeReportFile(out, report, o.Format); e != nil {
		fail(fmt.Errorf("写入报告失败: %w", e))
	}
	printSummary(s, out)
}

// writeReportFile 统一写出；DOCX 为二进制，显式 --out 后缀不匹配时给出提示但不阻断。
func writeReportFile(out string, data []byte, format string) error {
	if format == "docx" && !strings.HasSuffix(strings.ToLower(out), ".docx") {
		fmt.Fprintf(os.Stderr, "警告: --format docx 的输出路径 %q 不是 .docx 后缀，Word/WPS 可能无法识别\n", out)
	}
	return os.WriteFile(out, data, 0o644)
}

// runBatchMode 输出一份横向对比报告，可选额外输出每个 SQL_ID 的完整报告与快照。
func runBatchMode(o Options, items []BatchItem) {
	br := buildBatchReport(items, o)

	// AI 可选层：逐 SQL 归纳，任一失败都不阻断批量报告。
	if o.AI.Enabled {
		for _, it := range items {
			if it.Err != nil || it.Snap == nil {
				continue
			}
			it.Snap.Meta.AIEnabled = true
			it.Snap.Meta.AIProvider = o.AI.Provider
			summary, e := runAI(it.Snap, o.AI)
			if e != nil {
				br.AISummaries = append(br.AISummaries, [2]string{it.SQLID, "AI 未产出内容：" + e.Error()})
			} else {
				br.AISummaries = append(br.AISummaries, [2]string{it.SQLID, summary})
			}
		}
	}

	// 快照目录：每个 SQL_ID 一份，供规则复跑 / 优化前后对比。
	if o.SnapshotDir != "" {
		if e := os.MkdirAll(o.SnapshotDir, 0o755); e != nil {
			fmt.Fprintf(os.Stderr, "警告: 创建快照目录失败: %v\n", e)
		} else {
			n := 0
			for _, it := range items {
				if it.Err != nil || it.Snap == nil {
					continue
				}
				p := filepath.Join(o.SnapshotDir, it.SQLID+".json")
				if e := saveSnapshot(p, it.Snap); e == nil {
					n++
				}
			}
			fmt.Printf("快照已保存 %d 份到 %s\n", n, o.SnapshotDir)
		}
	}

	// 单份完整报告（可选）：便于把某条 SQL 的完整证据链单独发给 DBA。
	if o.PerReport {
		if e := os.MkdirAll(o.ReportDir, 0o755); e != nil {
			fmt.Fprintf(os.Stderr, "警告: 创建报告目录失败: %v\n", e)
		} else {
			ext := reportExt[o.Format]
			n := 0
			for _, it := range items {
				if it.Err != nil || it.Snap == nil {
					continue
				}
				data, e := encodeSingleReport(it.Snap, o.Format)
				if e != nil {
					fmt.Fprintf(os.Stderr, "警告: %s 报告编码失败: %v\n", it.SQLID, e)
					continue
				}
				p := filepath.Join(o.ReportDir, it.SQLID+"_diag."+ext)
				if e := os.WriteFile(p, data, 0o644); e == nil {
					n++
				}
			}
			fmt.Printf("单份完整报告已生成 %d 份到 %s\n", n, o.ReportDir)
		}
	}

	if o.RulesOnly {
		fmt.Print(renderBatchRulesOnly(br))
		return
	}
	out := o.Out
	if out == "" {
		out = fmt.Sprintf("batch_diag_%s.%s", time.Now().Format("20060102_150405"), reportExt[o.Format])
	}
	report, e := encodeBatchReport(br, o.Format)
	if e != nil {
		fail(fmt.Errorf("生成批量报告失败: %w", e))
	}
	if out == "-" {
		if _, e := os.Stdout.Write(report); e != nil {
			fail(fmt.Errorf("写出批量报告失败: %w", e))
		}
		return
	}
	if e := writeReportFile(out, report, o.Format); e != nil {
		fail(fmt.Errorf("写入批量报告失败: %w", e))
	}
	printBatchSummary(br, out)
}

func printSummary(s *Snapshot, out string) {
	cnt := countSev(s.Findings)
	fmt.Printf("\n诊断完成  SQL_ID=%s  模式=%s  章节=%d  规则=%d\n",
		s.Meta.SQLID, s.Meta.Mode, len(s.Sections), len(Rules))
	fmt.Printf("单次耗时 %s s  返回 %s 行  逻辑读 %s 块  命中率 %s%%\n",
		fmtSec(s.Metrics.ElapsedUS, s.Metrics.Execs),
		fmtInt(div(s.Metrics.RowsProc, s.Metrics.Execs)),
		fmtInt(div(s.Metrics.LIO, s.Metrics.Execs)),
		fmtTwo(pct(s.Metrics.LIO-s.Metrics.PIO, s.Metrics.LIO)))
	fmt.Printf("结论 %d 条：严重 %d / 警告 %d / 提示 %d\n",
		len(s.Findings), cnt[0], cnt[1], len(s.Findings)-cnt[0]-cnt[1])
	for i, f := range s.Findings {
		if i >= 5 {
			fmt.Printf("  ... 其余 %d 条见报告\n", len(s.Findings)-5)
			break
		}
		fmt.Printf("  [%s] %s (%s)\n", sevLabel[f.Severity], f.Problem, f.ID)
	}
	if s.AIError != "" {
		fmt.Printf("AI: 未产出内容（%s），不影响报告\n", truncate(s.AIError, 60))
	}
	if len(s.Errors) > 0 {
		fmt.Printf("采集异常 %d 个章节（多为权限或未授权视图），详见报告标黄部分\n", len(s.Errors))
	}
	fmt.Printf("报告已生成: %s\n", out)
}
