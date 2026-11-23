-- ============================================================================
SET DEFINE OFF
SET SCAN OFF
-- 平台授权（License）—— 可重复执行
--   SYS_LICENSE        已导入的授权文件（保留历史；续期授权可提前导入）
--   SYS_LICENSE_STATE  “见过的最晚平台库时间”（带 HMAC），用于识别时间回拨；不要手工修改，否则授权判定为异常
-- 执行：sqlplus user/pwd@db @migration_license.sql
-- 说明：docs/LICENSE.md
-- ============================================================================
SET SERVEROUTPUT ON

CREATE OR REPLACE PROCEDURE DI_EXEC_IGNORE(p_sql IN VARCHAR2) IS
BEGIN
  EXECUTE IMMEDIATE p_sql;
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE NOT IN (-955, -1430, -1408, -2275, -2260, -2261, -1442, -942) THEN RAISE; END IF;
END;
/

BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE SYS_LICENSE (
  LICENSE_ID     VARCHAR2(64)  PRIMARY KEY,
  CUSTOMER       VARCHAR2(256),
  LICENSE_TYPE   VARCHAR2(16),
  ISSUED_AT      DATE,
  NOT_BEFORE     TIMESTAMP,
  EXPIRES_AT     TIMESTAMP,
  MACHINE_CODE   VARCHAR2(32),
  MAX_INSTANCES  NUMBER,
  CONTENT        CLOB          NOT NULL,
  STATUS         VARCHAR2(16)  DEFAULT 'ACTIVE',   -- ACTIVE / REVOKED
  ACTIVATED_AT   TIMESTAMP     DEFAULT SYSTIMESTAMP,
  ACTIVATED_BY   VARCHAR2(64)
)]'); END;
/

BEGIN DI_EXEC_IGNORE(q'[
CREATE TABLE SYS_LICENSE_STATE (
  ID            NUMBER        PRIMARY KEY,
  LAST_SEEN_MS  NUMBER        NOT NULL,
  MAC           VARCHAR2(128) NOT NULL
)]'); END;
/

COMMIT;
PROMPT migration_license.sql done
