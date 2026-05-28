-- F-45 自动安装部署 — 增强 DEPLOY_TEMPLATE / DEPLOY_JOB 表结构 + 种子模板

-- 1. DEPLOY_TEMPLATE 增强字段
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_TEMPLATE ADD DEPLOY_TYPE VARCHAR2(32) DEFAULT ''INSTALL''';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_TEMPLATE ADD DB_TYPE VARCHAR2(32) DEFAULT ''ALL''';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_TEMPLATE ADD STEPS_JSON CLOB';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_TEMPLATE ADD SORT_ORDER NUMBER DEFAULT 0';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/

-- 2. DEPLOY_JOB 增强字段
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_JOB ADD HOST_ID NUMBER';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_JOB ADD TARGET_IP VARCHAR2(64)';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_JOB ADD STEPS_LOG CLOB';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_JOB ADD UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_JOB ADD CANCELLED_BY NUMBER';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/
BEGIN EXECUTE IMMEDIATE 'ALTER TABLE DEPLOY_JOB ADD CANCELLED_AT TIMESTAMP';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1430 THEN RAISE; END IF; END;
/

-- 3. 种子数据：4 个部署模板
-- Oracle 单机安装
INSERT INTO DEPLOY_TEMPLATE (TEMPLATE_NAME, DEPLOY_MODE, DEPLOY_TYPE, DB_TYPE, DESCRIPTION, PARAM_SCHEMA, STEPS_JSON, ENABLED, SORT_ORDER)
VALUES (
  'Oracle 单机安装', 'SINGLE', 'INSTALL', 'ORACLE',
  'Oracle 19c 单机实例标准安装，含环境检查、用户创建、内核参数配置、软件安装、实例创建和验证',
  '{"sid":"string","oracleHome":"string","memoryMb":"number","characterset":"string"}',
  '[{"name":"环境检查","type":"CHECK","command":"check_oracle_env"},{"name":"创建用户","type":"SHELL","command":"useradd -m oracle && mkdir -p {{oracleHome}}"},{"name":"配置内核参数","type":"SHELL","command":"sysctl -p /etc/sysctl.d/oracle.conf"},{"name":"安装软件","type":"SHELL","command":"{{oracleHome}}/runInstaller -silent -responseFile {{oracleHome}}/install/response/db_install.rsp"},{"name":"创建实例","type":"SQL","command":"CREATE DATABASE {{sid}} CHARACTER SET {{characterset}}"},{"name":"验证","type":"CHECK","command":"check_oracle_running"}]',
  1, 10
);

-- MySQL 安装
INSERT INTO DEPLOY_TEMPLATE (TEMPLATE_NAME, DEPLOY_MODE, DEPLOY_TYPE, DB_TYPE, DESCRIPTION, PARAM_SCHEMA, STEPS_JSON, ENABLED, SORT_ORDER)
VALUES (
  'MySQL 单机安装', 'SINGLE', 'INSTALL', 'MYSQL',
  'MySQL 8.0 单实例标准安装，含环境检查、依赖安装、初始化、配置、启动和验证',
  '{"port":"number","dataDir":"string","memoryMb":"number"}',
  '[{"name":"环境检查","type":"CHECK","command":"check_mysql_env"},{"name":"安装依赖","type":"SHELL","command":"yum install -y libaio numactl"},{"name":"初始化","type":"SHELL","command":"mysqld --initialize-insecure --datadir={{dataDir}}"},{"name":"配置","type":"SHELL","command":"cp /etc/my.cnf /etc/my.cnf.bak && echo [mysqld] > /etc/my.cnf"},{"name":"启动","type":"SHELL","command":"systemctl start mysqld && systemctl enable mysqld"},{"name":"验证","type":"CHECK","command":"check_mysql_running"}]',
  1, 20
);

-- PostgreSQL 安装
INSERT INTO DEPLOY_TEMPLATE (TEMPLATE_NAME, DEPLOY_MODE, DEPLOY_TYPE, DB_TYPE, DESCRIPTION, PARAM_SCHEMA, STEPS_JSON, ENABLED, SORT_ORDER)
VALUES (
  'PostgreSQL 单机安装', 'SINGLE', 'INSTALL', 'POSTGRESQL',
  'PostgreSQL 15 单实例标准安装，含环境检查、安装、初始化集群、配置、启动和验证',
  '{"port":"number","dataDir":"string","maxConnections":"number"}',
  '[{"name":"环境检查","type":"CHECK","command":"check_pg_env"},{"name":"安装","type":"SHELL","command":"yum install -y postgresql15-server"},{"name":"初始化集群","type":"SHELL","command":"/usr/pgsql-15/bin/postgresql-15-setup initdb"},{"name":"配置","type":"SHELL","command":"sed -i s/^#listen_addresses.*/listen_addresses=''*''/ /var/lib/pgsql/15/data/postgresql.conf"},{"name":"启动","type":"SHELL","command":"systemctl start postgresql-15 && systemctl enable postgresql-15"},{"name":"验证","type":"CHECK","command":"check_pg_running"}]',
  1, 30
);

-- 达梦安装
INSERT INTO DEPLOY_TEMPLATE (TEMPLATE_NAME, DEPLOY_MODE, DEPLOY_TYPE, DB_TYPE, DESCRIPTION, PARAM_SCHEMA, STEPS_JSON, ENABLED, SORT_ORDER)
VALUES (
  '达梦单机安装', 'SINGLE', 'INSTALL', 'DAMENG',
  '达梦数据库单实例标准安装，含环境检查、用户创建、安装、初始化、配置和验证',
  '{"port":"number","dataDir":"string","instanceName":"string"}',
  '[{"name":"环境检查","type":"CHECK","command":"check_dameng_env"},{"name":"创建用户","type":"SHELL","command":"useradd -m dmdba && mkdir -p {{dataDir}}"},{"name":"安装","type":"SHELL","command":"/opt/dmdbms/bin/install.sh -i"},{"name":"初始化","type":"SHELL","command":"/opt/dmdbms/bin/dminit PATH={{dataDir}} INSTANCE_NAME={{instanceName}}"},{"name":"配置","type":"SHELL","command":"cp /opt/dmdbms/bin/DmService /etc/init.d/ && chkconfig --add DmService"},{"name":"验证","type":"CHECK","command":"check_dameng_running"}]',
  1, 40
);

COMMIT;
