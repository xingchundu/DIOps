/**
 * 部分更新：只更新请求体里出现的字段（出现但为空 → 置 NULL；没出现 → 保持原值）。
 * 原先的 UPDATE 把没传的字段写成 NULL，前端只改一个开关就会清空描述、负责人等。
 *
 * @param {object} body 请求体
 * @param {Record<string, string | [string, (v:any)=>any]>} fields bodyKey → 列名 或 [列名, 转换函数]
 * @returns {{ sets: string[], binds: any[] }}
 */
function partialSet(body, fields) {
  const sets = [];
  const binds = [];
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, key)) continue;
    const [col, fn] = Array.isArray(spec) ? spec : [spec, null];
    let v = body[key];
    if (v === '' || v === undefined) v = null;
    if (fn && v != null) v = fn(v);
    binds.push(v);
    sets.push(`${col}=:${binds.length}`);
  }
  return { sets, binds };
}

const bool01 = v => (v ? 1 : 0);

module.exports = { partialSet, bool01 };
