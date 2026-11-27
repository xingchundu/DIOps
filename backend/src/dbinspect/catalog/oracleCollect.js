'use strict';
/**
 * Oracle（含 RAC）巡检项 —— 对应 collect_db.sql 的各小节，逐节拆成检查项，可单独启停 / 改阈值 / 改 SQL / 加入自建模板。
 *   · 全部使用 gv$ 视图，在任一实例上连接即可看到所有 RAC 节点（单实例库同样适用）。
 *   · INFO 类：只展示（证据表进入报告）；ROWS / THRESHOLD 类：规则引擎判定并生成问题项。
 *   · 带 SQL_ID 的检查项均 sqlBearing，SQL 洞察快照 / 报告里会带 sql_id。
 *   · 描述前缀 [DIAG] = 需要 Diagnostics Pack 许可；[TUNE] = Tuning Pack；[HEAVY] = 开销较大，默认不进“标准版”模板。
 */
const { ORA_SYS } = require('./core');

const ITEMS = [];
let seq = 200;
/**
 * @param {string} code 编码（ora.*）
 * @param {string} name 名称
 * @param {string} category 分类
 * @param {object} o { desc, rule, warn, crit, advice, sql, fallback, tags:[], sqlBearing, dimension, unit }
 */
function add(code, name, category, o) {
  const tags = o.tags || [];
  const prefix = tags.map((t) => `[${t}]`).join('');
  ITEMS.push({
    code, name, category, sort: seq++, sqlBearing: !!o.sqlBearing, dimension: o.dimension,
    desc: `${prefix}${prefix ? ' ' : ''}${o.desc || name}（对应 collect_db.sql ${o.sec || ''}）`.replace('（对应 collect_db.sql ）', ''),
    rule: o.rule || { type: 'INFO' }, warn: o.warn, crit: o.crit,
    advice: o.advice || '',
    impls: { ORACLE: { sql: o.sql.trim().replace(/\s+/g, ' '), fallback: o.fallback, unit: o.unit } },
    tags,
  });
}
const INFO = { type: 'INFO' };
const rows = (level = 'WARNING', extra = {}) => ({ type: 'ROWS', level, ...extra });

// ====================================================================== 00-03 环境 / 参数 / 内存
add('ora.env.instances', '实例与节点（RAC）', 'AVAILABILITY', { sec: '01', desc: '各节点实例状态、版本、启动时间', rule: INFO,
  sql: `SELECT 'inst'||inst_id AS OBJ, instance_name, host_name, status, database_status, version, TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') AS startup_time FROM gv$instance ORDER BY inst_id` });
add('ora.env.instance_down', 'RAC 节点实例非 OPEN', 'AVAILABILITY', { sec: '01', desc: '任一节点实例状态不是 OPEN 即异常', rule: rows('CRITICAL'),
  advice: '检查该节点 CRS 资源（crsctl stat res -t）、告警日志与 ASM 状态，必要时 srvctl start instance。',
  sql: `SELECT 'inst'||inst_id AS OBJ, status AS TXT, host_name FROM gv$instance WHERE status <> 'OPEN'` });
add('ora.env.database', '数据库基本信息', 'CONFIG', { sec: '01', desc: '库名、角色、打开模式、归档/强制日志/闪回、保护模式、CDB', rule: INFO,
  sql: `SELECT name AS OBJ, db_unique_name, database_role, open_mode, log_mode, force_logging, flashback_on, platform_name, protection_mode, cdb FROM v$database` });
add('ora.env.pdbs', 'PDB 状态', 'CONFIG', { sec: '01', desc: 'PDB 打开状态（非 READ WRITE 视为需关注）', rule: INFO,
  sql: `SELECT name AS OBJ, con_id, open_mode FROM v$pdbs ORDER BY con_id` });
add('ora.cfg.nls', '字符集与时区', 'CONFIG', { sec: '01', desc: '数据库字符集、国家字符集、时区', rule: INFO,
  sql: `SELECT parameter AS OBJ, value AS TXT FROM nls_database_parameters WHERE parameter IN ('NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET','NLS_LANGUAGE','NLS_TERRITORY') UNION ALL SELECT 'DBTIMEZONE', dbtimezone FROM dual` });
add('ora.cfg.spparameters', 'spfile 显式参数（含隐藏参数）', 'CONFIG', { sec: '02a', desc: 'spfile 中显式设置的全部参数，便于核对隐藏参数与异常调优', rule: INFO,
  sql: `SELECT name AS OBJ, sid, display_value AS TXT FROM v$spparameter WHERE isspecified = 'TRUE' ORDER BY name, sid` });
add('ora.cfg.rac_params', '关键参数各节点对比', 'CONFIG', { sec: '02b', desc: '内存 / 进程 / 优化器 / 并行 / Undo / RAC 关键参数，在各节点上的取值', rule: INFO,
  sql: `SELECT name AS OBJ, 'inst'||inst_id AS inst, value AS TXT FROM gv$parameter WHERE name IN ('sga_target','sga_max_size','pga_aggregate_target','pga_aggregate_limit','memory_target','use_large_pages','processes','sessions','transactions','cursor_sharing','optimizer_mode','optimizer_adaptive_plans','optimizer_adaptive_statistics','filesystemio_options','disk_asynch_io','db_writer_processes','db_block_checksum','statistics_level','undo_management','undo_tablespace','undo_retention','cluster_database','cluster_interconnects','gcs_server_processes','remote_login_passwordfile','parallel_max_servers','parallel_degree_policy','resource_manager_plan','job_queue_processes','audit_trail','open_cursors','session_cached_cursors','db_recovery_file_dest_size','fast_start_mttr_target','control_management_pack_access') ORDER BY name, inst_id` });
add('ora.cfg.param_diff', 'RAC 节点间关键参数不一致', 'CONFIG', { sec: '02b', desc: '同一参数在各节点取值不同（processes / sga_target / pga 等应一致）', rule: rows('WARNING'),
  advice: '除 instance_number / thread / undo_tablespace 等节点专属参数外，其余参数应各节点一致；用 ALTER SYSTEM SET … SID=\'*\' 统一。',
  sql: `SELECT name AS OBJ, COUNT(DISTINCT value) AS VAL, 'not same on nodes' AS TXT FROM gv$parameter WHERE name IN ('sga_target','sga_max_size','pga_aggregate_target','pga_aggregate_limit','memory_target','processes','sessions','cursor_sharing','optimizer_mode','db_writer_processes','statistics_level','undo_retention','open_cursors','session_cached_cursors','parallel_max_servers','job_queue_processes') GROUP BY name HAVING COUNT(DISTINCT value) > 1` });
add('ora.mem.sga', 'SGA 组成', 'PERFORMANCE', { sec: '03', desc: 'SGA 各部件大小', rule: INFO,
  sql: `SELECT 'inst'||inst_id AS OBJ, name, ROUND(bytes/1024/1024) AS mb FROM gv$sgainfo ORDER BY inst_id, name` });
add('ora.mem.sga_dynamic', 'SGA 动态组件', 'PERFORMANCE', { sec: '03', desc: '自动内存调整下各组件当前/最小/最大值', rule: INFO,
  sql: `SELECT 'inst'||inst_id AS OBJ, component, ROUND(current_size/1024/1024) AS mb, ROUND(min_size/1024/1024) AS min_mb, ROUND(max_size/1024/1024) AS max_mb, oper_count, last_oper_type FROM gv$sga_dynamic_components WHERE current_size > 0 ORDER BY inst_id, current_size DESC` });
add('ora.mem.pga', 'PGA 使用', 'PERFORMANCE', { sec: '03b', desc: 'PGA 目标、已分配、峰值、缓存命中', rule: INFO,
  sql: `SELECT 'inst'||inst_id AS OBJ, name, CASE WHEN unit='bytes' THEN ROUND(value/1024/1024,1) ELSE value END AS value_, CASE WHEN unit='bytes' THEN 'MB' ELSE unit END AS unit_ FROM gv$pgastat WHERE name IN ('aggregate PGA target parameter','aggregate PGA auto target','total PGA allocated','total PGA inuse','total freeable PGA memory','maximum PGA allocated','over allocation count','cache hit percentage') ORDER BY name, inst_id` });
add('ora.mem.pga_overalloc', 'PGA 超额分配', 'PERFORMANCE', { sec: '03b', desc: 'PGA over allocation count > 0 说明 pga_aggregate_target 偏小', rule: rows('WARNING'),
  advice: '增大 pga_aggregate_target（或核对 pga_aggregate_limit），并排查占用 PGA 的大排序/哈希 SQL。',
  sql: `SELECT 'inst'||inst_id AS OBJ, value AS VAL FROM gv$pgastat WHERE name = 'over allocation count' AND value > 0` });
add('ora.mem.sga_advice', 'SGA / 共享池 / PGA 顾问', 'PERFORMANCE', { sec: '03', desc: 'sga_target_advice、shared_pool_advice、pga_target_advice 摘要', rule: INFO,
  sql: `SELECT 'sga' AS OBJ, 'inst'||inst_id AS inst, sga_size AS size_mb, sga_size_factor AS factor, estd_db_time AS est_db_time, estd_physical_reads FROM gv$sga_target_advice WHERE sga_size_factor IN (0.5,1,1.5,2) UNION ALL SELECT 'pga', 'inst'||inst_id, ROUND(pga_target_for_estimate/1024/1024), pga_target_factor, estd_extra_bytes_rw, estd_overalloc_count FROM gv$pga_target_advice WHERE pga_target_factor IN (0.5,1,1.5,2)` });
add('ora.mem.sgastat_top', 'SGA 内存占用 Top 25', 'PERFORMANCE', { sec: '03', desc: 'gv$sgastat 占用最大的 25 项', rule: INFO,
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, pool, name, ROUND(bytes/1024/1024,1) AS mb FROM gv$sgastat ORDER BY bytes DESC) WHERE ROWNUM <= 25` });

// ====================================================================== 04 负载与等待
add('ora.perf.system_event', '实例启动以来 Top 等待（非 Idle）', 'PERFORMANCE', { sec: '04a', desc: '累计等待事件 Top 40', rule: INFO,
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, wait_class, event, total_waits, ROUND(time_waited_micro/1000) AS total_ms, ROUND(time_waited_micro/1000/NULLIF(total_waits,0),2) AS avg_ms, total_timeouts FROM gv$system_event WHERE wait_class <> 'Idle' ORDER BY time_waited_micro DESC) WHERE ROWNUM <= 40` });
add('ora.perf.time_model', '时间模型', 'PERFORMANCE', { sec: '04b', desc: 'DB time / DB CPU / 解析耗时占比', rule: INFO,
  sql: `SELECT 'inst'||inst_id AS OBJ, stat_name, ROUND(value/1e6) AS seconds FROM gv$sys_time_model WHERE stat_name IN ('DB time','DB CPU','sql execute elapsed time','parse time elapsed','hard parse elapsed time') ORDER BY inst_id, seconds DESC` });
add('ora.perf.ash_top', '最近 30 分钟 ASH Top 事件', 'PERFORMANCE', { sec: '04c', tags: ['DIAG'], desc: '活动会话历史采样的 Top 事件', rule: INFO,
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, NVL(wait_class,'CPU') AS wait_class, NVL(event,'ON CPU') AS event, COUNT(*) AS samples, ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 2) AS pct FROM gv$active_session_history WHERE sample_time > SYSTIMESTAMP - INTERVAL '30' MINUTE GROUP BY inst_id, NVL(wait_class,'CPU'), NVL(event,'ON CPU') ORDER BY samples DESC) WHERE ROWNUM <= 40` });
add('ora.perf.active_sessions', '当前活动会话（带 sql_id）', 'PERFORMANCE', { sec: '04d', desc: '正在等待的活动会话及其 SQL_ID', rule: INFO, sqlBearing: true, dimension: 'ACTIVE',
  sql: `SELECT * FROM (SELECT 'inst'||s.inst_id||':'||s.sid||','||s.serial# AS OBJ, s.username, s.service_name, s.program, s.event, s.wait_class, s.seconds_in_wait AS val, s.sql_id AS sql_id, s.blocking_instance, s.blocking_session, (SELECT SUBSTR(a.sql_text,1,300) FROM gv$sqlarea a WHERE a.sql_id = s.sql_id AND a.inst_id = s.inst_id AND ROWNUM = 1) AS sql_text FROM gv$session s WHERE s.status = 'ACTIVE' AND s.wait_class <> 'Idle' ORDER BY s.seconds_in_wait DESC) WHERE ROWNUM <= 60` });
add('ora.perf.sysmetric', '系统指标（最近 60 秒）', 'PERFORMANCE', { sec: '04e', desc: 'AAS、CPU、逻辑读/物理读/redo/事务/执行次数每秒', rule: INFO,
  sql: `SELECT metric_name AS OBJ, 'inst'||inst_id AS inst, ROUND(value,2) AS value_, metric_unit FROM gv$sysmetric WHERE group_id = 2 AND metric_name IN ('Average Active Sessions','Host CPU Utilization (%)','Database CPU Time Ratio','Database Wait Time Ratio','Logical Reads Per Sec','Physical Reads Per Sec','Redo Generated Per Sec','User Transaction Per Sec','Executions Per Sec','Logons Per Sec','Session Count') ORDER BY metric_name, inst_id` });
add('ora.perf.host_cpu', '主机 CPU 使用率（最近 60 秒）', 'RESOURCE', { sec: '04e', desc: '各节点 Host CPU Utilization', rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%' }, warn: 80, crit: 95,
  advice: '结合 ASH / Top SQL 判断是 SQL 还是主机上其它进程占用 CPU，必要时限流或扩容。',
  sql: `SELECT 'inst'||inst_id AS OBJ, ROUND(value,1) AS VAL FROM gv$sysmetric WHERE group_id = 2 AND metric_name = 'Host CPU Utilization (%)'` });
add('ora.perf.event_histogram', '关键等待事件延迟分布', 'PERFORMANCE', { sec: '04f', desc: 'log file sync / db file read / gc block 等事件的延迟直方', rule: INFO,
  sql: `SELECT event AS OBJ, 'inst'||inst_id AS inst, wait_time_milli, wait_count FROM gv$event_histogram WHERE event IN ('log file sync','log file parallel write','db file sequential read','db file scattered read','gc cr block 2-way','gc cr block 3-way','gc current block 2-way','gc current block 3-way','gc cr block busy','gc current block busy','gc buffer busy acquire','gc buffer busy release') AND wait_count > 0 ORDER BY event, inst_id, wait_time_milli` });
add('ora.perf.log_file_sync', 'log file sync 平均延迟', 'PERFORMANCE', { sec: '04a', desc: '提交等待的平均耗时，过高说明 redo 写盘慢', rule: { type: 'THRESHOLD', direction: 'HIGH', unit: 'ms' }, warn: 10, crit: 30,
  advice: '检查 redo 所在存储延迟、是否过度频繁提交（批量提交）、LGWR 是否被 CPU / IO 阻塞。',
  sql: `SELECT 'inst'||inst_id AS OBJ, ROUND(time_waited_micro/1000/NULLIF(total_waits,0),2) AS VAL, total_waits FROM gv$system_event WHERE event = 'log file sync' AND total_waits > 1000` });

// ====================================================================== 05 SQL
add('ora.sql.top_elapsed_gv', 'Top SQL：总耗时（全节点）', 'SQL', { sec: '05a', desc: '按总耗时 Top 30，含 SQL_ID、计划哈希、Cluster 等待', rule: { type: 'TOPN' }, sqlBearing: true, dimension: 'ELAPSED',
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, sql_id AS sql_id, plan_hash_value AS plan_hash, executions AS execs, ROUND(elapsed_time/1000) AS total_ms, ROUND(elapsed_time/NULLIF(executions,0)/1000,2) AS avg_ms, ROUND(cpu_time/1000) AS cpu_ms, buffer_gets AS logical_reads, disk_reads AS physical_reads, rows_processed AS rows_proc, ROUND(cluster_wait_time/1e6,1) AS cluster_s, parsing_schema_name AS schema_name, ROUND(elapsed_time/1000) AS val, SUBSTR(sql_text,1,500) AS sql_text FROM gv$sql WHERE executions > 0 AND parsing_schema_name NOT IN ('SYS','SYSTEM','DBSNMP','GSMADMIN_INTERNAL') ORDER BY elapsed_time DESC) WHERE ROWNUM <= 30` });
add('ora.sql.top_per_exec', 'Top SQL：单次耗时', 'SQL', { sec: '05b', desc: '按单次平均耗时 Top 20（执行过至少 1 次）', rule: { type: 'TOPN' }, sqlBearing: true, dimension: 'SLOW',
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, sql_id AS sql_id, plan_hash_value AS plan_hash, executions AS execs, ROUND(elapsed_time/1000) AS total_ms, ROUND(elapsed_time/NULLIF(executions,0)/1000,1) AS avg_ms, ROUND(cpu_time/NULLIF(executions,0)/1000,1) AS cpu_ms, buffer_gets AS logical_reads, disk_reads AS physical_reads, parsing_schema_name AS schema_name, ROUND(elapsed_time/NULLIF(executions,0)/1000,1) AS val, SUBSTR(sql_text,1,500) AS sql_text FROM gv$sql WHERE executions > 0 AND parsing_schema_name NOT IN ('SYS','SYSTEM','DBSNMP','GSMADMIN_INTERNAL') ORDER BY elapsed_time/NULLIF(executions,0) DESC) WHERE ROWNUM <= 20` });
add('ora.sql.top_cluster', 'Top SQL：Cluster 等待', 'SQL', { sec: '05c', desc: '按 RAC Cluster 等待时间 Top 20（节点间块传输开销大的 SQL）', rule: { type: 'TOPN' }, sqlBearing: true, dimension: 'CLUSTER',
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, sql_id AS sql_id, executions AS execs, ROUND(elapsed_time/1000) AS total_ms, ROUND(cluster_wait_time/1e6) AS cluster_s, ROUND(cluster_wait_time*100/NULLIF(elapsed_time,0),1) AS cluster_pct, ROUND(cluster_wait_time/1000) AS val, SUBSTR(sql_text,1,500) AS sql_text FROM gv$sqlstats WHERE cluster_wait_time > 0 ORDER BY cluster_wait_time DESC) WHERE ROWNUM <= 20` });
add('ora.sql.parse_stats', '解析与执行统计', 'SQL', { sec: '05d', desc: '解析总数 / 硬解析 / 执行次数 / 游标缓存命中等', rule: INFO,
  sql: `SELECT name AS OBJ, 'inst'||inst_id AS inst, value FROM gv$sysstat WHERE name IN ('parse count (total)','parse count (hard)','parse count (failures)','execute count','session cursor cache hits','user commits','user rollbacks','SQL*Net roundtrips to/from client') ORDER BY name, inst_id` });
add('ora.sql.hard_parse_ratio', '硬解析占比', 'SQL', { sec: '05d', desc: '硬解析次数 / 解析总数，过高说明字面量 SQL 多、绑定变量不足', rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%' }, warn: 10, crit: 30,
  advice: '推动应用使用绑定变量；必要时评估 cursor_sharing=FORCE（先在测试环境验证）。',
  sql: `SELECT 'inst'||inst_id AS OBJ, ROUND(hard*100/NULLIF(total,0),2) AS VAL, total, hard FROM (SELECT inst_id, SUM(DECODE(name,'parse count (total)',value)) AS total, SUM(DECODE(name,'parse count (hard)',value)) AS hard FROM gv$sysstat WHERE name IN ('parse count (total)','parse count (hard)') GROUP BY inst_id) WHERE total > 10000` });
add('ora.sql.library_cache', '库缓存命中与重载', 'SQL', { sec: '05e', desc: '各 namespace 命中率、reload、invalidation', rule: INFO,
  sql: `SELECT namespace AS OBJ, 'inst'||inst_id AS inst, gets, ROUND(gethitratio*100,2) AS hit_pct, pins, ROUND(pinhitratio*100,2) AS pin_hit_pct, reloads, invalidations FROM gv$librarycache ORDER BY reloads DESC` });
add('ora.sql.rowcache', '字典缓存 Top 20', 'SQL', { sec: '05e', desc: 'gv$rowcache 未命中最多的项', rule: INFO,
  sql: `SELECT * FROM (SELECT parameter AS OBJ, 'inst'||inst_id AS inst, gets, getmisses, ROUND(getmisses/NULLIF(gets,0)*100,2) AS miss_pct FROM gv$rowcache ORDER BY getmisses DESC) WHERE ROWNUM <= 20` });
add('ora.sql.monitor', '执行中的 SQL（SQL Monitor）', 'SQL', { sec: '05f', tags: ['TUNE'], desc: 'gv$sql_monitor 中正在执行的语句', rule: INFO, sqlBearing: true, dimension: 'MONITOR',
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, sql_id AS sql_id, status, ROUND(elapsed_time/1e6,1) AS elapsed_s, ROUND(cpu_time/1e6,1) AS cpu_s, buffer_gets AS logical_reads, disk_reads AS physical_reads, ROUND(elapsed_time/1000) AS val, SUBSTR(sql_text,1,500) AS sql_text FROM gv$sql_monitor WHERE status = 'EXECUTING') WHERE ROWNUM <= 20` });

// ====================================================================== 06 RAC / GC
add('ora.rac.interconnect', '集群互联网卡', 'HA', { sec: '06a', desc: 'gv$cluster_interconnects：确认互联使用私网（is_public = NO）', rule: INFO,
  sql: `SELECT 'inst'||inst_id AS OBJ, name, ip_address, is_public, source FROM gv$cluster_interconnects ORDER BY inst_id` });
add('ora.rac.interconnect_public', '集群互联走了公网', 'HA', { sec: '06a', desc: '互联网卡 is_public = YES 时 GC 流量与业务流量混跑', rule: rows('WARNING'),
  advice: '检查 oifcfg getif，将 cluster_interconnect 指向专用私网网卡，避免 GC 流量与业务共用。',
  sql: `SELECT 'inst'||inst_id AS OBJ, name AS TXT, ip_address FROM gv$cluster_interconnects WHERE is_public = 'YES'` });
add('ora.rac.gc_stats', 'GC 统计原值', 'HA', { sec: '06b', desc: 'gv$sysstat 中全部 gc 统计', rule: INFO,
  sql: `SELECT name AS OBJ, 'inst'||inst_id AS inst, value FROM gv$sysstat WHERE name LIKE 'gc %' ORDER BY name, inst_id` });
add('ora.rac.gc_latency', 'GC 块平均传输耗时', 'HA', { sec: '06c', desc: 'gc cr / current 块平均接收耗时（毫秒），反映私网与 LMS 健康度',
  rule: { type: 'THRESHOLD', direction: 'HIGH', unit: 'ms', objLabel: '节点/块类型' }, warn: 5, crit: 10,
  advice: '检查私网网卡带宽/丢包、MTU（建议巨型帧一致）、LMS 进程优先级与 CPU；排查热块与 Cluster 等待 SQL。',
  sql: `SELECT 'inst'||inst_id||' gc cr' AS OBJ, ROUND(SUM(DECODE(name,'gc cr block receive time',value))*10/NULLIF(SUM(DECODE(name,'gc cr blocks received',value)),0),2) AS VAL FROM gv$sysstat WHERE name IN ('gc cr blocks received','gc cr block receive time') GROUP BY inst_id UNION ALL SELECT 'inst'||inst_id||' gc current', ROUND(SUM(DECODE(name,'gc current block receive time',value))*10/NULLIF(SUM(DECODE(name,'gc current blocks received',value)),0),2) FROM gv$sysstat WHERE name IN ('gc current blocks received','gc current block receive time') GROUP BY inst_id` });
add('ora.rac.gc_lost', 'GC 丢块 / 坏块', 'HA', { sec: '06c', desc: 'gc blocks lost / corrupt 大于 0 说明私网丢包或硬件异常', rule: rows('CRITICAL'),
  advice: '立即检查私网网卡、交换机、线缆（netstat -s 丢包/重传），确认 MTU 与 UDP 缓冲区配置。',
  sql: `SELECT 'inst'||inst_id AS OBJ, SUM(DECODE(name,'gc blocks lost',value)) AS VAL, SUM(DECODE(name,'gc blocks corrupt',value)) AS CORRUPT FROM gv$sysstat WHERE name IN ('gc blocks lost','gc blocks corrupt') GROUP BY inst_id HAVING SUM(DECODE(name,'gc blocks lost',value)) > 0 OR SUM(DECODE(name,'gc blocks corrupt',value)) > 0` });
add('ora.rac.transfer', '块传输明细', 'HA', { sec: '06d', desc: 'gv$instance_cache_transfer：节点间 CR / Current 传输量与丢失', rule: INFO,
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, instance, class, cr_block, cr_busy, cr_congested, current_block, current_busy, current_congested, lost FROM gv$instance_cache_transfer WHERE cr_block + current_block + lost > 0 ORDER BY cr_block + current_block DESC) WHERE ROWNUM <= 50` });
add('ora.rac.gc_ash', 'GC 类等待（最近 60 分钟）', 'HA', { sec: '06e', tags: ['DIAG'], desc: 'ASH 中 gc 事件分布', rule: INFO,
  sql: `SELECT event AS OBJ, 'inst'||inst_id AS inst, COUNT(*) AS samples FROM gv$active_session_history WHERE sample_time > SYSTIMESTAMP - INTERVAL '60' MINUTE AND event LIKE 'gc%' GROUP BY inst_id, event ORDER BY samples DESC` });
add('ora.rac.cluster_wait_sql', 'Cluster 等待集中的对象和 SQL', 'HA', { sec: '06f', tags: ['DIAG'], desc: '最近 60 分钟 Cluster 类等待最多的 SQL_ID 与对象', rule: { type: 'TOPN' }, sqlBearing: true, dimension: 'CLUSTER',
  sql: `SELECT * FROM (SELECT 'inst'||h.inst_id AS OBJ, h.sql_id AS sql_id, h.event, o.owner AS schema_name, o.object_name, COUNT(*) AS val FROM gv$active_session_history h LEFT JOIN dba_objects o ON h.current_obj# = o.object_id WHERE h.sample_time > SYSTIMESTAMP - INTERVAL '60' MINUTE AND h.wait_class = 'Cluster' AND h.sql_id IS NOT NULL GROUP BY h.inst_id, h.event, h.sql_id, o.owner, o.object_name ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 30` });
add('ora.rac.xcur_blocks', '持有 xcur 块最多的对象', 'HA', { sec: '06g', tags: ['HEAVY'], desc: '缓存分布（不等于争用）', rule: INFO,
  sql: `SELECT * FROM (SELECT o.owner AS OBJ, o.object_name, o.object_type, bh.inst_id, COUNT(*) AS blocks FROM gv$bh bh, dba_objects o WHERE bh.objd = o.data_object_id AND bh.status = 'xcur' GROUP BY o.owner, o.object_name, o.object_type, bh.inst_id ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 20` });
add('ora.rac.sequence', '序列 cache 偏小或 ORDER', 'HA', { sec: '06h', desc: 'RAC 下序列 cache < 100 或 ORDER 会造成节点间争用', rule: rows('WARNING', { maxFindings: 20 }), warn: 1,
  advice: '热点序列 ALTER SEQUENCE … CACHE 1000 NOORDER；无严格顺序要求时避免 ORDER。',
  sql: `SELECT s.sequence_owner||'.'||s.sequence_name AS OBJ, s.cache_size AS VAL, s.order_flag AS TXT FROM dba_sequences s JOIN dba_users u ON s.sequence_owner = u.username WHERE u.oracle_maintained = 'N' AND (s.cache_size < 100 OR s.order_flag = 'Y') ORDER BY s.sequence_owner, s.sequence_name` });
add('ora.rac.segment_gc', '段级 GC 争用 Top 30', 'HA', { sec: '06i', tags: ['HEAVY'], desc: '实例启动以来累计，gc buffer busy / cr / current 最多的段', rule: INFO,
  sql: `SELECT * FROM (SELECT owner AS OBJ, 'inst'||inst_id AS inst, object_name, subobject_name, object_type, statistic_name, value FROM gv$segment_statistics WHERE statistic_name LIKE 'gc%' AND value > 0 AND owner NOT IN ('SYS','SYSTEM') ORDER BY value DESC) WHERE ROWNUM <= 30` });
add('ora.rac.hot_blocks', '热块（GC 等待集中）', 'HA', { sec: '06j', tags: ['DIAG'], desc: '最近 60 分钟 GC 等待集中的块', rule: INFO,
  sql: `SELECT * FROM (SELECT o.owner AS OBJ, o.object_name, h.current_file# AS file_id, h.current_block# AS block_id, h.event, COUNT(*) AS samples FROM gv$active_session_history h LEFT JOIN dba_objects o ON h.current_obj# = o.object_id WHERE h.sample_time > SYSTIMESTAMP - INTERVAL '60' MINUTE AND h.event LIKE 'gc%' GROUP BY o.owner, o.object_name, h.current_file#, h.current_block#, h.event ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 20` });
add('ora.rac.drm', '动态重主（DRM）次数最多的对象', 'HA', { sec: '06k', desc: 'v$gcspfmaster_info 中 remaster_cnt 最高的对象', rule: INFO,
  sql: `SELECT * FROM (SELECT NVL(o.owner,'-')||'.'||NVL(o.object_name, TO_CHAR(g.data_object_id)) AS OBJ, g.current_master, g.previous_master, g.remaster_cnt FROM v$gcspfmaster_info g LEFT JOIN dba_objects o ON g.data_object_id = o.data_object_id ORDER BY g.remaster_cnt DESC) WHERE ROWNUM <= 20` });

// ====================================================================== 07 Redo / 归档 / 控制文件
add('ora.redo.logs', 'Redo 日志组', 'STORAGE', { sec: '07', desc: '各线程 redo 组大小、成员数、状态', rule: INFO,
  sql: `SELECT 'thread'||thread# AS OBJ, group#, sequence#, ROUND(bytes/1024/1024,1) AS mb, members, status, archived FROM v$log ORDER BY thread#, group#` });
add('ora.redo.members', 'Redo 成员数不足', 'STORAGE', { sec: '07', desc: '每组 redo 建议至少 2 个成员（不同磁盘组）', rule: rows('WARNING'), warn: 1,
  advice: '为 redo 组增加镜像成员：ALTER DATABASE ADD LOGFILE MEMBER \'+FRA\' TO GROUP n。',
  sql: `SELECT 'group'||group# AS OBJ, members AS VAL, 'thread'||thread# AS TXT FROM v$log WHERE members < 2` });
add('ora.redo.switch_rate', '日志切换频率（最近 3 天峰值）', 'STORAGE', { sec: '07b', desc: '每小时日志切换次数峰值，过高说明 redo 过小或写入突增',
  rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '次/小时' }, warn: 12, crit: 30,
  advice: '加大 redo 组（建议每 15–30 分钟切换一次），并排查产生大量 redo 的批量作业。',
  sql: `SELECT 'thread'||thread# AS OBJ, MAX(cnt) AS VAL FROM (SELECT thread#, TO_CHAR(first_time,'YYYY-MM-DD HH24') AS hh, COUNT(*) AS cnt FROM v$log_history WHERE first_time > SYSDATE - 3 GROUP BY thread#, TO_CHAR(first_time,'YYYY-MM-DD HH24')) GROUP BY thread#` });
add('ora.redo.stats', 'Redo / 提交统计', 'STORAGE', { sec: '07', desc: 'redo size / writes / commits 等累计值', rule: INFO,
  sql: `SELECT name AS OBJ, 'inst'||inst_id AS inst, value FROM gv$sysstat WHERE name IN ('redo size','redo writes','redo write time','redo synch writes','redo synch time','redo blocks written','user commits','user rollbacks','execute count') ORDER BY name, inst_id` });
add('ora.cfg.controlfile', '控制文件冗余', 'CONFIG', { sec: '07c', desc: '控制文件至少 2 份（建议位于不同磁盘组）', rule: rows('WARNING'), warn: 1,
  advice: '增加控制文件副本（ALTER SYSTEM SET control_files=… SCOPE=SPFILE，复制后重启），分布在不同磁盘组。',
  sql: `SELECT 'controlfile' AS OBJ, COUNT(*) AS VAL FROM v$controlfile HAVING COUNT(*) < 2` });
add('ora.cfg.controlfile_list', '控制文件清单', 'CONFIG', { sec: '07c', desc: '控制文件位置', rule: INFO,
  sql: `SELECT name AS OBJ, status, is_recovery_dest_file, block_size, file_size_blks FROM v$controlfile` });
add('ora.redo.archive_dest', '归档目的地异常', 'BACKUP', { sec: '07d', desc: 'v$archive_dest 中状态为 ERROR 或带错误信息的目的地', rule: rows('CRITICAL'),
  advice: '检查目的地空间 / 网络 / 备库状态，修复后 ALTER SYSTEM ARCHIVE LOG CURRENT 验证。',
  sql: `SELECT 'dest'||dest_id AS OBJ, status AS TXT, destination, error FROM v$archive_dest WHERE status NOT IN ('INACTIVE','VALID') OR error IS NOT NULL` });
add('ora.redo.fra_usage', '恢复区各类文件占用', 'STORAGE', { sec: '07d', desc: 'v$recovery_area_usage', rule: INFO,
  sql: `SELECT file_type AS OBJ, percent_space_used, percent_space_reclaimable, number_of_files FROM v$recovery_area_usage` });
add('ora.redo.archive_daily', '最近 14 天每日归档量', 'STORAGE', { sec: '07e', desc: '用于评估 FRA 容量与备份窗口', rule: INFO,
  sql: `SELECT TO_CHAR(day,'YYYY-MM-DD') AS OBJ, 'thread'||thread# AS thread, COUNT(*) AS logs, ROUND(SUM(bytes)/1024/1024/1024,2) AS archived_gb FROM (SELECT DISTINCT thread#, sequence#, resetlogs_change#, TRUNC(completion_time) AS day, blocks*block_size AS bytes FROM v$archived_log WHERE standby_dest = 'NO' AND completion_time > SYSDATE - 14) GROUP BY day, thread# ORDER BY day, thread#` });

// ====================================================================== 08 Undo / 空间 / 对象
add('ora.undo.stat', 'Undo 使用（最近 20 个采样）', 'STORAGE', { sec: '08', desc: 'gv$undostat 最近采样', rule: INFO,
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, TO_CHAR(begin_time,'MM-DD HH24:MI') AS begin_time, undoblks, txncount, maxquerylen, maxconcurrency, unxpblkreuse, expblkrelcnt, nospaceerrcnt, ssolderrcnt FROM gv$undostat ORDER BY begin_time DESC) WHERE ROWNUM <= 20` });
add('ora.undo.errors', 'Undo 空间不足 / 快照过旧', 'STORAGE', { sec: '08', desc: '最近 24 小时 nospaceerrcnt / ssolderrcnt（ORA-30036 / ORA-01555）> 0', rule: rows('WARNING'),
  advice: '增大 undo 表空间或 undo_retention；排查长事务与长查询，避免 ORA-01555 / ORA-30036。',
  sql: `SELECT 'inst'||inst_id AS OBJ, MAX(nospaceerrcnt) AS VAL, MAX(ssolderrcnt) AS SNAPSHOT_TOO_OLD FROM gv$undostat WHERE begin_time > SYSDATE - 1 GROUP BY inst_id HAVING MAX(nospaceerrcnt) > 0 OR MAX(ssolderrcnt) > 0` });
add('ora.undo.extents', 'Undo 区间状态', 'STORAGE', { sec: '08', desc: 'ACTIVE / UNEXPIRED / EXPIRED 分布', rule: INFO,
  sql: `SELECT tablespace_name AS OBJ, status, ROUND(SUM(bytes)/1024/1024,1) AS mb FROM dba_undo_extents GROUP BY tablespace_name, status` });
add('ora.ts.usage_metrics', '表空间使用率（使用率排序）', 'STORAGE', { sec: '08b', desc: 'dba_tablespace_usage_metrics 按块换算，含大小/已用', rule: INFO,
  sql: `SELECT m.tablespace_name AS OBJ, ROUND(m.used_percent,2) AS used_pct, ROUND(m.tablespace_size*t.block_size/1024/1024,1) AS size_mb, ROUND(m.used_space*t.block_size/1024/1024,1) AS used_mb FROM dba_tablespace_usage_metrics m JOIN dba_tablespaces t ON m.tablespace_name = t.tablespace_name ORDER BY m.used_percent DESC` });
add('ora.ts.datafiles', '表空间数据文件汇总', 'STORAGE', { sec: '08b', desc: '各表空间数据文件总大小、文件数', rule: INFO,
  sql: `SELECT tablespace_name AS OBJ, ROUND(SUM(bytes)/1024/1024,1) AS mb, COUNT(*) AS files, MAX(autoextensible) AS autoext FROM dba_data_files GROUP BY tablespace_name ORDER BY 2 DESC` });
add('ora.temp.usage', '临时段使用（按用户）', 'STORAGE', { sec: '08b', desc: 'gv$tempseg_usage 按用户/类型汇总', rule: INFO,
  sql: `SELECT u.username AS OBJ, 'inst'||u.inst_id AS inst, u.segtype, ROUND(SUM(u.blocks*t.block_size)/1024/1024,1) AS mb, COUNT(*) AS segs FROM gv$tempseg_usage u JOIN dba_tablespaces t ON u.tablespace = t.tablespace_name GROUP BY u.inst_id, u.username, u.segtype ORDER BY 4 DESC` });
add('ora.seg.top', '最大的段 Top 20', 'STORAGE', { sec: '08c', tags: ['HEAVY'], desc: '占用空间最大的段', rule: INFO,
  sql: `SELECT owner||'.'||segment_name AS OBJ, segment_type, ROUND(bytes/1024/1024/1024,2) AS gb FROM dba_segments ORDER BY bytes DESC FETCH FIRST 20 ROWS ONLY` });
add('ora.tx.active', '活动事务（按开始时间，带 sql_id）', 'PERFORMANCE', { sec: '08d', desc: '最早的 20 个活动事务及占用 undo', rule: INFO, sqlBearing: true, dimension: 'TX',
  sql: `SELECT * FROM (SELECT 'inst'||t.inst_id||':'||s.sid||','||s.serial# AS OBJ, s.username, s.status, ROUND(t.used_ublk*(SELECT TO_NUMBER(value) FROM v$parameter WHERE name='db_block_size')/1024/1024,2) AS undo_mb, t.used_urec, TO_CHAR(t.start_date,'YYYY-MM-DD HH24:MI:SS') AS start_date, ROUND((SYSDATE - t.start_date)*86400) AS val, NVL(s.sql_id, s.prev_sql_id) AS sql_id, (SELECT SUBSTR(a.sql_text,1,300) FROM gv$sqlarea a WHERE a.sql_id = NVL(s.sql_id, s.prev_sql_id) AND a.inst_id = s.inst_id AND ROWNUM = 1) AS sql_text FROM gv$transaction t JOIN gv$session s ON s.inst_id = t.inst_id AND s.saddr = t.ses_addr ORDER BY t.start_date) WHERE ROWNUM <= 20` });
add('ora.obj.invalid_detail', '无效对象明细（非系统用户）', 'PERFORMANCE', { sec: '08f', desc: '业务用户的无效对象，最多 100 条', rule: rows('WARNING', { maxFindings: 20 }), warn: 1,
  advice: '执行 UTL_RECOMP.RECOMP_PARALLEL 或 ALTER … COMPILE，并排查引起失效的变更。',
  sql: `SELECT * FROM (SELECT o.owner||'.'||o.object_name AS OBJ, o.object_type AS TXT, TO_CHAR(o.last_ddl_time,'YYYY-MM-DD HH24:MI') AS last_ddl FROM dba_objects o JOIN dba_users u ON o.owner = u.username WHERE o.status = 'INVALID' AND o.object_name NOT LIKE 'BIN$%' AND u.oracle_maintained = 'N' ORDER BY o.owner, o.object_type, o.object_name) WHERE ROWNUM <= 100` });

// ====================================================================== 09 阻塞与锁
add('ora.lock.wait_chains', '等待链（v$wait_chains）', 'PERFORMANCE', { sec: '09', desc: '会话间的阻塞链', rule: INFO,
  sql: `SELECT * FROM (SELECT 'inst'||instance||':'||sid AS OBJ, blocker_instance, blocker_sid, wait_event_text, in_wait_secs, num_waiters FROM v$wait_chains ORDER BY in_wait_secs DESC NULLS LAST) WHERE ROWNUM <= 50` });
add('ora.lock.blocking_sessions', '被阻塞会话（带 sql_id）', 'PERFORMANCE', { sec: '09', desc: '正在被其他会话阻塞的会话，等待超过阈值秒数', rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '秒' }, warn: 30, crit: 300, sqlBearing: true, dimension: 'LOCK',
  advice: '定位最终阻塞者（final_blocking_session），确认其事务是否可提交 / 回滚，或联系应用方；必要时 kill 会话。',
  sql: `SELECT 'inst'||s.inst_id||':'||s.sid||','||s.serial# AS OBJ, s.username, s.event, s.wait_class, 'inst'||s.blocking_instance||':'||s.blocking_session AS blocker, 'inst'||s.final_blocking_instance||':'||s.final_blocking_session AS final_blocker, s.seconds_in_wait AS val, s.sql_id AS sql_id, (SELECT SUBSTR(a.sql_text,1,300) FROM gv$sqlarea a WHERE a.sql_id = s.sql_id AND a.inst_id = s.inst_id AND ROWNUM = 1) AS sql_text FROM gv$session s WHERE s.blocking_session IS NOT NULL ORDER BY s.seconds_in_wait DESC` });
add('ora.lock.locks', '阻塞类锁', 'PERFORMANCE', { sec: '09', desc: 'gv$lock 中 block=1 或在等待的锁（最多 30 条）', rule: INFO,
  sql: `SELECT * FROM (SELECT 'inst'||inst_id AS OBJ, type, id1, id2, lmode, request, ctime, block FROM gv$lock WHERE block = 1 OR request > 0 ORDER BY ctime DESC) WHERE ROWNUM <= 30` });

// ====================================================================== 10 服务 / 连接
add('ora.svc.services', '数据库服务定义', 'CONFIG', { sec: '10', desc: 'dba_services：FAN / TAF / 负载均衡目标', rule: INFO,
  sql: `SELECT name AS OBJ, network_name, goal, failover_method, failover_type, failover_retries, failover_delay, aq_ha_notifications, clb_goal FROM dba_services ORDER BY name` });
add('ora.svc.active', '服务在各节点的分布', 'HA', { sec: '10', desc: 'gv$active_services', rule: INFO,
  sql: `SELECT name AS OBJ, 'inst'||inst_id AS inst FROM gv$active_services ORDER BY name, inst_id` });
add('ora.svc.sessions', '各服务连接数', 'RESOURCE', { sec: '10', desc: '按节点与服务统计用户会话数', rule: INFO,
  sql: `SELECT service_name AS OBJ, 'inst'||inst_id AS inst, COUNT(*) AS conns FROM gv$session WHERE type = 'USER' GROUP BY inst_id, service_name ORDER BY 3 DESC` });
add('ora.svc.clients', '连接来源 Top 30', 'RESOURCE', { sec: '10', desc: '按服务/机器/程序统计连接数，发现连接泄漏', rule: INFO,
  sql: `SELECT * FROM (SELECT machine AS OBJ, 'inst'||inst_id AS inst, service_name, program, COUNT(*) AS cnt FROM gv$session WHERE type = 'USER' GROUP BY inst_id, service_name, machine, program ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 30` });
add('ora.res.limits', '资源上限使用率（含历史峰值）', 'RESOURCE', { sec: '14', desc: 'gv$resource_limit：sessions / processes / transactions 等的峰值占上限比例',
  rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%' }, warn: 80, crit: 90,
  advice: '峰值逼近上限时评估调大 processes / sessions / transactions（需重启）并排查连接泄漏。',
  sql: `SELECT 'inst'||inst_id||' '||resource_name AS OBJ, ROUND(max_utilization*100/TO_NUMBER(TRIM(limit_value)),1) AS VAL, current_utilization, max_utilization, TRIM(limit_value) AS limit_value FROM gv$resource_limit WHERE TRIM(limit_value) NOT IN ('UNLIMITED','0') AND REGEXP_LIKE(TRIM(limit_value),'^[0-9]+$') AND resource_name IN ('processes','sessions','transactions','enqueue_locks','enqueue_resources','parallel_max_servers','max_shared_servers')` });

// ====================================================================== 11 统计信息 / 自动任务 / 索引 / 作业
add('ora.stats.autotask', '自动维护任务', 'CONFIG', { sec: '11', desc: '统计信息收集 / 段顾问 / SQL 调优顾问任务开关与近 14 天运行情况', rule: INFO,
  sql: `SELECT c.client_name AS OBJ, c.status, h.job_status, COUNT(h.job_name) AS runs, MAX(h.job_start_time) AS last_start FROM dba_autotask_client c LEFT JOIN dba_autotask_job_history h ON h.client_name = c.client_name AND h.job_start_time > SYSTIMESTAMP - INTERVAL '14' DAY GROUP BY c.client_name, c.status, h.job_status` });
add('ora.stats.stats_job_disabled', '自动统计信息收集被禁用', 'CONFIG', { sec: '11', desc: 'auto optimizer stats collection 状态不是 ENABLED', rule: rows('WARNING'),
  advice: '执行 DBMS_AUTO_TASK_ADMIN.ENABLE(client_name=>\'auto optimizer stats collection\', operation=>NULL, window_name=>NULL) 恢复。',
  sql: `SELECT client_name AS OBJ, status AS TXT FROM dba_autotask_client WHERE client_name = 'auto optimizer stats collection' AND status <> 'ENABLED'` });
add('ora.stats.stale', '统计信息过期的表', 'PERFORMANCE', { sec: '11', desc: 'stale_stats = YES 的非系统表（按行数排序前 20）', rule: rows('WARNING', { maxFindings: 20 }), warn: 20,
  advice: '对大表按需 DBMS_STATS.GATHER_TABLE_STATS（并行、增量统计），避免执行计划劣化。',
  sql: `SELECT * FROM (SELECT owner||'.'||table_name AS OBJ, num_rows AS VAL, TO_CHAR(last_analyzed,'YYYY-MM-DD') AS last_analyzed FROM dba_tab_statistics WHERE stale_stats = 'YES' AND owner NOT IN ('SYS','SYSTEM') ORDER BY num_rows DESC NULLS LAST) WHERE ROWNUM <= 20` });
add('ora.stats.big_not_analyzed', '大表超过 7 天未收集统计信息', 'PERFORMANCE', { sec: '11e', tags: ['HEAVY'], desc: '段合计 ≥ 1 GB 且超过 7 天未分析的表', rule: rows('WARNING', { maxFindings: 20 }), warn: 1,
  advice: '核查统计信息是否被锁定（stattype_locked），按业务低峰收集统计。',
  sql: `SELECT * FROM (SELECT t.owner||'.'||t.table_name AS OBJ, ROUND(g.bytes/1024/1024/1024,1) AS VAL, TO_CHAR(t.last_analyzed,'YYYY-MM-DD') AS last_analyzed, t.stale_stats, t.stattype_locked FROM dba_tab_statistics t JOIN dba_users u ON t.owner = u.username JOIN (SELECT owner, segment_name, SUM(bytes) AS bytes FROM dba_segments WHERE segment_type IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION') GROUP BY owner, segment_name HAVING SUM(bytes) >= 1024*1024*1024) g ON g.owner = t.owner AND g.segment_name = t.table_name WHERE t.object_type = 'TABLE' AND u.oracle_maintained = 'N' AND (t.last_analyzed IS NULL OR t.last_analyzed < SYSDATE - 7) ORDER BY g.bytes DESC) WHERE ROWNUM <= 50` });
add('ora.idx.unusable', '不可用的索引', 'PERFORMANCE', { sec: '11b', desc: 'dba_indexes / 分区 / 子分区中状态为 UNUSABLE', rule: rows('CRITICAL', { maxFindings: 30 }), warn: 1,
  advice: 'ALTER INDEX … REBUILD [PARTITION …] ONLINE；排查 DDL（如 MOVE / SPLIT）后未重建的原因。',
  sql: `SELECT owner||'.'||index_name AS OBJ, table_name AS TXT FROM dba_indexes WHERE status = 'UNUSABLE' UNION ALL SELECT index_owner||'.'||index_name, partition_name FROM dba_ind_partitions WHERE status = 'UNUSABLE' UNION ALL SELECT index_owner||'.'||index_name, subpartition_name FROM dba_ind_subpartitions WHERE status = 'UNUSABLE'` });
add('ora.idx.low_usage', '使用记录最少的索引', 'PERFORMANCE', { sec: '11c', tags: ['HEAVY'], desc: 'dba_index_usage 记录最少的 50 个索引（默认抽样，无记录不等于未使用）', rule: INFO,
  sql: `SELECT * FROM (SELECT i.owner||'.'||i.index_name AS OBJ, i.table_name, u.total_access_count, TO_CHAR(u.last_used,'YYYY-MM-DD') AS last_used FROM dba_indexes i JOIN dba_users du ON i.owner = du.username LEFT JOIN dba_index_usage u ON i.owner = u.owner AND i.index_name = u.name WHERE du.oracle_maintained = 'N' AND i.index_type <> 'LOB' ORDER BY u.total_access_count NULLS FIRST, i.owner, i.index_name) WHERE ROWNUM <= 50` });
add('ora.idx.fk_no_index', '外键首列无索引', 'PERFORMANCE', { sec: '11d', tags: ['HEAVY'], desc: '外键首列没有对应前导索引列，主表更新易引发锁表', rule: rows('WARNING', { maxFindings: 20 }), warn: 1,
  advice: '为外键列建立索引（首列即外键列），避免父表 DML 时子表全表锁。',
  sql: `SELECT c.owner||'.'||c.table_name AS OBJ, c.constraint_name AS TXT FROM dba_constraints c JOIN dba_users u ON c.owner = u.username WHERE c.constraint_type = 'R' AND u.oracle_maintained = 'N' AND NOT EXISTS (SELECT 1 FROM dba_cons_columns cc JOIN dba_ind_columns ic ON ic.table_owner = cc.owner AND ic.table_name = cc.table_name AND ic.column_name = cc.column_name WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name AND cc.position = 1 AND ic.column_position = 1) ORDER BY c.owner, c.table_name` });
add('ora.job.scheduler_jobs', '业务调度任务状态', 'CONFIG', { sec: '11g', desc: '非系统用户的 DBMS_SCHEDULER 作业状态、失败次数', rule: INFO,
  sql: `SELECT j.owner||'.'||j.job_name AS OBJ, j.enabled, j.state, j.failure_count, j.run_count, TO_CHAR(j.last_start_date,'YYYY-MM-DD HH24:MI') AS last_start, TO_CHAR(j.next_run_date,'YYYY-MM-DD HH24:MI') AS next_run FROM dba_scheduler_jobs j JOIN dba_users u ON j.owner = u.username WHERE u.oracle_maintained = 'N' ORDER BY j.failure_count DESC, j.owner, j.job_name` });
add('ora.job.scheduler_failed', '调度任务近 7 天失败', 'CONFIG', { sec: '11h', desc: 'dba_scheduler_job_run_details 近 7 天状态非 SUCCEEDED', rule: rows('WARNING', { maxFindings: 20 }), warn: 1,
  advice: '查看 additional_info 与对应作业日志，修复后手工运行验证。',
  sql: `SELECT * FROM (SELECT owner||'.'||job_name AS OBJ, status AS TXT, error# AS VAL, TO_CHAR(actual_start_date,'YYYY-MM-DD HH24:MI') AS start_time, SUBSTR(additional_info,1,200) AS info FROM dba_scheduler_job_run_details WHERE status <> 'SUCCEEDED' AND actual_start_date > SYSTIMESTAMP - INTERVAL '7' DAY ORDER BY actual_start_date DESC) WHERE ROWNUM <= 100` });
add('ora.job.dbms_job', '旧式 DBMS_JOB 失败 / 中断', 'CONFIG', { sec: '11i', desc: 'dba_jobs 中 broken = Y 或 failures > 0', rule: rows('WARNING'), warn: 1,
  advice: '修复 what 中的语句后 DBMS_JOB.BROKEN(job,FALSE) 或重建任务。',
  sql: `SELECT TO_CHAR(job) AS OBJ, broken AS TXT, failures AS VAL, SUBSTR(what,1,100) AS what FROM dba_jobs WHERE broken = 'Y' OR failures > 0 ORDER BY failures DESC NULLS LAST` });

// ====================================================================== 12 ASM / 13 IO
add('ora.asm.diskgroups', 'ASM 磁盘组（详细）', 'STORAGE', { sec: '12', desc: '总容量 / 可用 / 可用文件空间 / 离线盘', rule: INFO,
  sql: `SELECT name AS OBJ, state, type, total_mb, free_mb, usable_file_mb, required_mirror_free_mb, offline_disks FROM v$asm_diskgroup_stat ORDER BY name` });
add('ora.asm.usable_low', 'ASM 可用文件空间不足', 'STORAGE', { sec: '12', desc: 'usable_file_mb 为负或接近 0，说明冗余重建空间不足', rule: { type: 'THRESHOLD', direction: 'LOW', unit: 'MB' }, warn: 10240, crit: 0,
  advice: '扩容磁盘组或清理空间；usable_file_mb 为负时磁盘故障后无法完成重平衡。',
  sql: `SELECT name AS OBJ, usable_file_mb AS VAL, total_mb, free_mb FROM v$asm_diskgroup_stat WHERE total_mb > 0` });
add('ora.asm.disk_errors', 'ASM 磁盘读写错误', 'STORAGE', { sec: '12b', desc: 'v$asm_disk_stat 中 read_errs / write_errs > 0', rule: rows('CRITICAL'),
  advice: '核对存储与多路径状态、系统日志，必要时替换磁盘。',
  sql: `SELECT name AS OBJ, path AS TXT, read_errs AS VAL, write_errs FROM v$asm_disk_stat WHERE read_errs > 0 OR write_errs > 0` });
add('ora.asm.disk_io', 'ASM 磁盘 IO Top 30', 'STORAGE', { sec: '12b', desc: '读写次数、延迟（read_time / write_time 单位秒，已换算为毫秒）', rule: INFO,
  sql: `SELECT * FROM (SELECT name AS OBJ, path, total_mb, free_mb, reads, writes, read_errs, write_errs, ROUND(read_time*1000/NULLIF(reads,0),3) AS avg_read_ms, ROUND(write_time*1000/NULLIF(writes,0),3) AS avg_write_ms FROM v$asm_disk_stat ORDER BY reads DESC) WHERE ROWNUM <= 30` });
add('ora.asm.operations', 'ASM 重平衡 / 操作', 'STORAGE', { sec: '12b', desc: 'v$asm_operation 正在进行的重平衡', rule: INFO,
  sql: `SELECT TO_CHAR(group_number) AS OBJ, operation, state, power, sofar, est_work, est_rate, est_minutes FROM v$asm_operation` });
add('ora.asm.attributes', 'ASM 磁盘组属性', 'CONFIG', { sec: '12b', desc: 'au_size / compatible / disk_repair_time 等', rule: INFO,
  sql: `SELECT TO_CHAR(group_number) AS OBJ, name, value FROM v$asm_attribute WHERE name IN ('au_size','compatible.asm','compatible.rdbms','sector_size','disk_repair_time','content.type')` });
add('ora.io.datafile_latency', '数据文件读延迟偏高', 'STORAGE', { sec: '13', desc: '数据文件平均读延迟（毫秒，readtim 为厘秒已换算），读次数超过 1000 的文件', rule: { type: 'THRESHOLD', direction: 'HIGH', unit: 'ms' }, warn: 20, crit: 50,
  advice: '核查该文件所在 ASM 磁盘 / 存储 LUN 的 IO 延迟与队列深度，排查是否有批量全表扫描。',
  sql: `SELECT * FROM (SELECT df.name AS OBJ, 'inst'||fs.inst_id AS inst, fs.phyrds, ROUND(fs.readtim*10/NULLIF(fs.phyrds,0),2) AS VAL, ROUND(fs.writetim*10/NULLIF(fs.phywrts,0),2) AS avg_write_ms FROM gv$filestat fs, gv$datafile df WHERE fs.file# = df.file# AND fs.inst_id = df.inst_id AND fs.phyrds > 1000 ORDER BY ROUND(fs.readtim*10/NULLIF(fs.phyrds,0),2) DESC NULLS LAST) WHERE ROWNUM <= 25` });
add('ora.io.datafile_top', '数据文件 IO Top 25', 'STORAGE', { sec: '13', desc: '读次数最多的数据文件', rule: INFO,
  sql: `SELECT * FROM (SELECT df.name AS OBJ, 'inst'||fs.inst_id AS inst, fs.phyrds, fs.phywrts, ROUND(fs.readtim*10/NULLIF(fs.phyrds,0),2) AS avg_read_ms, ROUND(fs.writetim*10/NULLIF(fs.phywrts,0),2) AS avg_write_ms, fs.maxiortm, fs.maxiowtm FROM gv$filestat fs, gv$datafile df WHERE fs.file# = df.file# AND fs.inst_id = df.inst_id ORDER BY fs.phyrds DESC) WHERE ROWNUM <= 25` });

// ====================================================================== 14 补丁 / 组件 / 账号
add('ora.patch.sqlpatch', '已应用补丁（SQL patch）', 'CONFIG', { sec: '14', desc: 'dba_registry_sqlpatch', rule: INFO,
  sql: `SELECT TO_CHAR(patch_id) AS OBJ, action, status, TO_CHAR(action_time,'YYYY-MM-DD HH24:MI') AS action_time, SUBSTR(description,1,100) AS description FROM dba_registry_sqlpatch ORDER BY action_time DESC` });
add('ora.patch.registry_history', '升级 / 补丁历史', 'CONFIG', { sec: '14', desc: 'dba_registry_history', rule: INFO,
  sql: `SELECT TO_CHAR(id) AS OBJ, action, version, TO_CHAR(action_time,'YYYY-MM-DD HH24:MI') AS action_time, SUBSTR(comments,1,100) AS comments FROM dba_registry_history ORDER BY action_time DESC` });
add('ora.patch.components_invalid', '数据库组件状态异常', 'CONFIG', { sec: '14', desc: 'dba_registry 中组件状态非 VALID', rule: rows('WARNING'),
  advice: '运行 datapatch -verbose 并检查 dba_registry_sqlpatch；必要时重新编译无效对象。',
  sql: `SELECT comp_id AS OBJ, comp_name||' '||version AS TXT, status AS VAL FROM dba_registry WHERE status NOT IN ('VALID','OPTION OFF')` });
add('ora.patch.components', '数据库组件', 'CONFIG', { sec: '14', desc: 'dba_registry 组件与版本', rule: INFO,
  sql: `SELECT comp_id AS OBJ, comp_name, version, status FROM dba_registry ORDER BY comp_id` });
add('ora.sec.account_status', '非 OPEN / 即将到期账号', 'SECURITY', { sec: '14b', desc: '非 Oracle 自带用户中状态非 OPEN 或 30 天内口令到期', rule: INFO,
  sql: `SELECT username AS OBJ, account_status, profile, TO_CHAR(lock_date,'YYYY-MM-DD') AS lock_date, TO_CHAR(expiry_date,'YYYY-MM-DD') AS expiry_date FROM dba_users WHERE oracle_maintained = 'N' AND (account_status <> 'OPEN' OR expiry_date < SYSDATE + 30) ORDER BY expiry_date NULLS LAST, username` });
add('ora.sec.default_pwd', '仍使用默认口令的 OPEN 账号', 'SECURITY', { sec: '14c', desc: 'dba_users_with_defpwd 中状态为 OPEN 的账号', rule: rows('CRITICAL', { maxFindings: 20 }), warn: 1,
  advice: '立即修改默认口令，不需要的账号加锁或删除。',
  sql: `SELECT d.username AS OBJ, u.account_status AS TXT FROM dba_users_with_defpwd d JOIN dba_users u ON d.username = u.username WHERE u.account_status = 'OPEN' ORDER BY d.username` });
add('ora.sec.profile_policy', 'Profile 口令策略', 'SECURITY', { sec: '14d', desc: '口令有效期、失败登录次数、校验函数', rule: INFO,
  sql: `SELECT profile AS OBJ, resource_name, limit FROM dba_profiles WHERE resource_name IN ('PASSWORD_LIFE_TIME','PASSWORD_GRACE_TIME','FAILED_LOGIN_ATTEMPTS','PASSWORD_LOCK_TIME','PASSWORD_VERIFY_FUNCTION') ORDER BY profile, resource_name` });

// ====================================================================== 15 备份 / DG / 告警日志
add('ora.backup.rman_jobs', 'RMAN 备份作业（最近 14 条）', 'BACKUP', { sec: '15', desc: 'v$rman_backup_job_details', rule: INFO,
  sql: `SELECT * FROM (SELECT TO_CHAR(session_key) AS OBJ, status, TO_CHAR(start_time,'YYYY-MM-DD HH24:MI') AS start_time, TO_CHAR(end_time,'YYYY-MM-DD HH24:MI') AS end_time, ROUND(input_bytes/1024/1024/1024,1) AS in_gb, ROUND(output_bytes/1024/1024/1024,1) AS out_gb, ROUND(elapsed_seconds/60) AS minutes, input_type FROM v$rman_backup_job_details ORDER BY start_time DESC) WHERE ROWNUM <= 14` });
add('ora.backup.rman_failed', 'RMAN 备份失败', 'BACKUP', { sec: '15', desc: '近 14 天状态为 FAILED 的备份作业', rule: rows('CRITICAL', { maxFindings: 10 }), warn: 1,
  advice: '查看 RMAN 日志与 v$rman_output，确认空间 / 介质 / 权限后重新备份。',
  sql: `SELECT TO_CHAR(session_key) AS OBJ, status AS TXT, input_type, TO_CHAR(start_time,'YYYY-MM-DD HH24:MI') AS start_time FROM v$rman_backup_job_details WHERE start_time > SYSDATE - 14 AND status LIKE 'FAILED%'` });
add('ora.backup.alert_errors', '告警日志错误（近 7 天）', 'LOG', { sec: '15b', tags: ['HEAVY'], desc: 'v$diag_alert_ext 仅读取当前节点 ADR，其它节点需分别连接巡检', rule: rows('WARNING', { maxFindings: 20 }), warn: 1,
  advice: '按 ORA- 错误号逐项核对 MOS，重点关注 Checkpoint not complete、cannot allocate new log、Deadlock、Reconfiguration。',
  sql: `SELECT * FROM (SELECT host_id AS OBJ, SUBSTR(message_text,1,200) AS TXT, TO_CHAR(originating_timestamp,'YYYY-MM-DD HH24:MI') AS happened FROM v$diag_alert_ext WHERE component_id = 'rdbms' AND originating_timestamp > SYSTIMESTAMP - INTERVAL '7' DAY AND REGEXP_LIKE(message_text,'ORA-|Checkpoint not complete|cannot allocate new log|Deadlock|LMS.*delay|Reconfiguration|Terminating the instance') ORDER BY originating_timestamp DESC) WHERE ROWNUM <= 200` });
add('ora.dg.status', 'Data Guard 目的地状态', 'HA', { sec: '15c', desc: '远程归档目的地的传输/应用进度', rule: INFO,
  sql: `SELECT dest_name AS OBJ, status, type, database_mode, recovery_mode, db_unique_name, archived_seq#, applied_seq#, synchronization_status, gap_status, error FROM v$archive_dest_status WHERE status <> 'INACTIVE' AND type <> 'LOCAL'` });
add('ora.dg.gap', 'Data Guard 归档缺口', 'HA', { sec: '15c', desc: '目的地存在 gap 或 v$archive_gap 有记录', rule: rows('CRITICAL'),
  advice: '检查网络与备库 MRP 进程，手工传输缺失归档并确认应用恢复。',
  sql: `SELECT dest_name AS OBJ, gap_status AS TXT, error FROM v$archive_dest_status WHERE status <> 'INACTIVE' AND type <> 'LOCAL' AND (gap_status NOT IN ('NO GAP','UNKNOWN') OR error IS NOT NULL) UNION ALL SELECT 'thread'||thread# AS OBJ, 'gap '||low_sequence#||'-'||high_sequence# AS TXT, NULL FROM v$archive_gap` });
add('ora.dg.stats', 'Data Guard 延迟统计', 'HA', { sec: '15c', desc: 'v$dataguard_stats（备库上有值）', rule: INFO,
  sql: `SELECT name AS OBJ, value, unit, time_computed FROM v$dataguard_stats` });

// ====================================================================== 16-17 AWR / 历史趋势
add('ora.awr.control', 'AWR 快照策略', 'CONFIG', { sec: '16', tags: ['DIAG'], desc: '快照间隔与保留期', rule: INFO,
  sql: `SELECT TO_CHAR(snap_interval) AS OBJ, TO_CHAR(retention) AS retention, topnsql FROM dba_hist_wr_control` });
add('ora.awr.snapshots', '最近 20 个 AWR 快照', 'CONFIG', { sec: '16', tags: ['DIAG'], desc: '确认快照正常产生', rule: INFO,
  sql: `SELECT * FROM (SELECT TO_CHAR(snap_id) AS OBJ, instance_number, TO_CHAR(begin_interval_time,'YYYY-MM-DD HH24:MI') AS begin_t, TO_CHAR(end_interval_time,'YYYY-MM-DD HH24:MI') AS end_t FROM dba_hist_snapshot ORDER BY snap_id DESC) WHERE ROWNUM <= 20` });
add('ora.awr.snapshot_stale', 'AWR 快照停止产生', 'CONFIG', { sec: '16', tags: ['DIAG'], desc: '最近一次快照距今超过 3 小时', rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '小时' }, warn: 3, crit: 12,
  advice: '检查 MMON 进程、SYSAUX 空间与 statistics_level，必要时 DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT 手工创建。',
  sql: `SELECT 'inst'||instance_number AS OBJ, ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(MAX(end_interval_time) AS DATE))*24,1) AS VAL FROM dba_hist_snapshot GROUP BY instance_number` });
add('ora.awr.baselines', 'AWR 基线', 'CONFIG', { sec: '16', tags: ['DIAG'], desc: 'dba_hist_baseline', rule: INFO,
  sql: `SELECT baseline_name AS OBJ, TO_CHAR(start_snap_id) AS start_snap, TO_CHAR(end_snap_id) AS end_snap, TO_CHAR(creation_time,'YYYY-MM-DD') AS created, expiration FROM dba_hist_baseline ORDER BY creation_time DESC` });
add('ora.awr.dbtime_daily', 'DB Time：最近 7 天按天', 'PERFORMANCE', { sec: '17a', tags: ['DIAG'], desc: '每日 DB Time / 平均 AAS / 峰值 AAS', rule: INFO,
  sql: `WITH t AS (SELECT sn.instance_number, sn.begin_interval_time, sn.end_interval_time, tm.value, LAG(tm.value) OVER (PARTITION BY sn.instance_number, sn.startup_time ORDER BY sn.snap_id) AS prev_value FROM dba_hist_snapshot sn JOIN dba_hist_sys_time_model tm ON tm.dbid = sn.dbid AND tm.snap_id = sn.snap_id AND tm.instance_number = sn.instance_number WHERE tm.stat_name = 'DB time' AND sn.dbid = (SELECT dbid FROM v$database) AND sn.end_interval_time > SYSTIMESTAMP - INTERVAL '7' DAY), d AS (SELECT instance_number, TO_CHAR(end_interval_time,'yyyy-mm-dd') AS day, (value - prev_value)/1e6 AS dbtime_s, (CAST(end_interval_time AS DATE) - CAST(begin_interval_time AS DATE))*86400 AS elapsed_s FROM t WHERE prev_value IS NOT NULL) SELECT day AS OBJ, 'inst'||instance_number AS inst, ROUND(SUM(dbtime_s)/60) AS dbtime_min, ROUND(SUM(dbtime_s)/NULLIF(SUM(elapsed_s),0),2) AS avg_aas, ROUND(MAX(dbtime_s/NULLIF(elapsed_s,0)),2) AS peak_aas FROM d GROUP BY day, instance_number ORDER BY day, instance_number` });
add('ora.awr.load_peak', '负载峰值（AAS / CPU 线程数）', 'PERFORMANCE', { sec: '17b', tags: ['DIAG'], desc: '最近 7 天按快照 load_pct = AAS / CPU 线程数（含等待，不是 CPU 使用率），取最高 20 个',
  rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '%' }, warn: 70, crit: 100,
  advice: '定位高峰时段的 Top SQL / 等待事件，评估限流、优化 SQL 或扩容 CPU。',
  sql: `SELECT * FROM (WITH tm AS (SELECT sn.snap_id, sn.instance_number, sn.begin_interval_time, sn.end_interval_time, t.value AS v, LAG(t.value) OVER (PARTITION BY sn.instance_number, sn.startup_time ORDER BY sn.snap_id) AS pv, (CAST(sn.end_interval_time AS DATE) - CAST(sn.begin_interval_time AS DATE))*1440 AS mins FROM dba_hist_snapshot sn JOIN dba_hist_sys_time_model t ON t.dbid = sn.dbid AND t.snap_id = sn.snap_id AND t.instance_number = sn.instance_number WHERE t.stat_name = 'DB time' AND sn.dbid = (SELECT dbid FROM v$database) AND sn.end_interval_time > SYSTIMESTAMP - INTERVAL '7' DAY), cpu AS (SELECT snap_id, instance_number, MAX(value) AS cpu_count FROM dba_hist_osstat WHERE stat_name = 'NUM_CPUS' AND dbid = (SELECT dbid FROM v$database) GROUP BY snap_id, instance_number) SELECT 'inst'||t.instance_number||' '||TO_CHAR(t.begin_interval_time,'MM-DD HH24:MI')||'-'||TO_CHAR(t.end_interval_time,'HH24:MI') AS OBJ, ROUND((t.v - t.pv)/1e6/60/t.mins/NULLIF(c.cpu_count,0)*100,2) AS VAL, ROUND((t.v - t.pv)/1e6/60/t.mins,2) AS aas, c.cpu_count FROM tm t LEFT JOIN cpu c ON c.snap_id = t.snap_id AND c.instance_number = t.instance_number WHERE t.pv IS NOT NULL AND t.mins > 0 ORDER BY 2 DESC NULLS LAST) WHERE ROWNUM <= 20` });
add('ora.awr.memory_trend', '内存趋势（按快照）', 'PERFORMANCE', { sec: '17c', tags: ['DIAG', 'HEAVY'], desc: 'SGA / PGA / 主机内存 / swap 趋势（MB）', rule: INFO,
  sql: `SELECT * FROM (WITH sn AS (SELECT dbid, snap_id, instance_number, end_interval_time FROM dba_hist_snapshot WHERE dbid = (SELECT dbid FROM v$database) AND end_interval_time > SYSTIMESTAMP - INTERVAL '7' DAY), pga AS (SELECT dbid, snap_id, instance_number, MAX(CASE WHEN name='aggregate PGA target parameter' THEN value END) AS target_bytes, MAX(CASE WHEN name='total PGA allocated' THEN value END) AS allocated_bytes, MAX(CASE WHEN name='maximum PGA allocated' THEN value END) AS max_bytes FROM dba_hist_pgastat GROUP BY dbid, snap_id, instance_number), os AS (SELECT dbid, snap_id, instance_number, MAX(CASE WHEN stat_name='PHYSICAL_MEMORY_BYTES' THEN value END) AS phys_bytes, MAX(CASE WHEN stat_name='FREE_MEMORY_BYTES' THEN value END) AS free_bytes, MAX(CASE WHEN stat_name='SWAP_FREE_BYTES' THEN value END) AS swap_free_bytes FROM dba_hist_osstat GROUP BY dbid, snap_id, instance_number) SELECT TO_CHAR(sn.snap_id) AS OBJ, 'inst'||sn.instance_number AS inst, TO_CHAR(sn.end_interval_time,'MM-DD HH24:MI') AS end_time, ROUND(pga.target_bytes/1048576) AS pga_target_mb, ROUND(pga.allocated_bytes/1048576) AS pga_alloc_mb, ROUND(pga.max_bytes/1048576) AS pga_max_mb, ROUND(os.phys_bytes/1048576) AS os_phys_mb, ROUND(os.free_bytes/1048576) AS os_free_mb, ROUND(os.swap_free_bytes/1048576) AS swap_free_mb FROM sn LEFT JOIN pga ON pga.dbid = sn.dbid AND pga.snap_id = sn.snap_id AND pga.instance_number = sn.instance_number LEFT JOIN os ON os.dbid = sn.dbid AND os.snap_id = sn.snap_id AND os.instance_number = sn.instance_number ORDER BY sn.snap_id DESC, sn.instance_number) WHERE ROWNUM <= 60` });
add('ora.awr.hist_wait', '历史等待（最近 3 天）', 'PERFORMANCE', { sec: '17d', tags: ['DIAG'], desc: 'dba_hist_active_sess_history 估算 DB Time 最多的事件', rule: INFO,
  sql: `SELECT * FROM (SELECT NVL(event,'ON CPU') AS OBJ, 'inst'||instance_number AS inst, COUNT(*)*10 AS est_db_time_s FROM dba_hist_active_sess_history WHERE sample_time > SYSDATE - 3 GROUP BY instance_number, NVL(event,'ON CPU') ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 30` });
add('ora.awr.top_sql_7d', '最近 7 天 Top SQL（AWR）', 'SQL', { sec: '17e', tags: ['DIAG'], desc: 'AWR 累计耗时最高的 SQL_ID，pct_captured 为占 AWR 已捕获 SQL 总耗时的比例', rule: { type: 'TOPN' }, sqlBearing: true, dimension: 'AWR',
  sql: `SELECT * FROM (SELECT st.sql_id AS sql_id, 'awr' AS OBJ, SUM(st.executions_delta) AS execs, ROUND(SUM(st.elapsed_time_delta)/1000) AS total_ms, ROUND(SUM(st.elapsed_time_delta)/NULLIF(SUM(st.executions_delta),0)/1000,2) AS avg_ms, ROUND(SUM(st.cpu_time_delta)/1000) AS cpu_ms, ROUND(SUM(st.iowait_delta)/1e6) AS io_s, ROUND(SUM(st.clwait_delta)/1e6) AS cluster_s, ROUND(RATIO_TO_REPORT(SUM(st.elapsed_time_delta)) OVER () * 100, 1) AS pct_captured, ROUND(SUM(st.elapsed_time_delta)/1000) AS val, (SELECT SUBSTR(DBMS_LOB.SUBSTR(x.sql_text,500,1),1,500) FROM dba_hist_sqltext x WHERE x.sql_id = st.sql_id AND x.dbid = st.dbid AND ROWNUM = 1) AS sql_text FROM dba_hist_sqlstat st JOIN dba_hist_snapshot sn ON sn.dbid = st.dbid AND sn.snap_id = st.snap_id AND sn.instance_number = st.instance_number WHERE st.dbid = (SELECT dbid FROM v$database) AND sn.end_interval_time > SYSTIMESTAMP - INTERVAL '7' DAY GROUP BY st.sql_id, st.dbid ORDER BY SUM(st.elapsed_time_delta) DESC) WHERE ROWNUM <= 30` });
add('ora.awr.mem_metric', '内存指标按天汇总', 'PERFORMANCE', { sec: '17f', tags: ['DIAG'], desc: 'Total PGA Allocated / Inuse / SGA Memory Used 最近 7 天均值、峰值', rule: INFO,
  sql: `SELECT TO_CHAR(s.end_interval_time,'YYYY-MM-DD') AS OBJ, 'inst'||s.instance_number AS inst, m.metric_name, ROUND(AVG(m.average),2) AS avg_value, ROUND(MAX(m.maxval),2) AS max_value, ROUND(MIN(m.minval),2) AS min_value FROM dba_hist_sysmetric_summary m JOIN dba_hist_snapshot s ON m.snap_id = s.snap_id AND m.dbid = s.dbid AND m.instance_number = s.instance_number WHERE s.end_interval_time >= SYSDATE - 7 AND s.dbid = (SELECT dbid FROM v$database) AND m.metric_name IN ('Total PGA Allocated','Total PGA Inuse','SGA Memory Used') GROUP BY TO_CHAR(s.end_interval_time,'YYYY-MM-DD'), s.instance_number, m.metric_name ORDER BY 1, 2, 3` });
add('ora.ts.growth', '表空间容量增长（最近 30 天）', 'STORAGE', { sec: '17h', tags: ['DIAG'], desc: '按天已用 / 增长（受 AWR 保留期限制）', rule: INFO,
  sql: `SELECT * FROM (WITH u AS (SELECT s.tablespace_id, TRUNC(CAST(sn.end_interval_time AS DATE)) AS day, MAX(s.tablespace_usedsize) AS used_blocks, MAX(s.tablespace_size) AS size_blocks FROM dba_hist_tbspc_space_usage s JOIN dba_hist_snapshot sn ON sn.dbid = s.dbid AND sn.snap_id = s.snap_id WHERE s.dbid = (SELECT dbid FROM v$database) AND sn.end_interval_time > SYSTIMESTAMP - INTERVAL '30' DAY GROUP BY s.tablespace_id, TRUNC(CAST(sn.end_interval_time AS DATE))) SELECT d.tablespace_name AS OBJ, TO_CHAR(u.day,'YYYY-MM-DD') AS day, ROUND(u.size_blocks*d.block_size/1024/1024/1024,2) AS size_gb, ROUND(u.used_blocks*d.block_size/1024/1024/1024,2) AS used_gb, ROUND((u.used_blocks - LAG(u.used_blocks) OVER (PARTITION BY d.tablespace_name ORDER BY u.day))*d.block_size/1024/1024/1024,2) AS growth_gb FROM u JOIN v$tablespace v ON v.ts# = u.tablespace_id JOIN dba_tablespaces d ON d.tablespace_name = v.name ORDER BY d.tablespace_name, u.day DESC) WHERE ROWNUM <= 90` });

// ====================================================================== 模板 =====
const heavy = (i) => i.tags.includes('HEAVY');
const diag = (i) => i.tags.includes('DIAG') || i.tags.includes('TUNE');
const CODES_ALL = ITEMS.map((i) => i.code);
const CODES_STD = ITEMS.filter((i) => !heavy(i)).map((i) => i.code);
const CODES_NO_LICENSE = ITEMS.filter((i) => !heavy(i) && !diag(i)).map((i) => i.code);
const RAC_ONLY = ITEMS.filter((i) => /^ora\.(rac|env\.instance|svc|cfg\.param_diff|perf\.log_file_sync)/.test(i.code) && !heavy(i)).map((i) => i.code);

const TEMPLATES = [
  {
    code: 'ora-collect-standard', name: 'Oracle RAC 全面巡检（collect_db 标准版）', kind: 'DAILY', families: ['ORACLE'],
    desc: '按 collect_db.sql 全部小节逐项采集并判定（含 RAC / GC / ASM / 备份 / DG / AWR 趋势）；不含标 [HEAVY] 的重型检查。含 [DIAG]/[TUNE] 项需相应许可，无许可请改用“不含 Pack 版”。',
    items: CODES_STD,
  },
  {
    code: 'ora-collect-nopack', name: 'Oracle 巡检（collect_db，不含 Diagnostics/Tuning Pack）', kind: 'DAILY', families: ['ORACLE'],
    desc: '同标准版，但剔除需要 Diagnostics / Tuning Pack 许可的小节（ASH、dba_hist_*、AWR、SQL Monitor）。',
    items: CODES_NO_LICENSE,
  },
  {
    code: 'ora-collect-full', name: 'Oracle 巡检（collect_db 全量，含重型检查）', kind: 'BASELINE', families: ['ORACLE'],
    desc: '包含全部 collect_db 小节，含 [HEAVY]（xcur 块、段级 GC、大段、索引使用、外键索引、大表统计、告警日志），建议低峰期执行。',
    items: CODES_ALL,
  },
  {
    code: 'ora-rac-special', name: 'Oracle RAC 专项（GC / 互联 / 服务）', kind: 'SPECIAL', families: ['ORACLE'],
    desc: '专项：节点状态、互联网卡、GC 平均传输耗时与丢块、Cluster 等待 SQL、序列、服务分布；告警中含 RAC / GC / 集群 / 互联 关键字时自动触发。',
    alertRules: ['RAC', 'GC', 'gc ', '集群', '互联', '节点', 'cluster', 'interconnect'],
    items: RAC_ONLY,
  },
];

module.exports = { ITEMS, TEMPLATES };
