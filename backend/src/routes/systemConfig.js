const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const sysConfig = require('../services/systemConfig');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');

// GET /api/system-config  获取所有配置
router.get('/', async (req, res) => {
  try {
    const rows = await sysConfig.getAll();
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/system-config/:key  更新配置值
router.put('/:key', adminDba, async (req, res) => {
  const { value } = req.body;
  const key = req.params.key;
  if (value === undefined || value === null) return res.json({ code: 400, msg: '值不能为空' });
  try {
    // 验证配置项存在
    const r = await db.execute(`SELECT MIN_VAL, MAX_VAL, VALUE_TYPE FROM SYS_CONFIG WHERE CONFIG_KEY=:1`, [key]);
    if (!r.rows.length) return res.json({ code: 404, msg: '配置项不存在' });

    const row = r.rows[0];
    if (row.VALUE_TYPE === 'NUMBER') {
      const n = Number(value);
      if (!Number.isFinite(n)) return res.json({ code: 400, msg: '值必须为数字' });
      if (row.MIN_VAL != null && n < row.MIN_VAL) return res.json({ code: 400, msg: `值不能小于 ${row.MIN_VAL}` });
      if (row.MAX_VAL != null && n > row.MAX_VAL) return res.json({ code: 400, msg: `值不能大于 ${row.MAX_VAL}` });
    }

    await sysConfig.set(key, value, req.user.userId);
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",RESOURCE_ID,STATUS,DETAIL) VALUES(:1,:2,:3,:4,:5,:6,:7)`,
      [req.user.userId, req.user.username, 'UPDATE_CONFIG', 'SystemConfig', key, 'SUCCESS', `${key}=${value}`]
    );
    res.json({ code: 200, msg: '配置已更新' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/system-config/:key/reset  重置为默认值
router.post('/:key/reset', adminDba, async (req, res) => {
  try {
    await sysConfig.reset(req.params.key, req.user.userId);
    res.json({ code: 200, msg: '已重置为默认值' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/system-config/reload  重新加载缓存
router.post('/reload', adminDba, async (req, res) => {
  try {
    await sysConfig.loadAll();
    res.json({ code: 200, msg: '配置已重新加载' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
