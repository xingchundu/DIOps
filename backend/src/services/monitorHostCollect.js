/**
 * [dxc][2026-10-08][新增] 阶段3 HOST 通道：SSH 白名单采集（Oracle lsnrctl/crsctl + 磐维 gs_om/gs_ctl + 通用 CPU/内存/df）
 */
const db = require('../config/db');
const { runSshCommand } = require('../utils/sshExec');
const { decodeDbPassword } = require('../utils/monitorTargetConn');

const CMD = {
  loadavg: 'cat /proc/loadavg 2>/dev/null || uptime',
  mem: "free -m 2>/dev/null | awk '/^Mem:/ {print $2,$3,$4}'",
  swap: "free -m 2>/dev/null | awk '/^Swap:/ {print $2,$3}'",
  df: "LANG=C df -P 2>/dev/null | awk 'NR>1 {gsub(/%/,\"\",$5); print $1,$5,$6}'",
  // top -bn1 第一帧是开机至今平均。先采 1 秒 /proc/stat；失败再取 top 第二帧。
  cpu: "LANG=C awk 'function snap(   line,n,id,i){n=0;id=0;while((getline line < \"/proc/stat\")>0){if(line ~ /^cpu /){split(line,f);id=f[5]+0;for(i=2;i<=9;i++)n+=f[i];break}}close(\"/proc/stat\");return n\" \"id}BEGIN{split(snap(),a,\" \");if(a[1]+0<=0)exit 1;system(\"sleep 1\");split(snap(),b,\" \");dt=b[1]-a[1];if(dt<=0)exit 1;printf \"%.2f\\n\",(dt-(b[2]-a[2]))*100/dt}' || LANG=C top -bn2 -d 1 2>/dev/null | grep -E 'Cpu\\(s\\)|%Cpu' | tail -1",
  vmstat: 'vmstat 1 2 2>/dev/null | tail -1',
  listener: "bash -lc 'command -v lsnrctl >/dev/null 2>&1 && lsnrctl status 2>&1 | head -30 || echo __LSNR_MISSING__'",
  crs: "bash -lc 'command -v crsctl >/dev/null 2>&1 && crsctl stat res -t 2>&1 | head -80 || echo __CRS_MISSING__'",
  ora_ps: "ps -eo comm 2>/dev/null | grep -E '^ora_' | sort -u",
  gs_om: "bash -lc 'command -v gs_om >/dev/null 2>&1 && gs_om -t status --detail 2>&1 | head -120 || echo __GS_OM_MISSING__'",
  gs_ctl: "bash -lc 'command -v gs_ctl >/dev/null 2>&1 && gs_ctl query 2>&1 | head -40 || echo __GS_CTL_MISSING__'",
};

/** 与 Java HostParsers.parseCpuSample 一致：纯数字为 1 秒采样；top 多帧只认最后一行 */
function parseCpuSample(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  if (!last) return null;
  if (/^\d+(\.\d+)?$/.test(last)) {
    const n = Number(last);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
  }
  const top = parseCpuPct(last);
  if (top != null) return top;
  const parts = last.split(/\s+/);
  if (parts.length >= 15) {
    const idle = Number(parts[14]);
    if (Number.isFinite(idle)) return Math.min(100, Math.max(0, 100 - idle));
  }
  return null;
}

function parseCpuPct(line) {
  const s = String(line || '');
  const idleM = s.match(/([0-9.]+)\s*%?\s*id/i);
  if (idleM) return Math.min(100, Math.max(0, 100 - parseFloat(idleM[1])));
  const usedM = s.match(/([0-9.]+)\s*%?\s*us/i);
  if (usedM) {
    const sy = s.match(/([0-9.]+)\s*%?\s*sy/i);
    return Math.min(100, parseFloat(usedM[1]) + (sy ? parseFloat(sy[1]) : 0));
  }
  return null;
}

/** 与 Java HostParsers.ignoreFs 一致：内存盘、loop 光盘镜像、snap 不计入磁盘使用率 */
function ignoreFs(device, mount) {
  const d = String(device || '').toLowerCase();
  const m = String(mount || '');
  if (m === '/dev' || m.startsWith('/dev/') || m.startsWith('/sys') || m.startsWith('/proc')
    || m.startsWith('/run') || m === '/snap' || m.startsWith('/snap/')
    || m === '/dvd' || m.startsWith('/dvd/') || m === '/cdrom' || m.startsWith('/cdrom/')
    || m === '/media' || m.startsWith('/media/')) return true;
  return d === 'tmpfs' || d === 'devtmpfs' || d === 'overlay' || d === 'squashfs'
    || d === 'iso9660' || d === 'udf' || d === 'ramfs' || d === 'autofs'
    || d === 'nsfs' || d === 'tracefs' || d === 'cgroup' || d === 'cgroup2'
    || d === 'configfs' || d === 'debugfs' || d === 'securityfs' || d === 'pstore'
    || d === 'bpf' || d === 'hugetlbfs' || d === 'mqueue' || d === 'fusectl'
    || d.startsWith('/dev/loop') || d.startsWith('loop');
}

function parseDf(text) {
  const rows = [];
  let maxPct = null;
  for (const line of String(text || '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 3) continue;
    const mount = p[2];
    const pct = Number(p[1]);
    if (!Number.isFinite(pct)) continue;
    if (ignoreFs(p[0], mount)) continue;
    rows.push({ mount, usedPct: pct, device: p[0] });
    if (maxPct == null || pct > maxPct) maxPct = pct;
  }
  return { rows, maxPct };
}

function parseListener(text) {
  const t = String(text || '');
  if (t.includes('__LSNR_MISSING__')) return { ready: null, skipped: true };
  const ok = /STATUS of the LISTENER|Listener LOG/i.test(t) && !/TNS-12541|TNS-12560|does not exist/i.test(t);
  return { ready: ok ? 1 : 0, skipped: false, excerpt: t.slice(0, 800) };
}

function parseCrsOffline(text) {
  const t = String(text || '');
  if (t.includes('__CRS_MISSING__')) return { offline: null, skipped: true };
  let offline = 0;
  for (const line of t.split('\n')) {
    if (/OFFLINE|UNKNOWN|INTERMEDIATE/i.test(line) && !/ONLINE/i.test(line.split(/\s+/)[0] || '')) {
      if (/\.(db|vip|lsnr|asm)/i.test(line) || /ora\./i.test(line)) offline += 1;
    }
  }
  if (offline === 0 && /OFFLINE/i.test(t)) {
    offline = (t.match(/OFFLINE/gi) || []).length;
  }
  return { offline, skipped: false, excerpt: t.slice(0, 1200) };
}

function parseGsOm(text) {
  const t = String(text || '');
  if (t.includes('__GS_OM_MISSING__')) return { abnormal: null, skipped: true, excerpt: null };
  const normal = /Normal|cluster_state\s*:\s*Normal|cluster state\s*:\s*Normal/i.test(t);
  const degraded = /Degraded|Abnormal|Unavailable|Offline|Stopped/i.test(t);
  let abnormal = 0;
  if (degraded && !normal) abnormal = 1;
  else if (!normal && /cluster/i.test(t)) abnormal = 1;
  return { abnormal, skipped: false, excerpt: t.slice(0, 1500) };
}

function hostCol(row, name) {
  if (!row) return undefined;
  if (row[name] !== undefined) return row[name];
  const lower = name.toLowerCase();
  return row[lower];
}

async function fetchInstanceHost(instanceId) {
  try {
    const r = await db.execute(
      `SELECT i.INSTANCE_ID, i.DB_TYPE, i.HOST_ID,
              h.IP_ADDR, h.SSH_ENABLED, h.SSH_PORT, h.SSH_USER, h.SSH_PASSWORD, h.SSH_PRIVATE_KEY, h.SSH_AUTH_TYPE
       FROM CMDB_INSTANCE i
       LEFT JOIN CMDB_HOST h ON h.HOST_ID = i.HOST_ID
       WHERE i.INSTANCE_ID = :1`,
      [instanceId]
    );
    return r.rows?.[0] || null;
  } catch (e) {
    if (/ORA-00904|904/.test(e.message || '')) {
      const e2 = new Error('CMDB_HOST 缺少 SSH 字段，请执行 migration_monitor_catalog_phase3.sql');
      e2.code = 'SSH_SCHEMA_MISSING';
      throw e2;
    }
    throw e;
  }
}

async function readSecretField(val) {
  if (val == null || val === '') return '';
  let raw = val;
  if (typeof val === 'object' && typeof val.getData === 'function') {
    raw = await val.getData();
  }
  const s = String(raw).trim();
  if (!s) return '';
  return decodeDbPassword(s);
}

function sshEnabledFlag(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n === 1;
  const t = String(v).trim().toUpperCase();
  return t === '1' || t === 'Y' || t === 'YES' || t === 'TRUE';
}

async function resolveMetricHub(instanceId) {
  const member = await db.execute(
    `SELECT NODE_ROLE FROM CMDB_CLUSTER_MEMBER WHERE INSTANCE_ID = :1`,
    [instanceId]
  );
  if (!member.rows?.length) return true;
  const hub = await db.execute(
    `SELECT 1 FROM CMDB_CLUSTER_MEMBER m
     JOIN CMDB_CLUSTER_MEMBER me ON me.CLUSTER_ID = m.CLUSTER_ID AND me.INSTANCE_ID = :1
     WHERE UPPER(NVL(m.NODE_ROLE, '')) = 'METRIC_HUB'`,
    [instanceId]
  );
  if (!(hub.rows || []).length) return true;
  return String(member.rows[0].NODE_ROLE || '').toUpperCase() === 'METRIC_HUB';
}

/** [dxc][2026-10-17][修改] SSH 判定：兼容 SSH_ENABLED 类型、CLOB 私钥、有凭据但标志未同步 */
async function buildSshConfig(row) {
  const ip = hostCol(row, 'IP_ADDR');
  const user = String(hostCol(row, 'SSH_USER') || '').trim();
  if (!ip || !user) {
    return { config: null, detail: !ip ? 'host_ip_missing' : 'ssh_user_missing' };
  }
  const pwd = await readSecretField(hostCol(row, 'SSH_PASSWORD'));
  const key = await readSecretField(hostCol(row, 'SSH_PRIVATE_KEY'));
  if (!pwd && !key) {
    return { config: null, detail: 'ssh_credentials_missing' };
  }
  const flag = sshEnabledFlag(hostCol(row, 'SSH_ENABLED'));
  // 凭据齐全时仍采集（避免 SSH_ENABLED 未同步为 1）；仅「无凭据且明确关闭」时在上层已拦截
  if (flag === false && !pwd && !key) {
    return { config: null, detail: 'ssh_disabled_on_host' };
  }
  const portRaw = hostCol(row, 'SSH_PORT');
  return {
    config: {
      host: String(ip).trim(),
      port: Number(portRaw) > 0 ? Number(portRaw) : 22,
      username: user,
      password: pwd || undefined,
      privateKey: key || undefined,
      readyTimeout: Math.max(5000, parseInt(process.env.MONITOR_SSH_CONNECT_MS || '15000', 10)),
    },
    detail: null,
  };
}

async function runCmd(ssh, key) {
  const timeoutMs = Math.max(8000, parseInt(process.env.MONITOR_SSH_CMD_MS || '25000', 10));
  try {
    const res = await runSshCommand(ssh, CMD[key], { timeoutMs });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message || String(e), stdout: '', stderr: '', code: -1 };
  }
}

/**
 * @returns {{ hostMetrics: Array<{key,value,unit}>, hostSummary: object|null }}
 */
async function collectHostMetrics(instanceId, dbType) {
  const row = await fetchInstanceHost(instanceId);
  const hostId = hostCol(row, 'HOST_ID');
  if (!hostId) {
    return { hostMetrics: [{ key: '_host_skip', value: 0, unit: 'reason:no_host_id' }], hostSummary: { skip: 'no_host_id' } };
  }
  if (!hostCol(row, 'IP_ADDR')) {
    return {
      hostMetrics: [{ key: '_host_skip', value: 0, unit: 'reason:host_row_missing' }],
      hostSummary: { skip: 'ssh_not_configured', detail: 'host_record_not_found', hostId },
    };
  }
  const { config: ssh, detail: sshDetail } = await buildSshConfig(row);
  if (!ssh) {
    return {
      hostMetrics: [{ key: '_host_skip', value: 0, unit: `reason:${sshDetail || 'ssh_disabled'}` }],
      hostSummary: {
        skip: 'ssh_not_configured',
        detail: sshDetail || 'ssh_disabled',
        hostId,
        sshEnabled: hostCol(row, 'SSH_ENABLED'),
        hasSshUser: !!String(hostCol(row, 'SSH_USER') || '').trim(),
        hasSshPassword: !!(hostCol(row, 'SSH_PASSWORD')),
        hasSshPrivateKey: !!(hostCol(row, 'SSH_PRIVATE_KEY')),
      },
    };
  }

  const dt = String(dbType || hostCol(row, 'DB_TYPE') || '').toUpperCase();
  const metrics = [];
  const summary = { hostId, ip: hostCol(row, 'IP_ADDR'), checks: {} };
  const hub = await resolveMetricHub(instanceId);

  try {
    await runSshCommand(ssh, 'echo DIOps_SSH_OK', { timeoutMs: 10000 });
  } catch (e) {
    return {
      hostMetrics: [
        { key: 'host_ssh_ok', value: 0, unit: '' },
        { key: '_host_error', value: 0, unit: String(e.message || e).slice(0, 120) },
      ],
      hostSummary: { ...summary, error: e.message || String(e) },
    };
  }

  const load = await runCmd(ssh, 'loadavg');
  summary.checks.loadavg = load.ok ? load.stdout.trim() : load.error;
  const load1 = parseFloat(String(load.stdout || '').trim().split(/\s+/)[0]);
  if (Number.isFinite(load1)) metrics.push({ key: 'host_load_1m', value: load1, unit: '' });

  const mem = await runCmd(ssh, 'mem');
  if (mem.ok) {
    const [total, used] = String(mem.stdout).trim().split(/\s+/).map(Number);
    if (total > 0 && Number.isFinite(used)) {
      const pct = Math.min(100, (used / total) * 100);
      metrics.push({ key: 'host_mem_used_pct', value: Number(pct.toFixed(2)), unit: '%' });
    }
  }

  const cpu = await runCmd(ssh, 'cpu');
  let cpuPct = parseCpuSample(cpu.stdout);
  if (cpuPct == null && cpu.ok) {
    const vm = await runCmd(ssh, 'vmstat');
    if (vm.ok) {
      const parts = vm.stdout.trim().split(/\s+/);
      const idle = Number(parts[parts.length - 3]);
      if (Number.isFinite(idle)) cpuPct = Math.min(100, Math.max(0, 100 - idle));
    }
  }
  if (cpuPct != null) {
    metrics.push({ key: 'host_cpu_used_pct', value: Number(cpuPct.toFixed(2)), unit: '%' });
    metrics.push({ key: 'host_cpu_usage', value: Number(cpuPct.toFixed(2)), unit: '%' });
  }

  const df = await runCmd(ssh, 'df');
  if (df.ok) {
    const parsed = parseDf(df.stdout);
    summary.filesystems = parsed.rows;
    if (parsed.maxPct != null) {
      metrics.push({ key: 'host_fs_used_pct_max', value: parsed.maxPct, unit: '%' });
    }
  }

  metrics.push({ key: 'host_ssh_ok', value: 1, unit: '' });

  if (dt === 'ORACLE') {
    const lsnr = await runCmd(ssh, 'listener');
    const lp = parseListener(lsnr.stdout + lsnr.stderr);
    summary.listener = lp;
    if (lp.ready != null) metrics.push({ key: 'host_listener_ready', value: lp.ready, unit: '' });

    const crs = await runCmd(ssh, 'crs');
    const cp = parseCrsOffline(crs.stdout + crs.stderr);
    summary.crs = cp;
    if (cp.offline != null) metrics.push({ key: 'host_crs_resource_offline', value: cp.offline, unit: '' });

    const ps = await runCmd(ssh, 'ora_ps');
    if (ps.ok) {
      const n = String(ps.stdout).trim().split('\n').filter(Boolean).length;
      metrics.push({ key: 'host_ora_background_proc_count', value: n, unit: '' });
    }
  }

  if (dt === 'PANWEI') {
    if (hub) {
      const gs = await runCmd(ssh, 'gs_om');
      const gp = parseGsOm(gs.stdout + gs.stderr);
      summary.gsOm = gp;
      if (gp.abnormal != null) {
        metrics.push({ key: 'panwei_gs_om_cluster_abnormal', value: gp.abnormal, unit: '' });
      }
    } else {
      summary.gsOm = { skipped: true, reason: 'not_metric_hub' };
    }
    const gctl = await runCmd(ssh, 'gs_ctl');
    if (gctl.ok && !String(gctl.stdout).includes('__GS_CTL_MISSING__')) {
      summary.gsCtlExcerpt = String(gctl.stdout).slice(0, 600);
    }
  }

  return { hostMetrics: metrics, hostSummary: summary };
}

module.exports = { collectHostMetrics, CMD };
