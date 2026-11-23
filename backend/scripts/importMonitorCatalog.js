#!/usr/bin/env node
/**
 * 导入 Oracle / 磐维监控目录 JSON → DB_MONITOR_CATALOG
 * 用法: cd backend && node scripts/importMonitorCatalog.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

const root = path.join(__dirname, '../..');

function classifyMode(collect, dbType) {
  const c = String(collect || '').toLowerCase();
  if (/lsnrctl|crsctl|^\s*(top|vmstat|sar|iostat|df |free |uptime|gs_om|gs_ctl|systemctl|ping )/.test(c)) {
    return 'HOST';
  }
  if (/巡检|日检|daily|report/.test(c)) return 'INSPECT';
  if (dbType === 'ORACLE' && /alert log|v\$diag/i.test(c)) return 'INSPECT';
  return 'REALTIME';
}

function guessMetricKey(item, dbType) {
  if (item.metric_key) return item.metric_key;
  const name = String(item.item || item.item_name || '').slice(0, 40);
  const slug = name.replace(/\s+/g, '_').replace(/[^\w\u4e00-\u9fa5]/g, '').toLowerCase();
  const prefix = dbType === 'PANWEI' ? 'panwei' : 'oracle';
  return `${prefix}_cat_${item.no || slug}`.slice(0, 128);
}

async function importFile(sourceFile, dbType, mapper) {
  const filePath = path.join(root, sourceFile);
  if (!fs.existsSync(filePath)) {
    console.warn('[skip] missing', filePath);
    return 0;
  }
  const rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let n = 0;
  for (const raw of rows) {
    const item = mapper(raw);
    const collectSpec = item.collect || item.source || '';
    const mode = classifyMode(collectSpec, dbType);
    await db.execute(
      `MERGE INTO DB_MONITOR_CATALOG t
       USING (SELECT :src AS SOURCE_FILE, :no AS ITEM_NO, :dbt AS DB_TYPE FROM DUAL) s
       ON (t.SOURCE_FILE = s.SOURCE_FILE AND t.ITEM_NO = s.ITEM_NO AND t.DB_TYPE = s.DB_TYPE)
       WHEN MATCHED THEN UPDATE SET
         CATEGORY = :cat, SUBCATEGORY = :sub, ITEM_NAME = :iname, ITEM_DESC = :ides,
         COLLECT_MODE = :mode, COLLECT_SPEC = :spec, METRIC_KEY = :mkey,
         THRESHOLD_TEXT = :th, SEVERITY_LABEL = :sev, NOTE_TEXT = :note, ENABLED = 1
       WHEN NOT MATCHED THEN INSERT (
         SOURCE_FILE, ITEM_NO, DB_TYPE, CATEGORY, SUBCATEGORY, ITEM_NAME, ITEM_DESC,
         COLLECT_MODE, COLLECT_SPEC, METRIC_KEY, THRESHOLD_TEXT, SEVERITY_LABEL, NOTE_TEXT, ENABLED
       ) VALUES (:src, :no, :dbt, :cat, :sub, :iname, :ides, :mode, :spec, :mkey, :th, :sev, :note, 1)`,
      {
        src: sourceFile,
        no: item.no,
        dbt: dbType,
        cat: item.category || null,
        sub: item.subcategory || null,
        iname: (item.item || '未命名').slice(0, 512),
        ides: (item.desc || '').slice(0, 1024) || null,
        mode,
        spec: collectSpec.slice(0, 32000) || null,
        mkey: guessMetricKey(item, dbType),
        th: (item.threshold || '').slice(0, 512) || null,
        sev: item.level || null,
        note: (item.note || '').slice(0, 1024) || null,
      }
    );
    n += 1;
  }
  return n;
}

async function main() {
  const ora = await importFile('docs/_oracle_monitor_items.json', 'ORACLE', (r) => ({
    no: r.no,
    category: r.category,
    subcategory: null,
    item: r.item,
    desc: r.note,
    collect: r.source,
    threshold: r.threshold,
    level: r.level,
    note: r.note,
  }));
  const pw = await importFile('docs/_panwei_monitor_items.json', 'PANWEI', (r) => ({
    no: r.no,
    category: r.category,
    subcategory: r.subcategory,
    item: r.item,
    desc: r.desc,
    collect: r.collect,
    threshold: r.threshold,
    level: r.level,
    note: r.note,
  }));
  console.log(`[OK] imported Oracle ${ora}, Panwei ${pw}, total ${ora + pw}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
