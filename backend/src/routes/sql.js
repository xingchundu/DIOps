const router = require('express').Router();
const oracledb = require('oracledb');
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

async function getInstConn(instanceId) {
  const r = await db.execute(`SELECT HOST_IP,PORT,SID,SERVICE_NAME,DB_USER,DB_PASSWORD FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`,[instanceId]);
  if (!r.rows.length) throw new Error('实例不存在');
  const i = r.rows[0];
  const pwd = i.DB_PASSWORD ? Buffer.from(i.DB_PASSWORD.replace('ENCRYPTED:',''),'base64').toString() : '';
  const cs = i.SERVICE_NAME ? `${i.HOST_IP}:${i.PORT}/${i.SERVICE_NAME}` : `${i.HOST_IP}:${i.PORT}/${i.SID}`;
  return oracledb.getConnection({ user:i.DB_USER, password:pwd, connectString:cs });
}

// GET /api/sql/slow  慢SQL列表
router.get('/slow', async (req, res) => {
  const { instanceId, page=1, size=20 } = req.query;
  try {
    let where=['1=1']; let binds=[]; let bi=1;
    if (instanceId){ where.push(`INSTANCE_ID=:${bi}`); binds.push(Number(instanceId)); bi++; }
    const sql = `SELECT s.*,i.INSTANCE_NAME FROM SQL_SLOW_SUMMARY s
                 LEFT JOIN CMDB_INSTANCE i ON s.INSTANCE_ID=i.INSTANCE_ID
                 WHERE ${where.join(' AND ')} ORDER BY AVG_ELAPSED DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code:200, data });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// POST /api/sql/explain  执行计划分析
router.post('/explain', async (req, res) => {
  const { instanceId, sqlText } = req.body;
  if (!instanceId || !sqlText) return res.json({code:400,msg:'instanceId和sqlText不能为空'});
  let conn;
  try {
    conn = await getInstConn(instanceId);
    await conn.execute(`EXPLAIN PLAN FOR ${sqlText}`);
    const r = await conn.execute(
      `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE',NULL,'ALL'))`,
      [], { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );
    const plan = r.rows.map(row => row[0]).join('\n');
    // 分析问题
    const issues = [];
    if (/TABLE ACCESS FULL/i.test(plan)) issues.push({ type:'FULL_SCAN', desc:'存在全表扫描，建议添加合适索引' });
    if (/NESTED LOOPS/i.test(plan) && plan.split('NESTED LOOPS').length > 3) issues.push({ type:'NESTED_LOOP', desc:'多层嵌套循环，可能影响性能' });
    if (/CARTESIAN/i.test(plan)) issues.push({ type:'CARTESIAN', desc:'笛卡尔积连接，检查WHERE条件是否完整' });

    res.json({ code:200, data:{ plan, issues } });
  } catch(err){ res.json({code:500,msg:err.message}); } finally { if(conn) await conn.close(); }
});

// POST /api/sql/optimize  AI优化建议（规则引擎）
router.post('/optimize', async (req, res) => {
  const { sqlText } = req.body;
  if (!sqlText) return res.json({code:400,msg:'SQL不能为空'});
  const suggestions = [];
  const upper = sqlText.toUpperCase();

  if (/SELECT\s+\*/i.test(upper))
    suggestions.push({ rule:'NO_SELECT_STAR', severity:'WARN', desc:'避免使用SELECT *，明确列出所需字段可减少网络传输和内存消耗' });
  if (/WHERE/i.test(upper) && /LIKE\s+'%/i.test(upper))
    suggestions.push({ rule:'LEADING_WILDCARD', severity:'HIGH', desc:'前缀通配符查询（LIKE \'%xxx\'）无法使用索引，建议改用全文索引或反转索引' });
  if (/WHERE/i.test(upper) && /OR\s+/i.test(upper))
    suggestions.push({ rule:'OR_CONDITION', severity:'WARN', desc:'OR条件可能导致索引失效，考虑改写为UNION ALL' });
  if (/NOT\s+IN/i.test(upper))
    suggestions.push({ rule:'NOT_IN', severity:'HIGH', desc:'NOT IN当子查询包含NULL时会返回空结果，建议改用NOT EXISTS' });
  if (/DISTINCT/i.test(upper))
    suggestions.push({ rule:'DISTINCT', severity:'INFO', desc:'DISTINCT会触发排序去重操作，确认是否确实需要去重，或可通过GROUP BY优化' });
  if (!/WHERE/i.test(upper) && /FROM\s+\w+/i.test(upper) && !/COUNT|SUM|MAX|MIN/i.test(upper))
    suggestions.push({ rule:'NO_WHERE', severity:'HIGH', desc:'查询无WHERE条件，可能为全表扫描，请确认是否需要过滤条件' });
  if (/TO_CHAR\(|TO_NUMBER\(|TRUNC\(/i.test(upper))
    suggestions.push({ rule:'FUNC_ON_COLUMN', severity:'WARN', desc:'索引列上使用函数会导致索引失效，考虑使用函数索引' });
  if (suggestions.length === 0)
    suggestions.push({ rule:'OK', severity:'INFO', desc:'SQL结构检查未发现明显问题，建议结合执行计划进一步分析' });

  res.json({ code:200, data:{ suggestions } });
});

// POST /api/sql/capture  手动采集实例慢SQL并存入平台库
router.post('/capture/:instanceId', async (req, res) => {
  let conn;
  try {
    conn = await getInstConn(req.params.instanceId);
    const r = await conn.execute(`
      SELECT SQL_ID, SUBSTR(SQL_TEXT,1,500) SQL_TEXT,
             EXECUTIONS, ROUND(ELAPSED_TIME/1000000,2) ELAPSED_SEC,
             ROUND(ELAPSED_TIME/DECODE(EXECUTIONS,0,1,EXECUTIONS)/1000,2) AVG_MS,
             BUFFER_GETS, PLAN_HASH_VALUE, PARSING_SCHEMA_NAME
      FROM V$SQLSTATS
      WHERE ELAPSED_TIME/DECODE(EXECUTIONS,0,1,EXECUTIONS) > 1000000
        AND SQL_TEXT NOT LIKE 'BEGIN%' AND SQL_TEXT NOT LIKE 'DECLARE%'
      ORDER BY AVG_MS DESC FETCH FIRST 30 ROWS ONLY`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    let inserted = 0;
    for (const row of r.rows) {
      await db.execute(
        `MERGE INTO SQL_SLOW_SUMMARY t USING DUAL ON (t.INSTANCE_ID=:1 AND t.SQL_HASH=:2)
         WHEN MATCHED THEN UPDATE SET EXEC_COUNT=:3,AVG_ELAPSED=:4,CAPTURE_TIME=SYSTIMESTAMP
         WHEN NOT MATCHED THEN INSERT(INSTANCE_ID,SQL_TEXT,SQL_HASH,DB_TYPE,AVG_ELAPSED,MAX_ELAPSED,EXEC_COUNT,TOTAL_ELAPSED,PLAN_HASH)
           VALUES(:1,:5,:2,'ORACLE',:4,:4,:3,:6,:7)`,
        [Number(req.params.instanceId),row.SQL_ID,row.EXECUTIONS,row.AVG_MS,
         row.SQL_TEXT,row.ELAPSED_SEC*1000,String(row.PLAN_HASH_VALUE||'')]
      ).catch(()=>{});
      inserted++;
    }
    res.json({ code:200, msg:`成功采集 ${inserted} 条慢SQL`, data:{ count:inserted } });
  } catch(err){ res.json({code:500,msg:err.message}); } finally { if(conn) await conn.close(); }
});

module.exports = router;
