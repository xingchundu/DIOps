package main

import "fmt"

// AWR / ASH 采集：近 N 天（--awr-days，默认 2；0 = 全部保留期），覆盖每一个执行计划。

func (c *collector) winSnap() string { // 作用于别名 sn
	if c.o.AWRDays <= 0 {
		return ""
	}
	return fmt.Sprintf(" AND sn.end_interval_time >= SYSDATE - %d", c.o.AWRDays)
}

func (c *collector) winAsh() string { // 作用于别名 h
	if c.o.AWRDays <= 0 {
		return ""
	}
	return fmt.Sprintf(" AND h.sample_time >= SYSDATE - %d", c.o.AWRDays)
}

func (c *collector) span() string {
	if c.o.AWRDays <= 0 {
		return "全部保留期"
	}
	return fmt.Sprintf("近 %d 天", c.o.AWRDays)
}

const awrFrom = `dba_hist_sqlstat s JOIN dba_hist_snapshot sn ON sn.snap_id = s.snap_id AND sn.dbid = s.dbid AND sn.instance_number = s.instance_number`

var awrKeys = [][2]string{{"ash", "ASH 实时"}, {"ashhist", "ASH 历史：等待事件分布"}, {"ashline", "ASH 历史：耗时落在计划哪一行"},
	{"ashobj", "ASH 历史：热点对象"}, {"ashtime", "ASH 历史：时间分布"}, {"awrtrend", "AWR 历史执行趋势"},
	{"awrplansum", "AWR 各执行计划对比"}, {"awrplan", "AWR 历史计划明细"}, {"awrxplan", "AWR 历史计划（DBMS_XPLAN）"}}

func (c *collector) collectAWR() {
	id := c.id
	span := c.span()
	if !c.s.Meta.AWREnabled {
		reason := "已跳过 AWR/ASH"
		if c.o.NoAWR {
			reason += "（--no-awr）"
		} else {
			reason += "（control_management_pack_access 未包含 DIAGNOSTIC，Diagnostics Pack 未授权）"
		}
		for _, k := range awrKeys {
			c.put(Section{Key: k[0], Title: k[1], Note: reason + "。可用 --snapshot-dir 定时自建快照替代历史趋势。"})
		}
		return
	}

	c.runSec("ash", "ASH 实时（内存，最近约 1 小时）", "GV$ACTIVE_SESSION_HISTORY 约 1 秒一个样本，APPROX_SEC≈该事件占用的会话秒数；只覆盖内存中的采样，更长时间看「ASH 历史」。",
		`SELECT * FROM (SELECT inst_id, NVL(event,'ON CPU') event, wait_class, COUNT(*) samples, COUNT(*) approx_sec
		   FROM gv$active_session_history WHERE sql_id = '`+id+`' GROUP BY inst_id, NVL(event,'ON CPU'), wait_class
		   ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 20`)

	hn := "DBA_HIST_ACTIVE_SESS_HISTORY 每 10 秒取 1 个样本（落盘为内存 ASH 的 1/10），APPROX_SEC = 样本数 × 10；样本少时只供方向判断。窗口：" + span + "。"
	c.runSec("ashhist", "ASH 历史：等待事件分布（"+span+"）", hn,
		`SELECT * FROM (SELECT h.instance_number, NVL(h.event,'ON CPU') event, h.wait_class, COUNT(*) samples, COUNT(*)*10 approx_sec,
		        ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 2) pct
		   FROM dba_hist_active_sess_history h WHERE h.sql_id = '`+id+`'`+c.winAsh()+`
		  GROUP BY h.instance_number, NVL(h.event,'ON CPU'), h.wait_class ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 30`)
	c.runSec("ashline", "ASH 历史：耗时落在执行计划哪一行（"+span+"）", "按 SQL_PLAN_LINE_ID 汇总：时间花在计划的哪一步、在等什么。",
		`SELECT * FROM (SELECT h.sql_plan_hash_value plan_hash_value, h.sql_plan_line_id line_id, h.sql_plan_operation operation,
		        h.sql_plan_options options, NVL(h.event,'ON CPU') event, COUNT(*) samples, COUNT(*)*10 approx_sec,
		        ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 2) pct
		   FROM dba_hist_active_sess_history h WHERE h.sql_id = '`+id+`'`+c.winAsh()+`
		  GROUP BY h.sql_plan_hash_value, h.sql_plan_line_id, h.sql_plan_operation, h.sql_plan_options, NVL(h.event,'ON CPU')
		  ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 40`)
	c.runSec("ashobj", "ASH 历史：热点对象（"+span+"）", "CURRENT_OBJ# 对应的表 / 索引（等 I/O 的对象）。",
		`SELECT o.owner object_owner, o.object_name, o.object_type, a.event, a.samples, a.samples*10 approx_sec
		   FROM (SELECT * FROM (SELECT h.current_obj# obj_id, NVL(h.event,'ON CPU') event, COUNT(*) samples
		           FROM dba_hist_active_sess_history h WHERE h.sql_id = '`+id+`' AND h.current_obj# > 0`+c.winAsh()+`
		          GROUP BY h.current_obj#, NVL(h.event,'ON CPU') ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 30) a
		   LEFT JOIN dba_objects o ON o.object_id = a.obj_id ORDER BY a.samples DESC`)
	c.runSec("ashtime", "ASH 历史：时间分布（按小时，"+span+"）", "这条 SQL 集中在哪些时段，是 CPU、I/O 还是集群等待。",
		`SELECT * FROM (SELECT TO_CHAR(h.sample_time,'YYYY-MM-DD HH24') hour, COUNT(*) samples,
		        SUM(CASE WHEN h.session_state = 'ON CPU' THEN 1 ELSE 0 END) on_cpu,
		        SUM(CASE WHEN h.wait_class = 'User I/O' THEN 1 ELSE 0 END) user_io,
		        SUM(CASE WHEN h.wait_class = 'Cluster' THEN 1 ELSE 0 END) cluster_wait,
		        SUM(CASE WHEN h.session_state = 'WAITING' AND NVL(h.wait_class,'x') NOT IN ('User I/O','Cluster') THEN 1 ELSE 0 END) other_wait
		   FROM dba_hist_active_sess_history h WHERE h.sql_id = '`+id+`'`+c.winAsh()+`
		  GROUP BY TO_CHAR(h.sample_time,'YYYY-MM-DD HH24') ORDER BY 1) WHERE ROWNUM <= 200`)

	c.runSec("awrtrend", "AWR 历史执行趋势（"+span+"，逐快照）", "DBA_HIST_SQLSTAT 快照差值；BUFFER_GETS=逻辑读（块），DISK_READS=物理读（块），PHYS_READ_MB=物理读字节；每行一个快照区间，时间倒序，最多 500 行。",
		`SELECT * FROM (SELECT s.snap_id, TO_CHAR(sn.end_interval_time,'YYYY-MM-DD HH24:MI') end_interval_time, s.instance_number,
		        s.plan_hash_value, s.executions_delta executions, ROUND(s.elapsed_time_delta/1e6,2) elapsed_sec,
		        ROUND(s.elapsed_time_delta/1e6/NULLIF(s.executions_delta,0),4) avg_sec, ROUND(s.cpu_time_delta/1e6,2) cpu_sec,
		        ROUND(s.iowait_delta/1e6,2) io_wait_sec, ROUND(s.clwait_delta/1e6,2) cluster_wait_sec,
		        s.buffer_gets_delta buffer_gets, ROUND(s.buffer_gets_delta/NULLIF(s.executions_delta,0)) buffer_gets_per_exec,
		        s.disk_reads_delta disk_reads, ROUND(s.disk_reads_delta/NULLIF(s.executions_delta,0)) disk_reads_per_exec,
		        ROUND(s.physical_read_bytes_delta/1048576) phys_read_mb, s.rows_processed_delta rows_processed,
		        s.parse_calls_delta parse_calls, s.sorts_delta sorts
		   FROM `+awrFrom+` WHERE s.sql_id = '`+id+`'`+c.winSnap()+` ORDER BY sn.end_interval_time DESC) WHERE ROWNUM <= 500`)
	ps := c.runSec("awrplansum", "AWR 各执行计划对比（"+span+"）", "同一 SQL_ID 在窗口内每个 PLAN_HASH_VALUE 的汇总：哪个计划更快、逻辑读 / 物理读差多少。",
		`SELECT s.plan_hash_value, COUNT(*) snapshots, SUM(s.executions_delta) executions, ROUND(SUM(s.elapsed_time_delta)/1e6,2) elapsed_sec,
		        ROUND(SUM(s.elapsed_time_delta)/1e6/NULLIF(SUM(s.executions_delta),0),3) avg_sec, ROUND(SUM(s.cpu_time_delta)/1e6,2) cpu_sec,
		        ROUND(SUM(s.iowait_delta)/1e6,2) io_wait_sec, SUM(s.buffer_gets_delta) buffer_gets,
		        ROUND(SUM(s.buffer_gets_delta)/NULLIF(SUM(s.executions_delta),0)) logical_reads_per_exec, SUM(s.disk_reads_delta) disk_reads,
		        ROUND(SUM(s.disk_reads_delta)/NULLIF(SUM(s.executions_delta),0)) physical_reads_per_exec,
		        ROUND(SUM(s.rows_processed_delta)/NULLIF(SUM(s.executions_delta),0)) rows_per_exec,
		        TO_CHAR(MIN(sn.begin_interval_time),'YYYY-MM-DD HH24:MI') first_seen, TO_CHAR(MAX(sn.end_interval_time),'YYYY-MM-DD HH24:MI') last_seen
		   FROM `+awrFrom+` WHERE s.sql_id = '`+id+`'`+c.winSnap()+` GROUP BY s.plan_hash_value ORDER BY MAX(sn.end_interval_time) DESC`)

	var phvs []string
	for _, m := range ps.Maps() {
		if p := m["PLAN_HASH_VALUE"]; hasNum(p) && len(phvs) < 8 {
			phvs = append(phvs, p)
		}
	}
	if len(phvs) == 0 {
		c.put(Section{Key: "awrplan", Title: "AWR 历史计划明细", Note: "窗口内 AWR 没有该 SQL 的执行记录（可加大 --awr-days，或该 SQL 未被 AWR 采样）。"})
		c.put(Section{Key: "awrxplan", Title: "AWR 历史计划（DBMS_XPLAN）", Note: "同上。"})
		return
	}
	det := Section{Key: "awrplan", Title: "AWR 历史计划明细（每个计划）", Note: fmt.Sprintf("共 %d 个 PLAN_HASH_VALUE（最多取 8 个），每个计划最多 150 行。", len(phvs))}
	var xl [][]string
	for _, p := range phvs {
		cols, rows, err := c.q(`SELECT * FROM (SELECT p.plan_hash_value, p.id, p.parent_id, p.operation, p.options, p.object_owner, p.object_name, p.object_type,
		        p.cardinality e_rows, p.cost, p.access_predicates, p.filter_predicates, p.partition_start, p.partition_stop
		   FROM dba_hist_sql_plan p WHERE p.sql_id = '` + id + `' AND p.plan_hash_value = ` + p + ` ORDER BY p.id) WHERE ROWNUM <= 150`)
		if err != nil {
			det.Err = "采集失败：" + shortErr(err)
			c.s.Errors = append(c.s.Errors, det.Title+": "+shortErr(err))
			break
		}
		det.Cols = cols
		det.Rows = append(det.Rows, rows...)
		_, xr, xe := c.q(`SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('` + id + `', ` + p + `, NULL, 'TYPICAL'))`)
		xl = append(xl, []string{"==================== PLAN_HASH_VALUE " + p + " ===================="})
		if xe != nil {
			xl = append(xl, []string{"DISPLAY_AWR 失败: " + shortErr(xe)})
			continue
		}
		for _, x := range xr {
			xl = append(xl, []string{x[0]})
		}
		xl = append(xl, []string{""})
	}
	c.put(det)
	c.put(Section{Key: "awrxplan", Title: "AWR 历史计划（DBMS_XPLAN.DISPLAY_AWR）", Kind: "text", Cols: []string{"PLAN"}, Rows: xl,
		Note: "AWR 计划不含 A-Rows；逐个计划对比访问路径（INDEX / FULL、连接方式、分区裁剪）即可看出计划变化原因。"})
}
