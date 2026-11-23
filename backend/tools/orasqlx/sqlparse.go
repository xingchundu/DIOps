package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// 轻量 SQL 结构解析：只做"线索"，解析失败不影响诊断（规则引擎回退到执行计划对象信息）。

type TabRef struct {
	Owner string
	Name  string
	Alias string
}

type FuncUse struct {
	Func string
	Col  string
	Text string
}

type SQLInfo struct {
	Type        string
	Tables      []TabRef
	Hints       []string
	BindCount   int
	Literals    int
	SelectStar  bool
	HasOrder    bool
	HasGroup    bool
	HasDistinct bool
	JoinCount   int
	SubQueries  int
	Opaque      bool
}

var (
	reComment  = regexp.MustCompile(`(?s)/\*[^+].*?\*/|--[^\n]*`)
	reHint     = regexp.MustCompile(`(?s)/\*\+(.*?)\*/`)
	reBind     = regexp.MustCompile(`:\s*[A-Za-z0-9_]+`)
	reStrLit   = regexp.MustCompile(`'(?:[^']|'')*'`)
	reNumLit   = regexp.MustCompile(`(?:^|[^A-Za-z0-9_$"])\d+(?:\.\d+)?`)
	reFromSeg  = regexp.MustCompile(`(?is)\bFROM\b(.*?)(?:\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bCONNECT\s+BY\b|\bSTART\s+WITH\b|\bUNION\b|\bMINUS\b|\bINTERSECT\b|\bFETCH\b|\bFOR\s+UPDATE\b|;|$)`)
	reJoin     = regexp.MustCompile(`(?is)\bJOIN\s+((?:"?[\w$#]+"?\.)?"?[\w$#]+"?)(?:\s+(?:AS\s+)?("?[\w$#]+"?))?`)
	reTabItem  = regexp.MustCompile(`(?is)^\s*((?:"?[\w$#]+"?\.)?"?[\w$#]+"?)(?:\s+(?:AS\s+)?("?[\w$#]+"?))?\s*$`)
	reFuncCol  = regexp.MustCompile(`(?i)\b(SUBSTR|SUBSTRB|TRUNC|TO_CHAR|TO_DATE|TO_NUMBER|UPPER|LOWER|NVL|INSTR|LENGTH|REPLACE|DECODE|TRIM|LTRIM|RTRIM|ROUND|COALESCE)\(\s*(?:"?[\w$#]+"?\.)?"?([A-Za-z_][\w$#]*)"?\s*(?:,|\))`)
	rePredCol  = regexp.MustCompile(`(?:"[\w$#]+"\.)?"([\w$#]+)"\s*(=|>=|<=|<>|!=|>|<|BETWEEN|LIKE|IN\b)`)
	reIdentTok = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_$#]*`)
)

var reservedAlias = map[string]bool{"WHERE": true, "ON": true, "INNER": true, "LEFT": true, "RIGHT": true,
	"FULL": true, "OUTER": true, "JOIN": true, "CROSS": true, "NATURAL": true, "GROUP": true, "ORDER": true,
	"UNION": true, "USING": true, "CONNECT": true, "START": true, "HAVING": true, "PARTITION": true, "SAMPLE": true}

func unq(s string) string { return strings.ToUpper(strings.Trim(s, `" `)) }

func splitTop(s string, sep byte) []string {
	var out []string
	depth, last := 0, 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(':
			depth++
		case ')':
			depth--
		case sep:
			if depth == 0 {
				out = append(out, s[last:i])
				last = i + 1
			}
		}
	}
	return append(out, s[last:])
}

func parseSQL(text string) SQLInfo {
	var in SQLInfo
	t := strings.TrimSpace(text)
	for _, m := range reHint.FindAllStringSubmatch(t, -1) {
		in.Hints = append(in.Hints, strings.Fields(strings.TrimSpace(m[1]))...)
	}
	in.Opaque = strings.Contains(strings.ToUpper(t), "OPAQUE_TRANSFORM")
	plain := reComment.ReplaceAllString(t, " ")
	plain = reHint.ReplaceAllString(plain, " ")
	up := strings.ToUpper(plain)
	fields := strings.Fields(up)
	if len(fields) > 0 {
		in.Type = fields[0]
		if in.Type == "WITH" {
			in.Type = "SELECT"
		}
	}
	in.BindCount = len(reBind.FindAllString(plain, -1))
	in.Literals = len(reStrLit.FindAllString(plain, -1))
	noStr := reStrLit.ReplaceAllString(plain, "''")
	in.Literals += len(reNumLit.FindAllString(noStr, -1))
	in.SelectStar = regexp.MustCompile(`(?i)SELECT\s+(?:/\*.*?\*/\s*)?(?:DISTINCT\s+)?\*`).MatchString(plain)
	in.HasOrder = strings.Contains(up, "ORDER BY")
	in.HasGroup = strings.Contains(up, "GROUP BY")
	in.HasDistinct = strings.Contains(up, "DISTINCT")
	in.JoinCount = strings.Count(up, " JOIN ")
	in.SubQueries = strings.Count(up, "(SELECT") + strings.Count(up, "( SELECT")

	seen := map[string]bool{}
	add := func(item string) {
		item = strings.TrimSpace(item)
		if item == "" || strings.HasPrefix(item, "(") {
			return
		}
		m := reTabItem.FindStringSubmatch(item)
		if m == nil {
			return
		}
		name := m[1]
		owner := ""
		if i := strings.LastIndex(name, "."); i >= 0 {
			owner, name = unq(name[:i]), name[i+1:]
		}
		alias := unq(m[2])
		if reservedAlias[alias] {
			alias = ""
		}
		tr := TabRef{Owner: owner, Name: unq(name), Alias: alias}
		if tr.Name == "DUAL" || tr.Name == "" {
			return
		}
		k := tr.Owner + "." + tr.Name + "." + tr.Alias
		if !seen[k] {
			seen[k] = true
			in.Tables = append(in.Tables, tr)
		}
	}
	for _, m := range reFromSeg.FindAllStringSubmatch(plain, -1) {
		for _, item := range splitTop(m[1], ',') {
			// 只取第一个 JOIN 之前的部分，JOIN 另行匹配
			if i := regexp.MustCompile(`(?i)\b(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL)?\s*(?:OUTER\s+)?JOIN\b`).FindStringIndex(item); i != nil {
				item = item[:i[0]]
			}
			add(item)
		}
	}
	for _, m := range reJoin.FindAllStringSubmatch(plain, -1) {
		add(m[1] + " " + m[2])
	}
	return in
}

// predFuncs 返回谓词中"列被函数包裹"的用法。
func predFuncs(pred string) []FuncUse {
	var out []FuncUse
	for _, m := range reFuncCol.FindAllStringSubmatchIndex(pred, -1) {
		fn := strings.ToUpper(pred[m[2]:m[3]])
		col := strings.ToUpper(pred[m[4]:m[5]])
		// 取完整函数调用文本（到匹配的右括号）
		start := m[0]
		depth, end := 0, len(pred)
		for i := start; i < len(pred); i++ {
			if pred[i] == '(' {
				depth++
			} else if pred[i] == ')' {
				depth--
				if depth == 0 {
					end = i + 1
					break
				}
			}
		}
		out = append(out, FuncUse{Func: fn, Col: col, Text: pred[start:end]})
	}
	return out
}

// predCols 返回执行计划谓词里的等值列与范围列。
func predCols(pred string) (eq, rng []string) {
	for _, m := range rePredCol.FindAllStringSubmatch(pred, -1) {
		col := strings.ToUpper(m[1])
		switch strings.ToUpper(m[2]) {
		case "=", "IN":
			eq = append(eq, col)
		default:
			rng = append(rng, col)
		}
	}
	return uniq(eq), uniq(rng)
}

// identTokens 返回文本中出现的全部标识符（大写），用于把 SQL 与字段名对上。
func identTokens(texts ...string) map[string]bool {
	out := map[string]bool{}
	for _, t := range texts {
		for _, w := range reIdentTok.FindAllString(t, -1) {
			out[strings.ToUpper(w)] = true
		}
	}
	return out
}

func sqlInfoRows(in SQLInfo) [][]string {
	var tabs []string
	for _, t := range in.Tables {
		s := t.Name
		if t.Owner != "" {
			s = t.Owner + "." + s
		}
		if t.Alias != "" {
			s += " " + t.Alias
		}
		tabs = append(tabs, s)
	}
	sort.Strings(tabs)
	yn := func(b bool) string {
		if b {
			return "是"
		}
		return "否"
	}
	return [][]string{
		{"语句类型", in.Type},
		{"涉及表（解析）", blankTo(strings.Join(tabs, "；"), "未解析到（回退到执行计划对象）")},
		{"JOIN 个数", fmt.Sprint(in.JoinCount)},
		{"子查询个数", fmt.Sprint(in.SubQueries)},
		{"绑定变量个数", fmt.Sprint(in.BindCount)},
		{"字面量个数", fmt.Sprint(in.Literals)},
		{"SELECT *", yn(in.SelectStar)},
		{"ORDER BY / GROUP BY / DISTINCT", yn(in.HasOrder) + " / " + yn(in.HasGroup) + " / " + yn(in.HasDistinct)},
		{"HINT", blankTo(strings.Join(in.Hints, " "), "无")},
		{"疑似远端网关改写（OPAQUE_TRANSFORM）", yn(in.Opaque)},
	}
}
