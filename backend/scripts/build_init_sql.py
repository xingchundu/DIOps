# -*- coding: utf-8 -*-
"""Build consolidated backend/sql/init.sql from base + migration fragments."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT / "sql"
OUT = SQL / "init.sql"

def main():
    base = (SQL / "init.sql").read_text(encoding="utf-8")

    # --- patch header ---
    base = base.replace(
        "-- 数据库智能平台 - Oracle平台库初始化脚本\n-- 执行用户: moitor",
        "-- 数据库智能平台 - Oracle 平台库完整初始化脚本\n-- 执行用户: monitor",
    )
    base = base.replace(
        "-- 1b. RBAC：角色、菜单、角色-菜单（SYS_USER.ROLE 与 SYS_ROLE.ROLE_CODE 对应；增量升级见 migration_v1_5_rbac.sql）",
        "-- 1b. RBAC：角色、菜单、角色-菜单",
    )

    # --- MONITOR_METRIC_SAMPLE + HEALTH_DETAIL ---
    base = base.replace(
        "  METRICS_JSON  CLOB,\n  ERR_MSG       VARCHAR2(512)\n);",
        "  METRICS_JSON  CLOB,\n  HEALTH_DETAIL CLOB,\n  ERR_MSG       VARCHAR2(512)\n);",
    )
    if "HEALTH_DETAIL" not in base.split("MONITOR_METRIC_SAMPLE")[1].split("CREATE TABLE")[0]:
        pass  # already added

    # --- CMDB_INSTANCE + INSTANCE_ROLE ---
    base = base.replace(
        "  LAST_CHECK    TIMESTAMP\n);",
        "  LAST_CHECK    TIMESTAMP,\n  INSTANCE_ROLE VARCHAR2(16)\n);",
    )

    # --- ALERT_RECORD extended columns ---
    old_alert = """CREATE TABLE ALERT_RECORD (
  ALERT_ID     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  RULE_ID      NUMBER,
  RULE_NAME    VARCHAR2(128),
  INSTANCE_ID  NUMBER,
  INSTANCE_NAME VARCHAR2(128),
  SEVERITY     VARCHAR2(16),
  CONTENT      VARCHAR2(1024),
  STATUS       VARCHAR2(16)  DEFAULT 'OPEN',  -- OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED
  TRIGGER_TIME TIMESTAMP     DEFAULT SYSTIMESTAMP,
  ACK_TIME     TIMESTAMP,
  ACK_BY       VARCHAR2(64),
  RESOLVE_TIME TIMESTAMP,
  RESOLVE_BY   VARCHAR2(64),
  DETAIL       CLOB,
  TENANT_ID    NUMBER         DEFAULT 1
);"""
    new_alert = """CREATE TABLE ALERT_RECORD (
  ALERT_ID     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  RULE_ID      NUMBER,
  RULE_NAME    VARCHAR2(128),
  INSTANCE_ID  NUMBER,
  INSTANCE_NAME VARCHAR2(128),
  SEVERITY     VARCHAR2(16),
  CONTENT      VARCHAR2(1024),
  STATUS       VARCHAR2(16)  DEFAULT 'OPEN',  -- OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED/SILENCED
  TRIGGER_TIME TIMESTAMP     DEFAULT SYSTIMESTAMP,
  ACK_TIME     TIMESTAMP,
  ACK_BY       VARCHAR2(64),
  RESOLVE_TIME TIMESTAMP,
  RESOLVE_BY   VARCHAR2(64),
  DETAIL       CLOB,
  TENANT_ID    NUMBER         DEFAULT 1,
  SILENCE_RULE_ID  NUMBER,
  SILENCED_AT      TIMESTAMP,
  AGG_GROUP_ID     NUMBER,
  IS_MERGED        NUMBER(1) DEFAULT 0,
  SUPPRESSED_BY_ID NUMBER,
  SUPPRESSED_AT    TIMESTAMP,
  SUPPRESSION_RULE VARCHAR2(128)
);"""
    base = base.replace(old_alert, new_alert)

    # --- DEPLOY_TEMPLATE enhanced ---
    old_deploy_tpl = """CREATE TABLE DEPLOY_TEMPLATE (
  TEMPLATE_ID   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  TEMPLATE_NAME VARCHAR2(128) NOT NULL,
  DEPLOY_MODE   VARCHAR2(32)  NOT NULL,
  DESCRIPTION   VARCHAR2(512),
  PARAM_SCHEMA  CLOB,
  ENABLED       NUMBER(1) DEFAULT 1,
  CREATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP,
  UPDATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP
);"""
    new_deploy_tpl = """CREATE TABLE DEPLOY_TEMPLATE (
  TEMPLATE_ID   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  TEMPLATE_NAME VARCHAR2(128) NOT NULL,
  DEPLOY_MODE   VARCHAR2(32)  NOT NULL,
  DEPLOY_TYPE   VARCHAR2(32) DEFAULT 'INSTALL',
  DB_TYPE       VARCHAR2(32) DEFAULT 'ALL',
  DESCRIPTION   VARCHAR2(512),
  PARAM_SCHEMA  CLOB,
  STEPS_JSON    CLOB,
  SORT_ORDER    NUMBER DEFAULT 0,
  ENABLED       NUMBER(1) DEFAULT 1,
  CREATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP,
  UPDATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP
);"""
    base = base.replace(old_deploy_tpl, new_deploy_tpl)

    # --- DEPLOY_JOB enhanced ---
    old_deploy_job = """CREATE TABLE DEPLOY_JOB (
  JOB_ID       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  TEMPLATE_ID  NUMBER,
  INSTANCE_ID  NUMBER,
  STATUS       VARCHAR2(32) DEFAULT 'PENDING',
  PARAMS       CLOB,
  LOG_SUMMARY  VARCHAR2(2000),
  CREATED_BY   NUMBER,
  START_TIME   TIMESTAMP,
  END_TIME     TIMESTAMP,
  CREATED_AT   TIMESTAMP DEFAULT SYSTIMESTAMP
);"""
    new_deploy_job = """CREATE TABLE DEPLOY_JOB (
  JOB_ID       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  TEMPLATE_ID  NUMBER,
  INSTANCE_ID  NUMBER,
  HOST_ID      NUMBER,
  TARGET_IP    VARCHAR2(64),
  STATUS       VARCHAR2(32) DEFAULT 'PENDING',
  PARAMS       CLOB,
  STEPS_LOG    CLOB,
  LOG_SUMMARY  VARCHAR2(2000),
  CREATED_BY   NUMBER,
  START_TIME   TIMESTAMP,
  END_TIME     TIMESTAMP,
  CANCELLED_BY NUMBER,
  CANCELLED_AT TIMESTAMP,
  CREATED_AT   TIMESTAMP DEFAULT SYSTIMESTAMP,
  UPDATED_AT   TIMESTAMP DEFAULT SYSTIMESTAMP
);"""
    base = base.replace(old_deploy_job, new_deploy_job)

    # --- OPS_SERVICE_CATALOG enhanced ---
    old_cat = """CREATE TABLE OPS_SERVICE_CATALOG (
  CATALOG_ID    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  SERVICE_NAME  VARCHAR2(128) NOT NULL,
  CATEGORY      VARCHAR2(64),
  DESCRIPTION   VARCHAR2(512),
  NEED_APPROVAL NUMBER(1) DEFAULT 1,
  CREATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP
);"""
    new_cat = """CREATE TABLE OPS_SERVICE_CATALOG (
  CATALOG_ID    NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  SERVICE_NAME  VARCHAR2(128) NOT NULL,
  CATEGORY      VARCHAR2(64),
  DESCRIPTION   VARCHAR2(512),
  NEED_APPROVAL NUMBER(1) DEFAULT 1,
  ICON          VARCHAR2(64),
  SORT_ORDER    NUMBER DEFAULT 0,
  ENABLED       NUMBER(1) DEFAULT 1,
  SLA_HOURS     NUMBER,
  ASSIGNEE_ROLE VARCHAR2(32),
  CREATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP,
  UPDATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP
);"""
    base = base.replace(old_cat, new_cat)

    # --- OPS_SERVICE_ORDER enhanced ---
    old_ord = """CREATE TABLE OPS_SERVICE_ORDER (
  ORDER_ID      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  CATALOG_ID    NUMBER,
  INSTANCE_ID   NUMBER,
  STATUS        VARCHAR2(32) DEFAULT 'OPEN',
  TICKET_REF    VARCHAR2(128),
  REMARK        VARCHAR2(512),
  CREATED_BY    NUMBER,
  CREATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP
);"""
    new_ord = """CREATE TABLE OPS_SERVICE_ORDER (
  ORDER_ID      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  CATALOG_ID    NUMBER,
  INSTANCE_ID   NUMBER,
  TITLE         VARCHAR2(256),
  STATUS        VARCHAR2(32) DEFAULT 'OPEN',
  PRIORITY      VARCHAR2(16) DEFAULT 'MEDIUM',
  TICKET_REF    VARCHAR2(128),
  REMARK        VARCHAR2(512),
  ASSIGNED_TO   NUMBER,
  ALERT_ID      NUMBER,
  FEEDBACK_SCORE NUMBER(1),
  FEEDBACK_COMMENT VARCHAR2(512),
  CREATED_BY    NUMBER,
  CREATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP,
  UPDATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP,
  RESOLVED_AT   TIMESTAMP,
  CLOSED_AT     TIMESTAMP
);"""
    base = base.replace(old_ord, new_ord)

    # --- insert extension DDL before seed section ---
    marker = "-- AI 智能分析模块表见 migration_v1_4_ai_analysis.sql"
    part2 = (SQL / "_init_consolidated_part2.sql").read_text(encoding="utf-8")
    part3_files = [
        "migration_v1_4_ai_analysis.sql",
        "migration_v2_automation_pro.sql",
        "migration_sql_review.sql",
        "migration_sql_opt_kb_chunk.sql",
    ]
    part3_parts = []
    for fn in part3_files:
        txt = (SQL / fn).read_text(encoding="utf-8")
        # strip file headers and trailing END comments
        lines = []
        skip_insert = fn == "migration_v1_4_ai_analysis.sql"  # keep AI inserts in seed
        in_insert = False
        for line in txt.splitlines():
            if line.strip().startswith("-- ==") and "DIOps" in line:
                continue
            if fn == "migration_v2_automation_pro.sql" and line.strip().startswith("INSERT INTO DDL_AUDIT_RULE"):
                in_insert = True
            if fn == "migration_v2_automation_pro.sql" and line.strip().startswith("INSERT INTO SQL_SCORE_CONFIG"):
                in_insert = True
            if in_insert:
                if line.strip() == "COMMIT;":
                    in_insert = False
                continue
            if skip_insert and line.strip().startswith("INSERT INTO AI_KNOWLEDGE_DOC"):
                in_insert = True
            if skip_insert and in_insert:
                if line.strip() == "COMMIT;":
                    in_insert = False
                continue
            if line.strip() in ("COMMIT;", "-- END", "-- ============================================================"):
                if "END" in line:
                    continue
                if line.strip() == "COMMIT;":
                    continue
            part3_parts.append(line)
        part3_parts.append("")
    part3 = "\n".join(part3_parts)

    # AI_CHAT_HISTORY CREATED_BY
    part3 = part3.replace(
        "  TOKENS_USED    NUMBER,\n  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\n\nCOMMENT ON TABLE AI_CHAT_HISTORY",
        "  TOKENS_USED    NUMBER,\n  CREATED_BY     VARCHAR2(64),\n  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\n\nCOMMENT ON TABLE AI_CHAT_HISTORY",
    )
    part3 = part3.replace(
        "CREATE INDEX IDX_AI_CHAT_SESSION ON AI_CHAT_HISTORY(SESSION_ID, CREATED_AT);",
        "CREATE INDEX IDX_AI_CHAT_SESSION ON AI_CHAT_HISTORY(SESSION_ID, CREATED_AT);\nCREATE INDEX IDX_AI_CHAT_USER_SESSION ON AI_CHAT_HISTORY(CREATED_BY, SESSION_ID, CREATED_AT DESC);",
    )

    # v3 columns merged into CREATE in v2 - patch FAULT_EXEC_LOG, PUBLISH_TICKET, SQL_AUDIT_RECORD, SQL_BASELINE, DR_LINK
    part3 = part3.replace(
        "  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCREATE INDEX IDX_FAULT_LOG_INST",
        "  HA_CORRELATION_ID NUMBER,\n  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCREATE INDEX IDX_FAULT_LOG_INST",
    )
    part3 = part3.replace(
        "CREATE INDEX IDX_FAULT_LOG_POL ON FAULT_EXEC_LOG(POLICY_ID);",
        "CREATE INDEX IDX_FAULT_LOG_POL ON FAULT_EXEC_LOG(POLICY_ID);\nCREATE INDEX IDX_FAULT_LOG_HA ON FAULT_EXEC_LOG(HA_CORRELATION_ID);",
    )
    part3 = part3.replace(
        "  UPDATED_AT      TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCOMMENT ON TABLE PUBLISH_TICKET",
        "  ENV                 VARCHAR2(16) DEFAULT 'PROD',\n  GOVERNANCE_AUDIT_ID NUMBER,\n  UPDATED_AT      TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCOMMENT ON TABLE PUBLISH_TICKET",
    )
    part3 = part3.replace(
        "CREATE INDEX IDX_PUB_TICK_INST ON PUBLISH_TICKET(INSTANCE_ID);",
        "CREATE INDEX IDX_PUB_TICK_INST ON PUBLISH_TICKET(INSTANCE_ID);\nCREATE INDEX IDX_PUB_TICK_ENV ON PUBLISH_TICKET(ENV, STATUS);",
    )
    part3 = part3.replace(
        "  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCREATE INDEX IDX_SQL_AUDIT_HASH",
        "  SOURCE         VARCHAR2(32) DEFAULT 'MANUAL',\n  REVIEW_STATUS  VARCHAR2(16) DEFAULT 'PENDING',\n  REVIEW_COMMENT VARCHAR2(1000),\n  REVIEWED_BY    NUMBER,\n  REVIEWED_AT    TIMESTAMP,\n  CREATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCREATE INDEX IDX_SQL_AUDIT_HASH",
    )
    part3 = part3.replace(
        "CREATE INDEX IDX_SQL_AUDIT_INST ON SQL_AUDIT_RECORD(INSTANCE_ID, CREATED_AT DESC);",
        "CREATE INDEX IDX_SQL_AUDIT_INST ON SQL_AUDIT_RECORD(INSTANCE_ID, CREATED_AT DESC);\nCREATE INDEX IDX_SQL_AUDIT_SOURCE ON SQL_AUDIT_RECORD(SOURCE, CREATED_AT DESC);\nCREATE INDEX IDX_SQL_AUDIT_RSTATUS ON SQL_AUDIT_RECORD(REVIEW_STATUS);",
    )
    part3 = part3.replace(
        "  UPDATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCREATE INDEX IDX_SQL_BASE_HASH",
        "  BASELINE_SCORE NUMBER(5,1) DEFAULT 100,\n  UPDATED_AT     TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCREATE INDEX IDX_SQL_BASE_HASH",
    )
    part3 = part3.replace(
        "  UPDATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCOMMENT ON TABLE DR_LINK",
        "  LAST_DRILL_AT TIMESTAMP,\n  UPDATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP\n);\nCOMMENT ON TABLE DR_LINK",
    )

    extension_block = (
        "\n-- ============================================================\n"
        "-- 扩展模块表（原 migration_*.sql 已合并）\n"
        "-- ============================================================\n\n"
        + part2 + "\n" + part3
    )

    if marker in base:
        base = base.replace(marker, extension_block.rstrip())
    else:
        base = base.replace(
            "COMMENT ON TABLE DEPLOY_TEMPLATE IS 'F-45 安装部署模板';",
            extension_block + "\nCOMMENT ON TABLE DEPLOY_TEMPLATE IS 'F-45 安装部署模板';",
        )

    # --- expand menus in seed ---
    extra_menus = """
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/monitor/compare', '性能对比', 36);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/sql-review', 'SQL评审', 32);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/alerts/suppression', '告警抑制规则', 22);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/cmdb/hosts', '主机管理', 55);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/cmdb/clusters', '集群拓扑', 56);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/cmdb/app-relation', '应用依赖关系', 57);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/cmdb/tags', '标签管理', 58);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/service-catalog', '服务工单', 65);
INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/settings/system-config', '系统配置', 115);
"""
    base = base.replace(
        "INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/settings/roles', '角色权限', 120);",
        "INSERT INTO SYS_MENU (MENU_PATH, MENU_NAME, SORT_ORDER) VALUES ('/settings/roles', '角色权限', 120);\n"
        + extra_menus,
    )

    # --- replace old deploy template seeds ---
    old_deploy_seed = """INSERT INTO DEPLOY_TEMPLATE (TEMPLATE_NAME, DEPLOY_MODE, DESCRIPTION, PARAM_SCHEMA, ENABLED)
VALUES ('Oracle 单机标准部署', 'SINGLE', '参数化 ORACLE_HOME、SID', '{"sid":"string","oracleHome":"string"}', 1);
INSERT INTO DEPLOY_TEMPLATE (TEMPLATE_NAME, DEPLOY_MODE, DESCRIPTION, ENABLED)
VALUES ('主从复制模板', 'REPLICA', '一主一从', 1);"""
    deploy_seed = (SQL / "migration_deploy.sql").read_text(encoding="utf-8")
    deploy_inserts = []
    capture = False
    for line in deploy_seed.splitlines():
        if line.strip().startswith("INSERT INTO DEPLOY_TEMPLATE"):
            capture = True
        if capture:
            deploy_inserts.append(line)
            if line.strip() == "COMMIT;":
                break
    new_deploy_seed = "\n".join(deploy_inserts[:-1])  # drop COMMIT
    if old_deploy_seed in base:
        base = base.replace(old_deploy_seed, new_deploy_seed)

    # --- replace single ops catalog seed with full set ---
    old_ops = """INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL)
VALUES ('实例扩容申请', 'CAPACITY', 'CPU/内存/存储扩容工单', 1);"""
    ops_lines = []
    for line in (SQL / "migration_service_catalog.sql").read_text(encoding="utf-8").splitlines():
        if "MERGE INTO OPS_SERVICE_CATALOG" in line or (ops_lines and line.strip()):
            if line.strip().startswith("-- =="):
                if ops_lines:
                    break
            if "MERGE INTO OPS_SERVICE_CATALOG" in line or (ops_lines and not line.strip().startswith("-- ==")):
                ops_lines.append(line)
    # use simpler INSERT seeds from migration
    ops_seed = """INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL, ICON, SORT_ORDER, ENABLED, SLA_HOURS, ASSIGNEE_ROLE)
VALUES ('实例扩容申请', 'CAPACITY', 'CPU/内存/存储扩容工单', 1, 'Expand', 10, 1, 48, 'DBA');
INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL, ICON, SORT_ORDER, ENABLED, SLA_HOURS, ASSIGNEE_ROLE)
VALUES ('权限申请', 'ACCESS', '数据库账号权限开通/变更', 1, 'Lock', 20, 1, 24, 'DBA');
INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL, ICON, SORT_ORDER, ENABLED, SLA_HOURS, ASSIGNEE_ROLE)
VALUES ('数据导出', 'DATA', '数据导出/迁移/清洗请求', 1, 'Download', 30, 1, 72, 'DBA');
INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL, ICON, SORT_ORDER, ENABLED, SLA_HOURS, ASSIGNEE_ROLE)
VALUES ('参数变更', 'CONFIG', '数据库参数调整', 1, 'Setting', 40, 1, 24, 'DBA');
INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL, ICON, SORT_ORDER, ENABLED, SLA_HOURS, ASSIGNEE_ROLE)
VALUES ('故障处理', 'INCIDENT', '数据库故障排查与处理', 0, 'Warning', 50, 1, 4, 'DBA');
INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL, ICON, SORT_ORDER, ENABLED, SLA_HOURS, ASSIGNEE_ROLE)
VALUES ('巡检报告', 'REPORT', '定期巡检报告生成与解读', 0, 'Document', 60, 1, 48, 'OPS');"""
    base = base.replace(old_ops, ops_seed)

    # --- append extra seeds before COMMIT in seed section ---
    extra_seeds = []

    # SYS_CONFIG
    for line in (SQL / "migration_system_config.sql").read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("MERGE INTO SYS_CONFIG"):
            extra_seeds.append(line)
        elif extra_seeds and extra_seeds[-1].startswith("MERGE") and (line.strip().startswith("WHEN") or line.strip().startswith("ON ") or "VALUES (" in line):
            extra_seeds.append(line)

    # suppression rules
    for line in (SQL / "migration_alert_suppression.sql").read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("INSERT INTO ALERT_SUPPRESSION_RULE"):
            extra_seeds.append(line)

    # tag groups/tags - copy INSERT block
    tag_block = (SQL / "migration_tag_group.sql").read_text(encoding="utf-8").split("-- 6. 预置默认分组")[1].split("COMMIT;")[0]
    extra_seeds.append(tag_block.strip())

    # DDL_AUDIT_RULE + SQL_SCORE_CONFIG from v2
    v2 = (SQL / "migration_v2_automation_pro.sql").read_text(encoding="utf-8")
    capture = False
    for line in v2.splitlines():
        if "INSERT INTO DDL_AUDIT_RULE" in line:
            capture = True
        if capture:
            extra_seeds.append(line)
            if line.strip() == "COMMIT;" and "DDL_AUDIT" in "\n".join(extra_seeds[-10:]):
                extra_seeds.pop()
                break
    capture = False
    for line in v2.splitlines():
        if "INSERT INTO SQL_SCORE_CONFIG" in line:
            capture = True
        if capture:
            if line.strip() == "COMMIT;":
                break
            extra_seeds.append(line)

    # FAULT_POLICY examples from v3
    for line in (SQL / "migration_v3_closed_loop.sql").read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("INSERT INTO FAULT_POLICY"):
            extra_seeds.append(line)

    # AI knowledge docs
    ai = (SQL / "migration_v1_4_ai_analysis.sql").read_text(encoding="utf-8")
    ai_start = ai.find("INSERT INTO AI_KNOWLEDGE_DOC")
    ai_end = ai.find("COMMIT;", ai_start)
    extra_seeds.append(ai[ai_start:ai_end].strip())

    extra_seed_block = "\n\n-- 扩展模块种子数据\n" + "\n".join(extra_seeds) + "\n"

    base = base.replace(
        "INSERT INTO AUTOMATION_INSPECT_BATCH (BATCH_NAME, INSTANCE_IDS, CRON_EXPR, STATUS)\nVALUES ('核心库日检', '1', '0 6 * * *', 'IDLE');\n\nCOMMIT;",
        "INSERT INTO AUTOMATION_INSPECT_BATCH (BATCH_NAME, INSTANCE_IDS, CRON_EXPR, STATUS)\nVALUES ('核心库日检', '1', '0 6 * * *', 'IDLE');\n"
        + extra_seed_block + "\nCOMMIT;",
    )

    # --- extra indexes at end ---
    extra_idx = """
CREATE INDEX IDX_ALERT_AGG_GROUP ON ALERT_RECORD(AGG_GROUP_ID);
CREATE INDEX IDX_AI_CHAT_USER_SESSION ON AI_CHAT_HISTORY(CREATED_BY, SESSION_ID, CREATED_AT DESC);
CREATE INDEX IDX_SRT_STATUS ON SQL_REVIEW_TICKET(STATUS);
CREATE INDEX IDX_SRT_SUBMITTER ON SQL_REVIEW_TICKET(SUBMITTED_BY);
CREATE INDEX IDX_SRT_ASSIGNED ON SQL_REVIEW_TICKET(ASSIGNED_TO);
CREATE INDEX IDX_SRT_HASH ON SQL_REVIEW_TICKET(SQL_HASH);
CREATE INDEX IDX_SRC_TICKET ON SQL_REVIEW_COMMENT(TICKET_ID);
"""
    if "IDX_SRT_STATUS" not in base:
        base = base.replace(
            "CREATE INDEX IDX_CHK8_BATCH ON INSPECT_CHECKV8_REPORT(BATCH_ID);\n\nCOMMIT;",
            "CREATE INDEX IDX_CHK8_BATCH ON INSPECT_CHECKV8_REPORT(BATCH_ID);\n" + extra_idx + "\nCOMMIT;",
        )

    # --- role-menu grants for new menus (simplified bulk) ---
    role_menu_extra = """
INSERT INTO SYS_ROLE_MENU (ROLE_ID, MENU_ID)
SELECT r.ROLE_ID, m.MENU_ID FROM SYS_ROLE r CROSS JOIN SYS_MENU m
WHERE r.ROLE_CODE = 'ADMIN' AND m.MENU_PATH IN (
  '/monitor/compare','/sql-review','/alerts/suppression','/cmdb/hosts','/cmdb/clusters',
  '/cmdb/app-relation','/cmdb/tags','/service-catalog','/settings/system-config'
) AND NOT EXISTS (SELECT 1 FROM SYS_ROLE_MENU rm WHERE rm.ROLE_ID=r.ROLE_ID AND rm.MENU_ID=m.MENU_ID);

INSERT INTO SYS_ROLE_MENU (ROLE_ID, MENU_ID)
SELECT r.ROLE_ID, m.MENU_ID FROM SYS_ROLE r JOIN SYS_MENU m ON m.MENU_PATH IN ('/cmdb/hosts','/cmdb/clusters','/cmdb/app-relation','/cmdb/tags','/settings/system-config')
WHERE r.ROLE_CODE = 'DBA' AND NOT EXISTS (SELECT 1 FROM SYS_ROLE_MENU rm WHERE rm.ROLE_ID=r.ROLE_ID AND rm.MENU_ID=m.MENU_ID);

INSERT INTO SYS_ROLE_MENU (ROLE_ID, MENU_ID)
SELECT r.ROLE_ID, m.MENU_ID FROM SYS_ROLE r JOIN SYS_MENU m ON m.MENU_PATH IN ('/alerts/suppression','/cmdb/app-relation','/cmdb/tags','/service-catalog')
WHERE r.ROLE_CODE = 'OPS' AND NOT EXISTS (SELECT 1 FROM SYS_ROLE_MENU rm WHERE rm.ROLE_ID=r.ROLE_ID AND rm.MENU_ID=m.MENU_ID);

INSERT INTO SYS_ROLE_MENU (ROLE_ID, MENU_ID)
SELECT r.ROLE_ID, m.MENU_ID FROM SYS_ROLE r JOIN SYS_MENU m ON m.MENU_PATH IN ('/sql-review','/service-catalog')
WHERE r.ROLE_CODE IN ('DEV','REVIEWER') AND NOT EXISTS (SELECT 1 FROM SYS_ROLE_MENU rm WHERE rm.ROLE_ID=r.ROLE_ID AND rm.MENU_ID=m.MENU_ID);
"""
    if "IDX_SRT_STATUS" in base and "/monitor/compare" in base:
        base = base.replace(
            "CREATE INDEX IDX_SRC_TICKET ON SQL_REVIEW_COMMENT(TICKET_ID);\n\nCOMMIT;",
            "CREATE INDEX IDX_SRC_TICKET ON SQL_REVIEW_COMMENT(TICKET_ID);\n\nCOMMIT;\n\n" + role_menu_extra,
        )

    OUT.write_text(base, encoding="utf-8", newline="\n")
    print(f"Wrote {OUT} ({base.count(chr(10))+1} lines, {base.upper().count('CREATE TABLE')} tables)")

if __name__ == "__main__":
    main()
