# SQL 评审工单：指定审核人与可见性

## 规则摘要（方案 2：允许空指派）

- `ASSIGNED_TO` 为空：工单进入 **DBA 待审池**（状态为 `PENDING` / `IN_REVIEW` / `CHANGES_REQUESTED` 时，`ADMIN`/`DBA` 在「与我相关」可见）。
- `ASSIGNED_TO` 非空：仅 **指定人 + ADMIN** 可人工审核；列表「待我审核」按 `ASSIGNED_TO = 当前用户` 过滤。
- 普通用户默认列表：**我提交的 OR 指派给我的**。
- SQL 洞察建单：弹窗可选审核人；未选则空指派。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sql-review/tickets?scope=mine\|submitted\|assigned\|all` | 列表范围 |
| GET | `/api/sql-review/stats?scope=...` | 与列表同范围 |
| GET | `/api/sql-review/reviewers` | 可选审核人 |
| PATCH | `/api/sql-review/tickets/:id/assign` | 指派/改派，`assignedTo` 可 null |
| POST | `/api/sql-insight/tickets` | Body 增加 `assignedTo`（可选） |