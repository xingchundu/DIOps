const router = require('express').Router();
const oracledb = require('oracledb');
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// POST /api/sql-opt/save  保存优化记录
router.post('/save', async (req, res) => {
  try {
    const {
      sqlHash, sqlText, dbType, optimizedSql,
      ruleEngine, explainBefore, explainAfter,
      llmProvider, llmModel,
      instanceId, optMode, precheck, instanceName,
    } = req.body;
    if (!sqlText) return res.json({ code: 400, msg: 'sqlText 不能为空' });

    const r = await db.execute(
      `INSERT INTO SQL_OPT_HISTORY
         (SQL_HASH, SQL_TEXT, DB_TYPE, OPTIMIZED_SQL, RULE_ENGINE,
          EXPLAIN_BEFORE, EXPLAIN_AFTER, LLM_PROVIDER, LLM_MODEL, CREATED_BY,
          INSTANCE_ID, OPT_MODE, PRECHECK)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13)
       RETURNING OPT_ID INTO :14`,
      [
        sqlHash || null, sqlText, dbType || null, optimizedSql || null,
        ruleEngine ? JSON.stringify(ruleEngine) : null,
        explainBefore || null, explainAfter || null,
        llmProvider || null, llmModel || null,
        req.user?.userId ?? null, // 创建人取自登录令牌，不信任请求体
        instanceId ?? null, optMode || null, precheck ? JSON.stringify(precheck) : null,
        { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      ]
    );
    const optId = r.outBinds?.[0]?.[0];
    // 写入知识图谱（失败不影响保存）
    require('../services/kgService').recordSqlOpt({
      optId, sqlText, dbType, optimizedSql, mode: optMode, instanceId, instanceName,
      rules: Array.isArray(ruleEngine?.rules) ? ruleEngine.rules : (Array.isArray(ruleEngine) ? ruleEngine : []), precheck,
    }).catch((e) => console.warn('[kg] recordSqlOpt 失败:', e.message));
    res.json({ code: 200, data: { optId }, msg: '保存成功' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/sql-opt/list  查询优化历史（分页、筛选状态）
router.get('/list', async (req, res) => {
  try {
    const { status, page = 1, size = 20 } = req.query;
    let where = ['1=1'];
    let binds = [];
    let bi = 1;
    if (status) {
      where.push(`STATUS = :${bi}`);
      binds.push(status);
      bi++;
    }
    const sql = `SELECT OPT_ID, SQL_HASH, SUBSTR(SQL_TEXT,1,200) SQL_TEXT,
                        DB_TYPE, STATUS, EFFECT_SCORE, LLM_PROVIDER, LLM_MODEL,
                        OPT_MODE, INSTANCE_ID, BASELINE_MS, AFTER_MS,
                        CREATED_AT, CREATED_BY
                 FROM SQL_OPT_HISTORY
                 WHERE ${where.join(' AND ')}
                 ORDER BY CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/sql-opt/stats  优化效果统计（总览卡片：数量/采纳率/规则 vs AI/平均提升）
router.get('/stats', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const [total, byStatus, byMode, byDb, gain] = await Promise.all([
      db.execute(`SELECT COUNT(*) C FROM SQL_OPT_HISTORY WHERE CREATED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:1,'DAY')`, [days]),
      db.execute(`SELECT STATUS, COUNT(*) C FROM SQL_OPT_HISTORY WHERE CREATED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:1,'DAY') GROUP BY STATUS`, [days]),
      db.execute(`SELECT NVL(OPT_MODE,'unknown') M, COUNT(*) C FROM SQL_OPT_HISTORY WHERE CREATED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:1,'DAY') GROUP BY OPT_MODE`, [days]),
      db.execute(`SELECT NVL(DB_TYPE,'-') T, COUNT(*) C FROM SQL_OPT_HISTORY WHERE CREATED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:1,'DAY') GROUP BY DB_TYPE`, [days]),
      db.execute(`SELECT COUNT(*) N, AVG((BASELINE_MS - AFTER_MS) / BASELINE_MS * 100) AVG_GAIN
                    FROM SQL_OPT_HISTORY WHERE BASELINE_MS > 0 AND AFTER_MS IS NOT NULL
                     AND CREATED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:1,'DAY')`, [days]),
    ]);
    const st = Object.fromEntries(byStatus.rows.map((r) => [r.STATUS, r.C]));
    const decided = (st.ADOPTED || 0) + (st.EXECUTED || 0) + (st.REJECTED || 0);
    res.json({ code: 200, data: {
      days, total: total.rows[0].C, byStatus: st,
      byMode: Object.fromEntries(byMode.rows.map((r) => [r.M, r.C])),
      byDbType: Object.fromEntries(byDb.rows.map((r) => [r.T, r.C])),
      adoptRate: decided ? Math.round(((st.ADOPTED || 0) + (st.EXECUTED || 0)) / decided * 1000) / 10 : null,
      measured: gain.rows[0].N, avgImprovePct: gain.rows[0].AVG_GAIN == null ? null : Math.round(gain.rows[0].AVG_GAIN * 10) / 10,
    } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/sql-opt/export  导出优化记录（CSV，带 BOM，Excel 直接打开不乱码；最多 5000 条）
router.get('/export', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT OPT_ID, DB_TYPE, OPT_MODE, STATUS, EFFECT_SCORE, BASELINE_MS, AFTER_MS, LLM_MODEL,
              TO_CHAR(CREATED_AT,'YYYY-MM-DD HH24:MI:SS') CREATED_AT, SUBSTR(SQL_TEXT,1,2000) SQL_TEXT,
              SUBSTR(OPTIMIZED_SQL,1,2000) OPTIMIZED_SQL, EFFECT_NOTE
         FROM SQL_OPT_HISTORY ORDER BY OPT_ID DESC FETCH FIRST 5000 ROWS ONLY`);
    const cols = ['OPT_ID', 'DB_TYPE', 'OPT_MODE', 'STATUS', 'EFFECT_SCORE', 'BASELINE_MS', 'AFTER_MS', 'LLM_MODEL', 'CREATED_AT', 'SQL_TEXT', 'OPTIMIZED_SQL', 'EFFECT_NOTE'];
    // 防 CSV 公式注入：以 = + - @ 开头的单元格前加单引号
    const cell = (v) => {
      let t = v == null ? '' : String(v);
      if (/^[=+\-@]/.test(t)) t = `'${t}`;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const csv = '\uFEFF' + cols.join(',') + '\n' + r.rows.map((x) => cols.map((c) => cell(x[c])).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sql_opt_history.csv"');
    res.send(csv);
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/sql-opt/:id  获取单条详情（含执行计划对比）
router.get('/:id', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT * FROM SQL_OPT_HISTORY WHERE OPT_ID = :1`,
      [Number(req.params.id)]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '记录不存在' });
    res.json({ code: 200, data: r.rows[0] });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// PUT /api/sql-opt/:id/status  更新状态
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['PENDING', 'ADOPTED', 'REJECTED', 'EXECUTED'].includes(status)) {
      return res.json({ code: 400, msg: '无效状态' });
    }
    const extra = status === 'EXECUTED' ? ', EXECUTED_AT = SYSTIMESTAMP' : '';
    const r = await db.execute(
      `UPDATE SQL_OPT_HISTORY SET STATUS = :1${extra} WHERE OPT_ID = :2`,
      [status, Number(req.params.id)]
    );
    if (r.rowsAffected === 0) return res.json({ code: 404, msg: '记录不存在' });
    res.json({ code: 200, msg: '状态已更新' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// PUT /api/sql-opt/:id/effect  更新效果评分和备注
router.put('/:id/effect', async (req, res) => {
  try {
    const { effectScore, effectNote, baselineMs, afterMs } = req.body;
    const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
    const sc = num(effectScore);
    if (sc != null && (sc < 1 || sc > 5)) return res.json({ code: 400, msg: 'effectScore 应为 1-5' });
    const r = await db.execute(
      `UPDATE SQL_OPT_HISTORY SET EFFECT_SCORE = :1, EFFECT_NOTE = :2, BASELINE_MS = NVL(:3, BASELINE_MS), AFTER_MS = NVL(:4, AFTER_MS)
        WHERE OPT_ID = :5`,
      [sc, effectNote ? Buffer.from(String(effectNote)).subarray(0, 1000).toString('utf8').replace(/\uFFFD/g, '') : null,
        num(baselineMs), num(afterMs), Number(req.params.id)]
    );
    if (r.rowsAffected === 0) return res.json({ code: 404, msg: '记录不存在' });
    res.json({ code: 200, msg: '效果已更新' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

module.exports = router;
