package main

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 采集层：只读、可降级、每个章节独立失败（权限不足 / 视图不存在不会中断整份报告）。
// 约定：
//   * %CAT% 在有 DBA 权限时替换为 DBA，否则降级为 ALL（只能看到本用户可见对象）。
//   * 标识符一律经 lit()/identRe 校验后内联，SQL_ID 同理；没有任何用户输入以未校验形式进入 SQL。

type pick struct {
	Inst, Child, PHV string
}

type collector struct {
	ctx     context.Context
	db      DB
	o       Options
	s       *Snapshot
	id      string
	pfx     string
	major   int
	inst    string
	params  map[string]string
	awr     bool   // 共享池里没有，改从 AWR 还原
	picks   []pick // 每个 PLAN_HASH_VALUE 取最近活跃的一个子游标
	tables  []TabRef
	tabSet  map[string]bool
	keyCols map[string]bool
	partTab map[string]bool
	numRows map[string]float64
}

func oneLine(q string) string {
	q = strings.Join(strings.Fields(q), " ")
	if len(q) > 600 {
		q = q[:600] + "…"
	}
	return q
}

func (c *collector) q(query string, args ...any) ([]string, [][]string, error) {
	query = strings.ReplaceAll(query, "%CAT%", c.pfx)
	ctx, cancel := context.WithTimeout(c.ctx, time.Duration(c.o.TimeoutSec)*time.Second)
	defer cancel()
	t0 := time.Now()
	cols, rows, err := c.db.Query(ctx, query, args...)
	st := "ok"
	if err != nil {
		st = "ERR"
	}
	c.s.Audit = append(c.s.Audit, fmt.Sprintf("[%s %dms %drows] %s", st, time.Since(t0).Milliseconds(), len(rows), oneLine(query)))
	c.s.AuditFull = append(c.s.AuditFull, query)
	return cols, rows, err
}

func (c *collector) one(query string) string {
	_, rows, err := c.q(query)
	if err != nil || len(rows) == 0 || len(rows[0]) == 0 {
		return ""
	}
	return rows[0][0]
}

// runSec 依次尝试 queries（后面的是降级版本），第一个成功的结果成为章节。
func (c *collector) runSec(key, title, note string, queries ...string) *Section {
	sec := Section{Key: key, Title: title, Note: note}
	var lastErr error
	for i, q := range queries {
		cols, rows, err := c.q(q)
		if err == nil {
			sec.Cols, sec.Rows, sec.Err = cols, rows, ""
			if i > 0 {
				sec.Note = strings.TrimSpace(sec.Note + " [已降级采集：部分字段（LONG 类型 / 高版本列）不可用]")
			}
			lastErr = nil
			break
		}
		lastErr = err
	}
	if lastErr != nil {
		sec.Err = "采集失败：" + shortErr(lastErr)
		c.s.Errors = append(c.s.Errors, title+": "+shortErr(lastErr))
	}
	c.s.Sections = append(c.s.Sections, sec)
	return &c.s.Sections[len(c.s.Sections)-1]
}

func shortErr(err error) string {
	s := strings.TrimSpace(err.Error())
	if i := strings.Index(s, "ORA-"); i >= 0 {
		s = s[i:]
	}
	if j := strings.Index(s, "\n"); j > 0 {
		s = s[:j]
	}
	return truncate(s, 160)
}

func (c *collector) put(sec Section) { c.s.Sections = append(c.s.Sections, sec) }

func (c *collector) inList(vals []string) string {
	var out []string
	for _, v := range vals {
		if l, err := lit(strings.ToUpper(v)); err == nil {
			out = append(out, l)
		}
	}
	if len(out) == 0 {
		return "('')"
	}
	return "(" + strings.Join(out, ",") + ")"
}

func (c *collector) tabPred(ownerCol, nameCol string) string {
	var parts []string
	for _, t := range c.tables {
		o, e1 := lit(t.Owner)
		n, e2 := lit(t.Name)
		if e1 == nil && e2 == nil {
			parts = append(parts, fmt.Sprintf("(%s=%s AND %s=%s)", ownerCol, o, nameCol, n))
		}
	}
	if len(parts) == 0 {
		return "1=0"
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

func friendlyVer(major int) string {
	switch {
	case major >= 23:
		return fmt.Sprintf("%dai", major)
	case major >= 12:
		return fmt.Sprintf("%dc", major)
	default:
		return fmt.Sprintf("%dg", major)
	}
}

func collect(ctx context.Context, db DB, o Options, id string) (*Snapshot, error) {
	if !sqlIDRe.MatchString(id) {
		return nil, fmt.Errorf("SQL_ID %q 格式不对", id)
	}
	t0 := time.Now()
	s := &Snapshot{Schema: snapSchema}
	s.Meta = Meta{SQLID: id, Mode: "online", Generated: time.Now().Format("2006-01-02 15:04:05")}
	c := &collector{ctx: ctx, db: db, o: o, s: s, id: id, pfx: "DBA", params: map[string]string{},
		tabSet: map[string]bool{}, keyCols: map[string]bool{}, partTab: map[string]bool{}, numRows: map[string]float64{}}

	if err := c.probe(); err != nil {
		return nil, fmt.Errorf("环境探测失败（权限不足？参见 GRANTS.sql）: %w", err)
	}
	c.collectParams()
	if err := c.collectSQL(); err != nil {
		return nil, err
	}
	if !c.awr {
		c.collectPlans()
	}
	c.collectRuntime()
	c.collectObjects()
	c.collectCatalog()
	c.collectMisc()
	if o.Sample {
		c.collectSample()
	}
	sortSections(s)
	s.Meta.CollectSec = round(time.Since(t0).Seconds(), 1)
	return s, nil
}

// ---------- 1. 环境探测 ----------

func (c *collector) probe() error {
	m := &c.s.Meta
	_, rows, err := c.q(`SELECT banner FROM v$version WHERE banner LIKE 'Oracle%' AND ROWNUM = 1`)
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		m.Banner = rows[0][0]
	}
	full := c.one(`SELECT version_full FROM v$instance`) // 18c+
	if full == "" {
		full = c.one(`SELECT version FROM v$instance`)
	}
	m.Version = full
	if i := strings.Index(full, "."); i > 0 {
		c.major, _ = strconv.Atoi(full[:i])
	}
	m.Major = c.major
	ed := "SE"
	if strings.Contains(m.Banner, "Enterprise") {
		ed = "EE"
	}
	m.Edition = ed
	m.Banner = fmt.Sprintf("Oracle %s %s %s", friendlyVer(c.major), ed, full)
	m.DBName = c.one(`SELECT name FROM v$database`)
	if c.major >= 12 {
		m.CDB = strings.EqualFold(c.one(`SELECT cdb FROM v$database`), "YES")
	}
	_, rows, _ = c.q(`SELECT SYS_CONTEXT('USERENV','CON_NAME'), SYS_CONTEXT('USERENV','CON_ID'), SYS_CONTEXT('USERENV','INSTANCE') FROM dual`)
	if len(rows) > 0 {
		m.Container, m.ConID, c.inst = rows[0][0], rows[0][1], rows[0][2]
	}
	n, _ := strconv.Atoi(c.one(`SELECT COUNT(*) FROM gv$instance`))
	m.Instances = n
	m.RAC = n > 1
	if _, _, err := c.q(`SELECT 1 FROM dba_tables WHERE ROWNUM = 1`); err != nil {
		c.pfx = "ALL"
	}

	cols, rows, err := c.q(`SELECT i.inst_id, i.instance_name, i.host_name, i.version, d.name db_name,
	       ` + ternary(c.major >= 12, `d.cdb`, `'NO'`) + ` cdb,
	       SYS_CONTEXT('USERENV','CON_NAME') con_name, (SELECT COUNT(*) FROM gv$instance) instance_count
	  FROM gv$instance i, v$database d ORDER BY i.inst_id`)
	sec := Section{Key: "env", Title: "数据库环境与 RAC 实例", Cols: cols, Rows: rows}
	if err != nil {
		sec.Err = "采集失败：" + shortErr(err)
	}
	if c.pfx == "ALL" {
		sec.Note = "当前账号无 DBA_* 视图权限，已降级为 ALL_* 视图（仅能看到本账号可见的对象）；segments 等章节可能缺失。授权参见 GRANTS.sql。"
	}
	c.put(sec)
	return nil
}

func ternary(b bool, x, y string) string {
	if b {
		return x
	}
	return y
}

func (c *collector) collectParams() {
	names := []string{"optimizer_mode", "optimizer_features_enable", "optimizer_index_cost_adj", "optimizer_index_caching",
		"optimizer_dynamic_sampling", "optimizer_adaptive_features", "optimizer_adaptive_plans", "optimizer_adaptive_statistics",
		"cursor_sharing", "db_file_multiblock_read_count", "db_block_size", "parallel_degree_policy", "parallel_force_local",
		"parallel_max_servers", "pga_aggregate_target", "workarea_size_policy", "statistics_level", "sga_target",
		"control_management_pack_access", "result_cache_mode", "star_transformation_enabled", "cell_offload_processing"}
	sec := c.runSec("optenv", "优化器与实例参数", "按取值合并实例；isdefault=FALSE 表示被显式修改过。",
		`SELECT name, value, isdefault, LISTAGG(inst_id, ',') WITHIN GROUP (ORDER BY inst_id) inst_ids
		   FROM gv$parameter WHERE name IN `+c.inList(names)+` GROUP BY name, value, isdefault ORDER BY name`,
		`SELECT name, value, isdefault, TO_CHAR(MIN(inst_id)) inst_ids FROM gv$parameter
		  WHERE name IN `+c.inList(names)+` GROUP BY name, value, isdefault ORDER BY name`)
	for _, m := range sec.Maps() {
		c.params[strings.ToLower(m["NAME"])] = m["VALUE"]
	}
	bs := num(c.params["db_block_size"])
	if bs == 0 {
		bs = 8192
	}
	c.s.Metrics.BlockSize = bs
	if v, ok := c.params["control_management_pack_access"]; ok {
		c.s.Meta.AWREnabled = strings.Contains(strings.ToUpper(v), "DIAGNOSTIC")
	} else {
		c.s.Meta.AWREnabled = true
	}
	if c.o.NoAWR {
		c.s.Meta.AWREnabled = false
	}
}

// ---------- 2. SQL 基本信息 ----------

func (c *collector) collectSQL() error {
	id := c.id
	con := ternary(c.major >= 12, "con_id,", "")
	patch := ternary(c.major >= 12, "sql_patch,", "")
	q := `SELECT * FROM (SELECT inst_id, ` + con + ` child_number, plan_hash_value, parsing_schema_name, module, action,
	       CASE command_type WHEN 3 THEN 'SELECT' WHEN 2 THEN 'INSERT' WHEN 6 THEN 'UPDATE' WHEN 7 THEN 'DELETE'
	            WHEN 189 THEN 'MERGE' WHEN 47 THEN 'PL/SQL' ELSE TO_CHAR(command_type) END sql_type,
	       executions, elapsed_time, cpu_time, user_io_wait_time, cluster_wait_time, application_wait_time,
	       concurrency_wait_time, buffer_gets, disk_reads, rows_processed, fetches, sorts, parse_calls,
	       is_bind_sensitive, is_bind_aware, first_load_time,
	       TO_CHAR(last_active_time,'YYYY-MM-DD HH24:MI:SS') last_active_time, sql_profile, sql_plan_baseline, ` + patch + `
	       REPLACE(SUBSTR(sql_text,1,100), CHR(10), ' ') sql_text_short
	  FROM gv$sql WHERE sql_id = '` + id + `' ORDER BY last_active_time DESC) WHERE ROWNUM <= 100`
	cols, rows, err := c.q(q)
	sec := Section{Key: "sqlinfo", Title: "SQL 基本信息（按实例 / 子游标）", Cols: cols, Rows: rows,
		Note: "GV$SQL 为共享池内累计值（自游标加载起），报告中的单次值 = 累计值 / 执行次数。"}
	if err != nil {
		return fmt.Errorf("读取 GV$SQL 失败: %w", err)
	}
	if len(rows) == 0 {
		return c.collectFromAWR()
	}
	c.put(sec)
	maps := sec.Maps()
	m := &c.s.Meta
	m.Module, m.SQLType, m.Parsing = maps[0]["MODULE"], maps[0]["SQL_TYPE"], maps[0]["PARSING_SCHEMA_NAME"]

	// 汇总指标：单独聚合，不受上面 100 行截断影响
	_, ag, err := c.q(`SELECT NVL(SUM(executions),0), NVL(SUM(elapsed_time),0), NVL(SUM(cpu_time),0), NVL(SUM(user_io_wait_time),0),
	       NVL(SUM(cluster_wait_time),0), NVL(SUM(application_wait_time),0), NVL(SUM(concurrency_wait_time),0),
	       NVL(SUM(buffer_gets),0), NVL(SUM(disk_reads),0), NVL(SUM(rows_processed),0), NVL(SUM(fetches),0),
	       COUNT(*), COUNT(DISTINCT plan_hash_value) FROM gv$sql WHERE sql_id = '` + id + `'`)
	if err == nil && len(ag) > 0 {
		a := ag[0]
		mt := &c.s.Metrics
		mt.Execs, mt.ElapsedUS, mt.CPUUS, mt.UserIOUS = num(a[0]), num(a[1]), num(a[2]), num(a[3])
		mt.ClusterUS, mt.ApplUS, mt.ConcUS = num(a[4]), num(a[5]), num(a[6])
		mt.LIO, mt.PIO, mt.RowsProc, mt.Fetches = num(a[7]), num(a[8]), num(a[9]), num(a[10])
		mt.Children, mt.PlanCount = int(num(a[11])), int(num(a[12]))
	}
	if c.s.Metrics.Execs == 0 { // 从未执行完（仍在执行首次）
		c.s.Metrics.Execs = 1
	}

	// 每个 PLAN_HASH_VALUE 取最近活跃子游标；优先本连接实例
	seen := map[string]bool{}
	for pass := 0; pass < 2; pass++ {
		for _, r := range maps {
			if pass == 0 && r["INST_ID"] != c.inst {
				continue
			}
			if seen[r["PLAN_HASH_VALUE"]] {
				continue
			}
			seen[r["PLAN_HASH_VALUE"]] = true
			c.picks = append(c.picks, pick{r["INST_ID"], r["CHILD_NUMBER"], r["PLAN_HASH_VALUE"]})
		}
	}
	if len(c.picks) > 5 {
		c.picks = c.picks[:5]
	}

	// 完整 SQL 文本（分片拼接，避免 CLOB 驱动兼容问题）
	_, tr, err := c.q(`SELECT sql_text FROM gv$sqltext_with_newlines WHERE sql_id = '` + id + `' AND inst_id = ` +
		c.picks[0].Inst + ` ORDER BY piece`)
	var sb strings.Builder
	if err == nil {
		for _, r := range tr {
			sb.WriteString(r[0])
		}
	}
	text := sb.String()
	if text == "" {
		text = c.one(`SELECT sql_text FROM gv$sql WHERE sql_id = '` + id + `' AND ROWNUM = 1`)
	}
	c.s.SQLText = text
	note := ""
	if strings.Contains(strings.ToUpper(text), "OPAQUE_TRANSFORM") {
		note = "说明：SQL 含 OPAQUE_TRANSFORM，说明由远端 dblink 网关生成，本端通常无法直接改写"
	}
	c.put(Section{Key: "sqltext", Title: "完整 SQL 文本", Kind: "text", Note: note, Cols: []string{"SQL"}, Rows: [][]string{{text}}})
	info := parseSQL(text)
	c.put(Section{Key: "sqlparse", Title: "SQL 结构解析（本地解析，仅作线索）", Cols: []string{"项目", "结果"}, Rows: sqlInfoRows(info),
		Note: "解析器为轻量实现，解析失败时诊断自动回退到执行计划对象信息。"})
	return nil
}

// ---------- 3. 执行计划 ----------

func (c *collector) pickCond(alias string) string {
	var parts []string
	for _, p := range c.picks {
		parts = append(parts, fmt.Sprintf("(%sinst_id = %s AND %schild_number = %s)", alias, p.Inst, alias, p.Child))
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

func (c *collector) collectPlans() {
	// DBMS_XPLAN：只能取到当前连接实例的游标
	var lines []string
	n := 0
	for _, p := range c.picks {
		if p.Inst != c.inst || n >= 2 {
			continue
		}
		n++
		_, rows, err := c.q(`SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('` + c.id + `', ` + p.Child +
			`, 'ALLSTATS LAST +PEEKED_BINDS +PREDICATE +ALIAS +PARTITION'))`)
		if err != nil {
			lines = append(lines, "采集失败: "+shortErr(err))
			continue
		}
		for _, r := range rows {
			lines = append(lines, r[0])
		}
		lines = append(lines, "")
	}
	note := "说明：RAC 下 DISPLAY_CURSOR 仅返回当前连接实例的游标；A-Rows 需 GATHER_PLAN_STATISTICS / STATISTICS_LEVEL=ALL"
	if n == 0 {
		lines = []string{"该 SQL 的游标不在当前连接的实例上，DBMS_XPLAN 无法取到；请看下面基于 GV$SQL_PLAN 的跨实例明细，或直连对应实例。"}
	}
	rows := make([][]string, 0, len(lines))
	for _, l := range lines {
		rows = append(rows, []string{l})
	}
	c.put(Section{Key: "xplan", Title: "执行计划（DBMS_XPLAN）", Kind: "text", Note: note, Cols: []string{"PLAN"}, Rows: rows})

	con := ternary(c.major >= 12, "p.con_id,", "")
	c.runSec("planops", "计划操作明细（跨实例 / 含谓词）", "",
		`SELECT p.inst_id, `+con+` p.child_number, p.plan_hash_value, p.id, p.parent_id, p.operation, p.options, p.object_owner,
		        p.object_name, p.object_type, p.cardinality e_rows, p.bytes, p.cost, p.cpu_cost, p.io_cost, p.temp_space,
		        p.partition_start, p.partition_stop, p.access_predicates, p.filter_predicates, p.qblock_name, p.depth
		   FROM gv$sql_plan p WHERE p.sql_id = '`+c.id+`' AND `+c.pickCond("p.")+` ORDER BY p.inst_id, p.child_number, p.id`)
	c.runSec("plantats", "E-Rows / A-Rows 运行时统计", "A-Rows 取自 GV$SQL_PLAN_STATISTICS_ALL（需 GATHER_PLAN_STATISTICS 或 STATISTICS_LEVEL=ALL）；缺失时报告不会用 E-Rows 冒充实测。",
		`SELECT p.inst_id, p.child_number, p.id, p.operation, p.options, p.object_name, p.cardinality e_rows,
		        p.last_output_rows a_rows, p.last_cr_buffer_gets, p.last_disk_reads, p.last_elapsed_time, p.last_starts
		   FROM gv$sql_plan_statistics_all p WHERE p.sql_id = '`+c.id+`' AND `+c.pickCond("p.")+`
		    AND p.last_output_rows IS NOT NULL ORDER BY p.inst_id, p.child_number, p.id`)
}

// ---------- 4. 绑定变量 / 漂移 / 等待 / 历史 ----------

var strType = regexp.MustCompile(`(?i)^(N?VARCHAR|N?CHAR|CLOB|NCLOB|RAW|LONG)`)

func maskVal(dt, v string) string {
	if v == "" || !strType.MatchString(dt) {
		return v
	}
	r := []rune(v)
	if len(r) <= 1 {
		return "*"
	}
	return fmt.Sprintf("%s***(len=%d)", string(r[:1]), len(r))
}

func (c *collector) collectRuntime() {
	if !c.awr {
		sec := c.runSec("binds", "绑定变量（共享池采样）", "V$SQL_BIND_CAPTURE 只是采样值，不代表每次执行的真实绑定值。"+ternary(c.o.MaskBinds, "字符串型取值已脱敏（--no-mask-binds 可关闭）。", ""),
			`SELECT * FROM (SELECT inst_id, child_number, name, position, datatype_string, value_string, was_captured,
		        TO_CHAR(last_captured,'YYYY-MM-DD HH24:MI:SS') last_captured
		   FROM gv$sql_bind_capture WHERE sql_id = '`+c.id+`' AND `+c.pickCond("")+` ORDER BY inst_id, child_number, position) WHERE ROWNUM <= 200`)
		c.maskBinds(sec)
		if false {
			dt, vi := -1, -1
			for i, n := range sec.Cols {
				if n == "DATATYPE_STRING" {
					dt = i
				}
				if n == "VALUE_STRING" {
					vi = i
				}
			}
			if dt >= 0 && vi >= 0 {
				for _, r := range sec.Rows {
					r[vi] = maskVal(r[dt], r[vi])
				}
			}
		}
		c.runSec("drift", "执行计划漂移", "",
			`SELECT inst_id, plan_hash_value, COUNT(*) child_count, SUM(executions) executions,
		        ROUND(SUM(elapsed_time)/1e6, 2) elapsed_sec, ROUND(SUM(buffer_gets)/NULLIF(SUM(executions),0)) avg_buffer_gets,
		        MIN(first_load_time) first_load, TO_CHAR(MAX(last_active_time),'YYYY-MM-DD HH24:MI:SS') last_active
		   FROM gv$sql WHERE sql_id = '`+c.id+`' GROUP BY inst_id, plan_hash_value ORDER BY inst_id, plan_hash_value`)

	}
	c.collectAWR()
}

// ---------- 5. 涉及对象 ----------

func (c *collector) collectObjects() {
	var plan *Section
	for i := range c.s.Sections {
		if c.s.Sections[i].Key == "planops" {
			plan = &c.s.Sections[i]
		}
	}
	type oref struct{ owner, name, typ string }
	var objs []oref
	seen := map[string]bool{}
	var rows [][]string
	var idxs []oref
	for _, m := range plan.Maps() {
		n := m["OBJECT_NAME"]
		if n == "" {
			continue
		}
		k := m["OBJECT_OWNER"] + "." + n
		if seen[k] {
			continue
		}
		seen[k] = true
		o := oref{strings.ToUpper(m["OBJECT_OWNER"]), strings.ToUpper(n), strings.ToUpper(m["OBJECT_TYPE"])}
		objs = append(objs, o)
		rows = append(rows, []string{m["OBJECT_OWNER"], n, m["OBJECT_TYPE"]})
		if strings.HasPrefix(o.typ, "INDEX") {
			idxs = append(idxs, o)
		}
	}
	addTab := func(owner, name string) {
		if owner == "" || name == "" || !identRe.MatchString(owner) || !identRe.MatchString(name) {
			return
		}
		k := owner + "." + name
		if !c.tabSet[k] && len(c.tables) < 12 {
			c.tabSet[k] = true
			c.tables = append(c.tables, TabRef{Owner: owner, Name: name})
		}
	}
	for _, o := range objs {
		if strings.HasPrefix(o.typ, "TABLE") {
			addTab(o.owner, o.name)
		}
	}
	if len(idxs) > 0 {
		var conds []string
		for _, i := range idxs {
			ow, e1 := lit(i.owner)
			nm, e2 := lit(i.name)
			if e1 == nil && e2 == nil {
				conds = append(conds, fmt.Sprintf("(owner=%s AND index_name=%s)", ow, nm))
			}
		}
		if len(conds) > 0 {
			_, r, err := c.q(`SELECT table_owner, table_name FROM %CAT%_INDEXES WHERE ` + strings.Join(conds, " OR "))
			if err == nil {
				for _, x := range r {
					addTab(strings.ToUpper(x[0]), strings.ToUpper(x[1]))
				}
			}
		}
	}
	// 回退：计划已老化时，用 SQL 文本解析出的表名 + 解析用户补齐
	note := ""
	if len(c.tables) == 0 {
		info := parseSQL(c.s.SQLText)
		for _, t := range info.Tables {
			ow := t.Owner
			if ow == "" {
				ow = strings.ToUpper(c.s.Meta.Parsing)
			}
			addTab(ow, t.Name)
			rows = append(rows, []string{ow, t.Name, "TABLE（由 SQL 文本解析）"})
		}
		note = "未能从执行计划取得对象，已回退为 SQL 文本解析（表属主按解析用户推断，可能不准）。"
	}
	if len(c.tables) >= 12 {
		note += " 涉及表超过 12 张，仅分析前 12 张。"
	}
	c.put(Section{Key: "objects", Title: "SQL 涉及对象", Note: strings.TrimSpace(note), Cols: []string{"OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE"}, Rows: rows})
}

// ---------- 6. 数据字典：表 / 索引 / 列 / 统计 / 分区 ----------

func (c *collector) collectCatalog() {
	if len(c.tables) == 0 {
		return
	}
	tp := c.tabPred("t.owner", "t.table_name")
	ts := c.runSec("tabstats", "表级统计信息", "STALE_STATS=YES 表示 DML 变化超过阈值（默认 10%），统计信息已过期。",
		`SELECT t.owner, t.table_name, t.num_rows, t.blocks, t.avg_row_len, t.sample_size,
		        TO_CHAR(t.last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed, t.partitioned, t.temporary, TRIM(t.degree) degree,
		        s.stale_stats
		   FROM %CAT%_TABLES t LEFT JOIN %CAT%_TAB_STATISTICS s ON s.owner = t.owner AND s.table_name = t.table_name
		        AND s.object_type = 'TABLE' WHERE `+tp+` ORDER BY t.owner, t.table_name`)
	for _, m := range ts.Maps() {
		k := m["OWNER"] + "." + m["TABLE_NAME"]
		c.numRows[k] = num(m["NUM_ROWS"])
		if strings.EqualFold(m["PARTITIONED"], "YES") {
			c.partTab[k] = true
		}
	}

	ip := c.tabPred("i.table_owner", "i.table_name")
	ix := c.runSec("indexes", "索引基本信息", "LOCALITY=GLOBAL 且表为分区表时，分区维护需 UPDATE GLOBAL INDEXES，跨实例回表也更重。",
		`SELECT i.owner, i.index_name, i.table_name, i.index_type, i.uniqueness, i.status, i.partitioned,
		        CASE WHEN i.partitioned = 'YES' THEN p.locality ELSE 'NONPART' END locality, i.distinct_keys, i.leaf_blocks,
		        i.clustering_factor, i.num_rows, i.blevel, TO_CHAR(i.last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed, i.visibility
		   FROM %CAT%_INDEXES i LEFT JOIN %CAT%_PART_INDEXES p ON p.owner = i.owner AND p.index_name = i.index_name
		  WHERE `+ip+` ORDER BY i.table_name, i.index_name`,
		`SELECT i.owner, i.index_name, i.table_name, i.index_type, i.uniqueness, i.status, i.partitioned,
		        CASE WHEN i.partitioned = 'YES' THEN 'LOCAL?' ELSE 'NONPART' END locality, i.distinct_keys, i.leaf_blocks,
		        i.clustering_factor, i.num_rows, i.blevel, TO_CHAR(i.last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed
		   FROM %CAT%_INDEXES i WHERE `+ip+` ORDER BY i.table_name, i.index_name`)
	for _, r := range ix.Rows {
		for i, n := range ix.Cols {
			if n == "LOCALITY" && r[i] == "NONPART" {
				tn := ""
				for j, cn := range ix.Cols {
					if cn == "TABLE_NAME" {
						tn = r[j]
					}
				}
				for k := range c.partTab {
					if strings.HasSuffix(k, "."+tn) {
						r[i] = "GLOBAL"
					}
				}
				if r[i] == "NONPART" {
					r[i] = "-"
				}
			}
		}
	}
	icp := c.tabPred("table_owner", "table_name")
	ic := c.runSec("indcols", "索引列顺序", "",
		`SELECT index_owner, index_name, table_name, column_position, column_name, descend
		   FROM %CAT%_IND_COLUMNS WHERE `+icp+` ORDER BY table_name, index_name, column_position`)
	for _, m := range ic.Maps() {
		c.keyCols[strings.ToUpper(m["COLUMN_NAME"])] = true
	}
	c.runSec("indexpr", "函数索引表达式", "函数索引要求谓词表达式与索引表达式文本完全一致才可能命中。",
		`SELECT index_owner, index_name, table_name, column_position, column_expression
		   FROM %CAT%_IND_EXPRESSIONS WHERE `+icp+` ORDER BY index_name, column_position`)

	pk := c.runSec("partkeys", "分区键与分区类型", "",
		`SELECT k.owner, k.name, k.object_type, k.column_name, k.column_position, pt.partitioning_type, pt.subpartitioning_type
		   FROM %CAT%_PART_KEY_COLUMNS k JOIN %CAT%_PART_TABLES pt ON pt.owner = k.owner AND pt.table_name = k.name
		  WHERE k.object_type = 'TABLE' AND `+c.tabPred("k.owner", "k.name")+` ORDER BY k.name, k.column_position`)
	for _, m := range pk.Maps() {
		c.keyCols[strings.ToUpper(m["COLUMN_NAME"])] = true
	}
	pp := c.tabPred("table_owner", "table_name")
	c.runSec("partitions", "分区与子分区", "最多列出每次查询前 200 个分区。",
		`SELECT * FROM (SELECT table_owner, table_name, partition_name, partition_position, high_value, num_rows, blocks,
		        TO_CHAR(last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed
		   FROM %CAT%_TAB_PARTITIONS WHERE `+pp+` ORDER BY table_name, partition_position) WHERE ROWNUM <= 200`,
		`SELECT * FROM (SELECT table_owner, table_name, partition_name, partition_position, num_rows, blocks,
		        TO_CHAR(last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed
		   FROM %CAT%_TAB_PARTITIONS WHERE `+pp+` ORDER BY table_name, partition_position) WHERE ROWNUM <= 200`)

	// 关键字段：SQL / 计划谓词里出现过的字段 ∪ 索引列 ∪ 分区键
	var predText strings.Builder
	predText.WriteString(c.s.SQLText)
	for i := range c.s.Sections {
		if c.s.Sections[i].Key == "planops" {
			for _, m := range c.s.Sections[i].Maps() {
				predText.WriteString(" " + m["ACCESS_PREDICATES"] + " " + m["FILTER_PREDICATES"])
			}
		}
	}
	toks := identTokens(predText.String())
	cp := c.tabPred("c.owner", "c.table_name")
	note := "仅列出 SQL 谓词 / 投影、索引、分区键涉及的字段。"
	colQ := `SELECT c.owner, c.table_name, c.column_id, c.column_name, c.data_type, c.data_length, c.data_precision,
	        c.data_scale, c.nullable%s FROM %%CAT%%_TAB_COLUMNS c WHERE ` + cp + ` ORDER BY c.owner, c.table_name, c.column_id`
	ccols, crows, cerr := c.q(fmt.Sprintf(colQ, ", c.data_default"))
	if cerr != nil {
		ccols, crows, cerr = c.q(fmt.Sprintf(colQ, ""))
		note += " [DATA_DEFAULT（LONG 类型）不可用，已降级]"
	}
	if cerr != nil {
		c.s.Errors = append(c.s.Errors, "表字段结构: "+shortErr(cerr))
		c.put(Section{Key: "columns", Title: "表字段结构", Err: "采集失败：" + shortErr(cerr)})
	} else {
		c.filterColumns(ccols, crows, toks, note)
	}

	// 列统计 / 直方图
	var kc []string
	for k := range c.keyCols {
		kc = append(kc, k)
	}
	sort.Strings(kc)
	if len(kc) > 150 {
		kc = kc[:150]
	}
	cs := c.runSec("colstats", "列统计 / NDV / 直方图", "AVG_SEL_PCT = 100/NDV（均匀分布下的等值选择率）；NULL_PCT 基于表 NUM_ROWS。",
		`SELECT cs.owner, cs.table_name, cs.column_name, cs.num_distinct ndv, cs.num_nulls, cs.density, cs.histogram,
		        cs.num_buckets, cs.avg_col_len, TO_CHAR(cs.last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed
		   FROM %CAT%_TAB_COL_STATISTICS cs WHERE `+c.tabPred("cs.owner", "cs.table_name")+` AND cs.column_name IN `+c.inList(kc)+`
		  ORDER BY cs.owner, cs.table_name, cs.column_name`)
	if len(cs.Cols) > 0 {
		cs.Cols = append(cs.Cols, "AVG_SEL_PCT", "NULL_PCT")
		oi, ti, nn := idx(cs.Cols, "OWNER"), idx(cs.Cols, "TABLE_NAME"), idx(cs.Cols, "NUM_NULLS")
		ndvI := idx(cs.Cols, "NDV")
		for ri, r := range cs.Rows {
			ndv := num(r[ndvI])
			sel, np := "", ""
			if ndv > 0 {
				sel = fmtTwo(100 / ndv)
			}
			if nr := c.numRows[r[oi]+"."+r[ti]]; nr > 0 {
				np = fmtTwo(num(r[nn]) / nr * 100)
			}
			cs.Rows[ri] = append(r, sel, np)
		}
	}
	var hcols []string
	for _, m := range cs.Maps() {
		if h := strings.ToUpper(m["HISTOGRAM"]); h != "" && h != "NONE" {
			hcols = append(hcols, m["COLUMN_NAME"])
		}
	}
	c.collectHistograms(uniq(hcols))

	c.runSec("constraints", "主键 / 唯一 / 外键约束", "",
		`SELECT owner, table_name, constraint_name, constraint_type, status, index_name, r_constraint_name
		   FROM %CAT%_CONSTRAINTS WHERE constraint_type IN ('P','U','R') AND `+c.tabPred("owner", "table_name")+` ORDER BY table_name, constraint_type`)
	if c.pfx == "DBA" {
		var names []string
		for _, t := range c.tables {
			names = append(names, t.Name)
		}
		for _, m := range ix.Maps() {
			names = append(names, m["INDEX_NAME"])
		}
		c.runSec("segments", "段空间占用", "",
			`SELECT owner, segment_name, segment_type, ROUND(SUM(bytes)/1048576,2) size_mb, COUNT(*) segments
			   FROM dba_segments WHERE segment_name IN `+c.inList(names)+` AND owner IN `+c.inList(ownersOf(c.tables))+`
			  GROUP BY owner, segment_name, segment_type ORDER BY size_mb DESC`)
	} else {
		c.put(Section{Key: "segments", Title: "段空间占用", Note: "需要 DBA_SEGMENTS 权限，当前已跳过。"})
	}
	c.runSec("extstats", "扩展统计 / 列组", "列组 / 表达式统计可修复相关列的基数估算偏差。",
		`SELECT owner, table_name, extension_name, creator, droppable, DBMS_LOB.SUBSTR(extension, 500, 1) extension
		   FROM %CAT%_STAT_EXTENSIONS WHERE `+c.tabPred("owner", "table_name")+` ORDER BY table_name`)
}

func ownersOf(ts []TabRef) []string {
	var o []string
	for _, t := range ts {
		o = append(o, t.Owner)
	}
	return uniq(o)
}

func idx(cols []string, name string) int {
	for i, c := range cols {
		if c == name {
			return i
		}
	}
	return -1
}

func (c *collector) filterColumns(cols []string, rows [][]string, toks map[string]bool, note string) {
	ci := idx(cols, "COLUMN_NAME")
	var out [][]string
	for _, r := range rows {
		n := strings.ToUpper(r[ci])
		if toks[n] || c.keyCols[n] {
			out = append(out, r)
			c.keyCols[n] = true
		}
	}
	c.put(Section{Key: "columns", Title: "表字段结构", Note: note, Cols: cols, Rows: out})
}

func (c *collector) collectHistograms(hcols []string) {
	sec := Section{Key: "histo", Title: "直方图桶与热点值推算", Note: "BUCKET_PCT 由 ENDPOINT_NUMBER 差值推算，是统计信息口径的占比，不等于精确值频率；每列仅列出占比最高的 10 个桶。"}
	if len(hcols) == 0 {
		sec.Note += " 当前关键字段均无直方图。"
		c.put(sec)
		return
	}
	cols, rows, err := c.q(`SELECT h.owner, h.table_name, h.column_name, h.endpoint_number, h.endpoint_value, h.endpoint_actual_value
	   FROM %CAT%_TAB_HISTOGRAMS h WHERE ` + c.tabPred("h.owner", "h.table_name") + ` AND h.column_name IN ` + c.inList(hcols) +
		` ORDER BY h.owner, h.table_name, h.column_name, h.endpoint_number`)
	if err != nil {
		sec.Err = "采集失败：" + shortErr(err)
		c.s.Errors = append(c.s.Errors, sec.Title+": "+shortErr(err))
		c.put(sec)
		return
	}
	_ = cols
	type key struct{ o, t, c string }
	groups := map[key][][]string{}
	var order []key
	for _, r := range rows {
		k := key{r[0], r[1], r[2]}
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], r)
	}
	sec.Cols = []string{"OWNER", "TABLE_NAME", "COLUMN_NAME", "ENDPOINT_NUMBER", "ENDPOINT_VALUE", "BUCKET_PCT"}
	for _, k := range order {
		g := groups[k]
		total := num(g[len(g)-1][3])
		type b struct {
			row []string
			p   float64
		}
		var bs []b
		prev := 0.0
		for _, r := range g {
			n := num(r[3])
			v := r[5]
			if v == "" {
				v = r[4]
			}
			bs = append(bs, b{[]string{r[0], r[1], r[2], r[3], v, fmtTwo(pct(n-prev, total))}, pct(n-prev, total)})
			prev = n
		}
		sort.SliceStable(bs, func(i, j int) bool { return bs[i].p > bs[j].p })
		for i, x := range bs {
			if i >= 10 {
				break
			}
			sec.Rows = append(sec.Rows, x.row)
		}
	}
	c.put(sec)
}

// ---------- 7. SQL 管理对象 / 会话 / 工作区 ----------

func (c *collector) collectMisc() {
	sig := `(SELECT exact_matching_signature FROM gv$sql WHERE sql_id = '` + c.id + `')`
	fsig := `(SELECT force_matching_signature FROM gv$sql WHERE sql_id = '` + c.id + `')`
	sec := Section{Key: "sqlmgmt", Title: "SQL Profile / Baseline / Patch / Directive", Cols: []string{"TYPE", "NAME", "STATUS", "DETAIL", "CREATED"}}
	run := func(label, q string) {
		_, rows, err := c.q(q)
		if err != nil {
			c.s.Errors = append(c.s.Errors, label+": "+shortErr(err))
			sec.Note += label + " 采集失败(" + shortErr(err) + ")；"
			return
		}
		sec.Rows = append(sec.Rows, rows...)
	}
	run("SQL Profile", `SELECT 'PROFILE', name, status, 'category='||category||' force_matching='||force_matching,
	      TO_CHAR(created,'YYYY-MM-DD HH24:MI') FROM dba_sql_profiles WHERE signature IN `+sig+` OR signature IN `+fsig)
	run("SQL Plan Baseline", `SELECT 'BASELINE', plan_name, CASE WHEN enabled='YES' AND accepted='YES' THEN 'ACTIVE' ELSE 'INACTIVE' END,
	      'handle='||sql_handle||' fixed='||fixed||' origin='||origin, TO_CHAR(created,'YYYY-MM-DD HH24:MI')
	      FROM dba_sql_plan_baselines WHERE signature IN `+sig)
	if c.major >= 12 {
		run("SQL Patch", `SELECT 'PATCH', name, status, 'category='||category, TO_CHAR(created,'YYYY-MM-DD HH24:MI')
		      FROM dba_sql_patches WHERE signature IN `+sig)
		if len(c.tables) > 0 {
			run("SQL Directive", `SELECT DISTINCT 'DIRECTIVE', TO_CHAR(d.directive_id), d.state,
			      d.type||' '||d.reason||' on '||o.object_name||NVL2(o.subobject_name,'.'||o.subobject_name,''),
			      TO_CHAR(d.created,'YYYY-MM-DD HH24:MI')
			      FROM dba_sql_plan_directives d JOIN dba_sql_plan_dir_objects o ON o.directive_id = d.directive_id
			     WHERE `+c.tabPred("o.owner", "o.object_name"))
		}
	}
	if len(sec.Rows) == 0 && sec.Note == "" {
		sec.Note = "无"
	}
	c.put(sec)

	c.runSec("sessions", "当前相关会话与阻塞", "",
		`SELECT s.inst_id, s.sid, s.serial# serial_no, s.username, s.status, s.event, s.blocking_instance, s.blocking_session,
		        s.sql_id, s.last_call_et FROM gv$session s WHERE s.sql_id = '`+c.id+`' AND ROWNUM <= 50 ORDER BY s.inst_id, s.sid`)
	c.runSec("workarea", "工作区（排序 / 哈希）与 TEMP 使用", "GV$SQL_WORKAREA；ONEPASS / MULTIPASS 次数 > 0 或 TEMPSEG > 0 表示发生了 TEMP 溢出。",
		`SELECT * FROM (SELECT inst_id, child_number, operation_id, operation_type, policy,
		        ROUND(estimated_optimal_size/1048576,2) est_optimal_mb, ROUND(last_memory_used/1048576,2) last_mem_mb,
		        last_execution, total_executions, optimal_executions, onepass_executions, multipasses_executions,
		        ROUND(last_tempseg_size/1048576,2) last_temp_mb, ROUND(max_tempseg_size/1048576,2) max_temp_mb
		   FROM gv$sql_workarea WHERE sql_id = '`+c.id+`' ORDER BY inst_id, child_number, operation_id) WHERE ROWNUM <= 100`)
}

// ---------- 8. 显式开启的值频率采样 ----------

var sensitiveCol = regexp.MustCompile(`(?i)(PASS|PWD|SECRET|TOKEN|ID_?CARD|IDNO|CERT|PHONE|MOBILE|TEL|EMAIL|MAIL|ADDR|BANK|CARD_?NO|ACCOUNT_?NO)`)

func (c *collector) collectSample() {
	sec := Section{Key: "sample", Title: "字段值频率采样（显式启用）", Cols: []string{"TABLE_NAME", "COLUMN_NAME", "VALUE", "CNT", "PCT"},
		Note: fmt.Sprintf("SAMPLE BLOCK(%g) 块采样，结果存在偏差；疑似敏感字段的取值已脱敏。该章节会读表，请在低峰执行。", c.o.SamplePct)}
	parts := strings.SplitN(c.o.SampleTab, ".", 2)
	if len(parts) != 2 || !identRe.MatchString(parts[0]) || !identRe.MatchString(parts[1]) {
		sec.Err = "--sample-table 需为 OWNER.TABLE 且仅含字母数字下划线"
		c.put(sec)
		return
	}
	if c.o.SamplePct <= 0 || c.o.SamplePct > 20 {
		sec.Err = "--sample-pct 必须在 (0,20] 之间，防止对大表做近全表扫描"
		c.put(sec)
		return
	}
	for _, col := range strings.Split(c.o.SampleCols, ",") {
		col = strings.TrimSpace(col)
		if !identRe.MatchString(col) {
			sec.Note += " 跳过非法列名 " + col
			continue
		}
		q := fmt.Sprintf(`SELECT * FROM (SELECT TO_CHAR(%s) v, COUNT(*) cnt, ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 2) pct
		   FROM %s.%s SAMPLE BLOCK (%g) GROUP BY %s ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 10`,
			dq(strings.ToUpper(col)), dq(strings.ToUpper(parts[0])), dq(strings.ToUpper(parts[1])), c.o.SamplePct, dq(strings.ToUpper(col)))
		_, rows, err := c.q(q)
		if err != nil {
			c.s.Errors = append(c.s.Errors, "采样 "+col+": "+shortErr(err))
			sec.Note += " 列 " + col + " 采样失败: " + shortErr(err)
			continue
		}
		for _, r := range rows {
			v := r[0]
			if sensitiveCol.MatchString(col) {
				v = maskVal("VARCHAR2", v)
			}
			sec.Rows = append(sec.Rows, []string{strings.ToUpper(parts[1]), strings.ToUpper(col), v, r[1], r[2]})
		}
	}
	c.put(sec)
}

// ---------- 章节顺序 ----------

var sectionOrder = []string{"env", "sqlinfo", "sqltext", "sqlparse", "xplan", "planops", "plantats", "binds", "drift",
	"ash", "ashhist", "ashline", "ashobj", "ashtime", "awrtrend", "awrplansum", "awrplan", "awrxplan", "objects", "tabstats", "columns", "colstats", "histo", "indexes", "indcols", "indexpr",
	"partkeys", "partitions", "constraints", "segments", "extstats", "sqlmgmt", "sessions", "workarea", "optenv", "sample"}

func sortSections(s *Snapshot) {
	pos := map[string]int{}
	for i, k := range sectionOrder {
		pos[k] = i
	}
	sort.SliceStable(s.Sections, func(i, j int) bool {
		a, ok1 := pos[s.Sections[i].Key]
		b, ok2 := pos[s.Sections[j].Key]
		if !ok1 {
			a = 999
		}
		if !ok2 {
			b = 999
		}
		return a < b
	})
}

func (c *collector) maskBinds(sec *Section) {
	if !c.o.MaskBinds || len(sec.Cols) == 0 {
		return
	}
	dt, vi := idx(sec.Cols, "DATATYPE_STRING"), idx(sec.Cols, "VALUE_STRING")
	if dt < 0 || vi < 0 {
		return
	}
	for _, r := range sec.Rows {
		r[vi] = maskVal(r[dt], r[vi])
	}
}

// ---------- 共享池没有时：从 AWR 还原 ----------

func (c *collector) collectFromAWR() error {
	id, m := c.id, &c.s.Meta
	notFound := func(extra string) error {
		return fmt.Errorf("共享池（GV$SQL）%s中都没有 SQL_ID=%s。\n当前连接：库 %s / 容器 %s(CON_ID=%s) / 连接实例 %s / 实例数 %d。\n%s请逐项确认：① SQL_ID 是否抄对；② 是否连在 SQL 实际运行的 PDB / 服务（可加 --pdb，或直连 PDB 服务名）；"+
			"③ 该 SQL 是否已被老化且未进 AWR（AWR 只保留 Top SQL）；④ 用 SQL*Plus 执行：SELECT inst_id, con_id, sql_id FROM gv$sqlarea WHERE sql_id='%s'; 核对。",
			ternary(m.AWREnabled, "和 AWR ", ""), id, m.DBName, m.Container, blankTo(m.ConID, "?"), c.inst, m.Instances, extra, id)
	}
	if !m.AWREnabled {
		return notFound("（AWR 已关闭：--no-awr 或 Diagnostics Pack 未授权，故没有查 AWR）\n")
	}
	if n := c.one(`SELECT COUNT(*) FROM dba_hist_sqltext WHERE sql_id = '` + id + `'`); n == "" || n == "0" {
		return notFound("")
	}
	c.awr = true
	m.Mode = "online-awr"

	// 汇总指标（快照差值求和 = AWR 保留期内的累计）
	_, ag, err := c.q(`SELECT NVL(SUM(s.executions_delta),0), NVL(SUM(s.elapsed_time_delta),0), NVL(SUM(s.cpu_time_delta),0), NVL(SUM(s.iowait_delta),0),
	       NVL(SUM(s.clwait_delta),0), NVL(SUM(s.apwait_delta),0), NVL(SUM(s.ccwait_delta),0), NVL(SUM(s.buffer_gets_delta),0),
	       NVL(SUM(s.disk_reads_delta),0), NVL(SUM(s.rows_processed_delta),0), NVL(SUM(s.fetches_delta),0),
	       COUNT(DISTINCT s.plan_hash_value), COUNT(*) FROM dba_hist_sqlstat s JOIN dba_hist_snapshot sn ON sn.snap_id = s.snap_id AND sn.dbid = s.dbid AND sn.instance_number = s.instance_number WHERE s.sql_id = '` + id + `'` + c.winSnap())
	if err == nil && len(ag) > 0 {
		a, mt := ag[0], &c.s.Metrics
		mt.Execs, mt.ElapsedUS, mt.CPUUS, mt.UserIOUS = num(a[0]), num(a[1]), num(a[2]), num(a[3])
		mt.ClusterUS, mt.ApplUS, mt.ConcUS = num(a[4]), num(a[5]), num(a[6])
		mt.LIO, mt.PIO, mt.RowsProc, mt.Fetches = num(a[7]), num(a[8]), num(a[9]), num(a[10])
		mt.PlanCount, mt.Children = int(num(a[11])), int(num(a[12]))
	}
	if c.s.Metrics.Execs == 0 {
		c.s.Metrics.Execs = 1
	}
	_, r, _ := c.q(`SELECT module, parsing_schema_name FROM (SELECT module, parsing_schema_name FROM dba_hist_sqlstat WHERE sql_id = '` + id + `' ORDER BY snap_id DESC) WHERE ROWNUM = 1`)
	if len(r) > 0 {
		m.Module, m.Parsing = r[0][0], r[0][1]
	}
	switch c.one(`SELECT command_type FROM dba_hist_sqltext WHERE sql_id = '` + id + `' AND ROWNUM = 1`) {
	case "3":
		m.SQLType = "SELECT"
	case "2":
		m.SQLType = "INSERT"
	case "6":
		m.SQLType = "UPDATE"
	case "7":
		m.SQLType = "DELETE"
	case "189":
		m.SQLType = "MERGE"
	}

	c.runSec("sqlinfo", "SQL 基本信息（AWR 按计划汇总）",
		"共享池中已无该游标，指标与计划均由 AWR（DBA_HIST_*）还原（窗口见 --awr-days，默认近 2 天）：数值为快照差值在窗口内的求和，只含被 AWR 采到的执行；没有子游标 / 绑定感知信息。",
		`SELECT s.plan_hash_value, COUNT(*) snapshots, SUM(s.executions_delta) executions, SUM(s.elapsed_time_delta) elapsed_time,
		        SUM(s.cpu_time_delta) cpu_time, SUM(s.iowait_delta) user_io_wait_time, SUM(s.clwait_delta) cluster_wait_time,
		        SUM(s.buffer_gets_delta) buffer_gets, SUM(s.disk_reads_delta) disk_reads, SUM(s.rows_processed_delta) rows_processed,
		        TO_CHAR(MIN(sn.begin_interval_time),'YYYY-MM-DD HH24:MI') first_snap, TO_CHAR(MAX(sn.end_interval_time),'YYYY-MM-DD HH24:MI') last_snap
		   FROM dba_hist_sqlstat s JOIN dba_hist_snapshot sn ON sn.snap_id = s.snap_id AND sn.dbid = s.dbid AND sn.instance_number = s.instance_number
		  WHERE s.sql_id = '`+id+`'`+c.winSnap()+` GROUP BY s.plan_hash_value ORDER BY MAX(sn.end_interval_time) DESC`)
	c.runSec("drift", "执行计划漂移（AWR）", "",
		`SELECT s.plan_hash_value, COUNT(*) child_count, SUM(s.executions_delta) executions, ROUND(SUM(s.elapsed_time_delta)/1e6,2) elapsed_sec,
		        ROUND(SUM(s.buffer_gets_delta)/NULLIF(SUM(s.executions_delta),0)) avg_buffer_gets,
		        TO_CHAR(MIN(sn.begin_interval_time),'YYYY-MM-DD HH24:MI') first_load, TO_CHAR(MAX(sn.end_interval_time),'YYYY-MM-DD HH24:MI') last_active
		   FROM dba_hist_sqlstat s JOIN dba_hist_snapshot sn ON sn.snap_id = s.snap_id AND sn.dbid = s.dbid AND sn.instance_number = s.instance_number
		  WHERE s.sql_id = '`+id+`'`+c.winSnap()+` GROUP BY s.plan_hash_value ORDER BY MAX(sn.end_interval_time)`)

	// SQL 文本：CLOB 按 4000 字符分段读取
	var sb strings.Builder
	for k := 0; k < 10; k++ {
		piece := c.one(fmt.Sprintf(`SELECT DBMS_LOB.SUBSTR(sql_text, 4000, %d) FROM dba_hist_sqltext WHERE sql_id = '%s' AND ROWNUM = 1`, 1+4000*k, id))
		sb.WriteString(piece)
		if len([]rune(piece)) < 4000 {
			break
		}
	}
	c.s.SQLText = sb.String()
	note := "SQL 文本取自 DBA_HIST_SQLTEXT。"
	if strings.Contains(strings.ToUpper(c.s.SQLText), "OPAQUE_TRANSFORM") {
		note += " SQL 含 OPAQUE_TRANSFORM，说明由远端 dblink 网关生成，本端通常无法直接改写。"
	}
	c.put(Section{Key: "sqltext", Title: "完整 SQL 文本", Kind: "text", Note: note, Cols: []string{"SQL"}, Rows: [][]string{{c.s.SQLText}}})
	c.put(Section{Key: "sqlparse", Title: "SQL 结构解析（本地解析，仅作线索）", Cols: []string{"项目", "结果"}, Rows: sqlInfoRows(parseSQL(c.s.SQLText)),
		Note: "解析器为轻量实现，解析失败时诊断自动回退到执行计划对象信息。"})

	// 最近一次出现的计划
	phv := c.one(`SELECT plan_hash_value FROM (SELECT plan_hash_value FROM dba_hist_sqlstat WHERE sql_id = '` + id + `' ORDER BY snap_id DESC) WHERE ROWNUM = 1`)
	if !hasNum(phv) {
		phv = "0"
	}
	var lines []string
	_, xr, xe := c.q(`SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('` + id + `', ` + phv + `, NULL, 'ALL'))`)
	if xe != nil {
		lines = []string{"DISPLAY_AWR 采集失败: " + shortErr(xe)}
	}
	for _, x := range xr {
		lines = append(lines, x[0])
	}
	var xrows [][]string
	for _, l := range lines {
		xrows = append(xrows, []string{l})
	}
	c.put(Section{Key: "xplan", Title: "执行计划（DBMS_XPLAN.DISPLAY_AWR）", Kind: "text", Cols: []string{"PLAN"}, Rows: xrows,
		Note: "来自 AWR 的最近一次计划（PLAN_HASH_VALUE=" + phv + "）；AWR 计划不含 A-Rows。"})
	c.runSec("planops", "计划操作明细（AWR）", "",
		`SELECT p.plan_hash_value, p.id, p.parent_id, p.operation, p.options, p.object_owner, p.object_name, p.object_type, p.cardinality e_rows,
		        p.bytes, p.cost, p.cpu_cost, p.io_cost, p.temp_space, p.partition_start, p.partition_stop, p.access_predicates, p.filter_predicates,
		        p.qblock_name, p.depth
		   FROM dba_hist_sql_plan p WHERE p.sql_id = '`+id+`' AND p.plan_hash_value = `+phv+` ORDER BY p.id`)
	c.put(Section{Key: "plantats", Title: "E-Rows / A-Rows 运行时统计", Note: "AWR 模式下没有运行时 A-Rows；如需验证基数，请在测试环境用 GATHER_PLAN_STATISTICS 重跑。"})
	bs := c.runSec("binds", "绑定变量（AWR 采样）", "DBA_HIST_SQLBIND 只是采样值，不代表每次执行的真实绑定值。"+ternary(c.o.MaskBinds, "字符串型取值已脱敏（--no-mask-binds 可关闭）。", ""),
		`SELECT * FROM (SELECT snap_id, name, position, datatype_string, value_string, TO_CHAR(last_captured,'YYYY-MM-DD HH24:MI:SS') last_captured
		   FROM dba_hist_sqlbind WHERE sql_id = '`+id+`' ORDER BY snap_id DESC, position) WHERE ROWNUM <= 100`)
	c.maskBinds(bs)
	return nil
}
