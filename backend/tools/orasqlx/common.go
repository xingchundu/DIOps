package main

import (
	"fmt"
	"strings"
)

func keyMetricRows(s *Snapshot) [][]string {
	m := s.Metrics
	return [][]string{
		{"单次执行耗时", fmtSec(m.ElapsedUS, m.Execs), "秒"},
		{"执行次数", fmtInt(m.Execs), "次"},
		{"单次返回行数", fmtInt(div(m.RowsProc, m.Execs)), "行"},
		{"单次逻辑读", fmtInt(div(m.LIO, m.Execs)), "块"},
		{"单次物理读", fmtInt(div(m.PIO, m.Execs)), "块"},
		{"缓存命中率", fmtTwo(m.HitRatio()), "%"},
		{"I/O 等待占比", fmtTwo(pct(m.UserIOUS, m.ElapsedUS)), "%"},
		{"RAC 集群等待", fmtTwo(pct(m.ClusterUS, m.ElapsedUS)), "%"},
		{"执行计划数", fmt.Sprint(m.PlanCount), "个"},
	}
}

func firstSentence(s string) string {
	for _, sep := range []string{"；", "。", ";"} {
		if i := strings.Index(s, sep); i > 0 {
			s = s[:i]
			break
		}
	}
	return truncate(s, 70)
}

// execSummary 给忙碌的读者：一段话说清"慢在哪、先做什么"。
func execSummary(s *Snapshot) string {
	m := s.Metrics
	cnt := countSev(s.Findings)
	var b strings.Builder
	fmt.Fprintf(&b, "SQL_ID %s 单次执行约 %s 秒，返回约 %s 行，逻辑读 %s 块，缓存命中率 %s%%。", s.Meta.SQLID, fmtSec(m.ElapsedUS, m.Execs),
		fmtInt(div(m.RowsProc, m.Execs)), fmtInt(div(m.LIO, m.Execs)), fmtTwo(m.HitRatio()))
	if len(s.Findings) == 0 {
		b.WriteString("规则引擎未发现明显问题；建议结合业务 SLA 判断是否仍需优化。")
		return b.String()
	}
	fmt.Fprintf(&b, "共 %d 条结论（严重 %d / 警告 %d / 提示 %d）。", len(s.Findings), cnt[0], cnt[1], len(s.Findings)-cnt[0]-cnt[1])
	var top []string
	for _, f := range s.Findings {
		if f.Severity == 0 && len(top) < 3 {
			top = append(top, f.ID+" "+f.Problem)
		}
	}
	if len(top) > 0 {
		b.WriteString("首要问题：" + strings.Join(top, "；") + "。")
	}
	b.WriteString("所有建议仅供 DBA 评审，工具不执行任何变更；先在测试环境按各条「验证方法」复测。")
	return b.String()
}

// roadmapRows 把结论整理成"先做什么、成本多大、风险在哪"的行动清单。
func roadmapRows(s *Snapshot) [][]string {
	var rows [][]string
	for i, f := range s.Findings {
		rows = append(rows, []string{fmt.Sprint(i + 1), sevLabel[f.Severity], f.ID + " " + f.Problem,
			firstSentence(f.Suggestion), blankTo(f.Effort, "-"), firstSentence(f.Risk)})
	}
	return rows
}

var roadmapCols = []string{"序", "等级", "问题", "首要动作", "实施成本", "主要风险"}

var footNotes = []string{
	"口径说明：GV$ 指标为共享池内累计值（自游标加载起），除以执行次数换算为单次；并行子查询可能累加导致各等待分项之和大于总耗时。",
	"A-Rows 需 GATHER_PLAN_STATISTICS 或 STATISTICS_LEVEL=ALL，缺失时本报告不会用 E-Rows 冒充实测；V$SQL_BIND_CAPTURE 为采样值，不代表每次执行。",
	"AWR / ASH 章节需 Oracle Diagnostics Pack 授权；默认按 control_management_pack_access 自动判断，也可用 --no-awr 强制跳过。CDB 环境请直连业务 PDB 或用 --pdb 切换，非 CDB 单库无需任何容器参数。",
	"本报告只生成建议，不执行任何 DDL / DML / SQL Patch / 统计信息收集；生产变更须经 DBA 审核与测试环境验证。",
}

func footer(s *Snapshot) string {
	s0 := fmt.Sprintf("由 %s %s 生成 · 快照 schema v%d · 规则引擎独立运行（%d 条规则）· AI 默认关闭", toolName, toolVersion, snapSchema, len(Rules))
	return s0
}

// evidenceSections 返回参与编号的"采集证据"章节（对比章节单独呈现）。
func evidenceSections(s *Snapshot) []Section {
	var out []Section
	for _, x := range s.Sections {
		if x.Key != "compare" {
			out = append(out, x)
		}
	}
	return out
}

// splitCommon 把宽表拆成"所有行相同的公共字段"和"有差异的列"，避免 30 列的表挤成一团。
func splitCommon(cols []string, rows [][]string) (common [][2]string, vcols []string, vrows [][]string) {
	if len(cols) <= 12 || len(rows) < 2 {
		return nil, cols, rows
	}
	var keep []int
	for i, c := range cols {
		same := true
		for _, r := range rows {
			if i >= len(r) || r[i] != rows[0][i] {
				same = false
				break
			}
		}
		if same {
			if rows[0][i] != "" {
				common = append(common, [2]string{c, rows[0][i]})
			}
		} else {
			keep = append(keep, i)
		}
	}
	for _, i := range keep {
		vcols = append(vcols, cols[i])
	}
	for _, r := range rows {
		var nr []string
		for _, i := range keep {
			if i < len(r) {
				nr = append(nr, r[i])
			} else {
				nr = append(nr, "")
			}
		}
		vrows = append(vrows, nr)
	}
	return
}
