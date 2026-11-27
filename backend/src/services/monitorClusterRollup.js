/**
 * 集群维度：RAC / 磐维集群 可达成员数 vs EXPECTED_MEMBER_COUNT
 */
const db = require('../config/db');

async function runClusterRollup() {
  const clusters = await db.execute(
    `SELECT c.CLUSTER_ID, c.CLUSTER_NAME, c.EXPECTED_MEMBER_COUNT, c.CLUSTER_TYPE
     FROM CMDB_CLUSTER c
     WHERE c.EXPECTED_MEMBER_COUNT IS NOT NULL AND c.EXPECTED_MEMBER_COUNT > 0`,
    []
  );
  const results = [];
  for (const cl of clusters.rows || []) {
    const members = await db.execute(
      `SELECT m.INSTANCE_ID, i.INSTANCE_NAME
       FROM CMDB_CLUSTER_MEMBER m
       JOIN CMDB_INSTANCE i ON i.INSTANCE_ID = m.INSTANCE_ID
       WHERE m.CLUSTER_ID = :1`,
      [cl.CLUSTER_ID]
    );
    let reachable = 0;
    for (const mem of members.rows || []) {
      const samp = await db.execute(
        `SELECT REACHABLE FROM (
           SELECT REACHABLE FROM MONITOR_METRIC_SAMPLE
           WHERE INSTANCE_ID = :1 ORDER BY COLLECTED_AT DESC
         ) WHERE ROWNUM = 1`,
        [mem.INSTANCE_ID]
      );
      if (samp.rows?.[0]?.REACHABLE === 1) reachable += 1;
    }
    const expected = Number(cl.EXPECTED_MEMBER_COUNT);
    const ok = reachable >= expected;
    results.push({
      clusterId: cl.CLUSTER_ID,
      clusterName: cl.CLUSTER_NAME,
      reachable,
      expected,
      ok,
    });
    if (ok) continue;

    const ruleName = 'RAC集群节点数不足';
    const rule = await db.execute(
      `SELECT RULE_ID FROM ALERT_RULE WHERE RULE_NAME = :1`,
      [ruleName]
    );
    const ruleId = rule.rows?.[0]?.RULE_ID;
    const open = await db.execute(
      `SELECT 1 FROM ALERT_RECORD
       WHERE RULE_NAME = :1 AND STATUS = 'OPEN' AND CONTENT LIKE :2`,
      [ruleName, `%CLUSTER_ID=${cl.CLUSTER_ID}%`]
    );
    if ((open.rows || []).length > 0) continue;

    const content = `CLUSTER_ID=${cl.CLUSTER_ID} ${cl.CLUSTER_NAME}: 可达成员 ${reachable}/${expected}`;
    await db.execute(
      `INSERT INTO ALERT_RECORD (RULE_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME)
       VALUES (:1, :2, NULL, :3, 'P1', :4, 'OPEN', SYSTIMESTAMP)`,
      [ruleId ?? null, ruleName, cl.CLUSTER_NAME, content.slice(0, 1024)]
    );
  }
  return results;
}

module.exports = { runClusterRollup };
