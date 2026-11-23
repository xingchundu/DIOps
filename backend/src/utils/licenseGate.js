/**
 * 授权闸门（Node 侧后台任务用）：授权由 Java 判定，这里每分钟读取一次 GET /api/license/status。
 * 到期后：登录与接口由 Java 网关立即拦截；Node 的定时任务（巡检、备份策略等）与 Java 采集一致，宽限 7 天后停止。
 * Java 暂时不可达时沿用上一次结果（首次未取到前默认放行，平台此时也无法登录）。
 */
const BASE = String(process.env.JAVA_SERVER_URL || `http://127.0.0.1:${process.env.JAVA_SERVER_PORT || 3000}`).replace(/\/+$/, '');

let allowed = true;
let state = 'UNKNOWN';
let timer = null;

async function refresh() {
  try {
    const resp = await fetch(`${BASE}/api/license/status`, { signal: AbortSignal.timeout(5000) });
    const body = await resp.json();
    if (body && body.code === 200 && body.data) {
      const next = body.data.backgroundAllowed !== false;
      if (next !== allowed || body.data.state !== state) {
        console.log(`[license] ${body.data.state} backgroundAllowed=${next}`);
      }
      allowed = next;
      state = body.data.state;
    }
  } catch (_) {
    // Java 不可达：沿用上次结果
  }
}

function start() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, 60 * 1000);
  if (timer.unref) timer.unref();
}

function backgroundAllowed() {
  return allowed;
}

module.exports = { start, backgroundAllowed, refresh };
