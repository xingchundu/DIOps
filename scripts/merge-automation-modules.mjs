import fs from 'fs';
import path from 'path';

const srcRoot = 'D:/E/fix/DIOps-main';
const dstRoot = 'D:/E/SLinux/DIOps';

function readLines(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n');
}

function writeLines(p, lines) {
  fs.writeFileSync(p, lines.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
}

fs.copyFileSync(
  path.join(srcRoot, 'backend/sql/migration_v3_closed_loop.sql'),
  path.join(dstRoot, 'backend/sql/migration_v3_closed_loop.sql'),
);

// backend automation.js: source inspect head + v3 mid + source tail + target python-check
const srcAuto = readLines(path.join(srcRoot, 'backend/src/routes/automation.js'));
const head = srcAuto.slice(0, 340);
const impIdx = head.findIndex((l) => l.includes("inspectPythonDocxRunner"));
if (impIdx >= 0) {
  head[impIdx] =
    "const { getInspectReportsRoot, detectPython } = require('../services/inspectPythonDocxRunner');";
}
const mid = srcAuto.slice(342, 1579);
const tail = srcAuto.slice(1580, 1727);

const pyBlock = `// ── Python 环境诊断接口（帮助排查 exit=9009 等问题）────────────
router.get('/inspect/python-check', async (req, res) => {
  const reportsRoot = getInspectReportsRoot();
  const HEADLESS_PY = path.join(__dirname, '..', '..', 'scripts', 'db_inspection_headless.py');
  const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'inspect');

  const pythonInfo = detectPython();
  const templateFiles = {};
  const templateList  = ['mysql','postgresql','oracle','goldendb','dameng'];
  for (const t of templateList) {
    const fp = path.join(TEMPLATES_DIR, \`\${t}_master_inspection.sql\`);
    templateFiles[t] = fs.existsSync(fp) ? \`✅ \${fp}\` : \`❌ 未找到: \${fp}\`;
  }

  let reportsRootOk = false;
  try {
    fs.mkdirSync(reportsRoot, { recursive: true });
    reportsRootOk = true;
  } catch (_) {}

  const result = {
    python: pythonInfo
      ? { ok: true,  cmd: pythonInfo.cmd, args: pythonInfo.args, version: pythonInfo.version }
      : { ok: false, msg: '未找到 Python3。请安装 Python3.8+ 并设置 INSPECT_PYTHON 环境变量' },
    headlessScript:  fs.existsSync(HEADLESS_PY) ? \`✅ \${HEADLESS_PY}\` : \`❌ 未找到: \${HEADLESS_PY}\`,
    reportsRoot:     reportsRootOk ? \`✅ \${reportsRoot}\` : \`❌ 无法创建: \${reportsRoot}\`,
    templatesDir:    TEMPLATES_DIR,
    templateFiles,
    envVars: {
      INSPECT_PYTHON:           process.env.INSPECT_PYTHON     || '（未设置）',
      INSPECT_PYTHON_WORD:      process.env.INSPECT_PYTHON_WORD|| '（未设置，默认开启）',
      INSPECT_PYTHON_REPORTS_DIR: process.env.INSPECT_PYTHON_REPORTS_DIR || '（未设置，默认 backend/reports）',
    },
    helpOnExit9009: [
      '1. 确认已安装 Python3.8+：https://www.python.org/downloads/',
      '2. 安装依赖：pip install python-docx pymysql psycopg2-binary tqdm oracledb',
      '3. Windows 用户：设置环境变量 INSPECT_PYTHON=C:\\\\Python312\\\\python.exe',
      '4. Linux 用户：设置 INSPECT_PYTHON=/usr/bin/python3 或 export INSPECT_PYTHON=$(which python3)',
      '5. 重启 Node.js 服务使环境变量生效',
    ],
  };
  res.json({ code: 200, data: result });
});

module.exports = router;`;

const mergedAuto = [...head, ...mid, ...tail, ...pyBlock.split('\n')];
writeLines(path.join(dstRoot, 'backend/src/routes/automation.js'), mergedAuto);

// API
const dstApi = readLines(path.join(dstRoot, 'frontend/src/api/index.js'));
const srcApi = readLines(path.join(srcRoot, 'frontend/src/api/index.js'));
const apiStart = dstApi.findIndex((l) => l.startsWith('export const automationApi'));
const apiEnd = dstApi.findIndex((l) => l.startsWith('export const userApi'));
const srcApiStart = srcApi.findIndex((l) => l.startsWith('export const automationApi'));
const srcApiEnd = srcApi.findIndex((l) => l.startsWith('export const userApi'));
writeLines(path.join(dstRoot, 'frontend/src/api/index.js'), [
  ...dstApi.slice(0, apiStart),
  ...srcApi.slice(srcApiStart, srcApiEnd),
  ...dstApi.slice(apiEnd),
]);

// Vue: source template/script with extra dashboard styles
const srcVue = readLines(path.join(srcRoot, 'frontend/src/views/automation/AutomationCenter.vue'));
const styleEnd = srcVue.findIndex((l) => l.trim() === '</style>' && srcVue[srcVue.indexOf(l) - 1]?.includes('task-run-log-pre'));
const vueOut = [
  ...srcVue.slice(0, styleEnd),
  '.review-sql-pre { max-height:260px; border:1px solid #e4e7ed }',
  '.fault-dashboard-bar { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; padding:12px; background:#fff; border-radius:8px; border:1px solid #e4e7ed }',
  '.dashboard-stat { min-width:90px; text-align:center }',
  '.ds-value { font-size:20px; font-weight:700 }',
  ...srcVue.slice(styleEnd),
];
writeLines(path.join(dstRoot, 'frontend/src/views/automation/AutomationCenter.vue'), vueOut);

console.log('automation.js:', mergedAuto.length);
console.log('AutomationCenter.vue:', vueOut.length);
