# Oracle CheckV8 深度巡检（平台内）

本功能将原独立脚本 **CheckV8.py** 中的 **Oracle 侧检查项** 迁入「自动化运维 → 自动巡检」，在 **DIOps 后端** 通过 `oracledb` 直连被管实例执行，结果写入平台 Oracle：

- `INSPECT_CHECKV8_REPORT`：完整 JSON（`PAYLOAD`）、可选 **Word**（`DOCX_BLOB`）、`TARGET_LABEL` / `ROW_NUM`（Excel 行）
- `INSPECT_RESULT`：`CHECK_ITEM = CHECKV8_ORACLE` 的摘要行

## 不包含的内容（已按产品要求移除）

- **许可证 / 试用 / 机器码 / XOR 加密**（原 `LicenseValidator`、`SimpleCrypto`）
- **邮件发送、SMTP、授权码、加密邮箱配置**（原 `sendmailcheck` / 智能邮件说明中的全部内容）
- **远程 SSH 主机巡检**（原 Python `paramiko` 段落）：平台当前仅执行 **数据库内 SQL**；主机层指标请继续使用「监控中心」Prometheus/Exporter

## 使用方式

1. 在 **资产管理** 中配置 Oracle 实例及 **有足够字典视图权限** 的账号（至少需能查询 `v$`；`dba_*` 部分项失败时会记入报告 `skipped`）。
2. **自动化运维 → 自动巡检**：
   - **单实例 CheckV8**：可选 **纳管实例**（下拉）或 **手动连接**（主机/端口/服务名或 SID/用户/口令）；手动凭据仅用于当次连接，不写入 CMDB。
   - **手动批次**：新建批次并填写逗号分隔实例 ID；**运行(CheckV8)** 对每个 Oracle 执行；非 Oracle 写入 `AUTO_BATCH_SKIP` 说明。
   - **Excel 批量（对齐原「下模板 → 填表 → 上传 → 巡检 → 下 Word」）**：
     1. 点击 **下载 Excel 模板**（`.xlsx`）。
     2. 按列填写：实例 ID（选填）、主机 IP、端口、服务名/SID、用户、密码、备注；填实例 ID 可走 CMDB，可不填直连列。
     3. **上传 Excel 建批次**（字段名 `file`），再在列表中 **运行(CheckV8)**。
     4. 巡检完成后点 **Word ZIP** 下载本批次生成的 `.docx` 压缩包。
3. 在 **CheckV8 报告历史** 中点 **详情 JSON** 查看完整结果。

**安全提示**：Excel 中的数据库口令会随批次写入平台库 `EXCEL_TARGETS`（JSON）；生产环境请评估合规要求，优先使用 **仅实例 ID + CMDB 凭证**。

## 数据库增量

- 若库由旧版 `init.sql` 创建：先按需执行 `backend/sql/migration_v1_2_automation.sql`（若已执行可忽略）。
- **Excel + Word**：执行 `backend/sql/migration_v1_3_inspect_excel_word.sql`（为 `AUTOMATION_INSPECT_BATCH` 增加 `SOURCE_TYPE` / `EXCEL_TARGETS`；为 `INSPECT_CHECKV8_REPORT` 增加 `ROW_NUM` / `TARGET_LABEL` / `DOCX_BLOB`，并将 `INSTANCE_ID` 改为可空）。

## API（需登录；上传与运行需 ADMIN/DBA）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/automation/inspect/excel-template` | 下载巡检用 Excel 模板 |
| POST | `/api/automation/inspect/upload-excel` | `multipart/form-data`，字段 `file`；可选 `batchName` |
| POST | `/api/automation/inspect/batches/:id/run` | 执行批次（有 `EXCEL_TARGETS` 则按行，否则按 `INSTANCE_IDS`） |
| GET | `/api/automation/inspect/batches/:id/word-zip` | 下载该批次 Word 报告 ZIP |
| POST | `/api/automation/inspect/checkv8` | 单实例：body 为 `{ instanceId }` 或 `{ host, port, serviceOrSid, user, password, remark? }`，可选 `batchId` |
| POST | `/api/automation/inspect/instances/:id/checkv8` | 兼容旧接口（仅纳管），body 可选 `batchId` |
| GET | `/api/automation/inspect/checkv8-reports` | 列表，`instanceId`、`limit` |
| GET | `/api/automation/inspect/checkv8-reports/:reportId` | 完整 JSON（不含 `DOCX_BLOB`） |
