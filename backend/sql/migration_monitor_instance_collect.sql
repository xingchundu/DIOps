-- [dxc][2026-10-17][新增] 实例级监控采集间隔（秒）；NULL/0=仅参与全局限制定时任务
-- 执行: sqlplus user/pass@db @migration_monitor_instance_collect.sql

BEGIN
  EXECUTE IMMEDIATE 'ALTER TABLE CMDB_INSTANCE ADD (COLLECT_INTERVAL_SEC NUMBER DEFAULT 0)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE NOT IN (-1430, -942) THEN RAISE; END IF;
END;
/

COMMENT ON COLUMN CMDB_INSTANCE.COLLECT_INTERVAL_SEC IS '本实例自动采集间隔(秒)，>0 时由 monitor 调度；0 表示仅用全局限频';

COMMIT;
