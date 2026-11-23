package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// 手写的最小 DOCX 生成器：只依赖标准库，版式对齐参考报告（横向 A4 / 目录域 / 指标表 / 分级结论块 / 代码块）。

const pageW = 14570 // 横向 A4，左右边距 1134 twips 后的可用宽度

var sevColor = [3]string{"C0392B", "C77700", "378ADD"}

func xesc(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '&':
			b.WriteString("&amp;")
		case r == '<':
			b.WriteString("&lt;")
		case r == '>':
			b.WriteString("&gt;")
		case r == '"':
			b.WriteString("&quot;")
		case r == '\'':
			b.WriteString("&apos;")
		case r == '\t' || r == '\n' || r == '\r' || r >= 0x20 && r != 0xFFFE && r != 0xFFFF && !(r >= 0xD800 && r <= 0xDFFF):
			b.WriteRune(r)
		}
	}
	return b.String()
}

type dx struct {
	body  strings.Builder
	heads [][2]string // level, title —— 用于预填目录
}

func rpr(bold bool, color string, sz int, extra string) string {
	var b strings.Builder
	if bold {
		b.WriteString("<w:b/>")
	}
	if color != "" {
		b.WriteString(`<w:color w:val="` + color + `"/>`)
	}
	if sz > 0 {
		fmt.Fprintf(&b, `<w:sz w:val="%d"/><w:szCs w:val="%d"/>`, sz, sz)
	}
	b.WriteString(extra)
	if b.Len() == 0 {
		return ""
	}
	return "<w:rPr>" + b.String() + "</w:rPr>"
}

func run(text, props string) string {
	return `<w:r>` + props + `<w:t xml:space="preserve">` + xesc(text) + `</w:t></w:r>`
}

const monoFont = `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>`

func chip(text string) string {
	return run(text, "<w:rPr>"+monoFont+`<w:sz w:val="18"/><w:szCs w:val="18"/><w:shd w:val="clear" w:color="auto" w:fill="EFEDE6"/></w:rPr>`)
}

func (d *dx) p(ppr, inner string) {
	d.body.WriteString("<w:p><w:pPr>" + ppr + "</w:pPr>" + inner + "</w:p>")
}

func (d *dx) title(t string) { d.p(`<w:pStyle w:val="Title"/>`, run(t, "")) }

func (d *dx) heading(level int, parts ...string) {
	var plain strings.Builder
	var inner strings.Builder
	for i := 0; i+1 < len(parts); i += 2 {
		plain.WriteString(parts[i])
		inner.WriteString(run(parts[i], parts[i+1]))
	}
	if len(parts)%2 == 1 {
		plain.WriteString(parts[len(parts)-1])
		inner.WriteString(run(parts[len(parts)-1], ""))
	}
	if level <= 2 {
		d.heads = append(d.heads, [2]string{fmt.Sprint(level), plain.String()})
	}
	d.p(fmt.Sprintf(`<w:pStyle w:val="Heading%d"/>`, level), inner.String())
}

func (d *dx) text(t string) { d.p("", run(t, "")) }

func (d *dx) note(t, color string) {
	d.p(`<w:spacing w:before="40" w:after="80"/>`, run(t, rpr(false, color, 18, "<w:i/>")))
}

func (d *dx) labeled(label, text string) {
	d.p("", run(label, rpr(true, "", 0, ""))+run("："+text, ""))
}

func (d *dx) bullet(t string) {
	d.p(`<w:ind w:left="340" w:hanging="240"/>`, run("•  ", rpr(true, "185FA5", 0, ""))+run(t, ""))
}

func (d *dx) spacer() {
	d.body.WriteString(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="auto"/></w:pPr></w:p>`)
}

const tblBorders = `<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D9D6CC"/>
<w:left w:val="single" w:sz="4" w:space="0" w:color="D9D6CC"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D9D6CC"/>
<w:right w:val="single" w:sz="4" w:space="0" w:color="D9D6CC"/>
<w:insideH w:val="single" w:sz="2" w:space="0" w:color="E8E5DC"/>
<w:insideV w:val="single" w:sz="2" w:space="0" w:color="E8E5DC"/></w:tblBorders>`

func tblOpen(widths []int, mar int) string {
	tot := 0
	for _, w := range widths {
		tot += w
	}
	var b strings.Builder
	fmt.Fprintf(&b, `<w:tbl><w:tblPr><w:tblW w:w="%d" w:type="dxa"/>%s<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="%d" w:type="dxa"/><w:left w:w="%d" w:type="dxa"/><w:bottom w:w="%d" w:type="dxa"/><w:right w:w="%d" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>`, tot, tblBorders, mar, mar, mar, mar)
	for _, w := range widths {
		fmt.Fprintf(&b, `<w:gridCol w:w="%d"/>`, w)
	}
	b.WriteString("</w:tblGrid>")
	return b.String()
}

func dispWidth(s string) int {
	n := 0
	for _, r := range s {
		if r > 0x2E80 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func calcWidths(cols []string, rows [][]string, total int) []int {
	n := len(cols)
	wt := make([]float64, n)
	for i, c := range cols {
		wt[i] = float64(dispWidth(c))
	}
	for _, r := range rows {
		for i := 0; i < n && i < len(r); i++ {
			if w := float64(dispWidth(strings.SplitN(r[i], "\n", 2)[0])); w > wt[i] {
				wt[i] = w
			}
		}
	}
	sum := 0.0
	for i := range wt {
		if wt[i] > 40 {
			wt[i] = 40
		}
		if wt[i] < 5 {
			wt[i] = 5
		}
		sum += wt[i]
	}
	out := make([]int, n)
	used := 0
	for i := range wt {
		out[i] = int(wt[i] / sum * float64(total))
		used += out[i]
	}
	out[n-1] += total - used
	return out
}

func isNumCol(rows [][]string, i int) bool {
	seen := false
	for _, r := range rows {
		if i >= len(r) || r[i] == "" {
			continue
		}
		if !hasNum(r[i]) {
			return false
		}
		seen = true
	}
	return seen
}

func cellP(text string, props, jc string) string {
	ppr := `<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>`
	if jc != "" {
		ppr += `<w:jc w:val="` + jc + `"/>`
	}
	return `<w:p><w:pPr>` + ppr + `</w:pPr>` + run(text, props) + `</w:p>`
}

func tc(w int, fill, inner string) string {
	return fmt.Sprintf(`<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="%s"/><w:vAlign w:val="center"/></w:tcPr>%s</w:tc>`, w, fill, inner)
}

const maxRows = 300

// table 输出数据表：自适应列宽、斑马纹、表头跨页重复、数值列右对齐。
func (d *dx) table(cols []string, rows [][]string) {
	if len(cols) == 0 {
		return
	}
	sz := 17
	if len(cols) > 14 {
		sz = 15
	} else if len(cols) > 8 {
		sz = 16
	}
	shown := rows
	if len(shown) > maxRows {
		shown = shown[:maxRows]
	}
	widths := calcWidths(cols, shown, pageW)
	var b strings.Builder
	b.WriteString(tblOpen(widths, 60))
	b.WriteString(`<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>`)
	for i, c := range cols {
		b.WriteString(tc(widths[i], "F1EFE8", cellP(c, rpr(true, "444441", sz, ""), "")))
	}
	b.WriteString("</w:tr>")
	numc := make([]bool, len(cols))
	for i := range cols {
		numc[i] = isNumCol(shown, i)
	}
	for ri, r := range shown {
		fill := "FFFFFF"
		if ri%2 == 0 {
			fill = "FBFBF8"
		}
		b.WriteString(`<w:tr><w:trPr><w:cantSplit/></w:trPr>`)
		for i := range cols {
			v := ""
			if i < len(r) {
				v = strings.Join(strings.Fields(strings.ReplaceAll(r[i], "\n", " ")), " ")
			}
			v = truncate(v, 500)
			jc := ""
			if numc[i] {
				jc = "right"
			}
			b.WriteString(tc(widths[i], fill, cellP(v, rpr(false, "444441", sz, ""), jc)))
		}
		b.WriteString("</w:tr>")
	}
	b.WriteString("</w:tbl>")
	d.body.WriteString(b.String())
	if len(rows) > maxRows {
		d.note(fmt.Sprintf("仅显示前 %d 行，共 %d 行（完整数据见 --snapshot 保存的 JSON）。", maxRows, len(rows)), "7F7F7F")
	}
	d.spacer()
}

func (d *dx) kvTable(head []string, rows [][]string, widths []int) {
	var b strings.Builder
	b.WriteString(tblOpen(widths, 60))
	b.WriteString(`<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>`)
	for i, h := range head {
		b.WriteString(tc(widths[i], "F1EFE8", cellP(h, rpr(true, "444441", 17, ""), "")))
	}
	b.WriteString("</w:tr>")
	for ri, r := range rows {
		fill := "FFFFFF"
		if ri%2 == 0 {
			fill = "FBFBF8"
		}
		b.WriteString(`<w:tr><w:trPr><w:cantSplit/></w:trPr>`)
		for i := range head {
			b.WriteString(tc(widths[i], fill, cellP(r[i], rpr(false, "444441", 17, ""), "")))
		}
		b.WriteString("</w:tr>")
	}
	b.WriteString("</w:tbl>")
	d.body.WriteString(b.String())
	d.spacer()
}

func (d *dx) code(text string) {
	text = strings.TrimRight(text, "\n ")
	ls := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	if len(ls) > 400 {
		ls = append(ls[:400], "-- ……（已截断）")
	}
	var r strings.Builder
	for i, l := range ls {
		if i > 0 {
			r.WriteString("<w:br/>")
		}
		r.WriteString(`<w:t xml:space="preserve">` + xesc(strings.ReplaceAll(l, "\t", "    ")) + `</w:t>`)
	}
	run := `<w:r><w:rPr>` + monoFont + `<w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>` + r.String() + `</w:r>`
	w := []int{pageW}
	d.body.WriteString(tblOpen(w, 90) + `<w:tr><w:trPr></w:trPr><w:tc><w:tcPr><w:tcW w:w="` + fmt.Sprint(pageW) + `" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F7F5EF"/></w:tcPr>` +
		`<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F7F5EF"/><w:spacing w:before="0" w:after="0" w:line="220" w:lineRule="auto"/></w:pPr>` + run + `</w:p></w:tc></w:tr></w:tbl>`)
	d.spacer()
}

// ---------------------------------------------------------------- 单 SQL 报告

func (d *dx) finding(f Finding) {
	col := sevColor[f.Severity]
	d.heading(2, "["+sevLabel[f.Severity]+"] ", rpr(true, col, 0, ""), f.Problem, "")
	d.p("", chip(f.ID)+run(fmt.Sprintf(" · 可信度 %.2f · 来源 %s", f.Confidence, f.Source)+ternary(f.Effort != "", " · 实施成本 "+f.Effort, ""), ""))
	if len(f.Evidence) > 0 {
		d.p("", run("诊断依据", rpr(true, "", 0, "")))
		for _, e := range f.Evidence {
			d.bullet(e)
		}
	}
	d.labeled("建议", f.Suggestion)
	if f.SQL != "" {
		d.p("", run("候选 SQL", rpr(true, "", 0, ""))+run("（仅供测试环境验证）", ""))
		d.code(f.SQL)
	}
	if f.Rollback != "" {
		d.p("", run("回滚方式", rpr(true, "", 0, "")))
		d.code(f.Rollback)
	}
	d.labeled("风险", f.Risk)
	d.labeled("验证方法", f.Verify)
}

func (d *dx) section(n int, sec Section) {
	d.heading(2, fmt.Sprintf("%02d   %s", n, sec.Title))
	if sec.Note != "" {
		d.note(sec.Note, "5F5E5A")
	}
	if sec.Err != "" {
		d.note("⚠ "+sec.Err, "A32D2D")
	}
	switch {
	case sec.Kind == "text" && len(sec.Rows) > 0:
		var ls []string
		for _, r := range sec.Rows {
			if len(r) > 0 {
				ls = append(ls, r[0])
			}
		}
		d.code(strings.Join(ls, "\n"))
	case len(sec.Rows) == 0:
		if sec.Err == "" {
			d.note("无数据（可能因权限、共享池老化或该章节不适用）", "888780")
		}
	default:
		common, vcols, vrows := splitCommon(sec.Cols, sec.Rows)
		if len(common) > 0 {
			var kv []string
			for _, c := range common {
				kv = append(kv, c[0]+"="+truncate(c[1], 60))
			}
			d.p("", run("各行相同的字段：", rpr(true, "444441", 17, ""))+run(strings.Join(kv, "；"), rpr(false, "444441", 17, "")))
		}
		if len(vcols) > 0 {
			d.table(vcols, vrows)
		}
	}
}

func buildDocx(s *Snapshot) ([]byte, error) {
	d := &dx{}
	d.title("Oracle SQL 智能诊断报告")
	d.p("", run("SQL_ID: ", "")+chip(s.Meta.SQLID)+run(fmt.Sprintf(" · 库: %s · 模式: %s · 生成于 %s", blankTo(s.Meta.DBName, "-"), s.Meta.Mode, s.Meta.Generated), ""))
	d.text("环境：" + envLine(s))
	d.p(`<w:spacing w:before="120" w:after="200"/>`, "@@TOC@@")

	d.heading(1, "关键指标")
	d.kvTable([]string{"指标", "值", "单位"}, keyMetricRows(s), []int{5759, 4939, 3870})

	d.heading(1, "执行摘要与优化路线图")
	d.text(execSummary(s))
	if len(s.Findings) > 0 {
		d.p("", run("按优先级排列的行动清单（严重度优先，其次可信度）；实施成本为经验估计，仅供排期参考。", rpr(false, "5F5E5A", 18, "<w:i/>")))
		d.kvTable(roadmapCols, roadmapRows(s), []int{500, 900, 4300, 4900, 1100, 2870})
	}
	if s.AISummary != "" || s.AIError != "" {
		d.heading(1, "AI 归纳（可选，仅供参考）")
		if s.AIError != "" {
			d.note("AI 未产出内容："+s.AIError+"。不影响规则引擎结论。", "A32D2D")
		} else {
			d.note(fmt.Sprintf("由 %s 基于规则结论生成，可能存在偏差；一切以规则证据与 DBA 判断为准。", blankTo(s.Meta.AIProvider, "AI")), "5F5E5A")
			for _, ln := range strings.Split(s.AISummary, "\n") {
				if strings.TrimSpace(ln) != "" {
					d.text(ln)
				}
			}
		}
	}
	for _, x := range s.Sections {
		if x.Key == "compare" {
			d.heading(1, x.Title)
			d.note(x.Note, "5F5E5A")
			d.table(x.Cols, x.Rows)
		}
	}

	d.heading(1, "诊断结论与优化建议")
	cnt := countSev(s.Findings)
	d.text(fmt.Sprintf("共 %d 条：严重 %d / 警告 %d / 提示 %d。每条均含依据、风险与验证方法；建议不会自动执行。", len(s.Findings), cnt[0], cnt[1], len(s.Findings)-cnt[0]-cnt[1]))
	for _, f := range s.Findings {
		d.finding(f)
	}

	d.heading(1, "采集证据")
	if len(s.Errors) > 0 {
		d.note(fmt.Sprintf("有 %d 个章节采集异常（多为权限不足或未授权视图），不影响其它章节：", len(s.Errors)), "A32D2D")
		for _, e := range s.Errors {
			d.bullet(e)
		}
	}
	for i, sec := range evidenceSections(s) {
		d.section(i+1, sec)
	}

	d.p(`<w:spacing w:before="200"/>`, run(footer(s), rpr(false, "888780", 18, "")))
	return packDocx(d, "Oracle SQL 诊断报告 "+s.Meta.SQLID)
}

// ---------------------------------------------------------------- 批量报告

func buildBatchDocx(br *BatchReport) ([]byte, error) {
	d := &dx{}
	d.title("Oracle SQL 批量诊断对比报告")
	d.text(fmt.Sprintf("共 %d 个 SQL_ID · 生成于 %s", len(br.Items), br.Generated))
	d.p(`<w:spacing w:before="120" w:after="200"/>`, "@@TOC@@")
	d.heading(1, "横向对比")
	var rows [][]string
	for _, it := range br.Items {
		rows = append(rows, batchRow(it))
	}
	d.table(batchCols, rows)
	for _, it := range br.Items {
		d.heading(1, "SQL_ID "+it.SQLID)
		if it.Err != nil || it.Snap == nil {
			d.note(fmt.Sprintf("诊断失败：%v", it.Err), "A32D2D")
			continue
		}
		s := it.Snap
		d.text(envLine(s))
		d.text(execSummary(s))
		if len(s.Findings) > 0 {
			d.kvTable(roadmapCols, roadmapRows(s), []int{500, 900, 4300, 4900, 1100, 2870})
		}
	}
	if len(br.AISummaries) > 0 {
		d.heading(1, "AI 归纳（可选）")
		for _, a := range br.AISummaries {
			d.heading(2, a[0])
			for _, ln := range strings.Split(a[1], "\n") {
				if strings.TrimSpace(ln) != "" {
					d.text(ln)
				}
			}
		}
	}
	d.heading(1, "说明")
	for _, n := range footNotes {
		d.bullet(n)
	}
	d.text("每个 SQL_ID 的完整证据链请加 --per-report 单独输出，或用 --snapshot-dir 保存快照后离线查看。")
	return packDocx(d, "Oracle SQL 批量诊断对比报告")
}

// ---------------------------------------------------------------- 打包

func tocXML(heads [][2]string) string {
	var b strings.Builder
	b.WriteString(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \o "1-1" \h \z \u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`)
	b.WriteString(run("目录（在 Word / WPS 中按 F9 或右键「更新域」可刷新页码）", rpr(false, "7F7F7F", 19, "<w:i/>")))
	b.WriteString(`</w:p>`)
	for _, h := range heads {
		if h[0] != "1" {
			continue
		}
		ind := "0"
		if h[0] == "2" {
			ind = "360"
		}
		b.WriteString(`<w:p><w:pPr><w:spacing w:before="0" w:after="20"/><w:ind w:left="` + ind + `"/></w:pPr>` + run(h[1], rpr(h[0] == "1", "444441", 18, "")) + `</w:p>`)
	}
	b.WriteString(`<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:fldChar w:fldCharType="end"/></w:r>`)
	return b.String()
}

const nsW = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`

const stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2E5496"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="2E5496"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="0" w:line="220" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style></w:styles>`

func packDocx(d *dx, title string) ([]byte, error) {
	body := d.body.String()
	// 目录占位：所在段落的 <w:p> 已经开了，这里把预填目录接在其后
	body = strings.Replace(body, "@@TOC@@", tocXML(d.heads), 1)
	doc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ` + nsW + `><w:body>` + body +
		`<w:sectPr><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	files := []struct{ name, data string }{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`},
		{"word/document.xml", doc},
		{"word/styles.xml", stylesXML},
		{"word/settings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`},
		{"word/footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="888780"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">` + toolName + ` 诊断报告 · 第 </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:rPr><w:color w:val="888780"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve"> 页 · 仅供 DBA 审阅，本工具不执行任何变更</w:t></w:r></w:p></w:ftr>`},
		{"word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`},
		{"docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>` + xesc(title) + `</dc:title><dc:creator>` + toolName + `</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">` + now + `</dcterms:created></cp:coreProperties>`},
		{"docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>` + toolName + ` ` + toolVersion + `</Application></Properties>`},
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.Create(f.name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(f.data)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	_ = utf8.RuneError
	return buf.Bytes(), nil
}
