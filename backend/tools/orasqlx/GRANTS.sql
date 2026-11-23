-- orasqlx 最小只读授权（DBA 执行）。工具只执行 SELECT；不需要 DBA 角色。
-- CDB 环境请在目标 PDB 内创建（或创建 common user 并 CONTAINER=ALL）。

CREATE USER orasqlx IDENTIFIED BY "<强密码>" PROFILE DEFAULT;   -- 建议单独 profile 限制并发会话 / CPU
GRANT CREATE SESSION TO orasqlx;

-- 方案一（推荐，简单）：目录只读角色，可读全部 V$/GV$/DBA_ 视图，不含业务表数据
GRANT SELECT_CATALOG_ROLE TO orasqlx;

-- 方案二（更严）：只授权实际用到的视图（把方案一换成下面这些）
-- GRANT SELECT ON sys.gv_$sql, sys.gv_$sql_plan, sys.gv_$sql_plan_statistics_all, sys.gv_$sql_bind_capture,
--       sys.gv_$sqltext_with_newlines, sys.gv_$session, sys.gv_$sql_workarea, sys.gv_$parameter, sys.gv_$instance,
--       sys.v_$version, sys.v_$instance, sys.v_$database TO orasqlx;
-- GRANT SELECT ON sys.dba_tables, sys.dba_tab_columns, sys.dba_tab_statistics, sys.dba_tab_col_statistics,
--       sys.dba_tab_histograms, sys.dba_indexes, sys.dba_ind_columns, sys.dba_ind_expressions, sys.dba_part_indexes,
--       sys.dba_part_tables, sys.dba_part_key_columns, sys.dba_tab_partitions, sys.dba_constraints,
--       sys.dba_segments, sys.dba_stat_extensions, sys.dba_sql_profiles, sys.dba_sql_plan_baselines TO orasqlx;
-- 12c+：GRANT SELECT ON sys.dba_sql_patches, sys.dba_sql_plan_directives, sys.dba_sql_plan_dir_objects TO orasqlx;

-- 可选：AWR / ASH（需 Diagnostics Pack 授权；无授权请不要授，或运行时加 --no-awr）
-- GRANT SELECT ON sys.gv_$active_session_history, sys.dba_hist_sqlstat, sys.dba_hist_snapshot, sys.dba_hist_sql_plan TO orasqlx;

-- 可选：--pdb 切换容器（common user 才需要）
-- GRANT SET CONTAINER TO orasqlx CONTAINER=ALL;

-- 可选：--sample 值频率采样（只对指定表授 SELECT）
-- GRANT SELECT ON <OWNER>.<TABLE> TO orasqlx;
