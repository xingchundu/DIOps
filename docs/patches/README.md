# 补丁说明

`sql-insight.patch`：第一轮交付（Java 迁移，`DIOps-java.zip`）→ 本工程（SQL 洞察融合）的全部改动，71 个文件。

- 本工程已包含这些改动，**直接使用本工程无需再打补丁**。
- 只有在你自己维护的第一轮代码上合并本轮改动时才需要：
  ```bash
  git apply --check --stat docs/patches/sql-insight.patch   # 先检查
  git apply docs/patches/sql-insight.patch                  # 应用；有冲突时用 --3way
  ```
