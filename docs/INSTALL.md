# 数据库智能平台 — 安装与部署指南

面向开发与运维的安装说明。版本功能变更见根目录 [README.md](../README.md)。

---

## 1. 概述

| 组件 | 说明 | 默认地址 |
|------|------|----------|
| 前端（Vue + Vite） | Web 控制台 | 开发：`https://localhost:5173`；生产：Nginx 静态站 |
| 后端（Node.js） | REST API、监控采集、代理 | `http://0.0.0.0:3000` |
| 平台库（Oracle） | 元数据、RBAC、CMDB、告警等 | 由 `backend/.env` 配置 |
| SQL Optimizer Agent（可选） | Python FastAPI，SQL 优化 | `http://127.0.0.1:8000` |
| AI Ops Agent（可选） | Python FastAPI，RCA / ChatOps 等 | `http://127.0.0.1:8001` |

**默认账号（首次登录后请改密）**

| 账号 | 密码 | 角色 |
|------|------|------|
| admin | Admin@123456 | 超管 |
| dba | Dba@123456 | DBA |

---

## 2. 环境要求

### 必装

| 依赖 | 版本 / 说明 |
|------|-------------|
| Node.js | **≥ 18**（`node` / `npm`） |
| Oracle 平台库 | 建议 19c；应用机默认 **Thin 模式**，**无需** Oracle Instant Client |
| 网络 | 应用机可访问平台库监听端口（常见 `1521`） |

### 开发可选

| 依赖 | 说明 |
|------|------|
| Python | **≥ 3.10**（`py` 或 `python`），用于两个 Agent |
| OpenSSL 或 Git for Windows | 生成 `certs/server.crt` / `server.key`（Vite HTTPS） |
| Ollama 或 OpenAI 兼容 API | SQL 优化 / AI 分析的 LLM（不配也能起服务，智能能力受限） |

### 生产可选

| 依赖 | 说明 |
|------|------|
| Nginx（或同类反向代理） | 托管前端静态资源并反代 `/api` |
| Oracle Instant Client | 仅当设置 `NODE_ORACLEDB_DRIVER_MODE=thick` 时需要 |

### 2.1 Linux 一键安装依赖（含离线）

`start-all.sh` 需要 **Node.js 18+**。若项目根目录已有 `offline-bundle/`，执行 `./start-all.sh start` 会**自动安装** Node、npm 依赖和 Python Agent，无需再上网。

**有网络的服务器：**

```bash
bash scripts/install-deps.sh
# 或强制联网
bash scripts/install-deps.sh --online
```

脚本会：安装 Node.js 到 `deps/node`、执行 `backend`/`frontend` 的 `npm install`，并在有 `offline-bundle` 时安装 Python Agent 虚拟环境。

**无法上网的服务器（离线）：**

1. 在**有网络的 Linux x64 机器**上（与离线机同架构）生成离线包：

```bash
bash scripts/prepare-offline-bundle.sh
tar -czf diops-offline-bundle.tgz offline-bundle/
```

Windows 开发机也可预下载（npm 按 linux/x64 打包）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-offline-bundle.ps1
```

2. 将 `offline-bundle/`（或 `diops-offline-bundle.tgz` 解压后）放到离线 Linux 服务器的**项目根目录**，直接启动：

```bash
./start-all.sh start
```

`start-all.sh` 会自动检测 `offline-bundle/`，安装 Node.js、`node_modules`、Python Agent 依赖后再启动，**无需联网**。

也可手动安装：`bash scripts/install-deps.sh --offline && ./start-all.sh start`

离线包内容：`node-v18.*-linux-x64.tar.xz`、`archives/*-node_modules.tgz`、`npm-cache/`、`python/wheels/`。

---

## 3. 数据库配置
sqlplus monitor/YourPassword@host:1521/ora19c @backend/sql/init.sql
平台涉及**两类**数据库，配置方式不同，请勿混淆：

| 类型 | 用途 | 配置位置 |
|------|------|----------|
| **平台库** | 用户/RBAC、CMDB 元数据、告警、监控样本、巡检记录等 | `backend/.env`（Node 后端）；AI Agent 另需 `backend/ai-ops-agent/.env` |
| **被管库** | 平台纳管并监控/巡检/SQL 执行的 Oracle、MySQL、PostgreSQL、达梦、SQL Server 等 | 控制台 **CMDB → 实例管理**（连接信息写入 `CMDB_INSTANCE`） |

下文先讲**平台库**（必配），再讲**被管库**（按需纳管）。

### 3.1 创建 Oracle 平台库用户（DBA 执行）

平台库建议使用**独立业务用户**（示例 `monitor`），不要用 `SYS` / `SYSTEM` 跑应用。

以 CDB/PDB 环境为例（PDB 名 `ORCLPDB1`，可按实际修改）：

```sql
-- 在 PDB 中执行（或等价环境）
ALTER SESSION SET CONTAINER = ORCLPDB1;

CREATE USER monitor IDENTIFIED BY "YourStrongPassword"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

GRANT CREATE SESSION TO monitor;
GRANT CREATE TABLE TO monitor;
GRANT CREATE SEQUENCE TO monitor;
GRANT CREATE VIEW TO monitor;
GRANT CREATE PROCEDURE TO monitor;
GRANT CREATE TRIGGER TO monitor;
-- 若希望一次授权，也可：GRANT CONNECT, RESOURCE TO monitor;
```

**权限说明**

- 应用用户只需在**自身 Schema** 下建表；`init.sql` 会在该用户下创建全部平台表。  
- 不需要 DBA 角色；不要授予 `SELECT ANY TABLE` 等过大权限。  
- 平台后端通过 **node-oracledb Thin 模式**连库，Oracle 版本建议 **12.1+**（推荐 19c）。

### 3.2 初始化平台库表结构

使用**上一步创建的平台库用户**执行建表脚本（连接串按环境修改）：

```bash
sqlplus monitor/YourStrongPassword@192.168.137.102:1521/ora19c @backend/sql/init.sql
```

> Windows 可在 SQL\*Plus 或 SQL Developer 中打开 `backend/sql/init.sql` 执行。  
> `init.sql` 文件头注释中的示例用户名为 `moitor`，仅为历史笔误，实际请使用你创建的 `monitor`（或自定义用户名，并与 `.env` 中 `DB_USER` 一致）。

脚本会创建平台表并写入种子数据，包括：

- RBAC 用户/角色/菜单  
- 默认账号 `admin` / `dba`（见本文第 1 节）  
- 示例 CMDB 主机与被管实例（可按需删除或修改）

#### 增量迁移（已合并）

**新环境只需执行 `init.sql` 即可**，其中已包含原 `migration_*.sql` 中的全部表结构与种子数据。

若库是**早期版本**、仅执行过旧版 `init.sql`，才需要按需补跑 `backend/sql/migration_*.sql` 中尚未执行的脚本。已存在同名对象时勿重复整脚本执行。

若默认账号无法登录，可对照 `init.sql` 末尾注释中的 `UPDATE SYS_USER ...` 修正密码哈希。

### 3.3 配置 Node 后端（`backend/.env`）

在 `backend/` 目录创建 `.env`（仓库通常不提交该文件）。后端启动时由 `dotenv` 加载，连接池逻辑见 `backend/src/config/db.js`。

#### 平台库连接（三选一）

| 方式 | 必填变量 | 连接串格式 |
|------|----------|------------|
| **整串（推荐生产）** | `DB_CONNECT_STRING` | `host:port/服务名` 或 `host:port/SID` |
| **服务名** | `DB_HOST` + `DB_PORT` + `DB_SERVICE_NAME` | 拼成 `host:port/service` |
| **SID** | `DB_HOST` + `DB_PORT` + `DB_SID` | 拼成 `host:port/sid` |

> 同时配置时 **`DB_CONNECT_STRING` 优先**；`DB_SERVICE_NAME` 与 `DB_SID` 二选一即可，不要混填冲突值。

**示例 A：Easy Connect + SID**

```env
DB_HOST=192.168.137.102
DB_PORT=1521
DB_SID=ora19c

DB_USER=monitor
DB_PASSWORD=YourStrongPassword
```

**示例 B：Easy Connect + 服务名（PDB 常用）**

```env
DB_HOST=192.168.137.102
DB_PORT=1521
DB_SERVICE_NAME=ORCLPDB1

DB_USER=monitor
DB_PASSWORD=YourStrongPassword
```

**示例 C：整串**

```env
DB_CONNECT_STRING=192.168.137.102:1521/ORCLPDB1
DB_USER=monitor
DB_PASSWORD=YourStrongPassword
```

#### 完整 `.env` 模板

```env
# ---------- 平台库 Oracle（必填） ----------
DB_HOST=192.168.137.102
DB_PORT=1521
DB_SID=ora19c
# DB_SERVICE_NAME=ORCLPDB1
# DB_CONNECT_STRING=192.168.137.102:1521/ORCLPDB1

DB_USER=monitor
DB_PASSWORD=YourStrongPassword

# ---------- 应用（必填 / 建议） ----------
JWT_SECRET=请换成足够长的随机串
# 被管库密码 / SSH 凭据的 AES-256-GCM 加密密钥（务必备份；丢失后只能重新录入各实例密码）
DBOPS_SECRET_KEY=请换成足够长的随机串
# Node 与 SQL 优化 / AI 分析两个 Python 服务之间的内部令牌
AI_INTERNAL_TOKEN=请换成足够长的随机串
# 以上三项用 start-all.sh / start-all.bat 启动时若为空会自动生成
JWT_EXPIRES=8h
PORT=3000
NODE_ENV=production

# ---------- Oracle 驱动（可选） ----------
# 默认 thin，应用机无需 Instant Client
# NODE_ORACLEDB_DRIVER_MODE=thick

# ---------- 被管 SQL Server 全局 TLS（可选，CMDB 纳管 MSSQL 时） ----------
# MSSQL_ENCRYPT=true
# MSSQL_TRUST_CERT=false

# ---------- Python 微服务地址（可选） ----------
# SQL_AGENT_URL=http://127.0.0.1:8000
# AI_OPS_AGENT_URL=http://localhost:8001

# ---------- 反向代理（生产 Nginx 后建议） ----------
# TRUST_PROXY=1
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `DB_USER` / `DB_PASSWORD` | 是 | 平台库 Oracle 用户名/密码 |
| `DB_CONNECT_STRING` 或 `DB_HOST`+端口+SID/服务名 | 是 | 见上表 |
| `JWT_SECRET` | 是 | 登录 Token 签名密钥，生产必须更换 |
| `JWT_EXPIRES` | 否 | Token 有效期，默认 `8h` |
| `PORT` | 否 | 后端监听端口，默认 `3000` |
| `NODE_ORACLEDB_DRIVER_MODE` | 否 | `thin`（默认）或 `thick` |
| `MSSQL_ENCRYPT` | 否 | 连接被管 SQL Server 是否加密 |
| `MSSQL_TRUST_CERT` | 否 | 是否信任自签证书，默认不信任 |
| `SQL_AGENT_URL` | 否 | SQL Optimizer 地址 |
| `AI_OPS_AGENT_URL` | 否 | AI Ops Agent 地址 |
| `TRUST_PROXY` | 否 | 经 Nginx 反代时设为 `1` |

### 3.4 配置 AI Ops Agent 平台库（可选）

AI 分析微服务读写**同一套平台库**（监控样本、CMDB、RCA 结果等），需在 `backend/ai-ops-agent/` 下单独配置 `.env`：

```env
ORACLE_USER=monitor
ORACLE_PASSWORD=YourStrongPassword
ORACLE_DSN=192.168.137.102:1521/ora19c

AI_OPS_HOST=127.0.0.1
AI_OPS_PORT=8001
# AI_OPS_INTERNAL_TOKEN=可选，与 Node 转发约定一致时启用
```

| 变量 | 说明 |
|------|------|
| `ORACLE_USER` / `ORACLE_PASSWORD` / `ORACLE_DSN` | **必填**，与 `backend/.env` 指向同一平台库；`ORACLE_DSN` 为 Easy Connect 串（`host:port/service` 或 `host:port/sid`） |
| `AI_OPS_HOST` / `AI_OPS_PORT` | Agent 监听地址，默认 `127.0.0.1:8001` |

未配置上述 Oracle 三项时，AI Agent 启动后访问数据库会报错。

> **SQL Optimizer Agent** 不固定连接平台库：优化时由前端/用户指定被管库连接，或通过 `NODE_BACKEND_URL` 回调 Node；一般只需保证 `backend/.env` 与 CMDB 中实例信息正确。

### 3.5 纳管被管数据库（CMDB）

被管库**不要**写进 `backend/.env`（平台库除外）。登录控制台后：

**路径：** CMDB → 实例管理 → 新增实例

| 字段 | 说明 |
|------|------|
| 实例名称 | 平台内展示名 |
| 数据库类型 | `ORACLE` / `MYSQL` / `POSTGRESQL` / `GOLDENDB` / `DAMENG` / `PANWEI` / `SQLSERVER` 等 |
| 主机 IP / 端口 | 被管库监听地址 |
| SID / 服务名 | Oracle 类必填其一；MySQL 等可留空 SID |
| 数据库用户 / 密码 | **被管库**专用账号（≠ 平台库 `DB_USER`）；用于监控/SQL/巡检。权限不足时往往只能看到本 schema，见 [monitor-target-db-privileges.md](./monitor-target-db-privileges.md) |
| 环境 / 业务线 | 便于筛选与报表 |

**各类型默认端口（参考）**

| 类型 | 默认端口 |
|------|----------|
| Oracle | 1521 |
| MySQL / GoldenDB | 3306 |
| PostgreSQL / 磐维 | 5432 |
| 达梦 | 5236 |
| SQL Server | 1433 |

**SQL Server TLS**：在 `backend/.env` 中设置 `MSSQL_ENCRYPT`、`MSSQL_TRUST_CERT`（见 3.3 节），对所有经 `mssql` 驱动的连接生效。

密码在平台库中以 Base64 编码存入 `CMDB_INSTANCE.DB_PASSWORD`（非明文）；应用连接时会自动解码。

**Oracle 被管库监控用户（DBA 在被管库执行，完整说明见 [monitor-target-db-privileges.md](./monitor-target-db-privileges.md)）**

监控采集会读 `V$SESSION`、`V$SQL`、`DBA_DATA_FILES` 等字典/动态视图。**目录只读权限二选一**（不要与平台库用户混用）：

| 方式 | 说明 |
|------|------|
| **推荐** | `GRANT SELECT ANY DICTIONARY TO diops_monitor;` — 与产品默认 SQL 一致 |
| **备选** | `GRANT SELECT_CATALOG_ROLE TO diops_monitor;` — 仅当企业禁止 ANY DICTIONARY；**授后必须**用 `v$session` / `dba_data_files` 自检，不通过则改 ANY DICTIONARY 或逐对象补权 |

```sql
CREATE USER diops_monitor IDENTIFIED BY "替换为强口令"
  DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp;

GRANT CREATE SESSION TO diops_monitor;
GRANT LOGMINING TO diops_monitor;
GRANT SELECT ANY DICTIONARY TO diops_monitor;   -- 推荐；备选见上表
GRANT SELECT ANY TRANSACTION TO diops_monitor;
-- 纯只读监控可不授：CREATE TABLE / CREATE SEQUENCE（部分巡检需在被管库建临时对象时再开）
```

部署自检（`diops_monitor` 登录）：

```sql
SELECT COUNT(*) FROM v$session;
SELECT COUNT(*) FROM dba_data_files;
SELECT sql_id FROM v$sql WHERE ROWNUM = 1;
```

### 3.6 验证数据库配置

**1）SQL\*Plus 连通性**

```bash
sqlplus monitor/YourStrongPassword@192.168.137.102:1521/ora19c
SQL> SELECT COUNT(*) FROM SYS_USER;
```

**2）Node 初始化检测脚本**

```bash
cd backend
npm install
node src/utils/initDb.js
```

成功时会输出「数据库连接成功」及平台表检查结果；缺表会提示需执行 `init.sql`。

**3）启动后端看日志**

```bash
node app.js
```

正常应出现类似：

```text
[DB] Oracle pool OK (thin) min=2 max=20 timeout=60s -> 192.168.137.102:1521/ora19c
```

**4）健康检查与登录**

```bash
curl http://127.0.0.1:3000/health
```

浏览器登录 `admin` / `Admin@123456`；CMDB 中可测试纳管实例连通性。

### 3.7 Oracle Thick 模式（可选）

默认 **Thin 模式**无需安装 Oracle Instant Client。仅在必须使用 Thick 特性时：

```env
NODE_ORACLEDB_DRIVER_MODE=thick
```

并安装 Instant Client，配置 `LD_LIBRARY_PATH`（Linux）等。详见 [node-oracledb 安装说明](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html)。

---

## 4. 配置后端环境变量（速查）

完整说明见 **第 3.3 节**。最小可运行配置：

```env
DB_HOST=192.168.137.102
DB_PORT=1521
DB_SID=ora19c
DB_USER=monitor
DB_PASSWORD=YourStrongPassword
JWT_SECRET=请换成足够长的随机串
PORT=3000
```

---

## 5. 第 1 章：开发安装

目标：本机快速跑通前后端（及可选 Agent），便于联调。

### 5.1 一键启动（推荐）

**Windows**（项目根目录）：

```bat
start-all.bat
```

**Linux**（对齐 `start-all.bat`，后台启动 + PID/日志）：

```bash
chmod +x start-all.sh stop-all.sh   # 首次
./start-all.sh start                # 或 ./start_all.sh start
./start-all.sh stop                 # 或 ./stop-all.sh
./start-all.sh status
./start-all.sh restart
```

脚本会：

1. 检查 Node.js  
2. 若无证书则尝试生成 `certs/` 自签 HTTPS 证书  
3. 启动后端（`npm install` + `node app.js`，端口 **3000**）  
4. 启动前端（`npm install` + `npm run dev`，端口 **5173**）  
5. 若检测到 Python 与 Agent 目录，再启动 SQL Optimizer（**8000**）与 AI Ops Agent（**8001**）  

日志目录：`logs/`（如 `backend.log`、`frontend.log`）；Linux PID：`logs/pids/`。

访问：

- 前端登录：`https://localhost:5173/login`（证书为自签，浏览器需信任或继续访问）  
- 后端健康检查：`http://localhost:3000/health`  

### 5.2 分步启动

**后端**

```bash
cd backend
npm install
node app.js
```

**前端**

```bash
# 首次建议生成证书（Windows PowerShell）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-ssl-cert.ps1
# Linux / macOS：scripts/gen-ssl-cert.sh

cd frontend
npm install
npm run dev
```

开发时 Vite 将 `/api` 代理到 `http://127.0.0.1:3000`（可用 `frontend/.env.development` 中 `VITE_DEV_PROXY_TARGET` 覆盖）。若需关闭 HTTPS：`VITE_HTTPS=0`。

**仅后端（Linux）**

```bash
./start.sh start    # stop | restart | status | logs
```

### 5.3 开发验收

```bash
curl http://localhost:3000/health
```

浏览器打开登录页，使用 `admin` / `Admin@123456` 登录成功即核心链路可用。

---

## 6. 第 2 章：生产部署

目标：后端常驻 + 前端构建产物由 Nginx（或同类）提供，对外只暴露 HTTPS。

### 6.1 后端

```bash
cd backend
npm install --production
# 确认 .env 已按第 3.3 节配置，且 JWT_SECRET 已更换
node app.js
# 或使用进程管理：systemd / pm2 / forever 等，工作目录为 backend/
```

健康检查：`http://127.0.0.1:3000/health`（建议仅本机或内网可达，由反向代理对外暴露）。

**可选 Thick 模式**（一般不需要）：见 **第 3.7 节**。

### 6.2 前端构建

```bash
cd frontend
npm install
npm run build
# 产物目录：frontend/dist
```

将 `dist` 部署到服务器目录（示例 `/opt/dbops/frontend/dist`）。

### 6.3 Nginx 示例

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    root /opt/dbops/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 长请求 / SSE（SQL Agent 流式等）可按需加大超时
        proxy_read_timeout 300s;
    }
}
```

HTTP 仅监听时可去掉 `ssl_*`，将 `listen` 改为 `80`。前端 `baseURL` 为 `/api`，反代路径需与此一致。

重载：

```bash
nginx -t && nginx -s reload
```

### 6.4 生产侧 Python Agent（可选）

与开发相同：在服务器上为各 Agent 建 venv、安装依赖并常驻运行；保证后端能访问：

- `SQL_AGENT_URL`（默认 `http://127.0.0.1:8000`）  
- `AI_OPS_AGENT_URL`（默认 `http://localhost:8001`）  

不必把 8000/8001 暴露到公网；由 Node 后端鉴权后代理即可。

### 6.5 版本升级注意事项（存量环境）

离线客户包升级、源码/开发环境换版本，均适用本节。新装请从 **第 3～5 节**执行，本节**不要**在全新安装时重复做迁移。

#### 升级前必做（备份）

| 备份项 | 位置 | 丢失后果 |
|--------|------|----------|
| **`DBOPS_SECRET_KEY`** | `backend/.env` 或离线包 `config/backend.env` | 无法解密已保存的**被管库密码**、SSH 凭据；CMDB 实例显示离线或「凭据解密失败」，须在控制台**逐个重录密码**（不必删实例） |
| **`JWT_SECRET`** | 同上 | 已登录 Token 失效，用户需重新登录 |
| **`AI_INTERNAL_TOKEN`** | 同上 | Node 调用 Python Agent 可能 401，需与两份 `.env` 保持一致 |
| **整份 `.env`** | 同上 | 建议直接复制备份文件，升级后只合并**新增配置项**，勿覆盖密钥 |

> **禁止**：升级时用安装脚本自动生成的**新** `DBOPS_SECRET_KEY` / `JWT_SECRET` 覆盖生产旧值（除非已接受在 CMDB 中重录全部被管库与主机凭据）。  
> `start-all.sh` / `bin/install.sh` 仅在密钥为空或过短时才会生成新值；升级前应保证三项密钥**已存在且足够长**。

#### 升级步骤（推荐顺序）

1. **停服务**：`./bin/stop.sh` 或 `./start-all.sh stop`（离线包 / 源码根目录）。
2. **备份** `config/backend.env` / `backend/.env`（见上表）。
3. **平台库增量 SQL**（由厂商按**当前版本 → 目标版本**提供脚本列表；离线安装包内**不含** `migration_*.sql`）  
   - 在**原平台库**、**原平台用户**下执行，可重复执行的脚本一般带 `DI_EXEC_IGNORE` / 幂等设计。  
   - 新装仅需 `init.sql`；旧库缺表时常见补跑示例（以厂商清单为准）：  
     `migration_license.sql`、`migration_security_fixes.sql`、`migration_sql_insight.sql`、`migration_db_inspect.sql` 等。  
   - 详见 [README.md](../README.md) 各版本说明、[LICENSE.md](./LICENSE.md)、[CODE_REVIEW_RESPONSE.md](./CODE_REVIEW_RESPONSE.md)。
4. **替换程序**：用新版本离线包覆盖安装目录（或更新 `dbops-server.jar`、`frontend/dist`、`backend` 等），**不要用开发源码目录直接覆盖客户离线包**。
5. **恢复配置**：将备份的 `DBOPS_SECRET_KEY`、`JWT_SECRET`、`AI_INTERNAL_TOKEN` 写回 `config/backend.env` / `backend/.env`；核对 `DB_HOST` / `DB_SID` / 密码未误改。
6. **检查 `.env` 格式**：每行一个变量，例如 `AI_OPS_HOST=127.0.0.1` **单独一行**，勿与其它键拼在同一行（否则 AI 服务会启动失败）。
7. **启动**：`./bin/start.sh` 或 `./start-all.sh start`；查看 `logs/dbops-java.log` 出现 `[DB] Oracle pool OK`。
8. **验收**：`curl -k https://127.0.0.1:<HTTPS_PORT>/health`；登录验证；CMDB 抽查实例连通性；按需验证授权状态（见下）。

#### 平台授权（License，v4.2+）

| 事项 | 说明 |
|------|------|
| 绑定对象 | 授权绑定**平台库 DBID**（机器码），非应用服务器 IP；**只换应用、不换库**一般无需重签 |
| 换平台库 | 机器码变化，须向供应商提供**新机器码**后重新签发 `.lic` |
| 导入方式 | **登录页**可**未登录**导入（「导入授权」）；完整 JSON 或 `.lic` 文件，见 [LICENSE.md](./LICENSE.md) |
| 授权表 | `SYS_LICENSE`（导入记录）、`SYS_LICENSE_STATE`（防时间回拨；校验值含 `DBOPS_SECRET_KEY`，**勿手工改时间或 MAC**） |
| 导入失败 | 先排除「平台库不可用」；再核对机器码、签名、是否过期；一般不须先删 `SYS_LICENSE`，同 `licenseId` 可重复导入 |
| 换应用服务器后登录页仍提示「时间被回拨」 | 见下方排查。同一平台库机器码不变，**不用重签**；重新导入授权也不会改写 `SYS_LICENSE_STATE` |

#### 换应用服务器或升级后：登录页提示「时间被回拨」

登录页「检测到系统时间被回拨，授权暂不可用」在换应用服务器时，多数不是平台库时间错了，而是新机器上的 `DBOPS_SECRET_KEY` 和 `SYS_LICENSE_STATE` 里的校验值对不上。

搬服务器或升级之前：把旧服务器的 `config/backend.env` / `backend/.env` 原样拷过来，至少 `DBOPS_SECRET_KEY`、`JWT_SECRET`、`AI_INTERNAL_TOKEN` 与旧环境相同；启动日志应有 `[env] loaded … keys from …`，且路径是这份文件。不要删 `SYS_LICENSE`、`SYS_LICENSE_STATE`。

出现红字后：

1. 看 `logs/dbops-java.log`。有 `SYS_LICENSE_STATE 校验失败（记录被修改，或 DBOPS_SECRET_KEY 未加载/已更换）` 就是密钥问题，做第 2 步。没有这句、只有时间回拨，才做第 4 步。
2. 核对密钥是否加载：

```bash
grep -E '^DBOPS_SECRET_KEY=' config/backend.env
tr '\0' '\n' < /proc/$(pgrep -f dbops-server.jar | head -1)/environ | grep DBOPS_ENV_FILE
```

`DBOPS_SECRET_KEY` 必须与旧服务器完全一致，`DBOPS_ENV_FILE` 必须指向这份文件。改对后重启 Java，不用重新导入授权。

3. 旧密钥已丢失：先用下面的 SQL 确认平台库时间正确，再 `DELETE FROM SYS_LICENSE_STATE;` 并重启。程序按当前密钥重写该行，已导入的 `SYS_LICENSE` 仍在。用旧密钥加密的被管库 / SSH 密码会解不开，到资产管理里重新保存密码，不要删实例。
4. 区分是否真的回拨：

```sql
SELECT LAST_SEEN_MS,
       TO_CHAR(
         TIMESTAMP '1970-01-01 00:00:00 UTC'
         + NUMTODSINTERVAL(LAST_SEEN_MS/1000, 'SECOND'),
         'YYYY-MM-DD HH24:MI:SS'
       ) AS LAST_SEEN_UTC,
       TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), 'YYYY-MM-DD HH24:MI:SS') AS DB_UTC
FROM SYS_LICENSE_STATE
WHERE ID = 1;
```

`DB_UTC` 比 `LAST_SEEN_UTC` 早 1 小时以上，才是时间回拨。把平台库服务器时间改正确，等数据库时间超过 `LAST_SEEN_UTC` 后约 1 分钟提示消失。时间未追上前不要删这行。

#### 升级后监控/CMDB 离线

- 若出现 **`凭据解密失败（DBOPS_SECRET_KEY 与加密时不一致？）`**：恢复升级前的 `DBOPS_SECRET_KEY` 并重启；无法恢复则在 **CMDB → 实例管理** 编辑实例**重新保存数据库密码**（主机 SSH 同理）。
- 演示/种子实例可停用或改正连接信息，不必保留错误账号（如历史种子中的笔误用户）。

#### Java 网关（v4.0+）

核心 API 与监控采集在 **Java `dbops-server`（默认 3000）**；升级须包含新 `dbops-server.jar`（或离线包 `app/`）。离线包不要只换 Node 而不换 Java。

#### Python Agent（可选）

SQL 优化（8000）、AI 分析（8001）需要 **CPython 3.9+**；离线包自带 `runtime/python`。升级后若 Agent 未起，执行 `bash scripts/install-deps.sh` 或离线包 `bin/install.sh` 重建 venv。

#### 给客户/实施的检查清单

- [ ] 升级前已备份 `config/backend.env` / `backend/.env`（含三项密钥）  
- [ ] 已执行厂商提供的增量 SQL  
- [ ] 升级后密钥与升级前**一致**（或已计划在 CMDB 重录凭据）  
- [ ] `dbops-java` / 网关健康检查通过  
- [ ] 授权仍为 `VALID` 或已在登录页重新导入  
- [ ] 被管实例连通性正常  

---

## 7. 可选组件：Python Agent

不启动 Agent 时，平台主体（登录、CMDB、监控、告警等）仍可用；SQL 优化页与 AI 分析相关功能会不可用或报错。

### 7.1 SQL Optimizer（端口 8000）

```bash
cd backend/sql-optimizer-agent
python -m venv venv

# Windows
venv\Scripts\activate
# Linux / macOS
# source venv/bin/activate

pip install -r requirements.txt
python app.py
```

前端经 `/api/sql-agent`（开发态也可由 Vite 直代）访问。LLM（Ollama / OpenAI 兼容）配置见根目录 README「SQL 优化 Agent」章节。

### 7.2 AI Ops Agent（端口 8001）

```bash
cd backend/ai-ops-agent
python -m venv venv
# 激活 venv 后：
pip install -r requirements.txt
python app.py
```

环境变量示例：`AI_OPS_PORT=8001`、`AI_OPS_HOST=127.0.0.1`。Node 通过 `/api/ai/*` 转发。

---

## 8. 验收检查清单

- [ ] 按 **第 3.1～3.2 节**创建平台用户并执行 `init.sql`  
- [ ] **第 3.3 节** `backend/.env` 配置正确，`node src/utils/initDb.js` 或启动日志出现 Oracle pool OK  
- [ ] `curl http://127.0.0.1:3000/health` 返回正常  
- [ ] 开发：可打开 `https://localhost:5173/login`；生产：经 Nginx 打开站点并登录  
- [ ] （可选）`http://127.0.0.1:8000` / `8001` 文档或健康接口可达  
- [ ] （按需）相关 `migration_*.sql` 已执行，对应菜单无 ORA-00942  

---

## 9. 常见问题

**后端连接 Oracle 失败**

- 按 **第 3.3 节**核对 `DB_HOST` / `DB_PORT` / `DB_SERVICE_NAME` 或 `DB_SID`（或 `DB_CONNECT_STRING`）与 `.env` 是否指向已执行 `init.sql` 的同一用户。  
- 用 **第 3.6 节**步骤：`sqlplus` 直连 → `node src/utils/initDb.js` → 查看 `Oracle pool OK` 日志。  
- Thin 模式无需 Instant Client；Thick 模式见 **第 3.7 节**。  
- 网络：`telnet <DB_HOST> 1521` 或 `tnsping`。

**前端提示网络错误 / 代理失败**

- 确认后端已在 3000 监听；开发时 Vite 代理目标是否指向该端口。  
- 生产 Nginx 的 `location /api/` 是否 `proxy_pass` 到后端，且路径无多余截断。

**登录失败但库已初始化**

- 确认 `init.sql` 由与 `DB_USER` 相同的平台库用户执行，且 `.env` 指向同一库。  
- 对照 `init.sql` 注释重置 `admin` 密码哈希。

**AI 分析 / RCA 报 Oracle 配置缺失**

- 检查 `backend/ai-ops-agent/.env` 是否配置 `ORACLE_USER`、`ORACLE_PASSWORD`、`ORACLE_DSN`（见 **第 3.4 节**）。

**升级后被管实例离线 / 凭据解密失败**

- 见 **第 6.5 节**：升级时是否更换了 `DBOPS_SECRET_KEY`；恢复旧密钥或在 CMDB 中重录实例密码。

**授权无法导入 / 登录页提示时间被回拨**

- 见 **第 6.5 节**「换应用服务器或升级后」与 [LICENSE.md](./LICENSE.md)。同一平台库只换应用服务器时机器码不变，不用重签；红字多半是 `DBOPS_SECRET_KEY` 与 `SYS_LICENSE_STATE` 不一致。

**被管实例连接失败（CMDB 纳管）**

- 在控制台核对实例 IP、端口、SID/服务名、账号密码。  
- SQL Server 检查 `MSSQL_ENCRYPT` / `MSSQL_TRUST_CERT`（**第 3.5 节**）。  
- 确认应用机到被管库防火墙已放行。

**自动化运维 / 巡检报 ORA-00942**

- 执行 `migration_v2_automation_pro.sql` 等对应增量脚本。

**oracledb npm 安装失败**

- 见官方文档：<https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html>

**开发 HTTPS 证书缺失**

- 运行 `scripts/gen-ssl-cert.ps1`（Windows）或 `scripts/gen-ssl-cert.sh`；或设 `VITE_HTTPS=0` 使用 HTTP。

---

## 10. 相关路径速查

```
DIOps/
├── backend/                 Node 后端 + .env
│   ├── app.js
│   ├── sql/init.sql
│   ├── sql/migration_*.sql
│   ├── sql-optimizer-agent/ 可选，:8000
│   └── ai-ops-agent/        可选，:8001
├── frontend/                Vue 前端（dist 为构建产物）
├── certs/                   开发/内网自签证书
├── scripts/gen-ssl-cert.*   证书生成
├── start-all.bat            Windows 一键启动
├── start.sh                 Linux 后端启停
└── docs/INSTALL.md          本文档
```
