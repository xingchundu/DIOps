const router = require('express').Router();
const multer = require('multer');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const {
  buildCmdbInstanceImportTemplate,
  parseCmdbInstanceImportBuffer,
} = require('../services/cmdbInstanceExcelService');

router.use(authMiddleware);

const adminDba = requireRole('ADMIN', 'DBA');

/** 与 monitorCollectPersist 一致：可自动采集的类型新建为 UNKNOWN，首轮采集后变为 RUNNING/ERROR；其余为 UNMONITORED。 */
function initialCmDbStatus(dbTypeUpper) {
  const t = String(dbTypeUpper || '').toUpperCase();
  if (['ORACLE', 'MYSQL', 'POSTGRESQL', 'DAMENG', 'GOLDENDB'].includes(t)) return 'UNKNOWN';
  return 'UNMONITORED';
}

const uploadCmdbImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(xlsx)$/i.test(file.originalname || '')) return cb(new Error('仅支持 .xlsx'));
    cb(null, true);
  },
});

// GET /api/cmdb/instances
router.get('/instances', async (req, res) => {
  try {
    const { keyword, dbType, status, env, page = 1, size = 20 } = req.query;
    let where = ['1=1'];
    let binds = [];
    let bi = 1;
    if (keyword) { where.push(`(INSTANCE_NAME LIKE :${bi} OR HOST_IP LIKE :${bi+1})`); binds.push(`%${keyword}%`, `%${keyword}%`); bi+=2; }
    if (dbType)  { where.push(`DB_TYPE = :${bi}`);    binds.push(dbType); bi++; }
    if (status)  { where.push(`STATUS = :${bi}`);     binds.push(status); bi++; }
    if (env)     { where.push(`ENVIRONMENT = :${bi}`);binds.push(env); bi++; }
    const sql = `SELECT * FROM CMDB_INSTANCE WHERE ${where.join(' AND ')} ORDER BY CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/cmdb/instances/import-template — 多 Sheet：Oracle / MySQL / PostgreSQL / Dameng / GoldenDB / 其他
router.get('/instances/import-template', async (req, res) => {
  try {
    const buf = await buildCmdbInstanceImportTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cmdb_instance_import_template.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ code: 500, msg: e.message });
  }
});

// POST /api/cmdb/instances/bulk-import — multipart 字段名 file
router.post('/instances/bulk-import', adminDba, (req, res, next) => {
  uploadCmdbImport.single('file')(req, res, (err) => {
    if (err) return res.json({ code: 400, msg: err.message || '上传失败' });
    next();
  });
}, async (req, res) => {
  if (!req.file?.buffer) return res.json({ code: 400, msg: '请上传 xlsx（字段名 file）' });
  try {
    const parsed = await parseCmdbInstanceImportBuffer(req.file.buffer);
    const errors = [];
    const rows = [];
    for (const p of parsed) {
      if (p._error) errors.push({ sheet: p._sheet, line: p._line, msg: p._error });
      else rows.push(p);
    }
    let ok = 0;
    const fail = [...errors];
    for (const row of rows) {
      const {
        instanceName, dbType, hostIp, port, sid, serviceName, dbUser, dbPassword,
        dbVersion, charset, environment, bizLine, tags, role, clusterName, hostId,
        _sheet, _line,
      } = row;
      try {
        const typeNorm = String(dbType || '').trim().toUpperCase();
        const enc = dbPassword ? Buffer.from(String(dbPassword), 'utf8').toString('base64') : null;
        await db.execute(
          `INSERT INTO CMDB_INSTANCE (INSTANCE_NAME,DB_TYPE,DB_VERSION,HOST_IP,PORT,SID,SERVICE_NAME,
            DB_USER,DB_PASSWORD,CHARSET,STATUS,ENVIRONMENT,BIZ_LINE,TAGS,ROLE,CLUSTER_NAME,HOST_ID,CREATED_BY)
           VALUES(:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14,:15,:16,:17,:18)`,
          [
            instanceName,
            typeNorm,
            dbVersion || null,
            hostIp,
            port,
            sid,
            serviceName,
            dbUser || null,
            enc,
            charset || null,
            initialCmDbStatus(typeNorm),
            environment,
            bizLine,
            tags,
            role,
            clusterName || null,
            hostId ?? null,
            req.user.userId,
          ]
        );
        ok += 1;
      } catch (e) {
        fail.push({ sheet: _sheet, line: _line, msg: e.message || String(e) });
      }
    }
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'BULK_IMPORT_INSTANCE', `ok=${ok},fail=${fail.length}`, 'SUCCESS']
    ).catch(() => {});
    res.json({
      code: 200,
      msg: `导入完成：成功 ${ok} 条，失败 ${fail.length} 条`,
      data: { ok, fail },
    });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// GET /api/cmdb/instances/:id
router.get('/instances/:id', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT i.*, h.HOSTNAME, h.OS_TYPE, h.CPU_CORES, h.MEMORY_GB, h.DATACENTER
       FROM CMDB_INSTANCE i LEFT JOIN CMDB_HOST h ON i.HOST_ID = h.HOST_ID
       WHERE i.INSTANCE_ID = :1`, [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '实例不存在' });
    res.json({ code: 200, data: r.rows[0] });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/cmdb/instances
router.post('/instances', async (req, res) => {
  const { instanceName, dbType, dbVersion, hostIp, port, sid, serviceName, dbUser, dbPassword,
          charset, environment, bizLine, tags, role, clusterName, hostId } = req.body;
  if (!instanceName || !dbType || !hostIp) {
    return res.json({ code: 400, msg: '实例名称、数据库类型、主机IP不能为空' });
  }
  const hostNorm = String(hostIp).trim();
  const typeNorm = String(dbType).trim().toUpperCase();
  try {
    const dup = await db.execute(
      `SELECT COUNT(*) AS C FROM CMDB_INSTANCE WHERE TRIM(HOST_IP)=:1 AND UPPER(DB_TYPE)=:2`,
      [hostNorm, typeNorm]
    );
    if (Number(dup.rows[0]?.C) > 0) {
      return res.json({
        code: 400,
        msg: `已存在相同主机 IP（${hostNorm}）且数据库类型为「${typeNorm}」的实例，请勿重复添加`,
      });
    }
    await db.execute(
      `INSERT INTO CMDB_INSTANCE (INSTANCE_NAME,DB_TYPE,DB_VERSION,HOST_IP,PORT,SID,SERVICE_NAME,
        DB_USER,DB_PASSWORD,CHARSET,STATUS,ENVIRONMENT,BIZ_LINE,TAGS,ROLE,CLUSTER_NAME,HOST_ID,CREATED_BY)
       VALUES(:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14,:15,:16,:17,:18)`,
      [
        instanceName,
        typeNorm,
        dbVersion,
        hostNorm,
        port || 1521,
        sid,
        serviceName,
        dbUser,
        dbPassword ? Buffer.from(dbPassword).toString('base64') : null,
        charset,
        initialCmDbStatus(typeNorm),
        environment,
        bizLine,
        tags,
        role,
        clusterName,
        hostId,
        req.user.userId,
      ]
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'CREATE_INSTANCE', instanceName, 'SUCCESS']
    );
    res.json({ code: 200, msg: '实例添加成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/cmdb/instances/:id
router.put('/instances/:id', async (req, res) => {
  const {
    instanceName,
    dbType,
    dbVersion,
    hostIp,
    port,
    sid,
    serviceName,
    dbUser,
    dbPassword,
    charset,
    environment,
    bizLine,
    tags,
    role,
  } = req.body;
  if (!instanceName || !dbType || hostIp == null || String(hostIp).trim() === '') {
    return res.json({ code: 400, msg: '实例名称、数据库类型、主机IP不能为空' });
  }
  const typeNorm = String(dbType).trim().toUpperCase();
  const hostNorm = String(hostIp).trim();
  const pwdEnc =
    dbPassword != null && String(dbPassword).trim() !== ''
      ? Buffer.from(String(dbPassword), 'utf8').toString('base64')
      : null;
  try {
    if (pwdEnc) {
      await db.execute(
        `UPDATE CMDB_INSTANCE SET INSTANCE_NAME=:1,DB_VERSION=:2,PORT=:3,CHARSET=:4,
          ENVIRONMENT=:5,BIZ_LINE=:6,TAGS=:7,ROLE=:8,
          HOST_IP=:9,DB_TYPE=:10,SID=:11,SERVICE_NAME=:12,DB_USER=:13,DB_PASSWORD=:14,UPDATED_AT=SYSTIMESTAMP
         WHERE INSTANCE_ID=:15`,
        [
          instanceName,
          dbVersion,
          port,
          charset,
          environment,
          bizLine,
          tags,
          role,
          hostNorm,
          typeNorm,
          sid || null,
          serviceName || null,
          dbUser || null,
          pwdEnc,
          req.params.id,
        ]
      );
    } else {
      await db.execute(
        `UPDATE CMDB_INSTANCE SET INSTANCE_NAME=:1,DB_VERSION=:2,PORT=:3,CHARSET=:4,
          ENVIRONMENT=:5,BIZ_LINE=:6,TAGS=:7,ROLE=:8,
          HOST_IP=:9,DB_TYPE=:10,SID=:11,SERVICE_NAME=:12,DB_USER=:13,UPDATED_AT=SYSTIMESTAMP
         WHERE INSTANCE_ID=:14`,
        [
          instanceName,
          dbVersion,
          port,
          charset,
          environment,
          bizLine,
          tags,
          role,
          hostNorm,
          typeNorm,
          sid || null,
          serviceName || null,
          dbUser || null,
          req.params.id,
        ]
      );
    }
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// DELETE /api/cmdb/instances/:id
router.delete('/instances/:id', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  try {
    const r = await db.execute(`SELECT INSTANCE_NAME FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`,[req.params.id]);
    if (!r.rows.length) return res.json({ code: 404, msg: '实例不存在' });
    await db.execute(`DELETE FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`,[req.params.id]);
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'DELETE_INSTANCE', r.rows[0].INSTANCE_NAME, 'SUCCESS']
    );
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/cmdb/hosts
router.get('/hosts', async (req, res) => {
  const { keyword, status, datacenter } = req.query;
  try {
    let where = ['1=1']; let binds = []; let bi = 1;
    if (keyword)   { where.push(`(UPPER(HOSTNAME) LIKE :${bi} OR UPPER(IP_ADDR) LIKE :${bi})`); binds.push(`%${keyword.toUpperCase()}%`); bi++; }
    if (status)     { where.push(`STATUS=:${bi}`); binds.push(status); bi++; }
    if (datacenter) { where.push(`DATACENTER=:${bi}`); binds.push(datacenter); bi++; }
    const r = await db.execute(`SELECT * FROM CMDB_HOST WHERE ${where.join(' AND ')} ORDER BY HOST_ID`, binds);
    res.json({ code: 200, data: r.rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/cmdb/hosts  创建主机
router.post('/hosts', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  const { hostname, ipAddr, osType, osVersion, cpuCores, memoryGb, datacenter, status } = req.body;
  if (!hostname || !ipAddr) return res.json({ code: 400, msg: '主机名和IP地址不能为空' });
  try {
    const dup = await db.execute(`SELECT HOST_ID FROM CMDB_HOST WHERE IP_ADDR=:1`, [ipAddr]);
    if (dup.rows.length) return res.json({ code: 409, msg: '该IP地址已存在' });
    await db.execute(
      `INSERT INTO CMDB_HOST(HOSTNAME,IP_ADDR,OS_TYPE,OS_VERSION,CPU_CORES,MEMORY_GB,DATACENTER,STATUS)
       VALUES(:1,:2,:3,:4,:5,:6,:7,:8)`,
      [hostname, ipAddr, osType, osVersion, cpuCores, memoryGb, datacenter, status || 'ONLINE']
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'CREATE_HOST', `${hostname}(${ipAddr})`, 'SUCCESS']
    );
    res.json({ code: 200, msg: '主机创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/cmdb/hosts/:id  更新主机
router.put('/hosts/:id', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  const { hostname, ipAddr, osType, osVersion, cpuCores, memoryGb, datacenter, status } = req.body;
  try {
    const old = await db.execute(`SELECT HOSTNAME FROM CMDB_HOST WHERE HOST_ID=:1`, [req.params.id]);
    if (!old.rows.length) return res.json({ code: 404, msg: '主机不存在' });
    await db.execute(
      `UPDATE CMDB_HOST SET HOSTNAME=:1,IP_ADDR=:2,OS_TYPE=:3,OS_VERSION=:4,CPU_CORES=:5,MEMORY_GB=:6,DATACENTER=:7,STATUS=:8 WHERE HOST_ID=:9`,
      [hostname, ipAddr, osType, osVersion, cpuCores, memoryGb, datacenter, status, req.params.id]
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'UPDATE_HOST', old.rows[0].HOSTNAME, 'SUCCESS']
    );
    res.json({ code: 200, msg: '主机更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/cmdb/hosts/:id  删除主机
router.delete('/hosts/:id', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  try {
    const old = await db.execute(`SELECT HOSTNAME FROM CMDB_HOST WHERE HOST_ID=:1`, [req.params.id]);
    if (!old.rows.length) return res.json({ code: 404, msg: '主机不存在' });
    const refs = await db.execute(`SELECT COUNT(*) AS C FROM CMDB_INSTANCE WHERE HOST_ID=:1`, [req.params.id]);
    if (refs.rows[0].C > 0) return res.json({ code: 409, msg: '该主机下仍有数据库实例，请先迁移实例后再删除' });
    await db.execute(`DELETE FROM CMDB_HOST WHERE HOST_ID=:1`, [req.params.id]);
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'DELETE_HOST', old.rows[0].HOSTNAME, 'SUCCESS']
    );
    res.json({ code: 200, msg: '主机删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ======================== 集群拓扑管理 ========================

// GET /api/cmdb/clusters  集群列表
router.get('/clusters', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT c.*, (SELECT COUNT(*) FROM CMDB_CLUSTER_MEMBER m WHERE m.CLUSTER_ID=c.CLUSTER_ID) AS MEMBER_COUNT
       FROM CMDB_CLUSTER c ORDER BY c.CLUSTER_ID`, []
    );
    res.json({ code: 200, data: r.rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/cmdb/clusters/:id  集群详情（含成员实例）
router.get('/clusters/:id', async (req, res) => {
  try {
    const cluster = await db.execute(`SELECT * FROM CMDB_CLUSTER WHERE CLUSTER_ID=:1`, [req.params.id]);
    if (!cluster.rows.length) return res.json({ code: 404, msg: '集群不存在' });
    const members = await db.execute(
      `SELECT m.MEMBER_ID, m.NODE_ROLE, m.SORT_ORDER,
              i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.HOST_IP, i.PORT, i.STATUS, i.HEALTH_SCORE
       FROM CMDB_CLUSTER_MEMBER m
       JOIN CMDB_INSTANCE i ON m.INSTANCE_ID = i.INSTANCE_ID
       WHERE m.CLUSTER_ID = :1 ORDER BY m.SORT_ORDER, m.MEMBER_ID`,
      [req.params.id]
    );
    res.json({ code: 200, data: { ...cluster.rows[0], members: members.rows } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/cmdb/clusters  创建集群
router.post('/clusters', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  const { clusterName, clusterType, description, vip, status } = req.body;
  if (!clusterName || !clusterType) return res.json({ code: 400, msg: '集群名称和类型不能为空' });
  try {
    await db.execute(
      `INSERT INTO CMDB_CLUSTER(CLUSTER_NAME,CLUSTER_TYPE,DESCRIPTION,VIP,STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [clusterName, clusterType, description, vip, status || 'NORMAL']
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'CREATE_CLUSTER', clusterName, 'SUCCESS']
    );
    res.json({ code: 200, msg: '集群创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/cmdb/clusters/:id  更新集群
router.put('/clusters/:id', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  const { clusterName, clusterType, description, vip, status } = req.body;
  try {
    const old = await db.execute(`SELECT CLUSTER_NAME FROM CMDB_CLUSTER WHERE CLUSTER_ID=:1`, [req.params.id]);
    if (!old.rows.length) return res.json({ code: 404, msg: '集群不存在' });
    await db.execute(
      `UPDATE CMDB_CLUSTER SET CLUSTER_NAME=:1,CLUSTER_TYPE=:2,DESCRIPTION=:3,VIP=:4,STATUS=:5,UPDATED_AT=SYSTIMESTAMP WHERE CLUSTER_ID=:6`,
      [clusterName, clusterType, description, vip, status, req.params.id]
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'UPDATE_CLUSTER', old.rows[0].CLUSTER_NAME, 'SUCCESS']
    );
    res.json({ code: 200, msg: '集群更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/cmdb/clusters/:id  删除集群
router.delete('/clusters/:id', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  try {
    const old = await db.execute(`SELECT CLUSTER_NAME FROM CMDB_CLUSTER WHERE CLUSTER_ID=:1`, [req.params.id]);
    if (!old.rows.length) return res.json({ code: 404, msg: '集群不存在' });
    await db.execute(`DELETE FROM CMDB_CLUSTER WHERE CLUSTER_ID=:1`, [req.params.id]);
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'DELETE_CLUSTER', old.rows[0].CLUSTER_NAME, 'SUCCESS']
    );
    res.json({ code: 200, msg: '集群已删除' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/cmdb/clusters/:id/members  添加集群成员
router.post('/clusters/:id/members', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  const { instanceId, nodeRole } = req.body;
  if (!instanceId) return res.json({ code: 400, msg: '实例ID不能为空' });
  try {
    const cluster = await db.execute(`SELECT CLUSTER_NAME FROM CMDB_CLUSTER WHERE CLUSTER_ID=:1`, [req.params.id]);
    if (!cluster.rows.length) return res.json({ code: 404, msg: '集群不存在' });
    const dup = await db.execute(`SELECT MEMBER_ID FROM CMDB_CLUSTER_MEMBER WHERE CLUSTER_ID=:1 AND INSTANCE_ID=:2`, [req.params.id, instanceId]);
    if (dup.rows.length) return res.json({ code: 409, msg: '该实例已在集群中' });
    await db.execute(
      `INSERT INTO CMDB_CLUSTER_MEMBER(CLUSTER_ID,INSTANCE_ID,NODE_ROLE) VALUES(:1,:2,:3)`,
      [req.params.id, instanceId, nodeRole || 'PRIMARY']
    );
    res.json({ code: 200, msg: '成员添加成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/cmdb/clusters/:id/members/:instanceId  移除集群成员
router.delete('/clusters/:id/members/:instanceId', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  try {
    await db.execute(`DELETE FROM CMDB_CLUSTER_MEMBER WHERE CLUSTER_ID=:1 AND INSTANCE_ID=:2`, [req.params.id, req.params.instanceId]);
    res.json({ code: 200, msg: '成员已移除' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/cmdb/stats  (统计概览)
router.get('/stats', async (req, res) => {
  try {
    const [total, running, error, byType] = await Promise.all([
      db.execute(`SELECT COUNT(*) AS CNT FROM CMDB_INSTANCE`,[]),
      db.execute(`SELECT COUNT(*) AS CNT FROM CMDB_INSTANCE WHERE STATUS='RUNNING'`,[]),
      db.execute(`SELECT COUNT(*) AS CNT FROM CMDB_INSTANCE WHERE STATUS='ERROR'`,[]),
      db.execute(`SELECT DB_TYPE, COUNT(*) AS CNT FROM CMDB_INSTANCE GROUP BY DB_TYPE`,[]),
    ]);
    res.json({
      code: 200,
      data: {
        total: total.rows[0].CNT,
        running: running.rows[0].CNT,
        error: error.rows[0].CNT,
        byType: byType.rows,
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
