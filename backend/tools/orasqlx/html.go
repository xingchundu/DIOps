package main

import (
	"fmt"
	"html"
	"strings"
)

const htmlCSS = `*{box-sizing:border-box}
body{margin:0;padding:28px 32px 60px;background:#F7F7F5;color:#2C2C2A;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.65}
.wrap{max-width:1280px;margin:0 auto}h1{font-size:24px;font-weight:600;margin:0 0 6px}
h2{font-size:18px;font-weight:600;margin:34px 0 14px;padding-bottom:8px;border-bottom:1px solid #E3E1DA}
.sub{color:#5F5E5A;font-size:12px;margin-bottom:22px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0 8px}
.card{background:#fff;border:1px solid #E3E1DA;border-radius:8px;padding:14px 16px}.card .k{font-size:12px;color:#5F5E5A;margin-bottom:6px}
.card .v{font-size:21px;font-weight:600}.card .u{font-size:12px;color:#888780;font-weight:400;margin-left:3px}
.nav{background:#fff;border:1px solid #E3E1DA;border-radius:8px;padding:14px 18px;margin:18px 0}
.nav a{display:inline-block;margin:3px 14px 3px 0;color:#185FA5;text-decoration:none;font-size:12px}
.f{background:#fff;border:1px solid #E3E1DA;border-left-width:4px;border-radius:8px;padding:14px 18px;margin:12px 0}
.f.s0{border-left-color:#C0392B}.f.s1{border-left-color:#C77700}.f.s2{border-left-color:#378ADD}
.tag{display:inline-block;font-size:11px;padding:2px 9px;border-radius:4px;color:#fff;margin-right:9px}
.s0 .tag{background:#C0392B}.s1 .tag{background:#C77700}.s2 .tag{background:#378ADD}
.f .id{font-size:11px;color:#888780;float:right}.f ul{margin:6px 0 8px;padding-left:20px}.f li{font-size:12.5px;color:#444441}
.f .row{margin-top:7px;font-size:12.5px}.f .risk{color:#A32D2D}
pre.sql{background:#F1EFE8;border:1px solid rgba(0,0,0,.08);border-radius:6px;padding:10px 12px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:8px 0 0;font-family:Consolas,"Courier New",monospace}
pre.plan{background:#FBFAF7;border:1px solid #E3E1DA;border-radius:6px;padding:12px;font-size:12px;white-space:pre;overflow-x:auto;font-family:Consolas,"Courier New",monospace}
.sc{background:#fff;border:1px solid #E3E1DA;border-radius:8px;margin:14px 0;overflow:hidden}.sc>.hd{padding:11px 16px;font-weight:600;background:#FBFAF7;border-bottom:1px solid #E3E1DA}
.note{padding:8px 16px;font-size:12px;color:#5F5E5A;background:#FBFAF7}.err{padding:8px 16px;font-size:12px;color:#A32D2D;background:#FDF3F2}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}th{background:#F4F3EF;text-align:left;padding:8px 10px;white-space:nowrap;border-bottom:1px solid #E3E1DA}
td{padding:7px 10px;border-bottom:1px solid #F0EEE8;vertical-align:top;word-break:break-word}tr:nth-child(even) td{background:#FCFBF9}
.empty{padding:12px 16px;color:#888780;font-size:12px}.badge{display:inline-block;background:#EFEDE6;border-radius:4px;padding:1px 7px;font-size:11px;color:#5F5E5A;margin-right:6px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid #E3E1DA;color:#888780;font-size:11.5px;line-height:1.8}`

func he(s string) string { return html.EscapeString(s) }

func htmlTable(cols []string, rows [][]string) string {
	var b strings.Builder
	b.WriteString(`<div class="scroll"><table><thead><tr>`)
	for _, c := range cols {
		b.WriteString("<th>" + he(c) + "</th>")
	}
	b.WriteString("</tr></thead><tbody>")
	for i, r := range rows {
		if i >= maxRows {
			break
		}
		b.WriteString("<tr>")
		for j := range cols {
			v := ""
			if j < len(r) {
				v = r[j]
			}
			b.WriteString("<td>" + he(truncate(v, 500)) + "</td>")
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</tbody></table></div>")
	return b.String()
}

func buildHTML(s *Snapshot) string {
	var b strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&b, f, a...) }
	w(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oracle SQL 诊断报告 %s</title><style>%s</style></head><body><div class="wrap">`, he(s.Meta.SQLID), htmlCSS)
	w(`<h1>Oracle SQL 智能诊断报告</h1><div class="sub">SQL_ID <b>%s</b> · %s · 模式 %s · 生成于 %s<br>%s</div>`, he(s.Meta.SQLID), he(blankTo(s.Meta.DBName, "-")), he(s.Meta.Mode), he(s.Meta.Generated), he(envLine(s)))
	w(`<h2>关键指标</h2><div class="cards">`)
	for _, r := range keyMetricRows(s) {
		w(`<div class="card"><div class="k">%s</div><div class="v">%s<span class="u">%s</span></div></div>`, he(r[0]), he(r[1]), he(r[2]))
	}
	w(`</div><h2>执行摘要与优化路线图</h2><p>%s</p>`, he(execSummary(s)))
	if len(s.Findings) > 0 {
		b.WriteString(`<div class="sc"><div class="bd">` + htmlTable(roadmapCols, roadmapRows(s)) + `</div></div>`)
	}
	if s.AISummary != "" {
		w(`<h2>AI 归纳（可选，仅供参考）</h2><div class="sc"><div class="note"><pre style="white-space:pre-wrap;margin:0;font-family:inherit">%s</pre></div></div>`, he(s.AISummary))
	}
	for _, x := range s.Sections {
		if x.Key == "compare" {
			w(`<h2>%s</h2><div class="note">%s</div>%s`, he(x.Title), he(x.Note), htmlTable(x.Cols, x.Rows))
		}
	}
	cnt := countSev(s.Findings)
	w(`<h2>诊断结论与优化建议</h2><div class="sub">共 %d 条：严重 %d / 警告 %d / 提示 %d。每条均含依据、风险与验证方法；建议不会自动执行。</div>`, len(s.Findings), cnt[0], cnt[1], len(s.Findings)-cnt[0]-cnt[1])
	for _, f := range s.Findings {
		w(`<div class="f s%d"><span class="tag">%s</span><b>%s</b><span class="id">%s · 可信度 %.2f · %s</span><ul>`, f.Severity, sevLabel[f.Severity], he(f.Problem), f.ID, f.Confidence, he(f.Source))
		for _, e := range f.Evidence {
			w("<li>%s</li>", he(e))
		}
		w(`</ul><div class="row"><b>建议：</b>%s</div>`, he(f.Suggestion))
		if f.SQL != "" {
			w(`<pre class="sql">%s</pre>`, he(f.SQL))
		}
		if f.Rollback != "" {
			w(`<div class="row"><b>回滚方式：</b></div><pre class="sql">%s</pre>`, he(f.Rollback))
		}
		w(`<div class="row risk"><b>风险：</b>%s</div><div class="row"><b>验证：</b>%s</div></div>`, he(f.Risk), he(f.Verify))
	}
	ev := evidenceSections(s)
	w(`<h2>采集证据（章节导航）</h2><div class="nav">`)
	for i, x := range ev {
		w(`<a href="#sec-%d">%02d %s</a>`, i, i+1, he(x.Title))
	}
	w(`</div>`)
	for i, x := range ev {
		w(`<div class="sc" id="sec-%d"><div class="hd">%02d &nbsp; %s</div>`, i, i+1, he(x.Title))
		if x.Note != "" {
			w(`<div class="note">%s</div>`, he(x.Note))
		}
		if x.Err != "" {
			w(`<div class="err">⚠ %s</div>`, he(x.Err))
		}
		switch {
		case x.Kind == "text" && len(x.Rows) > 0:
			var ls []string
			for _, r := range x.Rows {
				ls = append(ls, r[0])
			}
			w(`<div style="padding:12px"><pre class="plan">%s</pre></div>`, he(strings.Join(ls, "\n")))
		case len(x.Rows) == 0:
			if x.Err == "" {
				w(`<div class="empty">无数据（可能因权限、共享池老化或该章节不适用）</div>`)
			}
		default:
			b.WriteString(htmlTable(x.Cols, x.Rows))
		}
		w(`</div>`)
	}
	w(`<footer>%s<br>%s</footer></div></body></html>`, he(strings.Join(footNotes, " ")), he(footer(s)))
	return b.String()
}

func buildBatchHTML(br *BatchReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Oracle SQL 批量诊断对比报告</title><style>%s</style></head><body><div class="wrap"><h1>Oracle SQL 批量诊断对比报告</h1><div class="sub">共 %d 个 SQL_ID · 生成于 %s</div>`, htmlCSS, len(br.Items), he(br.Generated))
	var rows [][]string
	for _, it := range br.Items {
		rows = append(rows, batchRow(it))
	}
	b.WriteString(`<div class="sc"><div class="bd">` + htmlTable(batchCols, rows) + `</div></div>`)
	for _, it := range br.Items {
		fmt.Fprintf(&b, `<h2>SQL_ID %s</h2>`, he(it.SQLID))
		if it.Err != nil || it.Snap == nil {
			fmt.Fprintf(&b, `<div class="err">诊断失败：%s</div>`, he(fmt.Sprint(it.Err)))
			continue
		}
		fmt.Fprintf(&b, `<p>%s</p>`, he(execSummary(it.Snap)))
		if len(it.Snap.Findings) > 0 {
			b.WriteString(`<div class="sc">` + htmlTable(roadmapCols, roadmapRows(it.Snap)) + `</div>`)
		}
	}
	for _, a := range br.AISummaries {
		fmt.Fprintf(&b, `<h2>AI 归纳 %s</h2><pre style="white-space:pre-wrap">%s</pre>`, he(a[0]), he(a[1]))
	}
	fmt.Fprintf(&b, `<footer>%s</footer></div></body></html>`, he(strings.Join(footNotes, " ")))
	return b.String()
}
