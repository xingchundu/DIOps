package main

import (
	"fmt"
	"strings"
)

func planHashes(s *Snapshot) string {
	var p []string
	for _, r := range s.Sec("drift").Maps() {
		p = append(p, r["PLAN_HASH_VALUE"])
	}
	p = uniq(p)
	return blankTo(strings.Join(p, ", "), "-")
}

func delta(before, after float64, lowerBetter bool) string {
	if before == 0 {
		return "-"
	}
	d := (after - before) / before * 100
	mark := ""
	switch {
	case d == 0:
		mark = "持平"
	case (d < 0) == lowerBetter:
		mark = "改善"
	default:
		mark = "变差"
	}
	return fmt.Sprintf("%+.1f%%（%s）", d, mark)
}

// buildCompare 生成"优化前 vs 优化后"章节。base 是优化前快照（--compare 指定），cur 是本次。
func buildCompare(base, cur *Snapshot) Section {
	b, c := base.Metrics, cur.Metrics
	row := func(name string, x, y float64, f func(float64) string, lower bool) []string {
		return []string{name, f(x), f(y), delta(x, y, lower)}
	}
	sec := fmt.Sprintf
	rows := [][]string{
		row("单次耗时（秒）", b.PerExecSec(), c.PerExecSec(), fmtTwo, true),
		row("单次逻辑读（块）", div(b.LIO, b.Execs), div(c.LIO, c.Execs), fmtInt, true),
		row("单次物理读（块）", div(b.PIO, b.Execs), div(c.PIO, c.Execs), fmtInt, true),
		row("缓存命中率（%）", b.HitRatio(), c.HitRatio(), fmtTwo, false),
		row("单次返回行数", div(b.RowsProc, b.Execs), div(c.RowsProc, c.Execs), fmtInt, false),
		row("I/O 等待占比（%）", pct(b.UserIOUS, b.ElapsedUS), pct(c.UserIOUS, c.ElapsedUS), fmtTwo, true),
		row("RAC 集群等待占比（%）", pct(b.ClusterUS, b.ElapsedUS), pct(c.ClusterUS, c.ElapsedUS), fmtTwo, true),
		{"PLAN_HASH_VALUE", planHashes(base), planHashes(cur), ternary(planHashes(base) == planHashes(cur), "未变化", "计划已变化")},
		{"基线采集时间 / 本次采集时间", base.Meta.Generated, cur.Meta.Generated, ""},
	}
	bc, cc := countSev(base.Findings), countSev(cur.Findings)
	rows = append(rows, []string{"结论数（严重/警告/提示）", sec("%d / %d / %d", bc[0], bc[1], bc[2]), sec("%d / %d / %d", cc[0], cc[1], cc[2]), ""})
	old := map[string]string{}
	for _, f := range base.Findings {
		old[f.ID] = f.Problem
	}
	now := map[string]string{}
	for _, f := range cur.Findings {
		now[f.ID] = f.Problem
	}
	var gone, added []string
	for _, f := range base.Findings {
		if _, ok := now[f.ID]; !ok {
			gone = append(gone, f.ID+" "+f.Problem)
		}
	}
	for _, f := range cur.Findings {
		if _, ok := old[f.ID]; !ok {
			added = append(added, f.ID+" "+f.Problem)
		}
	}
	rows = append(rows, []string{"已消除的问题", "", blankTo(strings.Join(gone, "；"), "无"), ""})
	rows = append(rows, []string{"新出现的问题", "", blankTo(strings.Join(added, "；"), "无"), ""})
	note := "基线来自 --compare 指定的历史快照。单次值均按「累计值 / 执行次数」折算；两次的数据量、绑定值、缓存状态不同会影响可比性，务必在同口径下复测。"
	if b.Execs == 0 || c.Execs == 0 {
		note += " 注意：某一侧执行次数为 0，对比无意义。"
	}
	return Section{Key: "compare", Title: "优化前后效果对比", Note: note, Cols: []string{"指标", "优化前（基线）", "优化后（本次）", "变化"}, Rows: rows}
}
