# 平台运维闭环（一体设计）

通知外发、数据治理、告警升级、备份演练、SSO、自监控同属 **平台运维** 能力，不再区分「阶段 1/2/3」。

## 数据库

| 场景 | 脚本 |
|------|------|
| 新环境（推荐） | 仅执行 `backend/sql/init.sql`（`pack-offline.sh` 会按 `init-merge.list` 自动并入 `migration_platform_ops*.sql`） |
| 新环境（只跑增量） | `migration_platform_ops.sql` + `migration_platform_ops_config_labels.sql` |
| 曾执行 `PHASE*` 旧迁移 | 先 `migration_platform_ops_upgrade.sql`，再 `migration_platform_ops_config_labels.sql` |

### 核心表

| 表 | 用途 |
|----|------|
| `NOTIFY_CHANNEL` / `NOTIFY_OUTBOX` | 告警 Webhook 外发 |
| `BACKUP_RETENTION_LOG` | 备份保留期清理 |
| `DATA_RETENTION_RUN` | 平台数据生命周期 |
| `ALERT_ESCALATION_LOG` | 告警升级 |
| `ALERT_MAINTENANCE_WINDOW` / `ALERT_MAINTENANCE_SILENCE_LOG` | 维护窗静默 |
| `BACKUP_RESTORE_DRILL` | 恢复演练待办 |
| `PLATFORM_HEALTH_SNAPSHOT` | 自监控 |
| `SSO_LOGIN_LOG` | SSO 审计 |

## API（Java）

| 前缀 | 能力 |
|------|------|
| `/api/platform/notify/**` | 渠道、外发队列、备份保留日志 |
| `/api/platform/governance/**` | 保留、升级、维护窗、巡检对比、演练 |
| `/api/platform/health/**`、`/api/platform/status` | 自监控、OpenAPI 链接 |
| `/api/platform/sso/**` | LDAP/OIDC（登录页） |

## 配置键（SYS_CONFIG）

- `platform.enabled` — 总开关  
- `notify.enabled` — 外发  
- `governance.enabled` — 治理作业  
- `retention.*` / `alert.escalation.*` / `alert.maintenance.*`  
- `backup.restore_drill.*` / `backup.retention.job_enabled`  
- `platform.sso.*` / `platform.health.*` / `platform.openapi.enabled`  

（仍兼容读取 `phase1.*` / `phase2.*` / `phase3.*` 旧键。）

## 前端（无独立菜单页）

能力已嵌入业务页面，不再提供「平台运维闭环」设置入口：

| 能力 | 入口 |
|------|------|
| 开关 / SSO / 自监控阈值 | **系统设置 → 系统配置**（`通知外发`、`告警治理`、`平台能力` 等分组） |
| Webhook 渠道 | **告警中心 → 外发渠道** |
| 外发/升级状态 | **告警中心 → 告警详情** |
| 保留日志 / 演练待办 | **自动化 → 备份恢复 → 保留与演练** |
| 自监控指标 | **控制台** 平台自监控卡片 |

旧书签 `/settings/platform-ops` 会重定向到系统配置。

## Node 作业

`backend/src/platform/bootstrap.js`：备份保留、恢复演练登记。

| 变量 | 说明 | 默认 |
|------|------|------|
| `PLATFORM_NOTIFY_MODULE` | `0` 关闭通知侧 Node 作业（含备份保留） | 开启 |
| `PLATFORM_GOVERNANCE_MODULE` | `0` 关闭治理侧 Node 作业（含演练登记） | 开启 |
| `BACKUP_RETENTION_ENABLED` | `0` 仅关闭保留清理作业 | 开启 |
| `BACKUP_RETENTION_CRON` | 保留清理 Cron | `0 4 * * *` |
| `BACKUP_RESTORE_DRILL` | `1` 开启演练待办登记 | 关闭 |
| `BACKUP_RESTORE_DRILL_CRON` | 演练登记 Cron | `0 5 * * 1` |
| `BACKUP_RESTORE_DRILL_DAYS` | 登记周期（天） | `30` |

## 业务内嵌（一体化 UI）

- **告警中心 → 外发渠道**：Webhook 增删改测、手动外发一轮。
- **告警中心 → 详情**：外发队列状态、升级记录（只读）。
- **自动化 → 备份恢复 → 保留与演练**：`BACKUP_RETENTION_LOG` 与 `BACKUP_RESTORE_DRILL` 列表，可按策略 ID 筛选。
