-- ============================================================
-- DIOps v3 — 四模块闭环增量迁移
-- 故障自动处理 / 自动发布 / SQL治理中心 / 高可用与容灾
--
-- 执行前提：已执行 migration_v2_automation_pro.sql
-- 执行用户：monitor（或有建表/ALTER TABLE权限的用户）
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. FAULT_EXEC_LOG：增加 HA 关联字段 + 开始时间
-- ──────────────────────────────────────────────────────────
ALTER TABLE FAULT_EXEC_LOG ADD HA_CORRELATION_ID NUMBER;
ALTER TABLE FAULT_EXEC_LOG ADD STARTED_AT        TIMESTAMP DEFAULT SYSTIMESTAMP;
COMMENT ON COLUMN FAULT_EXEC_LOG.HA_CORRELATION_ID IS '关联HA拓扑ID（当ACTION_TYPE=HA_FAILOVER时）';
CREATE INDEX IDX_FAULT_LOG_HA ON FAULT_EXEC_LOG(HA_CORRELATION_ID) WHERE HA_CORRELATION_ID IS NOT NULL;

-- ──────────────────────────────────────────────────────────
-- 2. PUBLISH_TICKET：增加环境字段 + SQL治理关联
-- ──────────────────────────────────────────────────────────
ALTER TABLE PUBLISH_TICKET ADD ENV                 VARCHAR2(16)  DEFAULT 'PROD';  -- DEV/STAGING/PROD
ALTER TABLE PUBLISH_TICKET ADD GOVERNANCE_AUDIT_ID NUMBER;                        -- 关联 SQL_AUDIT_RECORD
COMMENT ON COLUMN PUBLISH_TICKET.ENV                 IS '发布环境：DEV/STAGING/PROD';
COMMENT ON COLUMN PUBLISH_TICKET.GOVERNANCE_AUDIT_ID IS '关联SQL治理审核记录ID';

-- 状态枚举扩展（新增 GRAY_TESTING / EXECUTING）
-- Oracle CHECK CONSTRAINT 无法热修改，此处仅加索引
CREATE INDEX IDX_PUB_TICK_ENV ON PUBLISH_TICKET(ENV, STATUS);

-- ──────────────────────────────────────────────────────────
-- 3. SQL_AUDIT_RECORD：增加来源字段
-- ──────────────────────────────────────────────────────────
ALTER TABLE SQL_AUDIT_RECORD ADD SOURCE VARCHAR2(32) DEFAULT 'MANUAL';
-- SOURCE 可选值：MANUAL / FAULT_AUTO / SLOW_IMPORT / PUBLISH_PRE
COMMENT ON COLUMN SQL_AUDIT_RECORD.SOURCE IS '审核来源：MANUAL/FAULT_AUTO/SLOW_IMPORT/PUBLISH_PRE';
CREATE INDEX IDX_SQL_AUDIT_SOURCE ON SQL_AUDIT_RECORD(SOURCE, CREATED_AT DESC);

-- ──────────────────────────────────────────────────────────
-- 4. SQL_BASELINE：增加状态字段（ACTIVE/CANDIDATE/REVOKED）
--    + 基线评分（用于回归检测比较）
-- ──────────────────────────────────────────────────────────
-- STATUS 字段可能已存在，ALTER 前检查
-- 若已存在则跳过（实际部署时根据实际情况执行）
ALTER TABLE SQL_BASELINE ADD BASELINE_SCORE   NUMBER(5,1) DEFAULT 100;
ALTER TABLE SQL_BASELINE ADD UPDATED_AT       TIMESTAMP DEFAULT SYSTIMESTAMP;
COMMENT ON COLUMN SQL_BASELINE.BASELINE_SCORE IS '基线固化时的SQL审核评分（用于退化比较）';
-- 修改已有 STATUS 枚举含义（ACTIVE/CANDIDATE/REVOKED）
-- 对存量 ACTIVE 数据赋分
UPDATE SQL_BASELINE SET BASELINE_SCORE = 95 WHERE STATUS = 'ACTIVE' AND BASELINE_SCORE IS NULL;
COMMIT;

-- ──────────────────────────────────────────────────────────
-- 5. DR_LINK：增加最后演练时间
-- ──────────────────────────────────────────────────────────
ALTER TABLE DR_LINK ADD LAST_DRILL_AT TIMESTAMP;
COMMENT ON COLUMN DR_LINK.LAST_DRILL_AT IS '最后一次容灾演练时间';

-- ──────────────────────────────────────────────────────────
-- 6. CMDB_INSTANCE：增加实例角色字段（主备标识）
-- ──────────────────────────────────────────────────────────
ALTER TABLE CMDB_INSTANCE ADD INSTANCE_ROLE VARCHAR2(16);  -- PRIMARY / REPLICA / STANDALONE
COMMENT ON COLUMN CMDB_INSTANCE.INSTANCE_ROLE IS '实例角色：PRIMARY/REPLICA/STANDALONE';

-- ──────────────────────────────────────────────────────────
-- 7. 新增：SQL_SCORE_CONFIG 若不存在则创建
--    （为 SQL 治理评分维度配置提供默认数据）
-- ──────────────────────────────────────────────────────────
BEGIN
  EXECUTE IMMEDIATE '
    CREATE TABLE SQL_SCORE_CONFIG (
      CONFIG_ID   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      DIMENSION   VARCHAR2(64) NOT NULL,
      DESCRIPTION VARCHAR2(256),
      WEIGHT      NUMBER(5,1) DEFAULT 20,
      UPDATED_AT  TIMESTAMP DEFAULT SYSTIMESTAMP
    )
  ';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -955 THEN RAISE; END IF;  -- ORA-00955: 对象已存在
END;
/

-- 评分维度种子数据
MERGE INTO SQL_SCORE_CONFIG USING (
  SELECT '索引使用' DIM,'查询是否有效利用索引' DESCR, 25 W FROM DUAL UNION ALL
  SELECT '执行安全','是否满足WHERE条件等安全约束', 30 FROM DUAL UNION ALL
  SELECT '语法规范','是否符合团队编码规范', 20 FROM DUAL UNION ALL
  SELECT '资源消耗','估算IO/CPU消耗是否可控', 15 FROM DUAL UNION ALL
  SELECT '可维护性','SQL可读性与注释完整度', 10 FROM DUAL
) src ON (SQL_SCORE_CONFIG.DIMENSION = src.DIM)
WHEN NOT MATCHED THEN
  INSERT (DIMENSION, DESCRIPTION, WEIGHT) VALUES (src.DIM, src.DESCR, src.W);
COMMIT;

-- ──────────────────────────────────────────────────────────
-- 8. 新增：FAULT_POLICY 扩展 ACTION_TYPE 枚举
--    增加 HA_FAILOVER / NOTIFY 内置策略示例
-- ──────────────────────────────────────────────────────────
-- 确保 ACTION_TYPE 约束允许 HA_FAILOVER（若有 CHECK 约束则先 DROP 再 ADD）
-- 此处仅插入示例策略供参考
INSERT INTO FAULT_POLICY (POLICY_NAME, DB_TYPE, FAULT_TYPE, CONDITION_JSON, ACTION_TYPE, ENABLED)
  SELECT '主从复制延迟自动重启',  'MYSQL',      'REPL_DELAY',
         '{"delayThreshold":60}', 'AUTO_FIX', 1
  FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM FAULT_POLICY WHERE POLICY_NAME='主从复制延迟自动重启');

INSERT INTO FAULT_POLICY (POLICY_NAME, DB_TYPE, FAULT_TYPE, CONDITION_JSON, ACTION_TYPE, ENABLED)
  SELECT 'Oracle FRA空间清理',   'ORACLE',     'FRA_FULL',
         '{"fraThreshold":85}',  'AUTO_FIX', 1
  FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM FAULT_POLICY WHERE POLICY_NAME='Oracle FRA空间清理');

INSERT INTO FAULT_POLICY (POLICY_NAME, DB_TYPE, FAULT_TYPE, CONDITION_JSON, ACTION_TYPE, ENABLED)
  SELECT '慢查询自动导入治理',  'ALL',        'SLOW_QUERY',
         '{"slowQueryThreshold":5}', 'AUTO_FIX', 1
  FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM FAULT_POLICY WHERE POLICY_NAME='慢查询自动导入治理');
COMMIT;

-- ──────────────────────────────────────────────────────────
-- 完成
-- ──────────────────────────────────────────────────────────
PROMPT '>>> DIOps v3 闭环迁移完成';

-- ============================================================
-- v3.1  人工审核流程补充（2025-05-20）
-- ============================================================

-- SQL_AUDIT_RECORD 新增人工审核状态字段
ALTER TABLE SQL_AUDIT_RECORD ADD REVIEW_STATUS  VARCHAR2(16)  DEFAULT 'PENDING';
ALTER TABLE SQL_AUDIT_RECORD ADD REVIEW_COMMENT VARCHAR2(1000);
ALTER TABLE SQL_AUDIT_RECORD ADD REVIEWED_BY    NUMBER;
ALTER TABLE SQL_AUDIT_RECORD ADD REVIEWED_AT    TIMESTAMP;

COMMENT ON COLUMN SQL_AUDIT_RECORD.REVIEW_STATUS  IS '人工审核状态: PENDING/CONFIRMED/IGNORED';
COMMENT ON COLUMN SQL_AUDIT_RECORD.REVIEW_COMMENT IS '人工审核意见';
COMMENT ON COLUMN SQL_AUDIT_RECORD.REVIEWED_BY    IS '审核人 USER_ID';
COMMENT ON COLUMN SQL_AUDIT_RECORD.REVIEWED_AT    IS '审核时间';

CREATE INDEX IDX_SQL_AUDIT_RSTATUS ON SQL_AUDIT_RECORD(REVIEW_STATUS);

COMMIT;
