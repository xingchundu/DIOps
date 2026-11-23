# 平台库建表（客户包）

**新环境只需执行一个文件：**

```text
sql/init.sql
```

脚本开头含 `SET DEFINE OFF` / `SET SCAN OFF`（**PL/SQL Developer / SQL\*Plus 必效**），否则 `DEPLOY_TEMPLATE` 等 JSON 中的 `&&` 会弹出 “Enter value for” 并中断建库。

由安装包在打包时已合并全部建表与种子数据（含 **授权表 SYS_LICENSE**、SQL 洞察、平台运维等），无需再执行 `migration_*.sql`。

**说明：**

- `backend/` 目录内**不含** SQL 脚本，避免与 `sql/` 重复。
- 若库已用旧版 `init.sql` 建过但缺授权表，可单独执行 `sql/license_tables.sql`（与仓库 `migration_license.sql` 相同，可重复执行）。
- 若从旧版本升级，请向厂商索取对应版本的**增量升级脚本**（不在本安装包内）。