# 平台授权（License）

按时间授权（月度 / 年度 / 试用 / 自定义天数），离线签名、绑定平台库。到期后**无法登录**，监控采集与告警**再运行 7 天**后停止。

## 1. 原理

| 项 | 做法 |
|---|---|
| 防篡改 | 授权文件用供应商私钥做 Ed25519 签名；平台只内置公钥（`dbops-server/src/main/resources/license/public.key`，打包进 jar，不提供配置覆盖）。改任何字段签名都对不上 |
| 绑定 | 机器码 = SHA-256(`DIOPS|DBID|` + 平台库 DBID) 前 16 位，形如 `8F3A-1C2D-55E0-9B7A`。DBID 由 `SYS_CONTEXT('USERENV','DBID')` 取得，不需要额外权限。**迁移应用服务器不用重签，换平台库才需要** |
| 时间 | 以平台库 `SYSTIMESTAMP` 为准（不用应用服务器时间），按北京时间判定；到期时间含当天 23:59:59 |
| 防回拨 | `SYS_LICENSE_STATE` 记录见过的最晚平台库时间，并用公钥、机器码和 `DBOPS_SECRET_KEY` 做 HMAC。当前时间比该记录早 1 小时以上 → 时间回拨。校验值对不上（换了应用服务器但密钥不是原来那把，或记录被改过）也会暂停授权，登录页同样显示「时间被回拨」，须按第 7 节区分 |
| 续期 | 新授权的生效日接在旧授权到期日之后，可提前导入，自动衔接；多份授权同时保存 |
| 实例上限 | 授权可带 `maxInstances`，新增 / 批量导入实例时校验 |

## 2. 到期前后的行为

| 状态 | 登录与接口 | 监控采集、SQL 洞察、告警、定时巡检 | 提示 |
|---|---|---|---|
| VALID 有效 | ✓ | ✓ | — |
| EXPIRING 15 天内到期 | ✓ | ✓ | 页面顶部横幅；到期前 7 天起每天在告警中心生成一条“授权到期提醒”（走告警推送策略） |
| EXPIRED 到期后 7 天内 | ✗（登录页显示原因与机器码，可导入授权） | ✓ | 每天一条 P1 告警 |
| STOPPED 到期超过 7 天 | ✗ | ✗ | — |
| NONE 未导入 / 未到生效时间 | ✗ | ✗ | 登录页提示导入 |
| CLOCK_TAMPERED 时间回拨或校验失败 | ✗ | ✗ | 先按第 7 节看日志：真回拨则校正平台库时间后自动恢复；密钥不一致则换回原 `DBOPS_SECRET_KEY` 后重启 |

拦截点：Java 网关的 `LicenseFilter` 作用于所有 `/api/*`（包括转发给 Node 的接口），返回 HTTP 403 + `code: 4031`；已登录的用户在下一次请求时回到登录页。
放行：`/api/license/status`、`/api/license/activate`（只接受验签通过、机器码一致、未过期的文件，所以不登录也能导入）、`/api/health`、`/api/auth/logout`。
Node（3001）与 Python Agent（8000）默认只监听 `127.0.0.1`，避免绕过网关直接访问。

## 3. 供应商：签发授权

签发工具 `tools/license/LicenseTool.java`：单文件、无依赖，JDK 17+ 直接运行。**私钥只保存在供应商处，不要放进代码库或发给客户。**

```bash
# 只做一次：生成密钥对（本次交付已生成，私钥单独提供；如需更换，见第 5 节）
java tools/license/LicenseTool.java genkey --out ~/diops-keys

# 年度授权（从今天起 12 个月），限 50 个实例
java tools/license/LicenseTool.java issue --key ~/diops-keys/private.key \
     --customer "某某银行" --type YEAR --machine 8F3A-1C2D-55E0-9B7A --max-instances 50

# 月度授权；续期时 --start 填旧授权到期日的次日
java tools/license/LicenseTool.java issue --key ~/diops-keys/private.key \
     --customer "某某银行" --type MONTH --start 2026-12-11 --machine 8F3A-1C2D-55E0-9B7A

# 试用 30 天 / 自定义 3 个月零 15 天
... --type TRIAL --days 30
... --type CUSTOM --months 3 --days 15

# 查看、校验签名
java tools/license/LicenseTool.java show 某某银行-LIC-xxx.lic --pub ~/diops-keys/public.key
```

Windows 命令行里客户名称含中文时，建议先执行 `chcp 65001`。

## 4. 客户：导入授权

1. **新装**：`sql/init.sql` 已含授权表；**已建库缺表**：执行安装包内 `sql/license_tables.sql` 或源码 `backend/sql/migration_license.sql`（可重复执行）。
2. 打开登录页，复制机器码发给供应商；或登录后在右上角菜单 → 授权信息 查看。
3. 收到 `.lic` 文件后，在登录页 / 授权信息里“选择 .lic 文件”或粘贴内容 → 导入授权。

**升级提示：** 升级到带授权的版本后，没有导入授权前无法登录。请先在旧版本或数据库中取得机器码（`SELECT SYS_CONTEXT('USERENV','DBID') FROM DUAL`，再用 `LicenseTool machine --dbid <DBID>` 计算），签发好授权再升级；或升级后在登录页直接导入。

## 5. 更换密钥

`genkey` 生成新密钥对 → 用新 `public.key` 覆盖 `dbops-server/src/main/resources/license/public.key` → 重新打包 → 用新私钥给所有客户重新签发。旧授权全部失效。

## 6. 局限

离线授权能防止改文件、拷贝到其它平台库、回拨时间，但 Java 程序可以被反编译后删掉校验。需要更强保护时，可以加代码混淆（ProGuard）把校验点分散，或改为联网激活。

## 7. 换应用服务器或升级后提示「时间被回拨」

同一台平台库只更换应用服务器时，机器码不变，**不用重新签发授权**。重新导入 `.lic` 也不会改写 `SYS_LICENSE_STATE`，所以密钥不对时会每次都看到同一句红字。

搬服务器之前：旧服务器的 `config/backend.env`（源码部署为 `backend/.env`）原样拷到新服务器，`DBOPS_SECRET_KEY`、`JWT_SECRET`、`AI_INTERNAL_TOKEN` 保持不变；启动日志有 `[env] loaded … keys from …`。不要删除 `SYS_LICENSE`、`SYS_LICENSE_STATE`。

排查顺序：

1. 看 `logs/dbops-java.log`。出现 `SYS_LICENSE_STATE 校验失败（记录被修改，或 DBOPS_SECRET_KEY 未加载/已更换）` 即密钥问题，做第 2 步。没有这句才做第 4 步。
2. 核对密钥：

```bash
grep -E '^DBOPS_SECRET_KEY=' config/backend.env
tr '\0' '\n' < /proc/$(pgrep -f dbops-server.jar | head -1)/environ | grep DBOPS_ENV_FILE
```

值必须与旧服务器一致，`DBOPS_ENV_FILE` 必须指向这份文件。改对后重启 Java，不必重新导入授权。

3. 旧密钥已丢失，且第 4 步确认时间正确：`DELETE FROM SYS_LICENSE_STATE;` 后重启。程序按当前密钥重建该行，已导入的授权仍在。被管库密码和 SSH 密码需在资产管理中重新保存，不要删实例。
4. 是否真的回拨：

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

`DB_UTC` 比 `LAST_SEEN_UTC` 早 1 小时以上才是时间回拨。校正平台库服务器时间，待数据库时间超过 `LAST_SEEN_UTC` 后约 1 分钟恢复。未追上之前不要删除该行。
