/**
 * Generates 数据库智能平台-客户方案简介.pptx (~10 slides).
 * cd docs/client-pitch-deck && npm install && node build-deck.mjs
 */
import pptxgen from 'pptxgenjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ACCENT = '1C2833';
const ACCENT2 = '2E4053';
const MUTED = 'AAB7B8';
const BG = 'F4F6F6';

function bulletSlide(ppt, title, bullets) {
  const slide = ppt.addSlide();
  slide.addShape(ppt.ShapeType.rect, {
    x: 0,
    y: 0,
    w: '100%',
    h: 0.45,
    fill: { color: ACCENT },
    line: { color: ACCENT, width: 0 },
  });
  slide.addText(title, {
    x: 0.5,
    y: 0.1,
    w: 9,
    h: 0.35,
    fontSize: 22,
    fontFace: 'Arial',
    color: 'FFFFFF',
    bold: true,
  });
  const body = bullets.map((t) => `• ${t}`).join('\n');
  slide.addText(body, {
    x: 0.55,
    y: 0.55,
    w: 9,
    h: 4.55,
    fontSize: 14,
    fontFace: 'Arial',
    color: ACCENT2,
    valign: 'top',
  });
}

const ppt = new pptxgen();
ppt.layout = 'LAYOUT_16x9';
ppt.author = 'DIOps';
ppt.title = '数据库智能平台 — 客户方案简介';
ppt.subject = '已实现能力与客户价值';

// Slide 1
{
  const s = ppt.addSlide();
  s.background = { color: BG };
  s.addShape(ppt.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 0.25,
    h: '100%',
    fill: { color: ACCENT },
    line: { width: 0 },
  });
  s.addText('数据库智能平台', {
    x: 0.55,
    y: 1.35,
    w: 8.5,
    h: 0.9,
    fontSize: 36,
    fontFace: 'Arial',
    color: ACCENT,
    bold: true,
  });
  s.addText('客户方案简介 · 已实现能力与差异化', {
    x: 0.55,
    y: 2.15,
    w: 8.5,
    h: 0.5,
    fontSize: 18,
    fontFace: 'Arial',
    color: MUTED,
  });
  s.addText(
    '统一纳管 · Oracle 深度监控 · SQL 治理 · 自动化巡检（CheckV8）\n平台元数据：Oracle ｜ 监控：直连采集 + 周期持久化',
    {
      x: 0.55,
      y: 2.85,
      w: 8.5,
      h: 1.2,
      fontSize: 13,
      fontFace: 'Arial',
      color: ACCENT2,
    }
  );
  s.addText('DIOps 项目交付说明稿', {
    x: 0.55,
    y: 4.85,
    w: 5,
    h: 0.35,
    fontSize: 11,
    fontFace: 'Arial',
    color: MUTED,
  });
}

bulletSlide(ppt, '定位：数据库一站式治理，而非“泛 IT 监控”', [
  '围绕数据库实例与 DBA 日常工作：资产、监控、告警、SQL、会话与锁、巡检与报告。',
  '与常见“主机/中间件大屏”不同：指标与库内事实（表空间、等待、Top SQL、AWR 等）在同一产品内联动。',
  '后端已落地：Oracle / MySQL / PostgreSQL 监控采集与 Oracle 专项能力（以实际纳管环境为准）。',
]);

bulletSlide(ppt, '已实现功能地图（与系统菜单一致）', [
  '仪表盘：总览与关键入口。',
  '监控中心：实例列表、单实例详情；采集调度观测。',
  '告警中心：列表与统计、确认/解决、告警规则维护。',
  '资产管理：实例维护、多 Sheet Excel 模板批量导入。',
  '自动化：Oracle CheckV8 巡检、Excel 批次、Word 报告 ZIP、报告 JSON 历史。',
  'SQL 优化：慢 SQL、执行计划、规则/AI 建议、手动采集入库；报表与用户权限、JWT 登录。',
]);

bulletSlide(ppt, '监控中心：深度与闭环', [
  '总览与实例列表；详情：基本信息、实时性能、历史趋势、表空间、Top SQL、等待、锁（Oracle）。',
  '会话与 Oracle Kill 会话（权限与审计依平台策略）。',
  'Oracle：AWR 快照等接口支撑深度排障。',
  '后端定时采集写入样本表，“采集调度”页可观测周期与最近样本。',
]);

bulletSlide(ppt, '告警中心：从“看见”到“处理”', [
  '告警查询与统计；单条确认、解决，形成处置闭环。',
  '告警规则：创建与编辑，支撑阈值类治理。',
  '与纯通知工具差异：告警与纳管实例、监控详情同源，定位更快。',
]);

bulletSlide(ppt, '资产管理：快速纳管与批量导入', [
  '实例增删改查；主机列表与统计支撑资产视图。',
  'Excel 多 Sheet 模板：Oracle / MySQL / PostgreSQL / 其他，一次上传批量入库。',
  '适合批量接管存量库、对齐运维台账，减少逐条录入。',
]);

bulletSlide(ppt, '自动化：Oracle CheckV8 深度巡检', [
  '检查项在平台内直连被管库执行，结果写入平台 Oracle。',
  '单实例、手动批次、Excel 建批次；Word 报告 ZIP 下载；JSON 详情便于复核。',
  '相对“只跑主机脚本”的平台：突出字典视图级数据库巡检与可交付报告。',
]);

bulletSlide(ppt, 'SQL 智能优化（已实现链路）', [
  '慢 SQL 列表与手动采集，将问题收敛到平台。',
  '执行计划分析 + 规则引擎 + AI 优化建议。',
  '对比仅展示慢日志：在同一界面完成计划解读与优化建议闭环。',
]);

bulletSlide(ppt, '安全、技术与下一步', [
  '用户管理、启用/禁用、管理员重置密码；操作审计日志查询。',
  '连接凭据等敏感数据按设计加密存储（以部署规范为准）。',
  'REST API、/health 健康检查；README 提供 Prometheus oracle_exporter 对接示例。',
  '下一步：PoC 范围（实例数、版本、账号权限）；与 ITSM/Prometheus 集成；导出物合规要求。',
]);

// Slide 10: Thank you
{
  const s = ppt.addSlide();
  s.background = { color: BG };
  s.addShape(ppt.ShapeType.rect, {
    x: 0,
    y: 0,
    w: '100%',
    h: 0.45,
    fill: { color: ACCENT },
    line: { width: 0 },
  });
  s.addText('谢谢聆听', {
    x: 0.5,
    y: 0.1,
    w: 9,
    h: 0.35,
    fontSize: 22,
    fontFace: 'Arial',
    color: 'FFFFFF',
    bold: true,
  });
  s.addText('欢迎交流演示环境、纳管清单与安全测评项。', {
    x: 0.55,
    y: 0.65,
    w: 9,
    h: 0.6,
    fontSize: 16,
    fontFace: 'Arial',
    color: ACCENT2,
  });
}

const dir = dirname(fileURLToPath(import.meta.url));
const pathOut = join(dir, '数据库智能平台-客户方案简介.pptx');
await ppt.writeFile({ fileName: pathOut });
console.log('Wrote:', pathOut);
