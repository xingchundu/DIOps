const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');

// ─── 标签分组 CRUD ─────────────────────────────────────────

// GET /api/tags/groups
router.get('/groups', async (req, res) => {
  try {
    const { status } = req.query;
    let where = ['1=1'];
    let binds = [];
    if (status) { where.push('STATUS = :1'); binds.push(status); }
    const { rows } = await db.execute(
      `SELECT g.*,
              (SELECT COUNT(*) FROM CMDB_TAG t WHERE t.GROUP_ID = g.GROUP_ID) AS TAG_COUNT
       FROM CMDB_TAG_GROUP g WHERE ${where.join(' AND ')} ORDER BY SORT_ORDER, GROUP_ID`, binds);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/tags/groups/:id
router.get('/groups/:id', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT * FROM CMDB_TAG_GROUP WHERE GROUP_ID = :1', [req.params.id]);
    if (!rows.length) return res.json({ code: 404, msg: '分组不存在' });
    res.json({ code: 200, data: rows[0] });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/tags/groups
router.post('/groups', async (req, res) => {
  try {
    const { groupName, groupCode, description, sortOrder } = req.body;
    if (!groupName || !groupCode) return res.json({ code: 400, msg: '分组名称和编码不能为空' });
    const dup = await db.execute('SELECT 1 FROM CMDB_TAG_GROUP WHERE GROUP_CODE = :1', [groupCode]);
    if (dup.rows.length) return res.json({ code: 409, msg: `编码 ${groupCode} 已存在` });
    await db.execute(
      `INSERT INTO CMDB_TAG_GROUP (GROUP_NAME, GROUP_CODE, DESCRIPTION, SORT_ORDER) VALUES (:1, :2, :3, :4)`,
      [groupName, groupCode, description || null, sortOrder || 0]);
    res.json({ code: 200, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/tags/groups/:id
router.put('/groups/:id', async (req, res) => {
  try {
    const { groupName, description, sortOrder, status } = req.body;
    await db.execute(
      `UPDATE CMDB_TAG_GROUP SET GROUP_NAME=NVL(:1,GROUP_NAME), DESCRIPTION=:2, SORT_ORDER=NVL(:3,SORT_ORDER),
       STATUS=NVL(:4,STATUS), UPDATED_AT=SYSTIMESTAMP WHERE GROUP_ID=:5`,
      [groupName, description || null, sortOrder, status, req.params.id]);
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/tags/groups/:id
router.delete('/groups/:id', adminDba, async (req, res) => {
  try {
    await db.execute('DELETE FROM CMDB_TAG_GROUP WHERE GROUP_ID = :1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 标签 CRUD ─────────────────────────────────────────────

// GET /api/tags — 获取所有标签（可按分组过滤）
router.get('/', async (req, res) => {
  try {
    const { groupId, groupCode, keyword, status } = req.query;
    let where = ['1=1'];
    let binds = [];
    let bi = 1;
    if (groupId)   { where.push(`t.GROUP_ID = :${bi}`);  binds.push(Number(groupId)); bi++; }
    if (groupCode) { where.push(`g.GROUP_CODE = :${bi}`); binds.push(groupCode); bi++; }
    if (keyword)   { where.push(`t.TAG_NAME LIKE :${bi}`); binds.push(`%${keyword}%`); bi++; }
    if (status)    { where.push(`t.STATUS = :${bi}`);     binds.push(status); bi++; }
    const { rows } = await db.execute(
      `SELECT t.TAG_ID, t.GROUP_ID, t.TAG_NAME, t.TAG_VALUE, t.COLOR, t.DESCRIPTION, t.SORT_ORDER, t.STATUS,
              g.GROUP_NAME, g.GROUP_CODE,
              (SELECT COUNT(*) FROM CMDB_INSTANCE_TAG it WHERE it.TAG_ID = t.TAG_ID) AS USAGE_COUNT
       FROM CMDB_TAG t
       JOIN CMDB_TAG_GROUP g ON t.GROUP_ID = g.GROUP_ID
       WHERE ${where.join(' AND ')}
       ORDER BY g.SORT_ORDER, t.SORT_ORDER, t.TAG_ID`, binds);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/tags
router.post('/', async (req, res) => {
  try {
    const { groupId, tagName, tagValue, color, description, sortOrder } = req.body;
    if (!groupId || !tagName) return res.json({ code: 400, msg: '分组和标签名称不能为空' });
    const dup = await db.execute('SELECT 1 FROM CMDB_TAG WHERE GROUP_ID = :1 AND TAG_NAME = :2', [groupId, tagName]);
    if (dup.rows.length) return res.json({ code: 409, msg: `该分组下标签 "${tagName}" 已存在` });
    await db.execute(
      `INSERT INTO CMDB_TAG (GROUP_ID, TAG_NAME, TAG_VALUE, COLOR, DESCRIPTION, SORT_ORDER, CREATED_BY)
       VALUES (:1, :2, :3, :4, :5, :6, :7)`,
      [groupId, tagName, tagValue || null, color || null, description || null, sortOrder || 0, req.user.username]);
    res.json({ code: 200, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/tags/:id
router.put('/tags/:id', async (req, res) => {
  try {
    const { tagName, tagValue, color, description, sortOrder, status } = req.body;
    await db.execute(
      `UPDATE CMDB_TAG SET TAG_NAME=NVL(:1,TAG_NAME), TAG_VALUE=:2, COLOR=:3, DESCRIPTION=:4,
       SORT_ORDER=NVL(:5,SORT_ORDER), STATUS=NVL(:6,STATUS), UPDATED_AT=SYSTIMESTAMP WHERE TAG_ID=:7`,
      [tagName, tagValue || null, color || null, description || null, sortOrder, status, req.params.id]);
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/tags/:id
router.delete('/tags/:id', adminDba, async (req, res) => {
  try {
    await db.execute('DELETE FROM CMDB_TAG WHERE TAG_ID = :1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 实例-标签关联 ─────────────────────────────────────────

// GET /api/tags/instance/:instanceId — 获取实例的所有标签
router.get('/instance/:instanceId', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT it.ID, it.TAG_ID, t.TAG_NAME, t.TAG_VALUE, t.COLOR, g.GROUP_NAME, g.GROUP_CODE
       FROM CMDB_INSTANCE_TAG it
       JOIN CMDB_TAG t ON it.TAG_ID = t.TAG_ID
       JOIN CMDB_TAG_GROUP g ON t.GROUP_ID = g.GROUP_ID
       WHERE it.INSTANCE_ID = :1
       ORDER BY g.SORT_ORDER, t.SORT_ORDER`, [req.params.instanceId]);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/tags/instance/:instanceId — 为实例设置标签（全量替换）
router.post('/instance/:instanceId', async (req, res) => {
  try {
    const { tagIds } = req.body; // number[]
    if (!Array.isArray(tagIds)) return res.json({ code: 400, msg: 'tagIds 必须是数组' });
    const instId = Number(req.params.instanceId);
    // 删除旧关联
    await db.execute('DELETE FROM CMDB_INSTANCE_TAG WHERE INSTANCE_ID = :1', [instId]);
    // 插入新关联
    if (tagIds.length > 0) {
      const binds = tagIds.map(tid => [instId, tid, req.user.username]);
      for (const b of binds) {
        await db.execute('INSERT INTO CMDB_INSTANCE_TAG (INSTANCE_ID, TAG_ID, CREATED_BY) VALUES (:1, :2, :3)', b);
      }
    }
    res.json({ code: 200, msg: '标签更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/tags/batch-assign — 批量为实例分配标签
router.post('/batch-assign', async (req, res) => {
  try {
    const { instanceIds, tagIds } = req.body;
    if (!Array.isArray(instanceIds) || !Array.isArray(tagIds)) return res.json({ code: 400, msg: 'instanceIds 和 tagIds 必须是数组' });
    let ok = 0;
    for (const instId of instanceIds) {
      for (const tagId of tagIds) {
        try {
          await db.execute(
            `INSERT INTO CMDB_INSTANCE_TAG (INSTANCE_ID, TAG_ID, CREATED_BY)
             SELECT :1, :2, :3 FROM DUAL
             WHERE NOT EXISTS (SELECT 1 FROM CMDB_INSTANCE_TAG WHERE INSTANCE_ID=:1 AND TAG_ID=:2)`,
            [instId, tagId, req.user.username]);
          ok++;
        } catch { /* duplicate skip */ }
      }
    }
    await db.execute(`INSERT INTO SYS_AUDIT_LOG (USER_ID, USERNAME, ACTION, RESOURCE, STATUS, DETAIL)
                      VALUES (:1, :2, 'BATCH_TAG', 'CMDB_INSTANCE_TAG', 'SUCCESS', :3)`,
      [req.user.userId, req.user.username, `批量打标: ${instanceIds.length} 实例, ${tagIds.length} 标签`]);
    res.json({ code: 200, msg: `批量打标完成: ${ok} 条`, data: { affected: ok } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/tags/batch-remove — 批量移除实例标签
router.post('/batch-remove', async (req, res) => {
  try {
    const { instanceIds, tagIds } = req.body;
    if (!Array.isArray(instanceIds) || !Array.isArray(tagIds)) return res.json({ code: 400, msg: 'instanceIds 和 tagIds 必须是数组' });
    const result = await db.execute(
      `DELETE FROM CMDB_INSTANCE_TAG WHERE INSTANCE_ID IN (${instanceIds.map((_, i) => ':' + (i + 1)).join(',')})
       AND TAG_ID IN (${tagIds.map((_, i) => ':' + (instanceIds.length + i + 1)).join(',')})`,
      [...instanceIds, ...tagIds]);
    res.json({ code: 200, msg: `批量移除完成: ${result.rowcount} 条`, data: { affected: result.rowcount } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/tags/instances-by-tag — 按标签筛选实例
router.get('/instances-by-tag', async (req, res) => {
  try {
    const { tagIds, matchMode = 'ANY', page = 1, size = 20 } = req.query;
    if (!tagIds) return res.json({ code: 400, msg: '请指定标签 ID' });
    const ids = String(tagIds).split(',').map(Number).filter(Boolean);
    if (!ids.length) return res.json({ code: 400, msg: '标签 ID 格式错误' });

    let sql;
    if (matchMode === 'ALL') {
      // 匹配所有指定标签
      sql = `SELECT i.* FROM CMDB_INSTANCE i
             WHERE (SELECT COUNT(DISTINCT it.TAG_ID) FROM CMDB_INSTANCE_TAG it
                    WHERE it.INSTANCE_ID = i.INSTANCE_ID AND it.TAG_ID IN (${ids.map((_, k) => ':' + (k + 1)).join(',')})) = ${ids.length}`;
    } else {
      // 匹配任意指定标签
      sql = `SELECT DISTINCT i.* FROM CMDB_INSTANCE i
             JOIN CMDB_INSTANCE_TAG it ON i.INSTANCE_ID = it.INSTANCE_ID
             WHERE it.TAG_ID IN (${ids.map((_, k) => ':' + (k + 1)).join(',')})`;
    }
    const data = await db.queryPage(sql, ids, page, size);
    res.json({ code: 200, data });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/tags/stats — 标签统计
router.get('/stats', async (req, res) => {
  try {
    const [groups, tags, assignments, topTags] = await Promise.all([
      db.execute('SELECT COUNT(*) AS CNT FROM CMDB_TAG_GROUP'),
      db.execute('SELECT COUNT(*) AS CNT FROM CMDB_TAG'),
      db.execute('SELECT COUNT(*) AS CNT FROM CMDB_INSTANCE_TAG'),
      db.execute(`SELECT t.TAG_NAME, t.COLOR, g.GROUP_NAME, COUNT(it.ID) AS CNT
                  FROM CMDB_TAG t
                  JOIN CMDB_TAG_GROUP g ON t.GROUP_ID = g.GROUP_ID
                  LEFT JOIN CMDB_INSTANCE_TAG it ON t.TAG_ID = it.TAG_ID
                  GROUP BY t.TAG_NAME, t.COLOR, g.GROUP_NAME
                  ORDER BY CNT DESC FETCH FIRST 10 ROWS ONLY`),
    ]);
    const untagged = await db.execute(
      `SELECT COUNT(*) AS CNT FROM CMDB_INSTANCE i
       WHERE NOT EXISTS (SELECT 1 FROM CMDB_INSTANCE_TAG it WHERE it.INSTANCE_ID = i.INSTANCE_ID)`);
    res.json({
      code: 200,
      data: {
        totalGroups: groups.rows[0].CNT,
        totalTags: tags.rows[0].CNT,
        totalAssignments: assignments.rows[0].CNT,
        untaggedInstances: untagged.rows[0].CNT,
        topTags: topTags.rows,
      }
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
