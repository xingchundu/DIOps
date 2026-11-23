package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

// recDB 是"录制型"假数据库：对关键探测语句返回最小可用的假行，其余返回空集。
// 用途：--dry-run 列出将要执行的全部语句；单元测试走一遍采集代码路径（不验证 SQL 在 Oracle 上的语法）。
var dryOwner, dryTable = "APP", "T1"

type recDB struct{}

func (recDB) Close() error { return nil }

func (recDB) Query(ctx context.Context, q string, args ...any) ([]string, [][]string, error) {
	l := strings.ToLower(strings.Join(strings.Fields(q), " "))
	has := func(s string) bool { return strings.Contains(l, s) }
	switch {
	case has("from v$version"):
		return []string{"BANNER"}, [][]string{{"Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production"}}, nil
	case has("select version_full"):
		return []string{"V"}, [][]string{{"19.30.0.0.0"}}, nil
	case has("select name from v$database"):
		return []string{"N"}, [][]string{{"DRYDB"}}, nil
	case has("select cdb from v$database"):
		return []string{"C"}, [][]string{{"NO"}}, nil
	case has("sys_context('userenv','con_name'), sys_context"):
		return []string{"A", "B", "C"}, [][]string{{"DRYDB", "0", "1"}}, nil
	case has("count(*) from gv$instance"):
		return []string{"N"}, [][]string{{"1"}}, nil
	case has("from dba_tables where rownum = 1"):
		return []string{"1"}, [][]string{{"1"}}, nil
	case has("from gv$parameter"):
		return []string{"NAME", "VALUE", "ISDEFAULT", "INST_IDS"}, [][]string{{"db_block_size", "8192", "TRUE", "1"}, {"control_management_pack_access", "DIAGNOSTIC+TUNING", "TRUE", "1"}}, nil
	case has("nvl(sum(executions),0)"):
		return []string{"A"}, [][]string{{"1", "1000000", "1000000", "0", "0", "0", "0", "100", "10", "10", "10", "1", "1"}}, nil
	case has("from (select inst_id, con_id,") || (has("from gv$sql where sql_id") && has("child_number, plan_hash_value")):
		return []string{"INST_ID", "CHILD_NUMBER", "PLAN_HASH_VALUE", "PARSING_SCHEMA_NAME", "MODULE", "SQL_TYPE"}, [][]string{{"1", "0", "111", "APP", "m", "SELECT"}}, nil
	case has("from gv$sqltext_with_newlines"):
		return []string{"SQL_TEXT"}, [][]string{{"SELECT * FROM APP.T1 A WHERE A.ID = :1"}}, nil
	case has("from gv$sql_plan p where"):
		return []string{"INST_ID", "OPERATION", "OPTIONS", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE"}, [][]string{{"1", "TABLE ACCESS", "FULL", dryOwner, dryTable, "TABLE"}}, nil
	}
	return []string{"X"}, nil, nil
}

func printDryRun(o Options) error {
	id := "0000000000000"
	if len(o.SQLIDs) > 0 {
		id = o.SQLIDs[0]
	}
	if o.DryTable != "" {
		p := strings.SplitN(strings.ToUpper(o.DryTable), ".", 2)
		if len(p) == 2 && identRe.MatchString(p[0]) && identRe.MatchString(p[1]) {
			dryOwner, dryTable = p[0], p[1]
		} else {
			return fmt.Errorf("--dry-table 需为 OWNER.TABLE")
		}
	}
	s, err := collect(context.Background(), recDB{}, o, id)
	if err != nil {
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "-- %s %s 干跑：将对数据库执行的全部语句（只读 SELECT）\n-- SQL_ID=%s  示例表=%s.%s（真实运行时由执行计划动态决定；用 --dry-table OWNER.TABLE 替换）\n", toolName, toolVersion, id, dryOwner, dryTable)
	fmt.Fprintf(&b, "-- 说明：只列出主路径语句；LONG/高版本列的降级备选语句仅在主语句失败时才会执行。\nSET LINESIZE 400 PAGESIZE 200 LONG 4000 TRIMSPOOL ON\n")
	if o.PDB != "" {
		fmt.Fprintf(&b, "ALTER SESSION SET CONTAINER = %s;\n", strings.ToUpper(o.PDB))
	}
	for i, q := range s.AuditFull {
		q = strings.ReplaceAll(q, "%CAT%", "DBA")
		fmt.Fprintf(&b, "\n-- [%d]\n%s;\n", i+1, strings.TrimSpace(q))
	}
	if o.Out != "" && o.Out != "-" {
		if err := os.WriteFile(o.Out, []byte(b.String()), 0o644); err != nil {
			return err
		}
		fmt.Printf("已写出 %d 条语句到 %s\n", len(s.AuditFull), o.Out)
		return nil
	}
	fmt.Print(b.String())
	return nil
}

func runConnCheck(o Options) error {
	db, err := openDB(o)
	if err != nil {
		return err
	}
	defer db.Close()
	c := &collector{ctx: context.Background(), db: db, o: o, s: &Snapshot{}, pfx: "DBA", params: map[string]string{}}
	if err := c.probe(); err != nil {
		return err
	}
	m := c.s.Meta
	fmt.Printf("连接成功：%s\n库名 %s | 架构 %s | 容器 %s (CON_ID=%s) | 实例数 %d | 连接实例 %s\n", m.Banner, m.DBName,
		ternary(m.CDB, "CDB/PDB", "非 CDB"), m.Container, m.ConID, m.Instances, c.inst)
	if m.CDB && strings.EqualFold(m.Container, "CDB$ROOT") {
		fmt.Println("提示：当前连在 CDB$ROOT，业务 SQL 通常在 PDB 中；请直连 PDB 服务名或加 --pdb <PDB名>。")
	}
	c.collectParams()
	fmt.Printf("AWR/ASH 采集: %v（control_management_pack_access=%s；--no-awr=%v）\n\n", c.s.Meta.AWREnabled, blankTo(c.params["control_management_pack_access"], "未知"), o.NoAWR)
	views := []string{"gv$sql", "gv$sql_plan", "gv$sql_plan_statistics_all", "gv$sql_bind_capture", "gv$sqltext_with_newlines", "gv$session",
		"gv$sql_workarea", "gv$active_session_history", "dba_hist_sqlstat", "dba_hist_sql_plan", "dba_tables", "dba_tab_columns", "dba_indexes",
		"dba_ind_columns", "dba_tab_col_statistics", "dba_tab_histograms", "dba_tab_partitions", "dba_segments", "dba_stat_extensions",
		"dba_sql_plan_baselines", "dba_sql_profiles"}
	tw := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "视图\t可读\t说明")
	miss := 0
	for _, v := range views {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		_, _, err := db.Query(ctx, "SELECT 1 FROM "+v+" WHERE ROWNUM = 1")
		cancel()
		st, note := "是", ""
		if err != nil {
			st, note = "否", shortErr(err)
			miss++
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", v, st, note)
	}
	tw.Flush()
	if miss > 0 {
		fmt.Printf("\n%d 个视图不可读；对应章节会降级或跳过（不影响其它章节）。授权方式见 GRANTS.sql。\n", miss)
	}
	return nil
}
