'use strict';
/**
 * 平台业务时区。Java 用 -Duser.timezone=${DBOPS_TZ:-Asia/Shanghai}。
 * Node 的定时任务和执行窗口必须用同一时区：宿主机若是美东，凌晨巡检会整段偏 13 小时。
 */
function platformTz() {
  const tz = process.env.DBOPS_TZ || process.env.AUTOMATION_SCHEDULER_TIMEZONE;
  return tz && String(tz).trim() ? String(tz).trim() : 'Asia/Shanghai';
}

function parts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: platformTz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const o = {};
  for (const p of fmt.formatToParts(now)) if (p.type !== 'literal') o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}

function minutesNow(now = new Date()) {
  const p = parts(now);
  return Number(p.hour) * 60 + Number(p.minute);
}

function ymd(now = new Date()) {
  const p = parts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

module.exports = { platformTz, minutesNow, ymd };
