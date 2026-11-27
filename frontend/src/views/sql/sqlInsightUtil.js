/** SQL 洞察分析面板共用的小工具 */
export function shortSqlId(n) {
  if (!n) return '-'
  const p = String(n).split('|')
  if (p.length >= 3) return p[2]
  if (p.length === 2) return p[1]
  return p[0]
}
export const num = (v) => (v == null || v === '' ? '-' : Math.abs(Number(v)) >= 100 ? Number(v).toFixed(0) : Number(Number(v).toPrecision(3)))
export function fmtTime(v) {
  if (!v) return '-'
  const d = new Date(v)
  if (isNaN(d)) return String(v)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export const hh = (h) => `${String(h).padStart(2, '0')}:00`
