-- ============================================================================
-- Java 后端（dbops-server）配套迁移：可重复执行
-- 1. 新增系统配置 alert.auto_resolve（指标恢复后自动关闭告警）
-- 2. 新增默认告警规则「数据库实例不可达」（db_reachable < 1 持续 3 分钟）
--    —— Node 版实例连不上时根本不做告警评估，数据库宕机反而不告警
-- 3. 告警去重/自动恢复查询所需索引
-- ============================================================================

MERGE INTO SYS_CONFIG t USING (SELECT 'alert.auto_resolve' AS k FROM DUAL) s
ON (t.CONFIG_KEY = s.k)
WHEN NOT MATCHED THEN INSERT (CONFIG_KEY, CONFIG_VALUE, DEFAULT_VALUE, CATEGORY, LABEL, DESCRIPTION, VALUE_TYPE, MIN_VAL, MAX_VAL)
  VALUES ('alert.auto_resolve', '1', '1', '告警延迟', '指标恢复自动关闭告警', '1=指标不再满足规则条件时自动将告警置为 RESOLVED（RESOLVE_BY=SYSTEM）；0=只能人工关闭', 'BOOLEAN', NULL, NULL);

MERGE INTO ALERT_RULE t USING (SELECT '数据库实例不可达' AS n FROM DUAL) s
ON (t.RULE_NAME = s.n)
WHEN NOT MATCHED THEN INSERT (RULE_NAME, RULE_TYPE, METRIC, OPERATOR, THRESHOLD, DURATION, SEVERITY, DB_TYPE, ENABLED)
  VALUES ('数据库实例不可达', 'THRESHOLD', 'db_reachable', 'lt', 1, 3, 'P1', NULL, 1);

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX IDX_ALERT_RECORD_RULE_INST ON ALERT_RECORD (RULE_ID, INSTANCE_ID, STATUS)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE NOT IN (-955, -1408) THEN RAISE; END IF; END;
/

BEGIN
  EXECUTE IMMEDIATE 'CREATE INDEX IDX_MMS_INST_TIME ON MONITOR_METRIC_SAMPLE (INSTANCE_ID, COLLECTED_AT)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE NOT IN (-955, -1408) THEN RAISE; END IF; END;
/

COMMIT;
