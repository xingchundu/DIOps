-- ============================================================
-- v6：告警规则支持「指定某 IP 实例的业务表空间」
--   ALERT_RULE.TABLESPACE_NAME  监测的表空间名（多个用逗号分隔，大小写不敏感，留空=全部）
--   ALERT_RULE.TARGET_HOST_IP   按目标库 IP 限定（留空=不限）；INSTANCE_ID 仍可作为更精确绑定
--   ALERT_RECORD.TABLESPACE_NAME / HOST_IP  告警带上维度，便于定位
-- 可重复执行：列已存在 / 索引已存在时忽略。
-- ============================================================
DECLARE
  PROCEDURE exec_ignore(p_sql VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE p_sql;
  EXCEPTION
    WHEN OTHERS THEN
      -- -01430 列已存在, -00955 对象名已存在, -01408 列已被索引
      IF SQLCODE NOT IN (-1430, -955, -1408) THEN
        RAISE;
      END IF;
  END;
BEGIN
  exec_ignore('ALTER TABLE ALERT_RULE ADD (TABLESPACE_NAME VARCHAR2(256))');
  exec_ignore('ALTER TABLE ALERT_RULE ADD (TARGET_HOST_IP VARCHAR2(64))');
  exec_ignore('ALTER TABLE ALERT_RECORD ADD (TABLESPACE_NAME VARCHAR2(128))');
  exec_ignore('ALTER TABLE ALERT_RECORD ADD (HOST_IP VARCHAR2(64))');
  exec_ignore('CREATE INDEX IDX_ALERT_RULE_TBS ON ALERT_RULE (INSTANCE_ID, TABLESPACE_NAME)');
END;
/

COMMENT ON COLUMN ALERT_RULE.TABLESPACE_NAME IS '监测的业务表空间名，多个用逗号分隔；留空=该实例全部表空间';
COMMENT ON COLUMN ALERT_RULE.TARGET_HOST_IP IS '按目标库 IP 限定规则生效范围；留空=不限';
COMMENT ON COLUMN ALERT_RECORD.TABLESPACE_NAME IS '触发告警的业务表空间名（按表空间维度规则）';
COMMENT ON COLUMN ALERT_RECORD.HOST_IP IS '告警实例的目标库 IP';
