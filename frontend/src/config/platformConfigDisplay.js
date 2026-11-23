/** 平台运维 SYS_CONFIG 展示元数据（与 migration_platform_ops_config_labels.sql 一致） */
const META = {
  'platform.enabled': { category: '平台运维', label: '平台运维闭环总开关' },
  'notify.enabled': { category: '通知外发', label: '告警 Webhook 外发' },
  'notify.poll_sec': { category: '通知外发', label: '外发队列扫描周期(秒)' },
  'backup.retention.job_enabled': { category: '备份治理', label: '备份保留期清理(Node)' },
  'governance.enabled': { category: '数据与告警治理', label: '治理总开关' },
  'retention.job_enabled': { category: '数据生命周期', label: '统一数据保留清理' },
  'retention.batch_size': { category: '数据生命周期', label: '每任务每轮最多删除行数' },
  'retention.automation_exec_days': { category: '数据生命周期', label: 'AUTOMATION_EXEC_LOG(天)' },
  'retention.script_exec_days': { category: '数据生命周期', label: 'SCRIPT_EXEC_LOG(天)' },
  'retention.ai_chat_days': { category: '数据生命周期', label: 'AI_CHAT_HISTORY(天)' },
  'retention.inspect_result_days': { category: '数据生命周期', label: 'INSPECT_RESULT(天)' },
  'retention.inspect_report_days': { category: '数据生命周期', label: 'INSPECT_REPORT(天)' },
  'retention.di_anomaly_days': { category: '数据生命周期', label: 'DI_SQL_ANOMALY(天)' },
  'retention.di_problem_days': { category: '数据生命周期', label: 'DI_SQL_PROBLEM(天)' },
  'alert.escalation.enabled': { category: '告警治理', label: '未认领告警升级' },
  'alert.escalation.ack_timeout_min': { category: '告警治理', label: 'OPEN未ACK超时(分钟)' },
  'alert.escalation.bump_severity': { category: '告警治理', label: '升级时提升级别' },
  'alert.maintenance.enabled': { category: '告警治理', label: '维护窗内静默告警' },
  'alert.maintenance.use_di_change_window': { category: '告警治理', label: '联动 DI_CHANGE_WINDOW' },
  'backup.restore_drill.enabled': { category: '备份治理', label: '恢复演练待办登记' },
  'backup.restore_drill.interval_days': { category: '备份治理', label: '演练登记周期(天)' },
  'platform.openapi.enabled': { category: '平台能力', label: 'OpenAPI/Swagger' },
  'platform.sso.enabled': { category: '平台能力', label: '企业 SSO 登录' },
  'platform.sso.mode': { category: '平台能力', label: 'SSO 认证模式' },
  'platform.sso.auto_provision': { category: '平台能力', label: 'SSO 自动开户' },
  'platform.sso.default_role': { category: '平台能力', label: '自动开户默认角色' },
  'platform.sso.ldap.url': { category: '平台能力', label: 'LDAP 服务 URL' },
  'platform.sso.ldap.user_dn_pattern': { category: '平台能力', label: 'LDAP 绑定 DN 模板' },
  'platform.sso.ldap.domain': { category: '平台能力', label: 'LDAP 域名' },
  'platform.sso.oidc.issuer': { category: '平台能力', label: 'OIDC Issuer' },
  'platform.sso.oidc.client_id': { category: '平台能力', label: 'OIDC Client ID' },
  'platform.sso.oidc.client_secret': { category: '平台能力', label: 'OIDC Client Secret' },
  'platform.sso.oidc.redirect_uri': { category: '平台能力', label: 'OIDC 回调地址' },
  'platform.sso.oidc.scopes': { category: '平台能力', label: 'OIDC scopes' },
  'platform.health.enabled': { category: '平台能力', label: '平台自监控' },
  'platform.health.collect_warn_pct': { category: '平台能力', label: '采集成功率告警阈值%' },
  'platform.health.outbox_warn': { category: '平台能力', label: '外发积压告警阈值' },
  'platform.health.backup_fail_warn': { category: '平台能力', label: '24h备份失败阈值' },
  'platform.health.sqlinsight_open_warn': { category: '平台能力', label: 'SQL洞察OPEN阈值' },
  'phase1.delivery.enabled': { category: '通知外发', label: '告警 Webhook 外发' },
  'phase1.notify.poll_sec': { category: '通知外发', label: '外发队列扫描周期(秒)' },
  'phase1.backup_retention.enabled': { category: '备份治理', label: '备份保留期清理(Node)' },
  'phase2.ops.enabled': { category: '数据与告警治理', label: '治理总开关' },
}

/** 旧 phase* 键 → 新键（与 migration_platform_ops_upgrade.sql 一致） */
const KEY_MIGRATE = {
  'phase1.delivery.enabled': 'notify.enabled',
  'phase1.notify.poll_sec': 'notify.poll_sec',
  'phase1.backup_retention.enabled': 'backup.retention.job_enabled',
  'phase2.ops.enabled': 'governance.enabled',
  'phase2.retention.enabled': 'retention.job_enabled',
  'phase2.retention.batch_size': 'retention.batch_size',
  'phase2.retention.automation_exec_days': 'retention.automation_exec_days',
  'phase2.retention.script_exec_days': 'retention.script_exec_days',
  'phase2.retention.ai_chat_days': 'retention.ai_chat_days',
  'phase2.retention.inspect_result_days': 'retention.inspect_result_days',
  'phase2.retention.inspect_report_days': 'retention.inspect_report_days',
  'phase2.retention.di_anomaly_days': 'retention.di_anomaly_days',
  'phase2.retention.di_problem_days': 'retention.di_problem_days',
  'phase2.escalation.enabled': 'alert.escalation.enabled',
  'phase2.escalation.ack_timeout_min': 'alert.escalation.ack_timeout_min',
  'phase2.escalation.bump_severity': 'alert.escalation.bump_severity',
  'phase2.maintenance.enabled': 'alert.maintenance.enabled',
  'phase2.maintenance.use_di_change_window': 'alert.maintenance.use_di_change_window',
  'phase2.restore_drill.enabled': 'backup.restore_drill.enabled',
  'phase2.restore_drill.interval_days': 'backup.restore_drill.interval_days',
  'phase3.delivery.enabled': 'platform.enabled',
  'phase3.openapi.enabled': 'platform.openapi.enabled',
  'phase3.sso.enabled': 'platform.sso.enabled',
  'phase3.sso.mode': 'platform.sso.mode',
  'phase3.sso.auto_provision': 'platform.sso.auto_provision',
  'phase3.sso.default_role': 'platform.sso.default_role',
  'phase3.sso.ldap.url': 'platform.sso.ldap.url',
  'phase3.sso.ldap.user_dn_pattern': 'platform.sso.ldap.user_dn_pattern',
  'phase3.sso.ldap.domain': 'platform.sso.ldap.domain',
  'phase3.sso.oidc.issuer': 'platform.sso.oidc.issuer',
  'phase3.sso.oidc.client_id': 'platform.sso.oidc.client_id',
  'phase3.sso.oidc.client_secret': 'platform.sso.oidc.client_secret',
  'phase3.sso.oidc.redirect_uri': 'platform.sso.oidc.redirect_uri',
  'phase3.sso.oidc.scopes': 'platform.sso.oidc.scopes',
  'phase3.health.enabled': 'platform.health.enabled',
  'phase3.health.collect_warn_pct': 'platform.health.collect_warn_pct',
  'phase3.health.outbox_warn': 'platform.health.outbox_warn',
  'phase3.health.backup_fail_warn': 'platform.health.backup_fail_warn',
  'phase3.health.sqlinsight_open_warn': 'platform.health.sqlinsight_open_warn',
}

export const PLATFORM_CONFIG_CATEGORY_ORDER = [
  '平台运维', '通知外发', '备份治理', '数据与告警治理', '数据生命周期', '告警治理', '平台能力',
]

const LEGACY = /^阶段[123]/

export function normalizePlatformConfigRow(row) {
  if (!row?.CONFIG_KEY) return row
  const canon = KEY_MIGRATE[row.CONFIG_KEY] || row.CONFIG_KEY
  const m = META[canon] || META[row.CONFIG_KEY]
  if (m) {
    return { ...row, CATEGORY: m.category, LABEL: m.label }
  }
  if (LEGACY.test(row.CATEGORY || '') || LEGACY.test(row.LABEL || '')) {
    return { ...row, CATEGORY: row.CATEGORY?.replace(LEGACY, '').trim() || row.CATEGORY, LABEL: row.DESCRIPTION || row.LABEL }
  }
  return row
}

export function normalizePlatformConfigRows(rows) {
  return (rows || []).map(normalizePlatformConfigRow)
}

export function sortConfigCategories(cats) {
  const order = PLATFORM_CONFIG_CATEGORY_ORDER
  return [...cats].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (ia === -1 && ib === -1) return String(a).localeCompare(String(b), 'zh-CN')
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}
