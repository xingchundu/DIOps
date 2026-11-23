package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// 规则引擎：确定性、可解释、完全不依赖 AI。每条规则只给"诊断线索 + 证据 + 候选动作 + 风险 + 验证方法"，
// 结论是否成立由 DBA 结合业务判断；本引擎绝不执行任何变更。

const defaultVerify = "在测试环境对比 DBMS_XPLAN（含 +ALLSTATS LAST）执行计划；对比单次 elapsed、BUFFER_GETS、DISK_READS、ROWS_PROCESSED；用 ALLSTATS LAST 或 SQL Monitor（需 Tuning Pack 授权）复核实际行数与等待事件"

type Rule struct {
	ID    string
	Title string
	Desc  string
	Check func(c *rctx) []Finding
}

type rctx struct {
	s    *Snapshot
	th   Thresholds
	m    Metrics
	info SQLInfo

	plan, rt, tabs, cols, hist, idx, idc, iex, pk, parts, binds, kids, trend, wa, sess, opt, samp, drift []map[string]string
	predText                                                                                             string
	perSec                                                                                               float64
	hit                                                                                                  float64
	tabRefs                                                                                              []TabRef
}

func newCtx(s *Snapshot, th Thresholds) *rctx {
	g := func(k string) []map[string]string { return s.Sec(k).Maps() }
	c := &rctx{s: s, th: th, m: s.Metrics, info: parseSQL(s.SQLText),
		plan: g("planops"), rt: g("plantats"), tabs: g("tabstats"), cols: g("colstats"), hist: g("histo"),
		idx: g("indexes"), idc: g("indcols"), iex: g("indexpr"), pk: g("partkeys"), parts: g("partitions"),
		binds: g("binds"), kids: g("sqlinfo"), trend: g("awrtrend"), wa: g("workarea"), sess: g("sessions"),
		opt: g("optenv"), samp: g("sample"), drift: g("drift")}
	c.perSec = c.m.PerExecSec()
	c.hit = c.m.HitRatio()
	var pt []string
	seen := map[string]bool{}
	for _, p := range c.plan {
		for _, k := range []string{"ACCESS_PREDICATES", "FILTER_PREDICATES"} {
			if v := p[k]; v != "" && !seen[v] {
				seen[v] = true
				pt = append(pt, v)
			}
		}
	}
	c.predText = strings.Join(pt, " AND ")
	for _, t := range c.tabs {
		c.tabRefs = append(c.tabRefs, TabRef{Owner: t["OWNER"], Name: t["TABLE_NAME"]})
	}
	return c
}

func fnd(id string, sev Severity, problem string, conf float64, effort string) Finding {
	return Finding{ID: id, Severity: sev, Problem: problem, Confidence: conf, Source: "rule:" + id, Verify: defaultVerify, Effort: effort}
}

func (c *rctx) mainTable() TabRef {
	if len(c.tabRefs) > 0 {
		return c.tabRefs[0]
	}
	return TabRef{Owner: "<OWNER>", Name: "<TABLE>"}
}

func (c *rctx) tab(name string) TabRef {
	for _, t := range c.tabRefs {
		if strings.EqualFold(t.Name, name) {
			return t
		}
	}
	return c.mainTable()
}

func (c *rctx) aliasOf(table string) string {
	for _, t := range c.info.Tables {
		if strings.EqualFold(t.Name, table) && t.Alias != "" {
			return t.Alias
		}
	}
	return "T"
}

func (c *rctx) colNDV(table, col string) float64 {
	for _, r := range c.cols {
		if strings.EqualFold(r["TABLE_NAME"], table) && strings.EqualFold(r["COLUMN_NAME"], col) {
			return num(r["NDV"])
		}
	}
	return 0
}

func (c *rctx) numRows(table string) float64 {
	for _, r := range c.tabs {
		if strings.EqualFold(r["TABLE_NAME"], table) {
			return num(r["NUM_ROWS"])
		}
	}
	return 0
}

func (c *rctx) hasRowidAccess() bool {
	for _, p := range c.plan {
		if strings.HasPrefix(p["OPERATION"], "TABLE ACCESS") && strings.Contains(p["OPTIONS"], "ROWID") {
			return true
		}
	}
	return false
}

func (c *rctx) hasIndexScan() bool {
	for _, p := range c.plan {
		if p["OPERATION"] == "INDEX" {
			return true
		}
	}
	return false
}

func (c *rctx) bindMap() map[string]string {
	m := map[string]string{}
	for _, b := range c.binds {
		n := b["NAME"]
		if n != "" && b["VALUE_STRING"] != "" {
			if _, ok := m[n]; !ok {
				m[n] = b["VALUE_STRING"]
			}
		}
	}
	return m
}

// ---------------------------------------------------------------- 规则集

var Rules = []Rule{
	{"R01", "SQL 单次执行耗时过高", "单次平均耗时超过阈值（默认 60s）", ruleR01},
	{"R02", "千万级结果集走索引回表", "大结果集 + 索引扫描 + ROWID 回表，随机单块读放大", ruleR02},
	{"R03", "优化器基数估算严重偏差", "E-Rows 与 A-Rows 偏差 ≥ 阈值（默认 10×）", ruleR03},
	{"R04", "物理读占比高，缓存命中不足", "缓存命中率低于阈值（默认 90%）", ruleR04},
	{"R05", "耗时以 I/O 等待为主", "USER_IO_WAIT 占 elapsed 超过阈值（默认 40%）", ruleR05},
	{"R06", "RAC 跨实例 gc 等待占比偏高", "CLUSTER_WAIT 占 elapsed 超过阈值（默认 15%）", ruleR06},
	{"R07", "函数谓词与函数索引表达式不匹配", "谓词用绑定变量作函数参数，函数索引表达式用字面量", ruleR07},
	{"R08", "统计信息过期、缺失或缺少直方图", "STALE_STATS / LAST_ANALYZED 空 / 谓词列无直方图", ruleR08},
	{"R09", "过滤列存在严重数据倾斜", "直方图或采样显示单值占比超过阈值（默认 60%）", ruleR09},
	{"R10", "分区裁剪不足或 GLOBAL 索引带来额外开销", "分区表未静态裁剪 / 存在 GLOBAL 索引", ruleR10},
	{"R11", "执行计划不稳定 / 绑定变量窥探风险", "子游标 BIND_SENSITIVE 且未 BIND_AWARE，或多计划", ruleR11},
	{"R12", "存在可评估的冗余 / 低效索引线索", "前导列 NDV 极低 / 前导列为分区键 / 前缀重复", ruleR12},
	{"R13", "大表全表扫描但返回比例很低", "TABLE ACCESS FULL 且预计/实际返回行 < 5% 表行数", ruleR13},
	{"R14", "隐式类型转换 / 索引列被函数包裹", "谓词出现 INTERNAL_FUNCTION 或 函数(列)", ruleR14},
	{"R15", "SQL 疑似由 dblink / 远端网关生成", "OPAQUE_TRANSFORM 或 TNS 模块", ruleR15},
	{"R16", "LIST 分区缺少 DEFAULT 兜底", "新键值写入将报 ORA-14400", ruleR16},
	{"R17", "索引聚簇因子偏高", "CLUSTERING_FACTOR / 表块数 ≥ 0.8", ruleR17},
	{"R18", "执行计划含笛卡尔积", "MERGE JOIN CARTESIAN", ruleR18},
	{"R19", "排序 / 哈希溢出到 TEMP", "WORKAREA onepass/multipass 或 TEMPSEG > 0", ruleR19},
	{"R20", "历史性能劣化 / 计划突变", "AWR 趋势中计划变化或平均耗时明显上升", ruleR20},
	{"R21", "游标版本过多 / 字面量未绑定", "子游标 > 20 或使用字面量未绑定变量", ruleR21},
	{"R22", "存在阻塞 / 锁等待", "GV$SESSION 有 BLOCKING_SESSION 或 enq 等待", ruleR22},
	{"R23", "优化器 / 实例参数疑似异常", "optimizer_index_cost_adj、cursor_sharing 等被改动", ruleR23},
}

func parseSpec(spec string) (only, skip map[string]bool) {
	only, skip = map[string]bool{}, map[string]bool{}
	for _, x := range strings.Split(spec, ",") {
		x = strings.ToUpper(strings.TrimSpace(x))
		if x == "" {
			continue
		}
		if strings.HasPrefix(x, "-") {
			skip[x[1:]] = true
		} else {
			only[x] = true
		}
	}
	return
}

func listRules(spec string) string {
	only, skip := parseSpec(spec)
	var b strings.Builder
	fmt.Fprintf(&b, "%-5s %-6s %s\n", "ID", "状态", "规则 / 触发条件")
	for _, r := range Rules {
		on := (len(only) == 0 || only[r.ID]) && !skip[r.ID]
		st := "启用"
		if !on {
			st = "停用"
		}
		fmt.Fprintf(&b, "%-5s %-6s %s —— %s\n", r.ID, st, r.Title, r.Desc)
	}
	return b.String()
}

func RunRules(s *Snapshot, spec string) []Finding {
	return RunRulesTh(s, spec, curTh)
}

func defaultThresholds() Thresholds {
	return Thresholds{ElapsedSec: 60, BigRows: 1000000, HitPct: 90, IOPct: 40, GCPct: 15, SkewPct: 60, ErrRatio: 10, BigTable: 1000000, CFRatio: 0.8}
}

var curTh = defaultThresholds()

func RunRulesTh(s *Snapshot, spec string, th Thresholds) []Finding {
	only, skip := parseSpec(spec)
	ctx := newCtx(s, th)
	var out []Finding
	for _, r := range Rules {
		if (len(only) > 0 && !only[r.ID]) || skip[r.ID] {
			continue
		}
		func() {
			defer func() { _ = recover() }() // 单条规则异常不影响其它规则
			out = append(out, r.Check(ctx)...)
		}()
	}
	sortFindings(out)
	return out
}

// ---------------------------------------------------------------- R01-R06

func ruleR01(c *rctx) []Finding {
	if c.perSec <= c.th.ElapsedSec {
		return nil
	}
	f := fnd("R01", 0, "SQL 单次执行耗时过高", 0.95, "中")
	f.Evidence = []string{
		fmt.Sprintf("执行次数 %s 次，累计耗时 %s 秒，单次 %s 秒（阈值 %g 秒）", fmtInt(c.m.Execs), fmtTwo(c.m.ElapsedUS/1e6), fmtTwo(c.perSec), c.th.ElapsedSec),
		fmt.Sprintf("CPU %.1fs / USER_IO_WAIT %.1fs / CLUSTER_WAIT %.1fs", c.m.CPUUS/1e6, c.m.UserIOUS/1e6, c.m.ClusterUS/1e6),
		fmt.Sprintf("模块 %s，SQL 类型 %s", blankTo(c.s.Meta.Module, "-"), blankTo(c.s.Meta.SQLType, "-")),
	}
	f.Suggestion = "先按结果集大小、访问路径、等待构成三条线定位，再决定改 SQL / 改索引 / 改抽取方式；不要直接加 INDEX hint。"
	f.Risk = "耗时为共享池累计值/执行次数，可能受并行子进程累加影响，需结合 SQL Monitor 或 ALLSTATS 复核。"
	return []Finding{f}
}

func ruleR02(c *rctx) []Finding {
	rows := div(c.m.RowsProc, c.m.Execs)
	if rows <= c.th.BigRows || !c.hasRowidAccess() || !c.hasIndexScan() {
		return nil
	}
	f := fnd("R02", 0, "千万级结果集走索引回表，随机单块读放大", 0.92, "中")
	if rows < 1e7 {
		f.Problem = "大结果集走索引回表，随机单块读放大"
	}
	f.Evidence = []string{
		fmt.Sprintf("单次返回 %s 行（阈值 %s 行）", fmtInt(rows), fmtInt(c.th.BigRows)),
		"计划含 ROWID 回表=true、索引扫描=true",
		fmt.Sprintf("单次逻辑读 %s 块、物理读 %s 块", fmtInt(div(c.m.LIO, c.m.Execs)), fmtInt(div(c.m.PIO, c.m.Execs))),
		"索引路径在结果集占比很高时必然劣于多块顺序读；逐行回表等于把结果集行数变成随机 I/O 次数",
	}
	f.Suggestion = "改走分区裁剪 + 并行全表扫描（PX BLOCK ITERATOR + TABLE ACCESS FULL + 多块读），或建覆盖索引彻底消除回表；同时评估把全量抽取改为增量抽取。"
	t := c.mainTable()
	for _, p := range c.plan {
		if strings.HasPrefix(p["OPERATION"], "TABLE ACCESS") && strings.Contains(p["OPTIONS"], "ROWID") {
			t = c.tab(p["OBJECT_NAME"])
			break
		}
	}
	al, qb := c.aliasOf(t.Name), "SEL$1"
	name := "PATCH_FULL_" + strings.ToUpper(c.s.Meta.SQLID)
	hint := fmt.Sprintf("FULL(@%s %s) PARALLEL(@%s %s 8)", qb, al, qb, al)
	if c.s.Meta.Major >= 12 {
		f.SQL = fmt.Sprintf(`-- 方式一：本端用 SQL Patch 固化（远端 / 应用 SQL 不可改时；需 12.2+，11g/12.1 请用 DBMS_SQLDIAG_INTERNAL.I_CREATE_PATCH）
DECLARE
  v_name VARCHAR2(128);
BEGIN
  v_name := DBMS_SQLDIAG.CREATE_SQL_PATCH(
    sql_id    => '%s',
    hint_text => '%s',
    name      => '%s');
END;
/
-- 方式二：能改 SQL 时
SELECT /*+ FULL(%s) PARALLEL(%s,8) */ ... FROM %s.%s %s WHERE ...;`, c.s.Meta.SQLID, hint, name, al, al, t.Owner, t.Name, al)
		f.Rollback = fmt.Sprintf("EXEC DBMS_SQLDIAG.DROP_SQL_PATCH(name => '%s');", name)
	} else {
		f.SQL = fmt.Sprintf("SELECT /*+ FULL(%s) PARALLEL(%s,8) */ ... FROM %s.%s %s WHERE ...;", al, al, t.Owner, t.Name, al)
	}
	f.Risk = "并行会抢占资源，需限制 DOP 并放低峰；FULL 固化后若数据分布变化可能不再最优，需定期复核。"
	return []Finding{f}
}

func ruleR03(c *rctx) []Finding {
	if len(c.rt) == 0 {
		f := fnd("R03", 2, "未采集到 A-Rows，无法验证基数估算", 0.60, "低")
		f.Evidence = []string{"GV$SQL_PLAN_STATISTICS_ALL 没有该游标的实际行数（未开启 GATHER_PLAN_STATISTICS / STATISTICS_LEVEL=ALL）",
			"本报告不会用 E-Rows 冒充实测值"}
		f.Suggestion = "在测试环境用 /*+ GATHER_PLAN_STATISTICS */ 重跑，或 ALTER SESSION SET statistics_level=ALL 后再用 DBMS_XPLAN.DISPLAY_CURSOR(NULL,NULL,'ALLSTATS LAST') 取 A-Rows。"
		f.Risk = "statistics_level=ALL 会增加执行开销，仅建议在测试环境或单会话使用。"
		return []Finding{f}
	}
	type bad struct {
		txt string
		r   float64
		tab string
	}
	var bs []bad
	for _, r := range c.rt {
		if !hasNum(r["E_ROWS"]) || !hasNum(r["A_ROWS"]) {
			continue
		}
		e, a := num(r["E_ROWS"]), num(r["A_ROWS"])
		x := ratio(e, a)
		if x >= c.th.ErrRatio {
			tab := ""
			if strings.HasPrefix(r["OPERATION"], "TABLE") {
				tab = r["OBJECT_NAME"]
			}
			bs = append(bs, bad{fmt.Sprintf("%s %s %s: E-Rows %s vs A-Rows %s，偏差 %.1f×", r["OPERATION"], blankTo(r["OBJECT_NAME"], ""), "#"+r["ID"], fmtInt(e), fmtInt(a), x), x, tab})
		}
	}
	if len(bs) == 0 {
		return nil
	}
	sort.SliceStable(bs, func(i, j int) bool { return bs[i].r > bs[j].r })
	f := fnd("R03", 0, "优化器基数估算严重偏差", 0.90, "中")
	for i, b := range bs {
		if i >= 6 {
			break
		}
		f.Evidence = append(f.Evidence, b.txt)
	}
	f.Evidence = append(f.Evidence, fmt.Sprintf("共 %d 个计划步骤偏差 ≥ %g×；CBO 低估会导致错选索引回表、错选 JOIN 方式", len(bs), c.th.ErrRatio))
	t := c.mainTable()
	for _, b := range bs {
		if b.tab != "" {
			t = c.tab(b.tab)
			break
		}
	}
	eq, rng := predCols(c.predText)
	var low []string
	for _, col := range append(append([]string{}, eq...), rng...) {
		if n := c.colNDV(t.Name, col); n > 0 && n <= 254 {
			low = append(low, col)
		}
	}
	low = uniq(low)
	mo := "FOR ALL COLUMNS SIZE AUTO"
	if len(low) > 0 {
		mo += " FOR COLUMNS SIZE 254 " + strings.Join(low, ", ")
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "BEGIN\n  DBMS_STATS.GATHER_TABLE_STATS(\n    ownname => '%s', tabname => '%s',\n    method_opt => '%s',\n    degree => 8, cascade => TRUE, no_invalidate => FALSE);\nEND;\n/\n", t.Owner, t.Name, mo)
	if len(eq) >= 2 {
		fmt.Fprintf(&sb, "-- 关联度高的过滤列建列组扩展统计：\nSELECT DBMS_STATS.CREATE_EXTENDED_STATS('%s','%s','(%s)') FROM DUAL;\n", t.Owner, t.Name, strings.Join(eq[:2], ","))
	}
	f.SQL = strings.TrimSpace(sb.String())
	f.Rollback = fmt.Sprintf("-- 收集前先记下时间点；回退统计信息：\nEXEC DBMS_STATS.RESTORE_TABLE_STATS('%s','%s', SYSTIMESTAMP - INTERVAL '30' MINUTE);  -- 时间改为收集之前", t.Owner, t.Name)
	f.Suggestion = "补齐直方图与列组统计：低基数列强制直方图，关联列建扩展统计，函数谓词建表达式统计，分区表启用 INCREMENTAL；先修统计再评估索引。"
	f.Risk = "重新收集统计信息会改变全库共用该表的 SQL 计划，需评估回归；建议先在测试库验证并考虑 SQL Plan Baseline 兜底。"
	return []Finding{f}
}

func ruleR04(c *rctx) []Finding {
	if c.m.LIO == 0 || c.hit >= c.th.HitPct {
		return nil
	}
	bs := c.m.BlockSize
	if bs == 0 {
		bs = 8192
	}
	pioPer := div(c.m.PIO, c.m.Execs)
	f := fnd("R04", 1, "物理读占比高，缓存命中不足", 0.85, "中")
	f.Evidence = []string{
		fmt.Sprintf("逻辑读 %s 块、物理读 %s 块，命中率 %s%%（阈值 %g%%）", fmtInt(c.m.LIO), fmtInt(c.m.PIO), fmtTwo(c.hit), c.th.HitPct),
		fmt.Sprintf("单次物理读 %s 块 ≈ %.1f MB（%d KB 块）", fmtInt(pioPer), pioPer*bs/1048576, int(bs)/1024),
		"大量随机单块读通常来自索引回表，而非表本身过大",
	}
	f.Suggestion = "优先消除回表（覆盖索引 / 并行全扫多块读），再评估 Buffer Cache、KEEP 池或存储层；不要单纯靠加内存掩盖访问路径问题。"
	f.Risk = "扩大缓存会影响全库 SGA 分配；覆盖索引会增加空间与 DML 维护成本。"
	return []Finding{f}
}

func ruleR05(c *rctx) []Finding {
	p := pct(c.m.UserIOUS, c.m.ElapsedUS)
	if p < c.th.IOPct {
		return nil
	}
	f := fnd("R05", 1, "耗时以 I/O 等待为主", 0.82, "中")
	f.Evidence = []string{
		fmt.Sprintf("USER_IO_WAIT %.1fs / Elapsed %.1fs = %.1f%%（阈值 %g%%）", c.m.UserIOUS/1e6, c.m.ElapsedUS/1e6, p, c.th.IOPct),
		"结合「ASH 等待事件分布」确认是 db file sequential read（随机单块）还是 scattered / direct path read（多块）",
	}
	f.Suggestion = "把随机单块读改成顺序多块读：并行全扫、覆盖索引、分区裁剪；若为 direct path read temp 则需处理排序 / 哈希溢出。"
	f.Risk = "并行度过高会放大 I/O 带宽压力。"
	return []Finding{f}
}

func ruleR06(c *rctx) []Finding {
	p := pct(c.m.ClusterUS, c.m.ElapsedUS)
	if c.s.Meta.Instances < 2 || p < c.th.GCPct {
		return nil
	}
	f := fnd("R06", 1, "RAC 跨实例 gc 等待占比偏高", 0.80, "低")
	f.Evidence = []string{
		fmt.Sprintf("CLUSTER_WAIT %.1fs / Elapsed %.1fs = %.1f%%（阈值 %g%%）", c.m.ClusterUS/1e6, c.m.ElapsedUS/1e6, p, c.th.GCPct),
		fmt.Sprintf("检测到 %d 个 RAC 实例", c.s.Meta.Instances),
		"GLOBAL 索引 + 跨实例回表会持续申请远端块；把任务固定到数据所在实例通常比改索引更立竿见影",
	}
	f.Suggestion = "把该批处理 / dblink 服务绑定到单实例，设置 parallel_force_local=TRUE；若做分区维护再评估 GLOBAL 索引改 LOCAL。"
	f.SQL = "ALTER SESSION SET parallel_force_local = TRUE;\n-- 并将该应用的服务（srvctl modify service -preferred）固定到数据所在节点"
	f.Rollback = "ALTER SESSION SET parallel_force_local = FALSE;"
	f.Risk = "LOCAL 化会改变全局唯一性语义（PK/UK 若不含分区键则无法 LOCAL），且影响其他 SQL 计划。"
	return []Finding{f}
}

// ---------------------------------------------------------------- R07-R12

var reFuncCall = regexp.MustCompile(`(?i)(\w+)\("?([\w$#]+)"?((?:\s*,\s*[^,()]+)*)\)`)
var reBindFuncEq = regexp.MustCompile(`(?i)(\w+)\("([\w$#]+)"((?:\s*,\s*:\w+)+)\)\s*=\s*('[^']*'|\d+)`)

func ruleR07(c *rctx) []Finding {
	var f *Finding
	for _, e := range c.iex {
		expr := e["COLUMN_EXPRESSION"]
		m := reFuncCall.FindStringSubmatch(expr)
		if m == nil {
			continue
		}
		fn, col := strings.ToUpper(m[1]), strings.ToUpper(m[2])
		if strings.Contains(expr, ":") {
			continue
		}
		for _, u := range predFuncs(c.predText) {
			if u.Func != fn || u.Col != col || !strings.Contains(u.Text, ":") {
				continue
			}
			ff := fnd("R07", 0, "函数谓词与函数索引表达式不匹配（索引形同虚设）", 0.93, "低")
			pt := ""
			for _, p := range c.plan {
				for _, k := range []string{"FILTER_PREDICATES", "ACCESS_PREDICATES"} {
					if strings.Contains(strings.ToUpper(p[k]), u.Func+"(") && strings.Contains(p[k], ":") {
						pt = p[k]
					}
				}
			}
			ff.Evidence = []string{
				"含函数的谓词：" + truncate(blankTo(pt, u.Text), 420),
				fmt.Sprintf("已有函数索引：%s := %s", e["INDEX_NAME"], expr),
				fmt.Sprintf("谓词函数参数使用绑定变量（如 %s），而索引表达式使用字面量（如 %s）", u.Text, expr),
				"Oracle 要求表达式文本完全一致才会匹配函数索引；不匹配时索引永不可用，且 CBO 无法估算选择率",
			}
			t := c.tab(e["TABLE_NAME"])
			// 用捕获到的绑定值把谓词改写成字面量
			bm := c.bindMap()
			var lits []string
			var args string
			ok := true
			for _, mm := range reBindFuncEq.FindAllStringSubmatch(pt, -1) {
				if !strings.EqualFold(mm[1], fn) || !strings.EqualFold(mm[2], col) {
					continue
				}
				var vals []string
				for _, b := range strings.Split(strings.TrimPrefix(strings.TrimSpace(mm[3]), ","), ",") {
					v, has := bm[strings.TrimSpace(b)]
					if !has {
						ok = false
					}
					vals = append(vals, v)
				}
				a := strings.Join(vals, ",")
				if args != "" && args != a {
					ok = false
				}
				args = a
				lits = append(lits, mm[4])
			}
			var sb strings.Builder
			fmt.Fprintf(&sb, "-- 改写前：%s(%s, :1, :2) IN (%s)\n", fn, col, blankTo(strings.Join(lits, ","), "..."))
			if ok && args != "" && len(lits) > 0 {
				fmt.Fprintf(&sb, "-- 改写后（与现有函数索引一致，绑定值取自 V$SQL_BIND_CAPTURE 采样，需确认恒定）：\n%s(%s, %s) IN (%s)\n", fn, col, strings.ReplaceAll(args, ",", ", "), strings.Join(lits, ","))
			} else {
				fmt.Fprintf(&sb, "-- 改写后：把函数参数改为与索引表达式一致的字面量：%s\n", expr)
			}
			fmt.Fprintf(&sb, "-- 并补表达式统计：\nSELECT DBMS_STATS.CREATE_EXTENDED_STATS('%s','%s','(%s)') FROM DUAL;", t.Owner, t.Name, strings.ReplaceAll(expr, "\"", "\""))
			ff.SQL = sb.String()
			ff.Rollback = fmt.Sprintf("EXEC DBMS_STATS.DROP_EXTENDED_STATS('%s','%s','(%s)');", t.Owner, t.Name, expr)
			ff.Suggestion = "把函数参数改为字面量使其与索引表达式完全一致（并补表达式统计），或干脆放弃该索引路径改走并行全扫；若 SQL 由远端网关生成不可改，用 SQL Patch 固化正确计划。"
			ff.Risk = "确认绑定变量在所有执行中恒定；否则改写会改变语义，需业务方确认。"
			ff.Verify = "从 V$SQL_BIND_CAPTURE / AWR 确认绑定变量取值恒定；改写后检查 DBMS_XPLAN 是否出现 INDEX RANGE SCAN 命中该函数索引；在测试环境对比 DBMS_XPLAN（含 +ALLSTATS LAST）执行计划"
			f = &ff
			break
		}
		if f != nil {
			break
		}
	}
	if f == nil {
		return nil
	}
	return []Finding{*f}
}

func ruleR08(c *rctx) []Finding {
	var ev []string
	tab := c.mainTable()
	staleTab := false
	for _, t := range c.tabs {
		n := t["TABLE_NAME"]
		if strings.EqualFold(t["STALE_STATS"], "YES") {
			ev = append(ev, n+": STALE_STATS=YES（统计已过期）")
			tab, staleTab = c.tab(n), true
		}
		if t["LAST_ANALYZED"] == "" && t["NUM_ROWS"] == "" {
			ev = append(ev, n+": 统计信息缺失（LAST_ANALYZED 为空）")
			tab, staleTab = c.tab(n), true
		} else if ts, err := time.Parse("2006-01-02 15:04", t["LAST_ANALYZED"]); err == nil {
			if days := time.Since(ts).Hours() / 24; days > 60 && !strings.EqualFold(t["STALE_STATS"], "YES") && t["LAST_ANALYZED"] != "" {
				ev = append(ev, fmt.Sprintf("%s: 统计信息已 %.0f 天未更新（仅作参考，STALE_STATS 未标记）", n, days))
			}
		}
	}
	eq, rng := predCols(c.predText)
	predSet := map[string]bool{}
	for _, x := range append(append([]string{}, eq...), rng...) {
		predSet[x] = true
	}
	var want []string
	have := map[string]bool{}
	for _, r := range c.cols {
		col := strings.ToUpper(r["COLUMN_NAME"])
		have[col] = true
		if predSet[col] && strings.EqualFold(r["HISTOGRAM"], "NONE") {
			if n := num(r["NDV"]); n > 1 && n <= 254 {
				ev = append(ev, fmt.Sprintf("字段 %s 无直方图（NDV=%s，低基数列易倾斜）", col, r["NDV"]))
				want = append(want, col)
			}
		}
	}
	for col := range predSet {
		if !have[col] && len(c.cols) > 0 {
			ev = append(ev, fmt.Sprintf("字段 %s 无列统计", col))
		}
	}
	if len(ev) == 0 {
		return nil
	}
	sort.Strings(ev[len(c.tabs):]) // 稳定输出
	f := fnd("R08", 1, "统计信息过期、缺失或缺少直方图", 0.88, "低")
	f.Evidence = append(ev, "统计信息失真会直接导致 CBO 低估行数并选错访问路径")
	mo := "FOR ALL COLUMNS SIZE AUTO"
	if len(want) > 0 {
		sort.Strings(want)
		mo += " FOR COLUMNS SIZE 254 " + strings.Join(want, ", ")
	}
	var sb strings.Builder
	sb.WriteString("BEGIN\n")
	if c.partOf(tab.Name) {
		fmt.Fprintf(&sb, "  DBMS_STATS.SET_TABLE_PREFS('%s','%s','INCREMENTAL','TRUE');\n", tab.Owner, tab.Name)
	}
	fmt.Fprintf(&sb, "  DBMS_STATS.GATHER_TABLE_STATS('%s','%s',\n    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,\n    method_opt => '%s', degree => 8, cascade => TRUE);\nEND;\n/", tab.Owner, tab.Name, mo)
	f.SQL = sb.String()
	f.Rollback = fmt.Sprintf("EXEC DBMS_STATS.RESTORE_TABLE_STATS('%s','%s', SYSTIMESTAMP - INTERVAL '30' MINUTE);  -- 时间改为收集之前", tab.Owner, tab.Name)
	f.Suggestion = "重新收集表 / 分区统计；对低基数且倾斜的过滤列强制直方图，对关联列建列组扩展统计，分区表开启 INCREMENTAL 增量统计。"
	f.Risk = "收集统计可能引发全库计划变化，需变更窗口 + Baseline 兜底。"
	_ = staleTab
	return []Finding{f}
}

func (c *rctx) partOf(table string) bool {
	for _, t := range c.tabs {
		if strings.EqualFold(t["TABLE_NAME"], table) && strings.EqualFold(t["PARTITIONED"], "YES") {
			return true
		}
	}
	return false
}

func ruleR09(c *rctx) []Finding {
	toks := identTokens(c.s.SQLText, c.predText)
	var ev []string
	var col0, tab0 string
	for _, r := range c.samp {
		if p := num(r["PCT"]); p >= c.th.SkewPct && toks[strings.ToUpper(r["COLUMN_NAME"])] {
			ev = append(ev, fmt.Sprintf("%s.%s 值 %s 占比 %.2f%%（采样）", r["TABLE_NAME"], r["COLUMN_NAME"], r["VALUE"], p))
			col0, tab0 = r["COLUMN_NAME"], r["TABLE_NAME"]
		}
	}
	for _, r := range c.hist {
		if p := num(r["BUCKET_PCT"]); p >= c.th.SkewPct && toks[strings.ToUpper(r["COLUMN_NAME"])] {
			ev = append(ev, fmt.Sprintf("%s.%s 值 ENDPOINT=%s 占比 %.2f%%（直方图推算）", r["TABLE_NAME"], r["COLUMN_NAME"], r["ENDPOINT_VALUE"], p))
			col0, tab0 = r["COLUMN_NAME"], r["TABLE_NAME"]
		}
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R09", 1, "过滤列存在严重数据倾斜", 0.78, "低")
	f.Evidence = append(ev, fmt.Sprintf("阈值 %g%%；倾斜列上的等值谓词用索引可能不如全扫，且不宜作为联合索引首列", c.th.SkewPct))
	t := c.tab(tab0)
	f.SQL = fmt.Sprintf("-- 精确分布（默认关闭，需 --sample 显式开启）\n-- %s <SQL_ID> --connect ... --sample --sample-table %s.%s --sample-cols %s", toolName, t.Owner, t.Name, col0)
	f.Suggestion = "确认该列有频率直方图；对高占比值的查询倾向全扫 / 并行全扫，避免把倾斜列放联合索引首列；在源头评估把全量抽取改成按水位增量抽取。"
	f.Risk = "基于统计信息推算的桶频率不等于精确值频率；采样会读表，需控制比例与窗口。"
	f.Verify = "对比 DBA_TAB_HISTOGRAMS 与采样结果的偏差；检查该列谓词的实际选择率与 CBO 估算差异；对比单次 elapsed、BUFFER_GETS、DISK_READS"
	return []Finding{f}
}

func ruleR10(c *rctx) []Finding {
	var ptabs []string
	for _, t := range c.tabs {
		if strings.EqualFold(t["PARTITIONED"], "YES") {
			ptabs = append(ptabs, t["TABLE_NAME"])
		}
	}
	if len(ptabs) == 0 {
		return nil
	}
	var ev []string
	nParts := len(c.parts)
	ev = append(ev, fmt.Sprintf("表为分区表，共采集到 %d 个分区", nParts))
	trigger := false
	for _, p := range c.plan {
		ps := strings.ToUpper(p["PARTITION_START"])
		if ps == "" || !strings.HasPrefix(p["OPERATION"], "TABLE ACCESS") {
			continue
		}
		if ps == "ROW LOCATION" || ps == "ROWID" || ps == "KEY(INLIST)" {
			trigger = true
			ev = append(ev, fmt.Sprintf("计划 Id %s 的 PARTITION_START=%s / STOP=%s，未静态裁剪", p["ID"], p["PARTITION_START"], p["PARTITION_STOP"]))
			break
		}
		if ps == "1" && nParts > 1 && num(p["PARTITION_STOP"]) == float64(nParts) && p["OPERATION"] != "" {
			trigger = true
			ev = append(ev, fmt.Sprintf("计划 Id %s 访问全部 %d 个分区（Pstart=1 / Pstop=%s）", p["ID"], nParts, p["PARTITION_STOP"]))
			break
		}
	}
	var gl []string
	for _, i := range c.idx {
		if i["LOCALITY"] == "GLOBAL" {
			gl = append(gl, i["INDEX_NAME"])
		}
	}
	if len(gl) > 0 {
		ev = append(ev, fmt.Sprintf("存在 %d 个 GLOBAL 索引（%s），跨实例回表与年度分区维护都会受影响", len(gl), joinMax(gl, 5, ", ")))
	}
	if !trigger && len(gl) < 3 {
		return nil
	}
	f := fnd("R10", 1, "分区裁剪不足或 GLOBAL 索引带来额外开销", 0.75, "中")
	f.Evidence = ev
	f.Suggestion = "确认 WHERE 含分区键字面量谓词（避免绑定变量 / 函数包裹分区键）；计划应显示 Pstart/Pstop 为具体分区；分区维护窗口使用 UPDATE GLOBAL INDEXES，或评估 LOCAL 化。"
	f.SQL = fmt.Sprintf("SELECT INST_ID, ID, PARTITION_START, PARTITION_STOP, OPERATION\nFROM GV$SQL_PLAN WHERE SQL_ID = '%s' ORDER BY INST_ID, ID;", c.s.Meta.SQLID)
	f.Risk = "PK/UK 若不含分区键通常无法 LOCAL 化；TRUNCATE/DROP PARTITION 未加 UPDATE GLOBAL INDEXES 会使全局索引 UNUSABLE。"
	return []Finding{f}
}

func ruleR11(c *rctx) []Finding {
	sens, aware := 0, 0
	for _, k := range c.kids {
		if k["IS_BIND_SENSITIVE"] == "Y" {
			sens++
			if k["IS_BIND_AWARE"] != "Y" {
				aware++
			}
		}
	}
	if aware == 0 && c.m.PlanCount <= 1 {
		return nil
	}
	f := fnd("R11", 1, "执行计划不稳定 / 绑定变量窥探风险", 0.80, "中")
	if aware > 0 {
		f.Evidence = append(f.Evidence, fmt.Sprintf("%d 个子游标 IS_BIND_SENSITIVE=Y，其中 %d 个 IS_BIND_AWARE=N", sens, aware))
	}
	if c.m.PlanCount > 1 {
		f.Evidence = append(f.Evidence, fmt.Sprintf("同一 SQL_ID 出现 %d 个不同的 PLAN_HASH_VALUE", c.m.PlanCount))
	}
	f.Evidence = append(f.Evidence, "V$SQL_BIND_CAPTURE 只是采样值，不能代表每次执行的真实绑定值")
	f.Suggestion = "分别导出各 PLAN_HASH_VALUE 的计划与 A-Rows；确认是否存在数据倾斜导致的计划抖动；必要时用 SQL Plan Baseline / SQL Patch 固化已验证的最优计划，而非绑定 INDEX hint。"
	f.SQL = "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('" + c.s.Meta.SQLID + "', NULL, 'ALLSTATS LAST +PEEKED_BINDS +PREDICATE'));"
	f.Risk = "Baseline 会锁定计划，数据分布大幅变化后可能劣化，需保留回退与定期复核。"
	return []Finding{f}
}

func ruleR12(c *rctx) []Finding {
	partKey := map[string]bool{}
	for _, k := range c.pk {
		partKey[strings.ToUpper(k["COLUMN_NAME"])] = true
	}
	lead := map[string]map[string]string{} // index -> {col, table}
	cols := map[string][]string{}
	for _, r := range c.idc {
		n := r["INDEX_NAME"]
		cols[n] = append(cols[n], strings.ToUpper(r["COLUMN_NAME"]))
		if r["COLUMN_POSITION"] == "1" {
			lead[n] = map[string]string{"col": strings.ToUpper(r["COLUMN_NAME"]), "tab": r["TABLE_NAME"]}
		}
	}
	var names []string
	for n := range lead {
		names = append(names, n)
	}
	sort.Strings(names)
	var ev []string
	for _, n := range names {
		l := lead[n]
		if partKey[l["col"]] {
			isLocal := false
			for _, i := range c.idx {
				if i["INDEX_NAME"] == n && i["LOCALITY"] == "LOCAL" {
					isLocal = true
				}
			}
			if isLocal {
				ev = append(ev, fmt.Sprintf("%s 前导列为分区键 %s：分区裁剪后该列通常无额外过滤价值，建议评估是否冗余", n, l["col"]))
				continue
			}
		}
		if nd := c.colNDV(l["tab"], l["col"]); nd > 0 && nd <= 3 {
			ev = append(ev, fmt.Sprintf("%s 前导列 %s 的 NDV=%s：选择性极低，需结合回表行数评估，不能仅凭此判定索引无效", n, l["col"], fmtInt(nd)))
		}
	}
	for _, a := range names { // 前缀重复
		for _, b := range names {
			if a == b || lead[a]["tab"] != lead[b]["tab"] || len(cols[a]) >= len(cols[b]) {
				continue
			}
			pref := true
			for i := range cols[a] {
				if cols[a][i] != cols[b][i] {
					pref = false
				}
			}
			if pref && !strings.HasPrefix(cols[a][0], "SYS_NC") {
				ev = append(ev, fmt.Sprintf("%s (%s) 是 %s 的前缀索引，可能被后者覆盖（唯一 / 约束索引除外）", a, strings.Join(cols[a], ","), b))
			}
		}
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R12", 2, "存在可评估的冗余 / 低效索引线索", 0.60, "高")
	f.Evidence = append(ev, "以上仅为线索，索引是否冗余须结合 INDEX MONITORING USAGE 与完整工作负载判断")
	f.Suggestion = "先用 ALTER INDEX ... MONITORING USAGE 跑满一个完整业务周期，再联合 DBA 评估删除；不要仅凭单条 SQL 的计划下结论。"
	t := c.mainTable()
	f.SQL = fmt.Sprintf("ALTER INDEX %s.<INDEX_NAME> MONITORING USAGE;\n-- 一个业务周期后：SELECT * FROM V$OBJECT_USAGE;\n-- 若最终决定下线，先 ALTER INDEX ... INVISIBLE 观察，而不是直接 DROP。", t.Owner)
	f.Rollback = "ALTER INDEX " + t.Owner + ".<INDEX_NAME> VISIBLE;"
	f.Risk = "删除索引会影响其他未采集到的 SQL，存在计划突变风险。"
	f.Verify = "覆盖至少一个完整月结 / 批处理周期；删除前用 SQL Plan Baseline 或 SPA 做回归验证"
	return []Finding{f}
}

// ---------------------------------------------------------------- R13-R17

func ruleR13(c *rctx) []Finding {
	var f *Finding
	for _, p := range c.plan {
		if p["OPERATION"] != "TABLE ACCESS" || !strings.HasPrefix(p["OPTIONS"], "FULL") {
			continue
		}
		t := c.tab(p["OBJECT_NAME"])
		nr := c.numRows(p["OBJECT_NAME"])
		if nr < c.th.BigTable {
			continue
		}
		out := num(p["E_ROWS"])
		src := "预计"
		for _, r := range c.rt {
			if r["ID"] == p["ID"] && hasNum(r["A_ROWS"]) {
				out, src = num(r["A_ROWS"]), "实际"
			}
		}
		if out/nr >= 0.05 || (p["FILTER_PREDICATES"] == "" && p["ACCESS_PREDICATES"] == "") {
			continue
		}
		eq, rng := predCols(p["ACCESS_PREDICATES"] + " AND " + p["FILTER_PREDICATES"])
		sort.SliceStable(eq, func(i, j int) bool { return c.colNDV(t.Name, eq[i]) > c.colNDV(t.Name, eq[j]) })
		keys := append(append([]string{}, eq...), rng...)
		if len(keys) > 3 {
			keys = keys[:3]
		}
		ff := fnd("R13", 1, "大表全表扫描但返回比例很低", 0.70, "中")
		ff.Evidence = []string{
			fmt.Sprintf("%s 行数约 %s，全表扫描后%s返回 %s 行（%.2f%%）", t.Name, fmtInt(nr), src, fmtInt(out), out/nr*100),
			"过滤条件：" + truncate(blankTo(p["FILTER_PREDICATES"], p["ACCESS_PREDICATES"]), 300),
		}
		ff.Suggestion = "评估以过滤列建立索引（先建 INVISIBLE 索引在会话级验证，再决定是否可见）；若列有倾斜，不要把倾斜列放首位。"
		if len(keys) > 0 {
			iname := truncate("IDX_"+t.Name+"_"+keys[0], 30)
			ff.SQL = fmt.Sprintf("CREATE INDEX %s.%s ON %s.%s (%s) INVISIBLE ONLINE PARALLEL 4;\nALTER INDEX %s.%s NOPARALLEL;\n-- 会话级验证（不影响其他会话）：\nALTER SESSION SET optimizer_use_invisible_indexes = TRUE;",
				t.Owner, iname, t.Owner, t.Name, strings.Join(keys, ", "), t.Owner, iname)
			ff.Rollback = fmt.Sprintf("DROP INDEX %s.%s;", t.Owner, iname)
		}
		ff.Risk = "增加索引空间与 INSERT/UPDATE/DELETE 维护成本；可能改变其他 SQL 的计划。以上字段顺序仅为依据谓词的初稿，需结合数据分布与完整工作负载确认。"
		f = &ff
		break
	}
	if f == nil {
		return nil
	}
	return []Finding{*f}
}

func ruleR14(c *rctx) []Finding {
	var ev []string
	if strings.Contains(strings.ToUpper(c.predText), "INTERNAL_FUNCTION(") {
		ev = append(ev, "谓词出现 INTERNAL_FUNCTION(...)：说明发生了隐式数据类型转换，列上的索引通常无法使用")
	}
	idxFn := map[string]bool{}
	for _, e := range c.iex {
		if m := reFuncCall.FindStringSubmatch(e["COLUMN_EXPRESSION"]); m != nil {
			idxFn[strings.ToUpper(m[1]+"."+m[2])] = true
		}
	}
	seen := map[string]bool{}
	for _, u := range predFuncs(c.predText) {
		k := u.Func + "." + u.Col
		if idxFn[k] || seen[k] { // 已有函数索引的交给 R07
			continue
		}
		seen[k] = true
		ev = append(ev, fmt.Sprintf("列 %s 被 %s() 包裹：%s；普通索引无法用于该谓词", u.Col, u.Func, truncate(u.Text, 80)))
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R14", 1, "隐式类型转换 / 索引列被函数包裹", 0.72, "低")
	f.Evidence = ev
	f.Suggestion = "让比较两侧数据类型一致（改绑定变量类型 / 显式转换常量一侧）；把函数移到常量一侧，或为该表达式建函数索引（并补表达式统计）。"
	f.Risk = "改写前需确认语义等价（如截断、前导零、NLS 设置）；函数索引增加 DML 成本。"
	return []Finding{f}
}

func ruleR15(c *rctx) []Finding {
	mod := c.s.Meta.Module
	if !c.info.Opaque && !strings.Contains(strings.ToUpper(mod), "TNS V1-V3") {
		return nil
	}
	f := fnd("R15", 2, "SQL 疑似由 dblink / 远端网关生成，本端无法直接改 SQL 文本", 0.85, "高")
	f.Evidence = []string{"MODULE = " + blankTo(mod, "-"), "SQL 中含 OPAQUE_TRANSFORM 或来自 TNS V1-V3 会话", "这类同步每次全量拉取远端结果集，网络与客户端 fetch 也是瓶颈"}
	f.Suggestion = "改造优先级：① 源头改增量抽取（按 UPDATE_TIME / CREATE_TIME 水位）；② 本端建视图承接改写；③ 本端用 DBMS_SQLDIAG.CREATE_SQL_PATCH 固化正确计划；④ 去掉恒定列减少传输。所有 CREATE INDEX / SQL Patch 只生成建议，不自动执行。"
	t := c.mainTable()
	f.SQL = fmt.Sprintf("-- 利用现成水位字段做增量（确认业务无物理 DELETE）\nSELECT ... FROM %s.%s t\nWHERE UPDATE_TIME > :LAST_WATERMARK\n  AND <原有过滤条件>;\n-- 目标端用主键做幂等 MERGE", t.Owner, t.Name)
	f.Risk = "水位方案依赖 UPDATE_TIME 可靠维护，且无法识别物理 DELETE；需业务方确认。"
	f.Verify = "确认 UPDATE_TIME 在所有更新路径上都被维护；确认无物理 DELETE，或补充删除水位表；对比全量与增量的行数一致性"
	return []Finding{f}
}

func ruleR16(c *rctx) []Finding {
	var f *Finding
	for _, k := range c.pk {
		if k["PARTITIONING_TYPE"] != "LIST" || k["COLUMN_POSITION"] != "1" {
			continue
		}
		tn := k["NAME"]
		var names []string
		def, hasHV := false, false
		for _, p := range c.parts {
			if !strings.EqualFold(p["TABLE_NAME"], tn) {
				continue
			}
			names = append(names, p["PARTITION_NAME"])
			if _, ok := p["HIGH_VALUE"]; ok {
				hasHV = true
				if strings.Contains(strings.ToUpper(p["HIGH_VALUE"]), "DEFAULT") {
					def = true
				}
			}
		}
		if len(names) == 0 || def || !hasHV {
			continue
		}
		ff := fnd("R16", 1, "LIST 分区缺少 DEFAULT 兜底，新键值写入将报 ORA-14400", 0.80, "低")
		ff.Evidence = []string{
			fmt.Sprintf("共 %d 个分区，未发现 DEFAULT 分区，最大分区为 %s", len(names), names[len(names)-1]),
			"按年 LIST 分区时，跨年首次写入会直接失败（子分区若有 DEFAULT 仅能兜底子分区键）",
		}
		t := c.tab(tn)
		ff.Suggestion = "在年末变更窗口提前 ADD PARTITION，并显式补齐复合子分区（无子分区模板时需逐个列出）。"
		ff.SQL = fmt.Sprintf("ALTER TABLE %s.%s ADD PARTITION P<YYYY> VALUES ('<YYYY>')\n  ( SUBPARTITION ... ) UPDATE GLOBAL INDEXES;\n-- 或：ALTER TABLE %s.%s ADD PARTITION PDEFAULT VALUES (DEFAULT);", t.Owner, t.Name, t.Owner, t.Name)
		ff.Rollback = fmt.Sprintf("ALTER TABLE %s.%s DROP PARTITION P<YYYY> UPDATE GLOBAL INDEXES;  -- 仅限分区仍为空时", t.Owner, t.Name)
		ff.Risk = "新增分区会使 GLOBAL 索引失效（除非 UPDATE GLOBAL INDEXES），需安排在维护窗口。"
		ff.Verify = "在测试库用下一年度键值做一次插入验证；检查 DBA_INDEXES.STATUS 是否仍为 VALID/N/A"
		f = &ff
		break
	}
	if f == nil {
		return nil
	}
	return []Finding{*f}
}

func ruleR17(c *rctx) []Finding {
	blocks := map[string]float64{}
	for _, t := range c.tabs {
		blocks[t["TABLE_NAME"]] = num(t["BLOCKS"])
	}
	var ev []string
	for _, i := range c.idx {
		b := blocks[i["TABLE_NAME"]]
		cf := num(i["CLUSTERING_FACTOR"])
		if b > 0 && cf > 0 && cf/b >= c.th.CFRatio {
			ev = append(ev, fmt.Sprintf("%s：CLUSTERING_FACTOR=%s / 表 BLOCKS=%s = %.2f", i["INDEX_NAME"], fmtInt(cf), fmtInt(b), cf/b))
		}
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R17", 2, "索引聚簇因子偏高，需结合访问行数判断回表代价", 0.55, "高")
	f.Evidence = append(ev, "高聚簇因子 ≠ 索引无效；只有当访问行数大且需大量回表时才构成问题")
	f.Suggestion = "结合 R02 的回表行数判断；可评估覆盖索引消除回表，或对表做按索引键排序的重组（代价高，谨慎）。"
	f.Risk = "表重组属高风险大变更，需停机窗口与完整回退方案。"
	f.Verify = "对比 INDEX FAST FULL SCAN 与 TABLE ACCESS FULL 的实际逻辑读"
	return []Finding{f}
}

// ---------------------------------------------------------------- R18-R23（新增）

func ruleR18(c *rctx) []Finding {
	for _, p := range c.plan {
		if strings.HasPrefix(p["OPERATION"], "MERGE JOIN") && strings.Contains(p["OPTIONS"], "CARTESIAN") {
			f := fnd("R18", 0, "执行计划含笛卡尔积（MERGE JOIN CARTESIAN）", 0.80, "中")
			f.Evidence = []string{fmt.Sprintf("计划 Id %s：MERGE JOIN CARTESIAN，预计 %s 行", p["ID"], blankTo(p["E_ROWS"], "?")),
				"笛卡尔积在两侧行数都不小时代价为乘积；通常是缺少连接条件，或统计信息把一侧估成 1 行"}
			f.Suggestion = "检查 SQL 是否缺少 JOIN 条件；若估算偏差导致（某侧被估为 1 行），先修统计 / 直方图（参见 R03、R08）；确属需要笛卡尔积时确认两侧行数。"
			f.Risk = "无。该规则只指出线索。"
			return []Finding{f}
		}
	}
	return nil
}

func ruleR19(c *rctx) []Finding {
	var ev []string
	for _, w := range c.wa {
		if num(w["ONEPASS_EXECUTIONS"])+num(w["MULTIPASSES_EXECUTIONS"]) > 0 || num(w["MAX_TEMP_MB"]) > 0 {
			ev = append(ev, fmt.Sprintf("操作 #%s %s：估算最优内存 %s MB，上次用 %s MB，onepass=%s / multipass=%s，TEMP 峰值 %s MB",
				w["OPERATION_ID"], w["OPERATION_TYPE"], blankTo(w["EST_OPTIMAL_MB"], "?"), blankTo(w["LAST_MEM_MB"], "?"),
				blankTo(w["ONEPASS_EXECUTIONS"], "0"), blankTo(w["MULTIPASSES_EXECUTIONS"], "0"), blankTo(w["MAX_TEMP_MB"], "0")))
		}
	}
	for _, p := range c.plan {
		if num(p["TEMP_SPACE"]) > 0 {
			ev = append(ev, fmt.Sprintf("计划 Id %s %s 预计使用 TEMP %s", p["ID"], p["OPERATION"], humanBytes(num(p["TEMP_SPACE"]))))
		}
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R19", 1, "排序 / 哈希溢出到 TEMP", 0.78, "中")
	f.Evidence = ev
	f.Suggestion = "先确认是否真的需要排序 / 哈希（可用索引有序性、减少 DISTINCT / ORDER BY、提前过滤列与行）；再评估 PGA（pga_aggregate_target / workarea_size_policy）与并行度；TEMP 表空间需监控。"
	f.Risk = "放大 PGA 会占用整体内存；并行度提高会同时放大 TEMP 与内存占用。"
	return []Finding{f}
}

func ruleR20(c *rctx) []Finding {
	if len(c.trend) < 2 {
		return nil
	}
	rows := append([]map[string]string{}, c.trend...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i]["END_INTERVAL_TIME"] < rows[j]["END_INTERVAL_TIME"] })
	phv := map[string][]float64{}
	var order []string
	for _, r := range rows {
		p := r["PLAN_HASH_VALUE"]
		if _, ok := phv[p]; !ok {
			order = append(order, p)
		}
		if hasNum(r["AVG_SEC"]) {
			phv[p] = append(phv[p], num(r["AVG_SEC"]))
		}
	}
	var ev []string
	if len(order) > 1 {
		ev = append(ev, fmt.Sprintf("AWR 窗口内出现 %d 个计划：%s", len(order), strings.Join(order, " → ")))
		for _, p := range order {
			v := phv[p]
			if len(v) > 0 {
				sum := 0.0
				for _, x := range v {
					sum += x
				}
				ev = append(ev, fmt.Sprintf("PLAN_HASH_VALUE %s：%d 个快照，平均单次 %.3f 秒", p, len(v), sum/float64(len(v))))
			}
		}
	}
	first, last := 0.0, 0.0
	var vals []float64
	for _, r := range rows {
		if hasNum(r["AVG_SEC"]) && num(r["EXECUTIONS"]) > 0 {
			vals = append(vals, num(r["AVG_SEC"]))
		}
	}
	if len(vals) >= 3 {
		first = vals[0]
		for _, v := range vals[:len(vals)-1] {
			if v > first {
				first = v
			}
		}
		_ = first
		base := 0.0
		for _, v := range vals[:len(vals)-1] {
			base += v
		}
		base /= float64(len(vals) - 1)
		last = vals[len(vals)-1]
		if base > 0 && last >= 2*base && last > 1 {
			ev = append(ev, fmt.Sprintf("最近快照平均单次 %.3f 秒，是此前均值 %.3f 秒的 %.1f 倍", last, base, last/base))
		}
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R20", 1, "历史性能劣化 / 计划突变", 0.70, "中")
	f.Evidence = ev
	f.Suggestion = "对比变化前后计划（DBMS_XPLAN.DISPLAY_AWR）与统计信息 / 绑定变量 / 数据量变化；若旧计划明显更优，可用 SQL Plan Baseline 加载旧计划（DBMS_SPM.LOAD_PLANS_FROM_AWR）作为止血。"
	f.Risk = "Baseline 会锁定计划；数据增长后旧计划可能不再合适。"
	return []Finding{f}
}

func ruleR21(c *rctx) []Finding {
	var ev []string
	if c.m.Children > 20 {
		ev = append(ev, fmt.Sprintf("共 %d 个子游标（> 20），解析与共享池压力偏大", c.m.Children))
	}
	if c.info.Literals >= 3 && c.info.BindCount == 0 {
		ev = append(ev, fmt.Sprintf("SQL 含 %d 个字面量且没有绑定变量，可能每个取值生成一个 SQL_ID", c.info.Literals))
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R21", 2, "游标版本过多 / 字面量未绑定", 0.60, "中")
	f.Evidence = ev
	f.Suggestion = "应用侧改用绑定变量；无法改应用时评估 cursor_sharing=FORCE（会话 / 服务级）；查 V$SQL_SHARED_CURSOR 找出子游标不共享的原因。"
	f.SQL = fmt.Sprintf("SELECT * FROM V$SQL_SHARED_CURSOR WHERE SQL_ID = '%s';", c.s.Meta.SQLID)
	f.Risk = "cursor_sharing=FORCE 可能引入绑定变量窥探副作用。"
	return []Finding{f}
}

func ruleR22(c *rctx) []Finding {
	var ev []string
	for _, s := range c.sess {
		if s["BLOCKING_SESSION"] != "" {
			ev = append(ev, fmt.Sprintf("会话 %s,%s 被 %s,%s 阻塞（事件 %s）", s["INST_ID"], s["SID"], blankTo(s["BLOCKING_INSTANCE"], "?"), s["BLOCKING_SESSION"], s["EVENT"]))
		} else if strings.HasPrefix(strings.ToLower(s["EVENT"]), "enq:") {
			ev = append(ev, fmt.Sprintf("会话 %s,%s 正在等待 %s", s["INST_ID"], s["SID"], s["EVENT"]))
		}
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R22", 1, "存在阻塞 / 锁等待", 0.85, "低")
	f.Evidence = ev
	f.Suggestion = "先定位阻塞源会话与其 SQL（GV$SESSION.BLOCKING_SESSION、GV$LOCK）；由业务方决定提交 / 回滚 / 终止；不要在 SQL 层面盲目优化。"
	f.Risk = "终止会话会回滚其事务，需业务确认。"
	return []Finding{f}
}

func ruleR23(c *rctx) []Finding {
	p := map[string]string{}
	def := map[string]string{}
	for _, r := range c.opt {
		p[strings.ToLower(r["NAME"])] = r["VALUE"]
		def[strings.ToLower(r["NAME"])] = strings.ToUpper(r["ISDEFAULT"])
	}
	var ev []string
	chk := func(name, want, why string) {
		if v, ok := p[name]; ok && !strings.EqualFold(v, want) {
			ev = append(ev, fmt.Sprintf("%s = %s（默认/常见值 %s）：%s", name, v, want, why))
		}
	}
	chk("optimizer_mode", "ALL_ROWS", "FIRST_ROWS 倾向走索引 / 嵌套循环，批处理大结果集会吃亏")
	chk("optimizer_index_cost_adj", "100", "被调小会让 CBO 过度偏爱索引")
	chk("optimizer_index_caching", "0", "被调大会低估索引随机读成本")
	chk("cursor_sharing", "EXACT", "FORCE/SIMILAR 会改变绑定变量窥探行为")
	chk("statistics_level", "TYPICAL", "BASIC 会让 AWR/ASH 与 A-Rows 不可用")
	if v := p["optimizer_features_enable"]; v != "" && c.s.Meta.Major > 0 && !strings.HasPrefix(v, fmt.Sprint(c.s.Meta.Major)) {
		ev = append(ev, fmt.Sprintf("optimizer_features_enable = %s 与数据库版本 %d 不一致：新优化器特性被关闭", v, c.s.Meta.Major))
	}
	if v := p["db_file_multiblock_read_count"]; v != "" && def["db_file_multiblock_read_count"] == "FALSE" && num(v) > 0 && num(v) < 16 {
		ev = append(ev, "db_file_multiblock_read_count 被显式设为 "+v+"：多块读偏小，全扫成本被高估")
	}
	if len(ev) == 0 {
		return nil
	}
	f := fnd("R23", 2, "优化器 / 实例参数疑似异常", 0.50, "中")
	f.Evidence = ev
	f.Suggestion = "确认这些参数是否有变更记录与业务理由；优先用会话级 / 服务级 / SQL 级手段验证，而不是直接改实例级参数。"
	f.Risk = "实例级参数影响全库所有 SQL。"
	return []Finding{f}
}
