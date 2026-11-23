package main

import (
	"fmt"
	"strings"
	"time"
)

// 内置样例：模拟一条"RAC + CDB 上经 dblink 拉取千万行、走全局索引回表"的典型慢 SQL。
// 数据全部为虚构，仅用于演示报告版式与规则引擎，不代表任何真实库。

func tbl(key, title, note, cols, rows string) Section {
	s := Section{Key: key, Title: title, Note: note, Cols: strings.Split(cols, "|")}
	for _, ln := range strings.Split(strings.TrimSpace(rows), "\n") {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		s.Rows = append(s.Rows, strings.Split(ln, "|"))
	}
	return s
}

const demoSQL = `SELECT /*+ OPAQUE_TRANSFORM */
       "A1"."SET_YEAR", "A1"."MOF_DIV_CODE", "A1"."ACCOUNT_CLS_CODE",
       "A1"."AMT", "A1"."DR_CR", "A1"."EXP_FUNC_CODE",
       "A1"."AGENCY_CODE", "A1"."IS_DELETED", "A1"."POSTER_MARK"
  FROM "MOF_V2_BUS"."GLF_VOU_DETAIL" "A1"
 WHERE "A1"."SET_YEAR" = '2025'
   AND "A1"."IS_DELETED" = 2
   AND (SUBSTR("A1"."ACCOUNT_CLS_CODE", :1, :2) = '7001'
     OR SUBSTR("A1"."ACCOUNT_CLS_CODE", :3, :4) = '7002'
     OR SUBSTR("A1"."ACCOUNT_CLS_CODE", :5, :6) = '7003'
     OR SUBSTR("A1"."ACCOUNT_CLS_CODE", :7, :8) = '7005')
   AND "A1"."EXP_FUNC_CODE" IS NOT NULL
   AND "A1"."DR_CR" = 1`

const demoPlan = `SQL_ID  2jqdamknrmm6r, child number 0
-------------------------------------
Plan hash value: 3189042751

----------------------------------------------------------------------------------------------------------
| Id | Operation                                  | Name                            | Rows  | Pstart| Pstop |
----------------------------------------------------------------------------------------------------------
|  0 | SELECT STATEMENT                           |                                 |       |       |       |
|  1 |  TABLE ACCESS BY GLOBAL INDEX ROWID BATCHED| GLF_VOU_DETAIL                  |  347K | ROWID | ROWID |
|* 2 |   INDEX RANGE SCAN                         | IDX_GLF_VOU_DETAIL_YEAR_DEL_DIV |  491K |       |       |
----------------------------------------------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------
   1 - filter("EXP_FUNC_CODE" IS NOT NULL AND "DR_CR"=1)
   2 - access("IS_DELETED"=2 AND "SET_YEAR"='2025')
       filter(SUBSTR("ACCOUNT_CLS_CODE",:1,:2)='7001' OR
              SUBSTR("ACCOUNT_CLS_CODE",:3,:4)='7002' OR
              SUBSTR("ACCOUNT_CLS_CODE",:5,:6)='7003' OR
              SUBSTR("ACCOUNT_CLS_CODE",:7,:8)='7005')

Note: A-Rows 取自 GV$SQL_PLAN_STATISTICS_ALL（需 GATHER_PLAN_STATISTICS）`

func demoVariantSnapshot(id string, idx int) *Snapshot {
	s := demoBase()
	s.Meta.SQLID = id
	s.Meta.Generated = time.Now().Format("2006-01-02 15:04:05")
	s.Meta.Mode = "demo"
	if idx > 0 { // 批量演示：让不同 SQL_ID 的指标有差异，规则命中也随之不同
		f := []float64{1, 0.05, 0.4, 0.01}[idx%4]
		m := &s.Metrics
		m.ElapsedUS *= f
		m.CPUUS *= f
		m.UserIOUS *= f
		m.ClusterUS *= f
		m.LIO *= f
		m.PIO *= f
		m.RowsProc *= f
		for i := range s.Sections {
			if s.Sections[i].Key == "sqltext" && len(s.Sections[i].Rows) > 0 {
				s.Sections[i].Rows[0][0] = strings.ReplaceAll(s.Sections[i].Rows[0][0], "2jqdamknrmm6r", id)
			}
		}
	}
	return s
}

func demoBase() *Snapshot {
	s := &Snapshot{Schema: snapSchema}
	s.Meta = Meta{SQLID: "2jqdamknrmm6r", DBName: "MGFDB", Mode: "demo", Version: "19.30.0.0.0", Major: 19, Edition: "EE",
		Banner: "Oracle 19c EE 19.30.0.0.0", RAC: true, Instances: 2, CDB: true, Container: "MOFPDB", ConID: "3", AWREnabled: true,
		Module: "oracle@dbserver2 (TNS V1-V3)", SQLType: "SELECT", Parsing: "MOF_V2_BUS", CollectSec: 12.4}
	s.Metrics = Metrics{Execs: 3, ElapsedUS: 1713696000, CPUUS: 754594000, UserIOUS: 900508000, ClusterUS: 336976000,
		ApplUS: 36000, ConcUS: 9000, LIO: 9032893, PIO: 2412721, RowsProc: 30929322, Fetches: 30929322, Children: 3, PlanCount: 1, BlockSize: 8192}
	s.SQLText = demoSQL
	sq := func(inst, child string) string {
		return inst + "|3|" + child + "|3189042751|MOF_V2_BUS|oracle@dbserver2 (TNS V1-V3)||SELECT|1|571232000|251531333|300169333|112325333|12000|3000|3010964|804240|10309774|10309774|0|1|3|Y|N|2026-11-12/09:12:03|2026-11-12 10:41:18|||| SELECT /*+ OPAQUE_TRANSFORM */ \"A1\".\"SET_YEAR\", ... FROM GLF_VOU_DETAIL"
	}
	sec := []Section{
		tbl("env", "数据库环境与 RAC 实例", "", "INST_ID|INSTANCE_NAME|HOST_NAME|VERSION|DB_NAME|CDB|CON_NAME|INSTANCE_COUNT",
			"1|JDMOF1|dbserver1|19.30.0.0.0|MGFDB|YES|MOFPDB|2\n2|JDMOF2|dbserver2|19.30.0.0.0|MGFDB|YES|MOFPDB|2"),
		tbl("sqlinfo", "SQL 基本信息（按实例 / 子游标）", "GV$SQL 为共享池内累计值（自游标加载起），报告中的单次值 = 累计值 / 执行次数。",
			"INST_ID|CON_ID|CHILD_NUMBER|PLAN_HASH_VALUE|PARSING_SCHEMA_NAME|MODULE|ACTION|SQL_TYPE|EXECUTIONS|ELAPSED_TIME|CPU_TIME|USER_IO_WAIT_TIME|CLUSTER_WAIT_TIME|APPLICATION_WAIT_TIME|CONCURRENCY_WAIT_TIME|BUFFER_GETS|DISK_READS|ROWS_PROCESSED|FETCHES|SORTS|PARSE_CALLS|VERSION_COUNT|IS_BIND_SENSITIVE|IS_BIND_AWARE|FIRST_LOAD_TIME|LAST_ACTIVE_TIME|SQL_PROFILE|SQL_PLAN_BASELINE|SQL_PATCH|SQL_TEXT_SHORT",
			sq("2", "0")+"\n"+sq("1", "1")+"\n"+sq("2", "2")),
		{Key: "sqltext", Title: "完整 SQL 文本", Kind: "text", Note: "说明：SQL 含 OPAQUE_TRANSFORM，说明由远端 dblink 网关生成，本端通常无法直接改写",
			Cols: []string{"SQL"}, Rows: [][]string{{demoSQL}}},
		{Key: "sqlparse", Title: "SQL 结构解析（本地解析，仅作线索）", Note: "解析器为轻量实现，解析失败时诊断自动回退到执行计划对象信息。",
			Cols: []string{"项目", "结果"}, Rows: sqlInfoRows(parseSQL(demoSQL))},
		{Key: "xplan", Title: "执行计划（DBMS_XPLAN）", Kind: "text", Note: "说明：RAC 下 DISPLAY_CURSOR 仅返回当前连接实例的游标；A-Rows 需 GATHER_PLAN_STATISTICS / STATISTICS_LEVEL=ALL",
			Cols: []string{"PLAN"}, Rows: lines(demoPlan)},
		tbl("planops", "计划操作明细（跨实例 / 含谓词）", "",
			"INST_ID|CON_ID|CHILD_NUMBER|PLAN_HASH_VALUE|ID|PARENT_ID|OPERATION|OPTIONS|OBJECT_OWNER|OBJECT_NAME|OBJECT_TYPE|E_ROWS|BYTES|COST|CPU_COST|IO_COST|TEMP_SPACE|PARTITION_START|PARTITION_STOP|ACCESS_PREDICATES|FILTER_PREDICATES|QBLOCK_NAME|DEPTH",
			`2|3|0|3189042751|0||SELECT STATEMENT||||||347000||421000||||||||||SEL$1|0
2|3|0|3189042751|1|0|TABLE ACCESS|BY GLOBAL INDEX ROWID BATCHED|MOF_V2_BUS|GLF_VOU_DETAIL|TABLE|347000|640000000|421000||420000||ROW LOCATION|ROW LOCATION||"EXP_FUNC_CODE" IS NOT NULL AND "DR_CR"=1|SEL$1|1
2|3|0|3189042751|2|1|INDEX|RANGE SCAN|MOF_V2_BUS|IDX_GLF_VOU_DETAIL_YEAR_DEL_DIV|INDEX|491000||18000||18000||||"IS_DELETED"=2 AND "SET_YEAR"='2025'|SUBSTR("ACCOUNT_CLS_CODE",:1,:2)='7001' OR SUBSTR("ACCOUNT_CLS_CODE",:3,:4)='7002' OR SUBSTR("ACCOUNT_CLS_CODE",:5,:6)='7003' OR SUBSTR("ACCOUNT_CLS_CODE",:7,:8)='7005'|SEL$1|2`),
		tbl("plantats", "E-Rows / A-Rows 运行时统计", "A-Rows 取自 GV$SQL_PLAN_STATISTICS_ALL（需 GATHER_PLAN_STATISTICS 或 STATISTICS_LEVEL=ALL）；缺失时报告不会用 E-Rows 冒充实测。",
			"INST_ID|CHILD_NUMBER|ID|OPERATION|OPTIONS|OBJECT_NAME|E_ROWS|A_ROWS|LAST_CR_BUFFER_GETS|LAST_DISK_READS|LAST_ELAPSED_TIME|LAST_STARTS",
			"2|0|1|TABLE ACCESS|BY GLOBAL INDEX ROWID BATCHED|GLF_VOU_DETAIL|347000|10309774|3010964|804240|571232000|1\n2|0|2|INDEX|RANGE SCAN|IDX_GLF_VOU_DETAIL_YEAR_DEL_DIV|491000|29280000|968000|120450|118000000|1"),
		tbl("binds", "绑定变量（共享池采样）", "V$SQL_BIND_CAPTURE 只是采样值，不代表每次执行的真实绑定值。字符串型取值已脱敏（--no-mask-binds 可关闭）。",
			"INST_ID|CHILD_NUMBER|NAME|POSITION|DATATYPE_STRING|VALUE_STRING|WAS_CAPTURED|LAST_CAPTURED",
			`2|0|:1|1|NUMBER|1|YES|2026-11-12 09:12:03
2|0|:2|2|NUMBER|4|YES|2026-11-12 09:12:03
2|0|:3|3|NUMBER|1|YES|2026-11-12 09:12:03
2|0|:4|4|NUMBER|4|YES|2026-11-12 09:12:03
2|0|:5|5|NUMBER|1|YES|2026-11-12 09:12:03
2|0|:6|6|NUMBER|4|YES|2026-11-12 09:12:03
2|0|:7|7|NUMBER|1|YES|2026-11-12 09:12:03
2|0|:8|8|NUMBER|4|YES|2026-11-12 09:12:03`),
		tbl("drift", "执行计划漂移", "", "INST_ID|PLAN_HASH_VALUE|CHILD_COUNT|EXECUTIONS|ELAPSED_SEC|AVG_BUFFER_GETS|FIRST_LOAD|LAST_ACTIVE",
			"2|3189042751|3|3|1713.70|3010964|2026-11-12/09:12:03|2026-11-12 10:41:18"),
		tbl("ash", "ASH 等待事件分布", "GV$ACTIVE_SESSION_HISTORY 约 1 秒一个样本，APPROX_SEC≈该事件占用的会话秒数；仅覆盖内存中最近的采样。",
			"INST_ID|EVENT|WAIT_CLASS|SAMPLES|APPROX_SEC",
			"2|db file sequential read|User I/O|900|900\n2|gc buffer busy acquire|Cluster|220|220\n1|gc cr block 2-way|Cluster|117|117\n2|ON CPU||755|755"),
		tbl("awrtrend", "AWR 历史执行趋势", "DBA_HIST_SQLSTAT 按快照差值（_DELTA）统计，按时间倒序。",
			"SNAP_ID|END_INTERVAL_TIME|INSTANCE_NUMBER|PLAN_HASH_VALUE|EXECUTIONS|ELAPSED_SEC|AVG_SEC|CPU_SEC|BUFFER_GETS|DISK_READS|ROWS_PROCESSED",
			"46448|2026-11-12 11:00|2|3189042751|1|573.36|573.3600|251.96|3011818|804581|10309774\n46420|2026-11-12 10:00|2|3189042751|1|571.23|571.2300|251.53|3010964|804240|10309774\n46419|2026-11-12 09:00|2|3189042751|1|569.11|569.1100|251.10|3010110|803900|10309774"),
		tbl("awrplan", "AWR 历史计划", "", "DBID|PLAN_HASH_VALUE|ID|OPERATION|OPTIONS|OBJECT_NAME|CARDINALITY|COST|ACCESS_PREDICATES|FILTER_PREDICATES",
			`1846219733|3189042751|1|TABLE ACCESS|BY GLOBAL INDEX ROWID BATCHED|GLF_VOU_DETAIL|347000|421000||"DR_CR"=1`),
		tbl("objects", "SQL 涉及对象", "", "OBJECT_OWNER|OBJECT_NAME|OBJECT_TYPE",
			"MOF_V2_BUS|GLF_VOU_DETAIL|TABLE\nMOF_V2_BUS|IDX_GLF_VOU_DETAIL_YEAR_DEL_DIV|INDEX"),
		tbl("tabstats", "表级统计信息", "STALE_STATS=YES 表示 DML 变化超过阈值（默认 10%），统计信息已过期。",
			"OWNER|TABLE_NAME|NUM_ROWS|BLOCKS|AVG_ROW_LEN|SAMPLE_SIZE|LAST_ANALYZED|PARTITIONED|TEMPORARY|DEGREE|STALE_STATS",
			"MOF_V2_BUS|GLF_VOU_DETAIL|122685036|3200000|780|6134252|2026-09-28 02:10|YES|N|1|YES"),
		tbl("columns", "表字段结构", "仅列出 SQL 谓词 / 投影、索引、分区键涉及的字段。",
			"OWNER|TABLE_NAME|COLUMN_ID|COLUMN_NAME|DATA_TYPE|DATA_LENGTH|DATA_PRECISION|DATA_SCALE|NULLABLE|DATA_DEFAULT",
			`MOF_V2_BUS|GLF_VOU_DETAIL|2|SET_YEAR|VARCHAR2|4|||N|
MOF_V2_BUS|GLF_VOU_DETAIL|10|ACCOUNT_CLS_CODE|VARCHAR2|200|||N|
MOF_V2_BUS|GLF_VOU_DETAIL|22|EXP_FUNC_CODE|VARCHAR2|13|||Y|
MOF_V2_BUS|GLF_VOU_DETAIL|12|DR_CR|NUMBER|22||0|N|
MOF_V2_BUS|GLF_VOU_DETAIL|60|IS_DELETED|NUMBER|22||0|N|
MOF_V2_BUS|GLF_VOU_DETAIL|58|UPDATE_TIME|DATE|7|||N|sysdate
MOF_V2_BUS|GLF_VOU_DETAIL|62|CREATE_TIME|DATE|7|||N|sysdate`),
		tbl("colstats", "列统计 / NDV / 直方图", "AVG_SEL_PCT = 100/NDV（均匀分布下的等值选择率）；NULL_PCT 基于表 NUM_ROWS。",
			"OWNER|TABLE_NAME|COLUMN_NAME|NDV|NUM_NULLS|DENSITY|HISTOGRAM|NUM_BUCKETS|AVG_COL_LEN|LAST_ANALYZED|AVG_SEL_PCT|NULL_PCT",
			`MOF_V2_BUS|GLF_VOU_DETAIL|IS_DELETED|2|0|0.5|NONE|1|2|2026-09-28 02:10|50.00|0.00
MOF_V2_BUS|GLF_VOU_DETAIL|DR_CR|2|0|0.5|FREQUENCY|2|2|2026-09-28 02:10|50.00|0.00
MOF_V2_BUS|GLF_VOU_DETAIL|SET_YEAR|3|0|0.33|FREQUENCY|3|5|2026-09-28 02:10|33.33|0.00
MOF_V2_BUS|GLF_VOU_DETAIL|ACCOUNT_CLS_CODE|1842|0|0.00054|HEIGHT BALANCED|254|9|2026-09-28 02:10|0.05|0.00
MOF_V2_BUS|GLF_VOU_DETAIL|EXP_FUNC_CODE|3176|12034567|0.00031|NONE|1|8|2026-09-28 02:10|0.03|9.81`),
		tbl("histo", "直方图桶与热点值推算", "BUCKET_PCT 由 ENDPOINT_NUMBER 差值推算，是统计信息口径的占比，不等于精确值频率；每列仅列出占比最高的 10 个桶。",
			"OWNER|TABLE_NAME|COLUMN_NAME|ENDPOINT_NUMBER|ENDPOINT_VALUE|BUCKET_PCT",
			"MOF_V2_BUS|GLF_VOU_DETAIL|DR_CR|5440|1|54.40\nMOF_V2_BUS|GLF_VOU_DETAIL|DR_CR|10000|2|45.60"),
	}
	type ix struct {
		name, typ, uniq, loc string
		cf                   int
	}
	gl := []ix{{"DETAIL_BILLID", "", "NONUNIQUE", "GLOBAL", 2950000}, {"EXP_FUNC_CODE", "", "NONUNIQUE", "GLOBAL", 2710000},
		{"GLF_VOU_DETAIL_CREATE_TIME", "", "NONUNIQUE", "GLOBAL", 2850000}, {"GLF_VOU_DETAIL_UPDATE_TIME", "", "NONUNIQUE", "GLOBAL", 2800000},
		{"IDNX_ACCOUNT_CLS_CODE", "", "NONUNIQUE", "GLOBAL", 2600000}, {"IDX_CURRENCY", "", "NONUNIQUE", "GLOBAL", 3100000},
		{"IDX_GLF_VOU_DETAIL_OPT", "", "NONUNIQUE", "GLOBAL", 2550000}, {"IDX_GLF_VOU_DETAIL_YEAR_DEL_DIV", "", "NONUNIQUE", "GLOBAL", 2980000},
		{"IDX_SYN_GLF_VOU_DETAIL_YEAR_DEL_DIV", "", "NONUNIQUE", "GLOBAL", 2900000}, {"INDEX_DR_CR", "", "NONUNIQUE", "GLOBAL", 3120000},
		{"PK_GLF_VOU_DETAIL", "", "UNIQUE", "GLOBAL", 3050000}, {"UK_ID_9DSOFT", "", "UNIQUE", "GLOBAL", 3020000},
		{"ACCT_SET_CODE", "", "NONUNIQUE", "LOCAL", 2300000}, {"GLF_VOU_DETAIL_MOF_DIV", "", "NONUNIQUE", "LOCAL", 2300000},
		{"GLF_VOU_DETAIL_MOF_YEAR_SET", "", "NONUNIQUE", "LOCAL", 2300000}, {"GLF_VOU_DETAIL_VOU_ID", "", "NONUNIQUE", "LOCAL", 2300000},
		{"GLF_VOU_DETAIL_YEAR", "", "NONUNIQUE", "LOCAL", 2300000}}
	var ixr []string
	for _, x := range gl {
		part := "NO"
		if x.loc == "LOCAL" {
			part = "YES"
		}
		ixr = append(ixr, fmt.Sprintf("MOF_V2_BUS|%s|GLF_VOU_DETAIL|NORMAL|%s|VALID|%s|%s|18500000|412000|%d|122685036|3|2026-09-28 02:10|VISIBLE", x.name, x.uniq, part, x.loc, x.cf))
	}
	sec = append(sec,
		tbl("indexes", "索引基本信息", "LOCALITY=GLOBAL 且表为分区表时，分区维护需 UPDATE GLOBAL INDEXES，跨实例回表也更重。",
			"OWNER|INDEX_NAME|TABLE_NAME|INDEX_TYPE|UNIQUENESS|STATUS|PARTITIONED|LOCALITY|DISTINCT_KEYS|LEAF_BLOCKS|CLUSTERING_FACTOR|NUM_ROWS|BLEVEL|LAST_ANALYZED|VISIBILITY", strings.Join(ixr, "\n")),
		tbl("indcols", "索引列顺序", "", "INDEX_OWNER|INDEX_NAME|TABLE_NAME|COLUMN_POSITION|COLUMN_NAME|DESCEND", demoIndCols()),
		tbl("indexpr", "函数索引表达式", "函数索引要求谓词表达式与索引表达式文本完全一致才可能命中。",
			"INDEX_OWNER|INDEX_NAME|TABLE_NAME|COLUMN_POSITION|COLUMN_EXPRESSION",
			`MOF_V2_BUS|IDX_GLF_VOU_DETAIL_OPT|GLF_VOU_DETAIL|2|SUBSTR("ACCOUNT_CLS_CODE",1,4)`),
		tbl("partkeys", "分区键与分区类型", "", "OWNER|NAME|OBJECT_TYPE|COLUMN_NAME|COLUMN_POSITION|PARTITIONING_TYPE|SUBPARTITIONING_TYPE",
			"MOF_V2_BUS|GLF_VOU_DETAIL|TABLE|SET_YEAR|1|LIST|LIST\nMOF_V2_BUS|GLF_VOU_DETAIL|TABLE|MOF_DIV_CODE|2|LIST|LIST"),
		tbl("partitions", "分区与子分区", "最多列出每次查询前 200 个分区。", "TABLE_OWNER|TABLE_NAME|PARTITION_NAME|PARTITION_POSITION|HIGH_VALUE|NUM_ROWS|BLOCKS|LAST_ANALYZED",
			"MOF_V2_BUS|GLF_VOU_DETAIL|P2024|1|'2024'|39801244|1030000|2026-09-28 02:10\nMOF_V2_BUS|GLF_VOU_DETAIL|P2025|2|'2025'|40895012|1070000|2026-09-28 02:10\nMOF_V2_BUS|GLF_VOU_DETAIL|P2026|3|'2026'|41988780|1100000|2026-09-28 02:10"),
		tbl("constraints", "主键 / 唯一 / 外键约束", "", "OWNER|TABLE_NAME|CONSTRAINT_NAME|CONSTRAINT_TYPE|STATUS|INDEX_NAME|R_CONSTRAINT_NAME",
			"MOF_V2_BUS|GLF_VOU_DETAIL|PK_GLF_VOU_DETAIL|P|ENABLED|PK_GLF_VOU_DETAIL|\nMOF_V2_BUS|GLF_VOU_DETAIL|UK_ID_9DSOFT|U|ENABLED|UK_ID_9DSOFT|"),
		tbl("segments", "段空间占用", "", "OWNER|SEGMENT_NAME|SEGMENT_TYPE|SIZE_MB|SEGMENTS",
			"MOF_V2_BUS|GLF_VOU_DETAIL|TABLE PARTITION|25600.00|39\nMOF_V2_BUS|IDX_GLF_VOU_DETAIL_YEAR_DEL_DIV|INDEX|8420.50|1"),
		Section{Key: "extstats", Title: "扩展统计 / 列组", Note: "列组 / 表达式统计可修复相关列的基数估算偏差。无数据（可能因权限、对象不适用或确实没有）。",
			Cols: strings.Split("OWNER|TABLE_NAME|EXTENSION_NAME|CREATOR|DROPPABLE|EXTENSION", "|")},
		Section{Key: "sqlmgmt", Title: "SQL Profile / Baseline / Patch / Directive", Note: "无：该 SQL 没有任何 Profile / Baseline / Patch / Directive 干预。",
			Cols: strings.Split("TYPE|NAME|STATUS|DETAIL|CREATED", "|")},
		tbl("sessions", "当前相关会话与阻塞", "", "INST_ID|SID|SERIAL_NO|USERNAME|STATUS|EVENT|BLOCKING_INSTANCE|BLOCKING_SESSION|SQL_ID|LAST_CALL_ET",
			"2|1843|55217|MOF_V2_BUS|ACTIVE|db file sequential read|||2jqdamknrmm6r|571"),
		Section{Key: "workarea", Title: "工作区（排序 / 哈希）与 TEMP 使用", Note: "GV$SQL_WORKAREA；ONEPASS / MULTIPASS 次数 > 0 或 TEMPSEG > 0 表示发生了 TEMP 溢出。无数据：该计划没有排序 / 哈希操作。",
			Cols: strings.Split("INST_ID|CHILD_NUMBER|OPERATION_ID|OPERATION_TYPE|POLICY|EST_OPTIMAL_MB|LAST_MEM_MB|LAST_EXECUTION|TOTAL_EXECUTIONS|OPTIMAL_EXECUTIONS|ONEPASS_EXECUTIONS|MULTIPASSES_EXECUTIONS|LAST_TEMP_MB|MAX_TEMP_MB", "|")},
		tbl("optenv", "优化器与实例参数", "按取值合并实例；isdefault=FALSE 表示被显式修改过。", "NAME|VALUE|ISDEFAULT|INST_IDS",
			"control_management_pack_access|DIAGNOSTIC+TUNING|TRUE|1,2\ncursor_sharing|EXACT|TRUE|1,2\ndb_block_size|8192|TRUE|1,2\ndb_file_multiblock_read_count|128|TRUE|1,2\noptimizer_features_enable|19.1.0|TRUE|1,2\noptimizer_index_cost_adj|100|TRUE|1,2\noptimizer_mode|ALL_ROWS|TRUE|1,2\nparallel_force_local|FALSE|TRUE|1,2\nstatistics_level|TYPICAL|TRUE|1,2"),
		tbl("sample", "字段值频率采样（显式启用）", "SAMPLE BLOCK(1) 块采样，结果存在偏差；疑似敏感字段的取值已脱敏。该章节会读表，请在低峰执行。",
			"TABLE_NAME|COLUMN_NAME|VALUE|CNT|PCT",
			"GLF_VOU_DETAIL|IS_DELETED|2|29280000|71.61\nGLF_VOU_DETAIL|IS_DELETED|1|11610000|28.39\nGLF_VOU_DETAIL|DR_CR|1|22250000|54.41\nGLF_VOU_DETAIL|DR_CR|2|18640000|45.59"),
	)
	s.Sections = sec
	s.Audit = []string{"[演示数据] 本报告由 --demo 生成，未连接任何数据库，没有执行任何 SQL。"}
	s.Findings = RunRules(s, "")
	return s
}

func lines(t string) [][]string {
	var out [][]string
	for _, l := range strings.Split(t, "\n") {
		out = append(out, []string{l})
	}
	return out
}

func demoIndCols() string {
	one := map[string]string{"DETAIL_BILLID": "BILL_ID", "EXP_FUNC_CODE": "EXP_FUNC_CODE", "GLF_VOU_DETAIL_CREATE_TIME": "CREATE_TIME",
		"GLF_VOU_DETAIL_UPDATE_TIME": "UPDATE_TIME", "IDNX_ACCOUNT_CLS_CODE": "ACCOUNT_CLS_CODE", "IDX_CURRENCY": "CURRENCY_CODE",
		"IDX_SYN_GLF_VOU_DETAIL_YEAR_DEL_DIV": "IS_DELETED", "INDEX_DR_CR": "DR_CR", "PK_GLF_VOU_DETAIL": "VOU_DET_ID", "UK_ID_9DSOFT": "ID_9DSOFT",
		"ACCT_SET_CODE": "ACCT_SET_CODE", "GLF_VOU_DETAIL_MOF_DIV": "MOF_DIV_CODE", "GLF_VOU_DETAIL_MOF_YEAR_SET": "MOF_DIV_CODE",
		"GLF_VOU_DETAIL_VOU_ID": "VOU_ID", "GLF_VOU_DETAIL_YEAR": "SET_YEAR"}
	order := []string{"DETAIL_BILLID", "EXP_FUNC_CODE", "GLF_VOU_DETAIL_CREATE_TIME", "GLF_VOU_DETAIL_UPDATE_TIME", "IDNX_ACCOUNT_CLS_CODE", "IDX_CURRENCY",
		"IDX_SYN_GLF_VOU_DETAIL_YEAR_DEL_DIV", "INDEX_DR_CR", "PK_GLF_VOU_DETAIL", "UK_ID_9DSOFT", "ACCT_SET_CODE", "GLF_VOU_DETAIL_MOF_DIV",
		"GLF_VOU_DETAIL_MOF_YEAR_SET", "GLF_VOU_DETAIL_VOU_ID", "GLF_VOU_DETAIL_YEAR"}
	var r []string
	for _, n := range order {
		r = append(r, fmt.Sprintf("MOF_V2_BUS|%s|GLF_VOU_DETAIL|1|%s|ASC", n, one[n]))
	}
	r = append(r, "MOF_V2_BUS|IDX_GLF_VOU_DETAIL_OPT|GLF_VOU_DETAIL|1|IS_DELETED|ASC", "MOF_V2_BUS|IDX_GLF_VOU_DETAIL_OPT|GLF_VOU_DETAIL|2|SYS_NC00042$|ASC")
	for i, c := range []string{"IS_DELETED", "SET_YEAR", "MOF_DIV_CODE", "ACCT_SET_CODE", "ACCOUNT_CLS_CODE"} {
		r = append(r, fmt.Sprintf("MOF_V2_BUS|IDX_GLF_VOU_DETAIL_YEAR_DEL_DIV|GLF_VOU_DETAIL|%d|%s|ASC", i+1, c))
	}
	return strings.Join(r, "\n")
}

// demoSanity 校验内置样例自身是否自洽（防止改坏样例后规则悄悄失效）。
func demoSanity(s *Snapshot) []string {
	var bad []string
	if s.Metrics.Execs <= 0 || s.Metrics.ElapsedUS <= 0 {
		bad = append(bad, "指标为空")
	}
	for _, k := range sectionOrder {
		if isAWRKey(k) && k != "ash" && k != "awrtrend" && k != "awrplan" {
			continue
		}
		if s.Sec(k) == nil {
			bad = append(bad, "缺少章节 "+k)
		}
	}
	if len(s.Sec("planops").Maps()) < 3 {
		bad = append(bad, "计划明细不足 3 行")
	}
	return bad
}
