-- =============================================================================
-- 从 PHASE1_/PHASE2_/PHASE3_ 旧表升级到一体表名（保留数据）
-- 修改者: dxc | 时间: 2026-11-12
-- 执行顺序：先本脚本，再 migration_platform_ops.sql 中 MERGE 配置（若未执行过新脚本）
-- =============================================================================

DECLARE
  PROCEDURE try_rename(old_name VARCHAR2, new_name VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE 'ALTER TABLE ' || old_name || ' RENAME TO ' || new_name;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLCODE = -942 THEN NULL; ELSE
        IF SQLCODE = -955 THEN NULL; ELSE RAISE; END IF;
      END IF;
  END;
BEGIN
  try_rename('PHASE1_NOTIFY_CHANNEL', 'NOTIFY_CHANNEL');
  try_rename('PHASE1_NOTIFY_OUTBOX', 'NOTIFY_OUTBOX');
  try_rename('PHASE1_BACKUP_RETENTION_LOG', 'BACKUP_RETENTION_LOG');
  try_rename('PHASE2_RETENTION_RUN', 'DATA_RETENTION_RUN');
  try_rename('PHASE2_ESCALATION_LOG', 'ALERT_ESCALATION_LOG');
  try_rename('PHASE2_MAINTENANCE_SILENCE_LOG', 'ALERT_MAINTENANCE_SILENCE_LOG');
  try_rename('PHASE2_MONITOR_MAINTENANCE', 'ALERT_MAINTENANCE_WINDOW');
  try_rename('PHASE2_RESTORE_DRILL', 'BACKUP_RESTORE_DRILL');
  try_rename('PHASE3_SSO_LOGIN_LOG', 'SSO_LOGIN_LOG');
END;
/

-- 配置键迁移（旧 → 新）
UPDATE SYS_CONFIG SET CONFIG_KEY = 'notify.enabled' WHERE CONFIG_KEY = 'phase1.delivery.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'notify.poll_sec' WHERE CONFIG_KEY = 'phase1.notify.poll_sec';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'backup.retention.job_enabled' WHERE CONFIG_KEY = 'phase1.backup_retention.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'governance.enabled' WHERE CONFIG_KEY = 'phase2.ops.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.job_enabled' WHERE CONFIG_KEY = 'phase2.retention.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.batch_size' WHERE CONFIG_KEY = 'phase2.retention.batch_size';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.automation_exec_days' WHERE CONFIG_KEY = 'phase2.retention.automation_exec_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.script_exec_days' WHERE CONFIG_KEY = 'phase2.retention.script_exec_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.ai_chat_days' WHERE CONFIG_KEY = 'phase2.retention.ai_chat_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.inspect_result_days' WHERE CONFIG_KEY = 'phase2.retention.inspect_result_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.inspect_report_days' WHERE CONFIG_KEY = 'phase2.retention.inspect_report_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.di_anomaly_days' WHERE CONFIG_KEY = 'phase2.retention.di_anomaly_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'retention.di_problem_days' WHERE CONFIG_KEY = 'phase2.retention.di_problem_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'alert.escalation.enabled' WHERE CONFIG_KEY = 'phase2.escalation.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'alert.escalation.ack_timeout_min' WHERE CONFIG_KEY = 'phase2.escalation.ack_timeout_min';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'alert.escalation.bump_severity' WHERE CONFIG_KEY = 'phase2.escalation.bump_severity';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'alert.maintenance.enabled' WHERE CONFIG_KEY = 'phase2.maintenance.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'alert.maintenance.use_di_change_window' WHERE CONFIG_KEY = 'phase2.maintenance.use_di_change_window';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'backup.restore_drill.enabled' WHERE CONFIG_KEY = 'phase2.restore_drill.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'backup.restore_drill.interval_days' WHERE CONFIG_KEY = 'phase2.restore_drill.interval_days';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.enabled' WHERE CONFIG_KEY = 'phase3.delivery.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.openapi.enabled' WHERE CONFIG_KEY = 'phase3.openapi.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.enabled' WHERE CONFIG_KEY = 'phase3.sso.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.mode' WHERE CONFIG_KEY = 'phase3.sso.mode';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.auto_provision' WHERE CONFIG_KEY = 'phase3.sso.auto_provision';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.default_role' WHERE CONFIG_KEY = 'phase3.sso.default_role';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.ldap.url' WHERE CONFIG_KEY = 'phase3.sso.ldap.url';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.ldap.user_dn_pattern' WHERE CONFIG_KEY = 'phase3.sso.ldap.user_dn_pattern';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.ldap.domain' WHERE CONFIG_KEY = 'phase3.sso.ldap.domain';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.oidc.issuer' WHERE CONFIG_KEY = 'phase3.sso.oidc.issuer';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.oidc.client_id' WHERE CONFIG_KEY = 'phase3.sso.oidc.client_id';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.oidc.client_secret' WHERE CONFIG_KEY = 'phase3.sso.oidc.client_secret';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.oidc.redirect_uri' WHERE CONFIG_KEY = 'phase3.sso.oidc.redirect_uri';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.sso.oidc.scopes' WHERE CONFIG_KEY = 'phase3.sso.oidc.scopes';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.health.enabled' WHERE CONFIG_KEY = 'phase3.health.enabled';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.health.collect_warn_pct' WHERE CONFIG_KEY = 'phase3.health.collect_warn_pct';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.health.outbox_warn' WHERE CONFIG_KEY = 'phase3.health.outbox_warn';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.health.backup_fail_warn' WHERE CONFIG_KEY = 'phase3.health.backup_fail_warn';
UPDATE SYS_CONFIG SET CONFIG_KEY = 'platform.health.sqlinsight_open_warn' WHERE CONFIG_KEY = 'phase3.health.sqlinsight_open_warn';

-- 配置展示名归位（见 migration_platform_ops_config_labels.sql，建议本脚本 COMMIT 后立即执行）
COMMIT;
