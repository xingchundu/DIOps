-- 系统配置展示名一体归位（CATEGORY / LABEL / DESCRIPTION）
-- 适用：曾执行 phase1/2/3 迁移、界面仍显示「阶段1交付/阶段2运维/阶段3 SSO」的环境
-- 修改者: dxc | 2026-11-12
-- 执行: sqlplus user/pass@db @migration_platform_ops_config_labels.sql

MERGE INTO SYS_CONFIG t USING (
  SELECT 'platform.enabled' k, '平台运维' cat, '平台运维闭环总开关' lbl, 'platform.enabled 总开关' d FROM DUAL UNION ALL
  SELECT 'notify.enabled', '通知外发', '告警 Webhook 外发', '轮询 OPEN 告警入队并 POST Webhook' FROM DUAL UNION ALL
  SELECT 'notify.poll_sec', '通知外发', '外发队列扫描周期(秒)', 'NotifyScheduler 扫描间隔' FROM DUAL UNION ALL
  SELECT 'backup.retention.job_enabled', '备份治理', '备份保留期清理(Node)', '按策略 RETENTION_DAYS 清理 SUCCESS 记录与文件' FROM DUAL UNION ALL
  SELECT 'governance.enabled', '数据与告警治理', '治理总开关', '数据保留/告警升级/维护窗作业' FROM DUAL UNION ALL
  SELECT 'retention.job_enabled', '数据生命周期', '统一数据保留清理', '平台表历史数据定时清理' FROM DUAL UNION ALL
  SELECT 'retention.batch_size', '数据生命周期', '每任务每轮最多删除行数', '单表单次 DELETE 上限' FROM DUAL UNION ALL
  SELECT 'retention.automation_exec_days', '数据生命周期', 'AUTOMATION_EXEC_LOG(天)', '自动化执行日志保留' FROM DUAL UNION ALL
  SELECT 'retention.script_exec_days', '数据生命周期', 'SCRIPT_EXEC_LOG(天)', '脚本执行日志保留' FROM DUAL UNION ALL
  SELECT 'retention.ai_chat_days', '数据生命周期', 'AI_CHAT_HISTORY(天)', 'AI 对话历史保留' FROM DUAL UNION ALL
  SELECT 'retention.inspect_result_days', '数据生命周期', 'INSPECT_RESULT(天)', '巡检结果保留' FROM DUAL UNION ALL
  SELECT 'retention.inspect_report_days', '数据生命周期', 'INSPECT_REPORT(天)', '巡检报告保留' FROM DUAL UNION ALL
  SELECT 'retention.di_anomaly_days', '数据生命周期', 'DI_SQL_ANOMALY(天)', 'SQL 波动事件保留' FROM DUAL UNION ALL
  SELECT 'retention.di_problem_days', '数据生命周期', 'DI_SQL_PROBLEM(天)', 'SQL 问题事件保留' FROM DUAL UNION ALL
  SELECT 'alert.escalation.enabled', '告警治理', '未认领告警升级', 'OPEN 超时未 ACK 自动升级' FROM DUAL UNION ALL
  SELECT 'alert.escalation.ack_timeout_min', '告警治理', 'OPEN未ACK超时(分钟)', '超时分钟数' FROM DUAL UNION ALL
  SELECT 'alert.escalation.bump_severity', '告警治理', '升级时提升级别', '如 P2 升为 P1' FROM DUAL UNION ALL
  SELECT 'alert.maintenance.enabled', '告警治理', '维护窗内静默告警', '维护时段内监控告警静默' FROM DUAL UNION ALL
  SELECT 'alert.maintenance.use_di_change_window', '告警治理', '联动 DI_CHANGE_WINDOW', 'SQL 洞察变更窗口联动' FROM DUAL UNION ALL
  SELECT 'backup.restore_drill.enabled', '备份治理', '恢复演练待办登记', 'Node 登记演练待办(不自动恢复)' FROM DUAL UNION ALL
  SELECT 'backup.restore_drill.interval_days', '备份治理', '演练登记周期(天)', '距上次成功备份登记周期' FROM DUAL UNION ALL
  SELECT 'platform.openapi.enabled', '平台能力', 'OpenAPI/Swagger', '暴露 OpenAPI 文档' FROM DUAL UNION ALL
  SELECT 'platform.sso.enabled', '平台能力', '企业 SSO 登录', 'LDAP/OIDC 登录' FROM DUAL UNION ALL
  SELECT 'platform.sso.mode', '平台能力', 'SSO 认证模式', 'LOCAL|LDAP|OIDC|LDAP_OIDC' FROM DUAL UNION ALL
  SELECT 'platform.sso.auto_provision', '平台能力', 'SSO 自动开户', '认证通过但无本地用户时创建账号' FROM DUAL UNION ALL
  SELECT 'platform.sso.default_role', '平台能力', '自动开户默认角色', '如 VIEWER' FROM DUAL UNION ALL
  SELECT 'platform.sso.ldap.url', '平台能力', 'LDAP 服务 URL', '如 ldap://dc.example.com:389' FROM DUAL UNION ALL
  SELECT 'platform.sso.ldap.user_dn_pattern', '平台能力', 'LDAP 绑定 DN 模板', '{username} 占位' FROM DUAL UNION ALL
  SELECT 'platform.sso.ldap.domain', '平台能力', 'LDAP 域名', '' FROM DUAL UNION ALL
  SELECT 'platform.sso.oidc.issuer', '平台能力', 'OIDC Issuer', '' FROM DUAL UNION ALL
  SELECT 'platform.sso.oidc.client_id', '平台能力', 'OIDC Client ID', '' FROM DUAL UNION ALL
  SELECT 'platform.sso.oidc.client_secret', '平台能力', 'OIDC Client Secret', '建议加密存储' FROM DUAL UNION ALL
  SELECT 'platform.sso.oidc.redirect_uri', '平台能力', 'OIDC 回调地址', '' FROM DUAL UNION ALL
  SELECT 'platform.sso.oidc.scopes', '平台能力', 'OIDC scopes', '默认 openid profile' FROM DUAL UNION ALL
  SELECT 'platform.health.enabled', '平台能力', '平台自监控', '定时采集健康快照' FROM DUAL UNION ALL
  SELECT 'platform.health.collect_warn_pct', '平台能力', '采集成功率告警阈值%', '' FROM DUAL UNION ALL
  SELECT 'platform.health.outbox_warn', '平台能力', '外发积压告警阈值', '' FROM DUAL UNION ALL
  SELECT 'platform.health.backup_fail_warn', '平台能力', '24h备份失败阈值', '' FROM DUAL UNION ALL
  SELECT 'platform.health.sqlinsight_open_warn', '平台能力', 'SQL洞察OPEN阈值', '' FROM DUAL
) s ON (t.CONFIG_KEY = s.k)
WHEN MATCHED THEN UPDATE SET
  t.CATEGORY = s.cat,
  t.LABEL = s.lbl,
  t.DESCRIPTION = NVL(NULLIF(TRIM(s.d), ''), s.lbl);

-- 旧键名（未跑 upgrade 时）
MERGE INTO SYS_CONFIG t USING (
  SELECT 'phase1.delivery.enabled' k, '通知外发' cat, '告警 Webhook 外发' lbl, '轮询 OPEN 告警入队并 POST Webhook' d FROM DUAL UNION ALL
  SELECT 'phase1.notify.poll_sec', '通知外发', '外发队列扫描周期(秒)', 'NotifyScheduler 扫描间隔' FROM DUAL UNION ALL
  SELECT 'phase1.backup_retention.enabled', '备份治理', '备份保留期清理(Node)', '按策略 RETENTION_DAYS 清理' FROM DUAL UNION ALL
  SELECT 'phase2.ops.enabled', '数据与告警治理', '治理总开关', '数据保留/告警升级/维护窗' FROM DUAL
) s ON (t.CONFIG_KEY = s.k)
WHEN MATCHED THEN UPDATE SET t.CATEGORY = s.cat, t.LABEL = s.lbl, t.DESCRIPTION = s.d;

COMMIT;
