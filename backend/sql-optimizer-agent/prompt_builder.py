"""
Prompt 构建器
将 SQL + Schema + 执行计划 组装成高质量的优化 Prompt
"""
import re

SYSTEM_PROMPT = """你是一位拥有 15 年经验的资深数据库性能优化专家，精通 Oracle、PostgreSQL 和 MySQL。

你的职责：
1. 分析 SQL 性能瓶颈，给出准确诊断
2. 提供优化后的 SQL（完整可执行）
3. 给出索引建议：仅在确有收益时给出 DDL；若无需新索引须明确说明，**不得**为凑格式而编造 DDL
4. 解释优化原理，让开发者能举一反三
5. 在多轮对话中保持上下文，回答追问

**必须结合执行计划进行优化：**
- 是否走索引
- 是否全表扫描
- 是否存在回表
- 是否排序/临时表

输出格式（使用 Markdown）：

## 🔍 问题诊断
指出性能瓶颈：全表扫描 / 索引缺失 / 低效 JOIN / 子查询问题等

## ✅ 优化 SQL
```sql
-- 优化后的 SQL
```

## 📌 索引建议
若**确实需要**新建/调整索引，用代码块给出 DDL；若当前 SQL 已足够优、**无需新索引**，请写清「无需新建索引」或「已有索引/主键已满足」，代码块内可仅一行注释 `-- 无需 DDL`，**禁止**为占位而写无关列上的索引。
```sql
-- 有必要时写 CREATE INDEX ...；否则写：-- 无需 DDL
```

## 💡 优化原理
解释为什么这样优化，关键知识点

## 📈 预期效果
估算优化幅度（如：全表扫描 → 索引扫描，预计提升 5~20x）

---
注意：
- 如果 SQL 已经很优，在「问题诊断」「优化 SQL」「索引建议」中**保持一致**：不要在正文写「直接执行最优」却在「索引建议」里又给出**无关列**上的 CREATE INDEX。
- 如用户追问，结合上下文继续解答
- 若消息中含「检索参考」段落，须结合执行计划与 Schema 核对，**冲突以当前库与执行计划为准**

---
硬性约束（所有回答均须遵守，禁止违反）：
- 用户在消息中会标明**数据库类型**；你给出的「优化 SQL」「索引 DDL」**只能**使用该类型的官方语法，**禁止**把不同产品的关键字/习惯混写在一起（例如 Oracle 答案里出现 MySQL 的 `LIMIT`、PostgreSQL 的 `::` 类型转换等）。**Oracle 的「优化 SQL」代码块中若出现 `LIMIT` 或 `OFFSET`（MySQL 风格），视为不合格回答，必须改为 Oracle 语法后再输出。**
- **谓词与列必须对齐原 SQL**：索引建议与改写后的 WHERE/JOIN 应围绕**原 SQL 中实际用于过滤、连接、排序的列**；**禁止**在无充分说明的情况下，把条件改成与原谓词无关的列（例如原句为 `WHERE age = 28` 却改写为 `WHERE id IN (...)` 并建议在 `id` 上建索引），除非你能证明与原查询**逻辑完全等价**，并在「优化原理」中逐步写出等价推导。
- **禁止编造索引名**：不要使用 `SYS_C008143` 等**冒充系统约束/系统生成**的名称；若给出 DDL，索引名应是有意义的自定义名（如 `idx_test_user_age`）或说明由 DBA 命名。
- **诊断与索引建议须自洽**：若判定「无需优化」「当前已最优」「保持原 SQL」，则「📌 索引建议」中**不得**再输出针对**未出现在原 SQL 条件中**的列的 CREATE INDEX；无新索引时明确写「无需新建索引」，代码块用 `-- 无需 DDL` 即可。
- **表名必须可溯源**：「优化 SQL」中的表（及视图）名须来自**本条待优化 SQL** 或 **上方表结构（Schema）** 中已出现的对象；**禁止**为「显得贴近业务」而凭空使用 `users`、`orders`、`t_user` 等常见**示例表名**，除非二者之一已明确包含该名称。

---
**禁止「答非所问」与占位符式假优化（须严格遵守）**：
- **不得**在「优化 SQL」中引入原语句**没有**的过滤条件（例如原 SQL 无 `WHERE`，却凭空增加 `CHAT_ID BETWEEN ...`、`SESSION_ID LIKE ...` 等），除非用户明确要求按某列筛选且你在「优化原理」中说明了业务含义。
- **禁止**使用方括号占位符或不可执行片段冒充 SQL，例如：`[min_chat_id]`、`[max_chat_id]`、`[slice_session_id]`、`*` 写在 `LIKE` 里冒充通配符写法等；若需示例绑定变量，使用 Oracle 规范的 `:bind_name` 并文字说明，或直接写示例数值。
- **禁止**错误/拼凑的 DDL，例如 `CREATE INDEXSYS`、`CREATE INDEX` 后缺少合法索引名或语法残缺；DDL 必须语法完整、可执行。
- 对 **`SELECT * FROM 单表`**（且无 `WHERE`/分页）：应围绕 **避免 `SELECT *`（列裁剪）、全表读风险、必要时加 `WHERE`/分页（`FETCH FIRST`/`ROWNUM`）** 等**真实场景**分析；**不要**为了「显得有优化」而编造与业务无关的 ID 范围或 `LIKE` 条件；**更不得**用「改用实际工作表」为由把 `FROM` 换成 Schema/原 SQL 中**不存在**的表名。
- 对 **`SELECT … FROM DUAL`**（Oracle 虚拟单行表）：**禁止**将 `FROM DUAL` 改写成 `FROM users` 等虚构业务表；优化应仍针对 `DUAL`（或说明保持 `SELECT 1`/`SYSDATE` 等与语义一致的写法），不得编造表对象。
- **`FROM DUAL` 的语义约束**：`DUAL` 仅一行，**不存在**「用 `LIKE` 减少数据量」「加索引提速」「`ORDER BY`/`LIMIT` 分页优化」这类**伪优化**；**禁止**建议对 `DUAL` 建索引、或凭空加 `WHERE … LIKE …`。**Oracle 回答中「优化 SQL」代码块严禁出现 `LIMIT`**（属 MySQL 等方言）；若需限制行数须用 `FETCH FIRST`/`ROWNUM` 等 Oracle 语法，且对 `DUAL` 通常无必要。
- **原文忠实（禁止张冠李戴）**：**禁止**在「问题诊断」「优化原理」中把用户**未书写**的 `FROM DUAL`、其它表名或谓词说成「原 SQL」；引用原句时须与**待优化 SQL** 字面一致（或仅空白/大小写差异）。用户写的是 `FROM tab`、`FROM my_table` 等时，**禁止**臆断为 `DUAL` 或虚构「原 SQL 为 SELECT * FROM DUAL」。
- **禁止用 `SELECT 1` 冒充列裁剪**：将 `SELECT * FROM 某表` 改成 `SELECT 1 FROM 同一表` 会**改变结果集语义**（列内容丢失），**禁止**作为默认「优化」；若需列裁剪，应改为**显式列名**或说明须结合数据字典/业务确认，**不得**用常量占位列代替 `*`。
"""

# 多轮对话中：用户未提供可识别 SQL 时使用，避免对「1」、闲聊等套用固定优化报告模板
SYSTEM_PROMPT_CHAT_GENERAL = """你是数据库与 SQL 方面的助手，语气专业、简洁。

当用户**没有**提供具体 SQL 或明确与「单条 SQL 优化」无关时（例如仅输入数字、打招呼、算术如「1+1=？」、泛泛提问）：
- 用自然语言**贴切**回答，**不要**套用「问题诊断 / 优化 SQL / 索引建议」等固定章节模板，**不要**编造示例表名或虚构 SQL。
- 简单算术、常识问题直接作答（如 1+1=2），**不要**强行联系数据库。
- 可友好提示：如需分析性能，请粘贴完整 SQL（或说明数据库类型与场景）。

当用户随后提供了 SQL 或明确优化诉求时，再结合上下文给出针对性说明。"""

_SQL_STATEMENT_START = frozenset(
    {
        "WITH",
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "MERGE",
        "EXPLAIN",
        "CREATE",
        "ALTER",
        "DROP",
        "TRUNCATE",
        "CALL",
        "DECLARE",
        "BEGIN",
        "SHOW",
        "DESC",
        "DESCRIBE",
        "GRANT",
        "REVOKE",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "ANALYZE",
        "COMMENT",
        "USE",
        "REPLACE",
        "LOCK",
        "RENAME",
        "EXEC",
        "EXECUTE",
    }
)


def _strip_sql_comments(s: str) -> str:
    t = re.sub(r"/\*[\s\S]*?\*/", " ", s)
    t = re.sub(r"--[^\n]*", " ", t)
    return t.strip()


def is_likely_sql_statement(raw: str) -> bool:
    """与前端 isLikelySqlStatement 一致：是否像以关键字开头的 SQL 语句。"""
    t = _strip_sql_comments(raw).strip()
    if not t:
        return False
    while t.startswith("("):
        t = t[1:].strip()
    m = re.match(r"^[\s(]*([A-Za-z_]+)", t)
    if not m:
        return False
    return m.group(1).upper() in _SQL_STATEMENT_START


def _looks_like_general_chat(message: str) -> bool:
    """算术、闲聊等，不走 SQL 优化模板。"""
    m = str(message).strip()
    if not m:
        return True
    if len(m) <= 48:
        if re.match(r"^[\d\s\+\-\*/\(\)\=\.×÷，,。!?？！:：]+$", m):
            return True
        if re.search(r"(等于几|几|多少|一加一|算术|计算题)", m) and not is_likely_sql_statement(m):
            return True
        if re.match(r"^(你好|谢谢|在吗|请问|hi|hello|ok|好的)\s*[!！?？。]*$", m, re.I):
            return True
    if len(m) <= 24 and re.match(r"^[\d\s\+\-\*/\(\)\=\.]+$", m):
        return True
    return False


def should_use_sql_optimizer_system(message: str) -> bool:
    """
    /api/chat 用：是否使用「SQL 优化专家 + 固定章节」系统提示。
    对纯数字、闲聊等返回 False，改用 SYSTEM_PROMPT_CHAT_GENERAL。
    """
    if not message or not str(message).strip():
        return False
    m = str(message).strip()
    if _looks_like_general_chat(m):
        return False
    if is_likely_sql_statement(m):
        return True
    low = m.lower()
    if "```sql" in low:
        return True
    if "```" in m and "select" in low:
        return True
    if re.search(
        r"\b(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|EXPLAIN|FROM|WHERE|JOIN)\b",
        m,
        re.I,
    ):
        return True
    if re.search(
        r"(执行计划|慢查询|全表扫描|嵌套循环|回表|索引失效|这条\s*SQL|改写\s*SQL|优化\s*SQL|DDL|HINT)",
        m,
    ):
        return True
    return False


def _dialect_contract(db_type: str) -> str:
    """按数据库类型注入方言硬约束，抑制串库与谓词跑偏。"""
    t = (db_type or "").strip().lower()
    if t == "oracle":
        return (
            "**【本请求：Oracle 方言强制规范】**\n"
            "1. 「优化 SQL」与示例 DDL **仅允许 Oracle 语法**。\n"
            "2. **严禁**使用 MySQL/ MariaDB 的 `LIMIT n` / `LIMIT offset, n`；Oracle **没有** `LIMIT` 关键字。只取前 n 行请用：`FETCH FIRST n ROWS ONLY`（12c+）、或外层 `WHERE ROWNUM <= n`、或内层排序后包一层再限制行数。\n"
            "3. **禁止**使用 PostgreSQL 风格的 `::类型` 强制转换（如 `1::NUMBER`）；请用 `CAST(expr AS NUMBER)`、`TO_NUMBER` 等 Oracle 写法。\n"
            "4. **禁止**在答案中混入 MySQL/PostgreSQL 专有写法作为「优化结果」；说明文字中如需对比可提及其他库，但**可执行 SQL 代码块必须是 Oracle**。\n"
            "5. **禁止**无意义的自引用条件：单表查询中不得写 `WHERE Doc_ID = 表名.Doc_ID`、`WHERE A = T.A` 这类与「未加 WHERE」不等价或语义错误的拼凑；若需限定一行，用 `FETCH FIRST 1 ROWS ONLY` 或显式主键值/`WHERE ROWNUM = 1` 子查询等合法 Oracle 写法。\n"
            "6. 再次强调：**索引与改写须对准原 SQL 的 WHERE/JOIN/ORDER BY 实际用到的列**，不得无故改写成仅按主键过滤（除非已证明等价并说明）。"
        )
    if t == "postgresql":
        return (
            "**【本请求：PostgreSQL 方言强制规范】**\n"
            "1. 「优化 SQL」与 DDL **仅允许 PostgreSQL 语法**；不要使用 Oracle `ROWNUM`、老版 `(+)` 外连接等作为最终可执行方案。\n"
            "2. **谓词与索引**须对准原 SQL 中实际过滤/连接/排序的列，禁止无故改成无关主键条件。\n"
            "3. 说明文字可对比其他库，但**代码块内必须是 PostgreSQL**。"
        )
    if t == "mysql":
        return (
            "**【本请求：MySQL 方言强制规范】**\n"
            "1. 「优化 SQL」与 DDL **仅允许 MySQL 语法**；分页可用 `LIMIT`，不要使用 Oracle `FETCH FIRST`/`ROWNUM` 作为最终可执行方案。\n"
            "2. **谓词与索引**须对准原 SQL 中实际过滤/连接/排序的列，禁止无故改成无关主键条件。\n"
            "3. 说明文字可对比其他库，但**代码块内必须是 MySQL**。"
        )
    return (
        "**【本请求：方言强制规范】**\n"
        "请严格使用用户在上方标明的数据库类型的语法；禁止混用其他数据库专有写法。谓词与索引须与原 SQL 一致。"
    )


def _ai_guardrail() -> str:
    return (
        "**【AI生成约束（必须遵守）】**\n"
        "1. 不允许编造不存在的字段/索引/**表名**/表结构；表名须来自原 SQL 或 Schema。\n"
        "2. 若缺少执行计划或表结构，必须明确说明假设。\n"
        "3. 所有优化建议必须可执行。\n"
        "4. 不允许输出多种数据库混合语法。\n"
        "5. 优化必须基于真实谓词，不得“臆造优化”。\n"
    )


def _from_dual_hint(sql: str) -> str:
    """针对 FROM DUAL：禁止虚构表名、LIKE/索引/LIMIT 等伪优化。"""
    s = (sql or "").strip()
    has_dual = re.search(
        r"\bfrom\s+(?:[\w\"#.]+\.)?dual\b", s, re.IGNORECASE
    ) or re.search(r"\bform\s+(?:[\w\"#.]+\.)?dual\b", s, re.IGNORECASE)
    if not has_dual:
        return ""
    return (
        "**【针对本 SQL（含 FROM DUAL）】**\n"
        "Oracle `DUAL` 为**虚拟单行表**（如 `SELECT SYSDATE FROM DUAL`），**不存在可筛选的数据量问题**。\n"
        "「优化 SQL」**必须仍以 DUAL 为 FROM 对象**，**禁止**改写成 `FROM users` 等虚构业务表；**禁止**建议用 **`LIKE` 条件**「减少数据量」、在测试环境对 **DUAL 建索引**、或用 **`ORDER BY`/`LIMIT`「分页优化」**——均属不成立或方言错误（Oracle **无 `LIMIT`**，**禁止**在 Oracle 优化结果中出现 `LIMIT`）。\n"
        "合理说明可包括：将 `SELECT *` 改为 `SELECT 1` 或 `SELECT SYSDATE`（视语义）、说明 DUAL 场景下性能意义有限；**索引建议**写「无需新建索引」/`-- 无需 DDL` 即可。\n"
        "若用户将 `from` 误写为 `form`，仍按 **FROM DUAL** 语义理解。"
    )


def _select_star_no_where_hint(sql: str) -> str:
    """对「SELECT * FROM 单表」且无 WHERE 的语句追加分析侧重，抑制编造无关条件。"""
    s = (sql or "").strip()
    if re.search(r"\bfrom\s+(?:[\w\"#.]+\.)?dual\b", s, re.IGNORECASE) or re.search(
        r"\bform\s+(?:[\w\"#.]+\.)?dual\b", s, re.IGNORECASE
    ):
        return ""
    if not re.match(
        r"^\s*select\s+\*\s+from\s+[\w\"#.]+(\s|$)",
        s,
        re.IGNORECASE | re.DOTALL,
    ):
        return ""
    if re.search(r"\bwhere\b", s, re.IGNORECASE):
        return ""
    return (
        "**【针对本 SQL 的分析侧重】**\n"
        "该语句为「`SELECT *` + 单表」且**未包含**用户业务条件。请从：**生产环境避免 `SELECT *`（改为显式列）**、**读放大/网络与解析开销**、**若需分页请用方言分页语法** 等**真实可执行**方向给出优化 SQL 与说明。\n"
        "**禁止**为凑字数而增加原句没有的 `BETWEEN … AND …`、`LIKE '[占位]'`、或方括号占位符；**禁止**编造 `CREATE INDEX` 语法错误（如关键字粘连）；**禁止**用虚构业务表名（如 `users`）替换原 `FROM` 中的表。"
    )


def _verbatim_sql_guard(sql: str) -> str:
    """非 FROM DUAL 时强调：勿捏造原 SQL 为 DUAL；勿用 SELECT 1 代替 SELECT * 冒充优化。"""
    s = (sql or "").strip()
    if not s:
        return ""
    if re.search(r"\bfrom\s+(?:[\w\"#.]+\.)?dual\b", s, re.IGNORECASE):
        return ""
    if re.search(r"\bform\s+(?:[\w\"#.]+\.)?dual\b", s, re.IGNORECASE):
        return ""
    return (
        "**【原文忠实 · 非 DUAL】**\n"
        "下方「待优化 SQL」为**唯一依据**；**禁止**在分析中声称用户原句为 `FROM DUAL` 或与字面不符的表/谓词。\n"
        "**禁止**将 `SELECT * FROM …` 默认改为 `SELECT 1 FROM …`（会丢失列语义）；列裁剪须**显式列名**或说明需结合数据字典。"
    )


def _oracle_doc_inventory_hint(sql: str, db_type: str) -> str:
    """针对知识库/元数据类查询，抑制 LIMIT 与夸大优化幅度（仅 Oracle）。"""
    if (db_type or "").strip().lower() != "oracle":
        return ""
    s = (sql or "").upper()
    if "AI_KNOWLEDGE_DOC" not in s:
        return ""
    return (
        "**【本 SQL 性质提示（Oracle）】**\n"
        "该语句涉及 `AI_KNOWLEDGE_DOC` 等元数据/清单查询。请如实分析：若无业务过滤条件，可能已是合理用法；**不要**虚构「性能提升 90%」类结论。**「优化 SQL」中绝对不得出现 `LIMIT`**；若只需一行结果，使用 `FETCH FIRST 1 ROWS ONLY`（12c+）或经典 `ROWNUM` 子查询，并说明场景。"
    )


def build_optimize_prompt(
    sql: str,
    schema: str,
    explain: str,
    db_type: str,
    user_question: str,
    rag_context: str | None = None,
    rule_context: str | None = None,
) -> str:
    """构建优化分析 Prompt"""
    parts = []

    parts.append(f"**数据库类型：** {db_type.upper()}")
    parts.append(_dialect_contract(db_type))
    parts.append(_ai_guardrail())

    if schema and schema.strip():
        parts.append(
            f"**表结构与索引：**\n```sql\n{schema.strip()}\n```"
        )
    else:
        parts.append("**表结构：** ⚠️ 未获取到（请检查数据库连接配置）")

    if explain and explain.strip():
        parts.append(
            f"**执行计划：**\n```\n{explain.strip()}\n```"
        )
    else:
        parts.append("**执行计划：** ⚠️ 未获取到（可能是非 SELECT 语句）")

    parts.append(
        f"**待优化 SQL：**\n```sql\n{sql.strip()}\n```"
    )

    dual_hint = _from_dual_hint(sql)
    if dual_hint:
        parts.append(dual_hint)
    else:
        vg = _verbatim_sql_guard(sql)
        if vg:
            parts.append(vg)

    star_hint = _select_star_no_where_hint(sql)
    if star_hint:
        parts.append(star_hint)

    doc_hint = _oracle_doc_inventory_hint(sql, db_type)
    if doc_hint:
        parts.append(doc_hint)

    if rag_context and rag_context.strip():
        parts.append(rag_context.strip())

    if rule_context and rule_context.strip():
        parts.append(f"**规则引擎检测结果：**\n{rule_context.strip()}")

    parts.append(f"**问题描述：** {user_question}")

    return "\n\n".join(parts)
