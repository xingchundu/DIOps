package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

func encodeSingleReport(s *Snapshot, format string) ([]byte, error) {
	switch format {
	case "docx":
		return buildDocx(s)
	case "html":
		return []byte(buildHTML(s)), nil
	case "json":
		return json.MarshalIndent(s, "", " ")
	}
	return nil, fmt.Errorf("不支持的格式 %s", format)
}

func encodeBatchReport(br *BatchReport, format string) ([]byte, error) {
	switch format {
	case "docx":
		return buildBatchDocx(br)
	case "html":
		return []byte(buildBatchHTML(br)), nil
	case "json":
		type item struct {
			SQLID string    `json:"sql_id"`
			Err   string    `json:"error,omitempty"`
			Snap  *Snapshot `json:"snapshot,omitempty"`
		}
		var out []item
		for _, it := range br.Items {
			x := item{SQLID: it.SQLID, Snap: it.Snap}
			if it.Err != nil {
				x.Err = it.Err.Error()
			}
			out = append(out, x)
		}
		return json.MarshalIndent(out, "", " ")
	}
	return nil, fmt.Errorf("不支持的格式 %s", format)
}

func renderRulesOnly(s *Snapshot) string {
	var b strings.Builder
	cnt := countSev(s.Findings)
	fmt.Fprintf(&b, "SQL_ID %s  %s\n", s.Meta.SQLID, envLine(s))
	fmt.Fprintf(&b, "单次耗时 %s s | 返回 %s 行 | 逻辑读 %s 块 | 命中率 %s%%\n", fmtSec(s.Metrics.ElapsedUS, s.Metrics.Execs),
		fmtInt(div(s.Metrics.RowsProc, s.Metrics.Execs)), fmtInt(div(s.Metrics.LIO, s.Metrics.Execs)), fmtTwo(s.Metrics.HitRatio()))
	fmt.Fprintf(&b, "结论 %d 条：严重 %d / 警告 %d / 提示 %d\n\n", len(s.Findings), cnt[0], cnt[1], len(s.Findings)-cnt[0]-cnt[1])
	for _, f := range s.Findings {
		fmt.Fprintf(&b, "[%s] %s  (%s · 可信度 %.2f)\n", sevLabel[f.Severity], f.Problem, f.ID, f.Confidence)
		for _, e := range f.Evidence {
			fmt.Fprintf(&b, "    · %s\n", e)
		}
		fmt.Fprintf(&b, "    建议：%s\n    风险：%s\n\n", f.Suggestion, f.Risk)
	}
	return b.String()
}
