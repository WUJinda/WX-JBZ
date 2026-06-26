/**
 * 主页趋势图前端纯函数（对齐 PRD F4 R4.2/R4.3，开发计划阶段 F4）。
 *
 * 把趋势区间切换、柱高归一化、空态判定抽成纯函数，便于在 Node 下单测，
 * 不耦合 wx 运行时。柱状图渲染为纯 CSS（百分比高度），不引任何图表库。
 */

/** 合法区间白名单（R4.2：仅 7/30）。 */
const RANGES = [7, 30];

/**
 * 校正 range：仅接受 7/30，其余按默认 7 兜底（R4.2）。
 * @param {*} range
 * @param {number} [def=7]
 * @returns {number}
 */
function selectRange(range, def) {
  const n = Number(range);
  return n === 7 || n === 30 ? n : def === 30 ? 30 : 7;
}

/**
 * 柱高归一化：最大值 → 100% 高度；全 0 时给统一最小高度（1）避免柱状图塌陷。
 * 入参为 buildTrend.list（[{date, steps}]），返回带 heightPct 的副本数组。
 *
 * @param {Array<{date:string, steps:number}>} list
 * @returns {Array<{date:string, steps:number, heightPct:number}>}
 */
function normalizeBars(list) {
  const arr = (list || []).slice();
  const max = arr.reduce((m, it) => {
    const s = Number(it && it.steps) || 0;
    return s > m ? s : m;
  }, 0);
  return arr.map((it) => {
    const steps = Number(it && it.steps) || 0;
    const heightPct = max > 0 ? Math.round((steps / max) * 100) : 1;
    return { date: (it && it.date) || '', steps, heightPct };
  });
}

/**
 * 空态判定：list 全部为 0（无数据 → 展示 R4.3 占位）。
 * @param {Array<{date:string, steps:number}>} list
 * @returns {boolean}
 */
function isEmptyTrend(list) {
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.every((it) => (Number(it && it.steps) || 0) === 0);
}

module.exports = { RANGES, selectRange, normalizeBars, isEmptyTrend };
