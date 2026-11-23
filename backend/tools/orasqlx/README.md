# orasqlx — Oracle SQL 智能诊断与优化建议（单文件 Linux 二进制）

输入 **SQL_ID + 连接串**，自动采集 SQL 文本、执行计划（含 E-Rows/A-Rows）、表/字段/索引、统计信息与直方图、数据分布、分区、绑定变量、等待事件、AWR 趋势、SQL Profile/Baseline/Patch，
经 **23 条确定性规则** 生成带「依据 / 建议 / 候选 SQL / 回滚方式 / 风险 / 验证方法」的 **DOCX 报告**（版式对齐你的附件 1，并新增执行摘要、行动路线图、回滚脚本、采集审计清单）。

* 无需安装：纯 Go 静态编译（go-ora 驱动，不依赖 Instant Client），拷到任何 Linux 直接执行
* 默认只读：只发 SELECT；所有建议只生成不执行；`--dry-run` 可在连库前预览全部语句
* 兼容：Oracle 11g ~ 23ai，单机 / RAC，非 CDB / CDB（`--pdb`），无 DBA 权限自动降级到 ALL_* 视图
* 规则引擎独立，AI（本机 Ollama / OpenAI 兼容）完全可选

## 构建（一次）
```bash
./build.sh            # 产出 dist/orasqlx-linux-amd64 与 -arm64；首次需联网拉取 go-ora
```
离线内网：有网机器 `go mod tidy && go mod vendor`，整目录拷过去 `GOFLAGS=-mod=vendor ./build.sh`。

## 使用
```bash
# 1) DBA 先执行 GRANTS.sql 建只读账号
# 2) 体验（不连库）
./orasqlx --demo -o demo_report.docx

# 3) 连库诊断（密码建议用环境变量，避免进 ps/history）
export ORASQLX_PWD='***'
./orasqlx 2jqdamknrmm6r --connect orasqlx@10.1.1.8:1521/MOFPDB            # 默认输出 2jqdamknrmm6r_diag.docx
./orasqlx 2jqdamknrmm6r -c orasqlx@10.1.1.8:1521/CDBSVC --pdb MOFPDB       # CDB 根服务名 + 切 PDB
./orasqlx <SQL_ID> -c ... --check                                           # 先体检：版本/架构/各视图是否可读
./orasqlx <SQL_ID> -c ... --dry-run                                         # 只看将执行哪些 SELECT

# 4) 常用选项
--awr-days N                      AWR/ASH 历史窗口（天），默认 2；0 = 全部保留期。覆盖窗口内每个执行计划（逐快照趋势、各计划对比、计划明细、ASH 按事件/计划行/对象/时段）
--no-awr                         无 Diagnostics Pack 授权时跳过 AWR/ASH（默认按 control_management_pack_access 自动判断）
--sample --sample-table OWNER.T --sample-cols COL1,COL2   精确值频率采样（默认关，块采样 1%）
--snapshot before.json           保存快照（可离线复跑规则、做前后对比）
--compare before.json            与优化前快照对比，报告最前面出现「优化前后效果对比」
id1,id2,id3 --parallel 3         批量：输出横向对比报告；--per-report 另出每条完整报告
--input a.json --rules -R12      离线读快照并停用某些规则；--list-rules 查看全部规则
--format html|json               其它输出格式；--rules-only 只在终端打印结论
--ai --ai-url http://127.0.0.1:11434 --ai-model qwen2.5:14b    可选 AI 归纳
```

## 优化闭环（推荐流程）
1. `--snapshot before.json` 出诊断报告 → 2. DBA 在**测试库**按「候选 SQL」验证（索引先 INVISIBLE）→ 3. 变更后同一 SQL_ID 重跑 `--compare before.json` → 4. 报告里的「优化前后效果对比」作为验收材料。

## 重要限制（请读）
* 本工具的 Oracle 采集 SQL 在编写环境中**未能连真实 Oracle 实测**（沙箱无 Oracle，且无法下载驱动）。已做：全部语句经干跑录制、SQL 标识符白名单校验、采集代码路径单测、每章节独立容错。
  首次使用请先 `--check`，再在测试库跑一次，把 `--snapshot` 与报告里的「采集异常」章节反馈回来即可快速修正个别视图/列差异。
* 共享池里已老化的 SQL_ID 无法采集（会给出明确报错）；历史需依赖 AWR 或自建快照。
* 规则只给"线索与候选动作"，不是结论；`CREATE INDEX / 收集统计 / SQL Patch` 一律不自动执行。
* AWR/ASH 需 Diagnostics Pack 授权；SQL Monitor 需 Tuning Pack，本工具不使用 SQL Monitor。

