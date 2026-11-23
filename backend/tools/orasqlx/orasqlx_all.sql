-- orasqlx 2.0.0 干跑：将对数据库执行的全部语句（只读 SELECT）
-- SQL_ID=f89vn14ybw1ta  示例表=APP.T1（真实运行时由执行计划动态决定；用 --dry-table OWNER.TABLE 替换）
-- 说明：只列出主路径语句；LONG/高版本列的降级备选语句仅在主语句失败时才会执行。
SET LINESIZE 400 PAGESIZE 200 LONG 4000 TRIMSPOOL ON

-- [1]
SELECT banner FROM v$version WHERE banner LIKE 'Oracle%' AND ROWNUM = 1;

-- [2]
SELECT version_full FROM v$instance;

-- [3]
SELECT name FROM v$database;

-- [4]
SELECT cdb FROM v$database;

-- [5]
SELECT SYS_CONTEXT('USERENV','CON_NAME'), SYS_CONTEXT('USERENV','CON_ID'), SYS_CONTEXT('USERENV','INSTANCE') FROM dual;

-- [6]
SELECT COUNT(*) FROM gv$instance;

-- [7]
SELECT 1 FROM dba_tables WHERE ROWNUM = 1;

-- [8]
SELECT i.inst_id, i.instance_name, i.host_name, i.version, d.name db_name,
	       d.cdb cdb,
	       SYS_CONTEXT('USERENV','CON_NAME') con_name, (SELECT COUNT(*) FROM gv$instance) instance_count
	  FROM gv$instance i, v$database d ORDER BY i.inst_id;

-- [9]
SELECT name, value, isdefault, LISTAGG(inst_id, ',') WITHIN GROUP (ORDER BY inst_id) inst_ids
		   FROM gv$parameter WHERE name IN ('OPTIMIZER_MODE','OPTIMIZER_FEATURES_ENABLE','OPTIMIZER_INDEX_COST_ADJ','OPTIMIZER_INDEX_CACHING','OPTIMIZER_DYNAMIC_SAMPLING','OPTIMIZER_ADAPTIVE_FEATURES','OPTIMIZER_ADAPTIVE_PLANS','OPTIMIZER_ADAPTIVE_STATISTICS','CURSOR_SHARING','DB_FILE_MULTIBLOCK_READ_COUNT','DB_BLOCK_SIZE','PARALLEL_DEGREE_POLICY','PARALLEL_FORCE_LOCAL','PARALLEL_MAX_SERVERS','PGA_AGGREGATE_TARGET','WORKAREA_SIZE_POLICY','STATISTICS_LEVEL','SGA_TARGET','CONTROL_MANAGEMENT_PACK_ACCESS','RESULT_CACHE_MODE','STAR_TRANSFORMATION_ENABLED','CELL_OFFLOAD_PROCESSING') GROUP BY name, value, isdefault ORDER BY name;

-- [10]
SELECT * FROM (SELECT inst_id, con_id, child_number, plan_hash_value, parsing_schema_name, module, action,
	       CASE command_type WHEN 3 THEN 'SELECT' WHEN 2 THEN 'INSERT' WHEN 6 THEN 'UPDATE' WHEN 7 THEN 'DELETE'
	            WHEN 189 THEN 'MERGE' WHEN 47 THEN 'PL/SQL' ELSE TO_CHAR(command_type) END sql_type,
	       executions, elapsed_time, cpu_time, user_io_wait_time, cluster_wait_time, application_wait_time,
	       concurrency_wait_time, buffer_gets, disk_reads, rows_processed, fetches, sorts, parse_calls,
	       is_bind_sensitive, is_bind_aware, first_load_time,
	       TO_CHAR(last_active_time,'YYYY-MM-DD HH24:MI:SS') last_active_time, sql_profile, sql_plan_baseline, sql_patch,
	       REPLACE(SUBSTR(sql_text,1,100), CHR(10), ' ') sql_text_short
	  FROM gv$sql WHERE sql_id = 'f89vn14ybw1ta' ORDER BY last_active_time DESC) WHERE ROWNUM <= 100;

-- [11]
SELECT NVL(SUM(executions),0), NVL(SUM(elapsed_time),0), NVL(SUM(cpu_time),0), NVL(SUM(user_io_wait_time),0),
	       NVL(SUM(cluster_wait_time),0), NVL(SUM(application_wait_time),0), NVL(SUM(concurrency_wait_time),0),
	       NVL(SUM(buffer_gets),0), NVL(SUM(disk_reads),0), NVL(SUM(rows_processed),0), NVL(SUM(fetches),0),
	       COUNT(*), COUNT(DISTINCT plan_hash_value) FROM gv$sql WHERE sql_id = 'f89vn14ybw1ta';

-- [12]
SELECT sql_text FROM gv$sqltext_with_newlines WHERE sql_id = 'f89vn14ybw1ta' AND inst_id = 1 ORDER BY piece;

-- [13]
SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('f89vn14ybw1ta', 0, 'ALLSTATS LAST +PEEKED_BINDS +PREDICATE +ALIAS +PARTITION'));

-- [14]
SELECT p.inst_id, p.con_id, p.child_number, p.plan_hash_value, p.id, p.parent_id, p.operation, p.options, p.object_owner,
		        p.object_name, p.object_type, p.cardinality e_rows, p.bytes, p.cost, p.cpu_cost, p.io_cost, p.temp_space,
		        p.partition_start, p.partition_stop, p.access_predicates, p.filter_predicates, p.qblock_name, p.depth
		   FROM gv$sql_plan p WHERE p.sql_id = 'f89vn14ybw1ta' AND ((p.inst_id = 1 AND p.child_number = 0)) ORDER BY p.inst_id, p.child_number, p.id;

-- [15]
SELECT p.inst_id, p.child_number, p.id, p.operation, p.options, p.object_name, p.cardinality e_rows,
		        p.last_output_rows a_rows, p.last_cr_buffer_gets, p.last_disk_reads, p.last_elapsed_time, p.last_starts
		   FROM gv$sql_plan_statistics_all p WHERE p.sql_id = 'f89vn14ybw1ta' AND ((p.inst_id = 1 AND p.child_number = 0))
		    AND p.last_output_rows IS NOT NULL ORDER BY p.inst_id, p.child_number, p.id;

-- [16]
SELECT * FROM (SELECT inst_id, child_number, name, position, datatype_string, value_string, was_captured,
		        TO_CHAR(last_captured,'YYYY-MM-DD HH24:MI:SS') last_captured
		   FROM gv$sql_bind_capture WHERE sql_id = 'f89vn14ybw1ta' AND ((inst_id = 1 AND child_number = 0)) ORDER BY inst_id, child_number, position) WHERE ROWNUM <= 200;

-- [17]
SELECT inst_id, plan_hash_value, COUNT(*) child_count, SUM(executions) executions,
		        ROUND(SUM(elapsed_time)/1e6, 2) elapsed_sec, ROUND(SUM(buffer_gets)/NULLIF(SUM(executions),0)) avg_buffer_gets,
		        MIN(first_load_time) first_load, TO_CHAR(MAX(last_active_time),'YYYY-MM-DD HH24:MI:SS') last_active
		   FROM gv$sql WHERE sql_id = 'f89vn14ybw1ta' GROUP BY inst_id, plan_hash_value ORDER BY inst_id, plan_hash_value;

-- [18]
SELECT * FROM (SELECT inst_id, NVL(event,'ON CPU') event, wait_class, COUNT(*) samples, COUNT(*) approx_sec
		   FROM gv$active_session_history WHERE sql_id = 'f89vn14ybw1ta' GROUP BY inst_id, NVL(event,'ON CPU'), wait_class
		   ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 20;

-- [19]
SELECT * FROM (SELECT h.instance_number, NVL(h.event,'ON CPU') event, h.wait_class, COUNT(*) samples, COUNT(*)*10 approx_sec,
		        ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 2) pct
		   FROM dba_hist_active_sess_history h WHERE h.sql_id = 'f89vn14ybw1ta' AND h.sample_time >= SYSDATE - 2
		  GROUP BY h.instance_number, NVL(h.event,'ON CPU'), h.wait_class ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 30;

-- [20]
SELECT * FROM (SELECT h.sql_plan_hash_value plan_hash_value, h.sql_plan_line_id line_id, h.sql_plan_operation operation,
		        h.sql_plan_options options, NVL(h.event,'ON CPU') event, COUNT(*) samples, COUNT(*)*10 approx_sec,
		        ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 2) pct
		   FROM dba_hist_active_sess_history h WHERE h.sql_id = 'f89vn14ybw1ta' AND h.sample_time >= SYSDATE - 2
		  GROUP BY h.sql_plan_hash_value, h.sql_plan_line_id, h.sql_plan_operation, h.sql_plan_options, NVL(h.event,'ON CPU')
		  ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 40;

-- [21]
SELECT o.owner object_owner, o.object_name, o.object_type, a.event, a.samples, a.samples*10 approx_sec
		   FROM (SELECT * FROM (SELECT h.current_obj# obj_id, NVL(h.event,'ON CPU') event, COUNT(*) samples
		           FROM dba_hist_active_sess_history h WHERE h.sql_id = 'f89vn14ybw1ta' AND h.current_obj# > 0 AND h.sample_time >= SYSDATE - 2
		          GROUP BY h.current_obj#, NVL(h.event,'ON CPU') ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 30) a
		   LEFT JOIN dba_objects o ON o.object_id = a.obj_id ORDER BY a.samples DESC;

-- [22]
SELECT * FROM (SELECT TO_CHAR(h.sample_time,'YYYY-MM-DD HH24') hour, COUNT(*) samples,
		        SUM(CASE WHEN h.session_state = 'ON CPU' THEN 1 ELSE 0 END) on_cpu,
		        SUM(CASE WHEN h.wait_class = 'User I/O' THEN 1 ELSE 0 END) user_io,
		        SUM(CASE WHEN h.wait_class = 'Cluster' THEN 1 ELSE 0 END) cluster_wait,
		        SUM(CASE WHEN h.session_state = 'WAITING' AND NVL(h.wait_class,'x') NOT IN ('User I/O','Cluster') THEN 1 ELSE 0 END) other_wait
		   FROM dba_hist_active_sess_history h WHERE h.sql_id = 'f89vn14ybw1ta' AND h.sample_time >= SYSDATE - 2
		  GROUP BY TO_CHAR(h.sample_time,'YYYY-MM-DD HH24') ORDER BY 1) WHERE ROWNUM <= 200;

-- [23]
SELECT * FROM (SELECT s.snap_id, TO_CHAR(sn.end_interval_time,'YYYY-MM-DD HH24:MI') end_interval_time, s.instance_number,
		        s.plan_hash_value, s.executions_delta executions, ROUND(s.elapsed_time_delta/1e6,2) elapsed_sec,
		        ROUND(s.elapsed_time_delta/1e6/NULLIF(s.executions_delta,0),4) avg_sec, ROUND(s.cpu_time_delta/1e6,2) cpu_sec,
		        ROUND(s.iowait_delta/1e6,2) io_wait_sec, ROUND(s.clwait_delta/1e6,2) cluster_wait_sec,
		        s.buffer_gets_delta buffer_gets, ROUND(s.buffer_gets_delta/NULLIF(s.executions_delta,0)) buffer_gets_per_exec,
		        s.disk_reads_delta disk_reads, ROUND(s.disk_reads_delta/NULLIF(s.executions_delta,0)) disk_reads_per_exec,
		        ROUND(s.physical_read_bytes_delta/1048576) phys_read_mb, s.rows_processed_delta rows_processed,
		        s.parse_calls_delta parse_calls, s.sorts_delta sorts
		   FROM dba_hist_sqlstat s JOIN dba_hist_snapshot sn ON sn.snap_id = s.snap_id AND sn.dbid = s.dbid AND sn.instance_number = s.instance_number WHERE s.sql_id = 'f89vn14ybw1ta' AND sn.end_interval_time >= SYSDATE - 2 ORDER BY sn.end_interval_time DESC) WHERE ROWNUM <= 500;

-- [24]
SELECT s.plan_hash_value, COUNT(*) snapshots, SUM(s.executions_delta) executions, ROUND(SUM(s.elapsed_time_delta)/1e6,2) elapsed_sec,
		        ROUND(SUM(s.elapsed_time_delta)/1e6/NULLIF(SUM(s.executions_delta),0),3) avg_sec, ROUND(SUM(s.cpu_time_delta)/1e6,2) cpu_sec,
		        ROUND(SUM(s.iowait_delta)/1e6,2) io_wait_sec, SUM(s.buffer_gets_delta) buffer_gets,
		        ROUND(SUM(s.buffer_gets_delta)/NULLIF(SUM(s.executions_delta),0)) logical_reads_per_exec, SUM(s.disk_reads_delta) disk_reads,
		        ROUND(SUM(s.disk_reads_delta)/NULLIF(SUM(s.executions_delta),0)) physical_reads_per_exec,
		        ROUND(SUM(s.rows_processed_delta)/NULLIF(SUM(s.executions_delta),0)) rows_per_exec,
		        TO_CHAR(MIN(sn.begin_interval_time),'YYYY-MM-DD HH24:MI') first_seen, TO_CHAR(MAX(sn.end_interval_time),'YYYY-MM-DD HH24:MI') last_seen
		   FROM dba_hist_sqlstat s JOIN dba_hist_snapshot sn ON sn.snap_id = s.snap_id AND sn.dbid = s.dbid AND sn.instance_number = s.instance_number WHERE s.sql_id = 'f89vn14ybw1ta' AND sn.end_interval_time >= SYSDATE - 2 GROUP BY s.plan_hash_value ORDER BY MAX(sn.end_interval_time) DESC;

-- [25]
SELECT t.owner, t.table_name, t.num_rows, t.blocks, t.avg_row_len, t.sample_size,
		        TO_CHAR(t.last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed, t.partitioned, t.temporary, TRIM(t.degree) degree,
		        s.stale_stats
		   FROM DBA_TABLES t LEFT JOIN DBA_TAB_STATISTICS s ON s.owner = t.owner AND s.table_name = t.table_name
		        AND s.object_type = 'TABLE' WHERE ((t.owner='APP' AND t.table_name='T1')) ORDER BY t.owner, t.table_name;

-- [26]
SELECT i.owner, i.index_name, i.table_name, i.index_type, i.uniqueness, i.status, i.partitioned,
		        CASE WHEN i.partitioned = 'YES' THEN p.locality ELSE 'NONPART' END locality, i.distinct_keys, i.leaf_blocks,
		        i.clustering_factor, i.num_rows, i.blevel, TO_CHAR(i.last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed, i.visibility
		   FROM DBA_INDEXES i LEFT JOIN DBA_PART_INDEXES p ON p.owner = i.owner AND p.index_name = i.index_name
		  WHERE ((i.table_owner='APP' AND i.table_name='T1')) ORDER BY i.table_name, i.index_name;

-- [27]
SELECT index_owner, index_name, table_name, column_position, column_name, descend
		   FROM DBA_IND_COLUMNS WHERE ((table_owner='APP' AND table_name='T1')) ORDER BY table_name, index_name, column_position;

-- [28]
SELECT index_owner, index_name, table_name, column_position, column_expression
		   FROM DBA_IND_EXPRESSIONS WHERE ((table_owner='APP' AND table_name='T1')) ORDER BY index_name, column_position;

-- [29]
SELECT k.owner, k.name, k.object_type, k.column_name, k.column_position, pt.partitioning_type, pt.subpartitioning_type
		   FROM DBA_PART_KEY_COLUMNS k JOIN DBA_PART_TABLES pt ON pt.owner = k.owner AND pt.table_name = k.name
		  WHERE k.object_type = 'TABLE' AND ((k.owner='APP' AND k.name='T1')) ORDER BY k.name, k.column_position;

-- [30]
SELECT * FROM (SELECT table_owner, table_name, partition_name, partition_position, high_value, num_rows, blocks,
		        TO_CHAR(last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed
		   FROM DBA_TAB_PARTITIONS WHERE ((table_owner='APP' AND table_name='T1')) ORDER BY table_name, partition_position) WHERE ROWNUM <= 200;

-- [31]
SELECT c.owner, c.table_name, c.column_id, c.column_name, c.data_type, c.data_length, c.data_precision,
	        c.data_scale, c.nullable, c.data_default FROM DBA_TAB_COLUMNS c WHERE ((c.owner='APP' AND c.table_name='T1')) ORDER BY c.owner, c.table_name, c.column_id;

-- [32]
SELECT cs.owner, cs.table_name, cs.column_name, cs.num_distinct ndv, cs.num_nulls, cs.density, cs.histogram,
		        cs.num_buckets, cs.avg_col_len, TO_CHAR(cs.last_analyzed,'YYYY-MM-DD HH24:MI') last_analyzed
		   FROM DBA_TAB_COL_STATISTICS cs WHERE ((cs.owner='APP' AND cs.table_name='T1')) AND cs.column_name IN ('')
		  ORDER BY cs.owner, cs.table_name, cs.column_name;

-- [33]
SELECT owner, table_name, constraint_name, constraint_type, status, index_name, r_constraint_name
		   FROM DBA_CONSTRAINTS WHERE constraint_type IN ('P','U','R') AND ((owner='APP' AND table_name='T1')) ORDER BY table_name, constraint_type;

-- [34]
SELECT owner, segment_name, segment_type, ROUND(SUM(bytes)/1048576,2) size_mb, COUNT(*) segments
			   FROM dba_segments WHERE segment_name IN ('T1') AND owner IN ('APP')
			  GROUP BY owner, segment_name, segment_type ORDER BY size_mb DESC;

-- [35]
SELECT owner, table_name, extension_name, creator, droppable, DBMS_LOB.SUBSTR(extension, 500, 1) extension
		   FROM DBA_STAT_EXTENSIONS WHERE ((owner='APP' AND table_name='T1')) ORDER BY table_name;

-- [36]
SELECT 'PROFILE', name, status, 'category='||category||' force_matching='||force_matching,
	      TO_CHAR(created,'YYYY-MM-DD HH24:MI') FROM dba_sql_profiles WHERE signature IN (SELECT exact_matching_signature FROM gv$sql WHERE sql_id = 'f89vn14ybw1ta') OR signature IN (SELECT force_matching_signature FROM gv$sql WHERE sql_id = 'f89vn14ybw1ta');

-- [37]
SELECT 'BASELINE', plan_name, CASE WHEN enabled='YES' AND accepted='YES' THEN 'ACTIVE' ELSE 'INACTIVE' END,
	      'handle='||sql_handle||' fixed='||fixed||' origin='||origin, TO_CHAR(created,'YYYY-MM-DD HH24:MI')
	      FROM dba_sql_plan_baselines WHERE signature IN (SELECT exact_matching_signature FROM gv$sql WHERE sql_id = 'f89vn14ybw1ta');

-- [38]
SELECT 'PATCH', name, status, 'category='||category, TO_CHAR(created,'YYYY-MM-DD HH24:MI')
		      FROM dba_sql_patches WHERE signature IN (SELECT exact_matching_signature FROM gv$sql WHERE sql_id = 'f89vn14ybw1ta');

-- [39]
SELECT DISTINCT 'DIRECTIVE', TO_CHAR(d.directive_id), d.state,
			      d.type||' '||d.reason||' on '||o.object_name||NVL2(o.subobject_name,'.'||o.subobject_name,''),
			      TO_CHAR(d.created,'YYYY-MM-DD HH24:MI')
			      FROM dba_sql_plan_directives d JOIN dba_sql_plan_dir_objects o ON o.directive_id = d.directive_id
			     WHERE ((o.owner='APP' AND o.object_name='T1'));

-- [40]
SELECT s.inst_id, s.sid, s.serial# serial_no, s.username, s.status, s.event, s.blocking_instance, s.blocking_session,
		        s.sql_id, s.last_call_et FROM gv$session s WHERE s.sql_id = 'f89vn14ybw1ta' AND ROWNUM <= 50 ORDER BY s.inst_id, s.sid;

-- [41]
SELECT * FROM (SELECT inst_id, child_number, operation_id, operation_type, policy,
		        ROUND(estimated_optimal_size/1048576,2) est_optimal_mb, ROUND(last_memory_used/1048576,2) last_mem_mb,
		        last_execution, total_executions, optimal_executions, onepass_executions, multipasses_executions,
		        ROUND(last_tempseg_size/1048576,2) last_temp_mb, ROUND(max_tempseg_size/1048576,2) max_temp_mb
		   FROM gv$sql_workarea WHERE sql_id = 'f89vn14ybw1ta' ORDER BY inst_id, child_number, operation_id) WHERE ROWNUM <= 100;
