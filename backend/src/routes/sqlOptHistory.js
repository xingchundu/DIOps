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
      llmProvider, llmModel, createdBy,
    } = req.body;
    if (!sqlText) return res.json({ code: 400, msg: 'sqlText 不能为空' });

    const r = await db.execute(
      `INSERT INTO SQL_OPT_HISTORY
         (SQL_HASH, SQL_TEXT, DB_TYPE, OPTIMIZED_SQL, RULE_ENGINE,
          EXPLAIN_BEFORE, EXPLAIN_AFTER, LLM_PROVIDER, LLM_MODEL, CREATED_BY)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10)
       RETURNING OPT_ID INTO :11`,
      [
        sqlHash || null, sqlText, dbType || null, optimizedSql || null,
        ruleEngine ? JSON.stringify(ruleEngine) : null,
        explainBefore || null, explainAfter || null,
        llmProvider || null, llmModel || null,
        createdBy || null,
        { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      ]
    );
    const optId = r.outBinds[0];
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
    const { effectScore, effectNote } = req.body;
    const r = await db.execute(
      `UPDATE SQL_OPT_HISTORY SET EFFECT_SCORE = :1, EFFECT_NOTE = :2 WHERE OPT_ID = :3`,
      [effectScore || null, effectNote || null, Number(req.params.id)]
    );
    if (r.rowsAffected === 0) return res.json({ code: 404, msg: '记录不存在' });
    res.json({ code: 200, msg: '效果已更新' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

module.exports = router;
