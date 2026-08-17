/**
 * 主页趋势图前端纯函数（对齐 PRD F4 R4.2/R4.3，开发计划阶段 F4）。
 *
 * 把趋势区间切换、柱高归一化、空态判定抽成纯函数，便于在 Node 下单测，
 * 不耦合 wx 运行时。柱状图渲染为纯 CSS（百分比高度），不引任何图表库。
 */

/** 默认短期区间（天）。 */
const SHORT_RANGE = 7;

/** 每根柱（含日期文字）的最小宽度（rpx）——与 home.wxss .trend-bar-wrap 的 flex-basis 对齐。 */
const BAR_MIN_WIDTH_RPX = 60;

/** trend-bars 可视区宽度（rpx）：750 屏幕 − home-page 左右 padding 32×2 − trend-block 左右 padding 24×2 = 638。 */
const SCROLL_THRESHOLD_RPX = 638;

/**
 * 日期格式化（去年份）：YYYY-MM-DD → M.D（如 "2026-08-01" → "8.1"）。
 * 趋势图横坐标空间有限，去掉年份避免 30 天柱状图日期文字撑爆容器。
 *
 * @param {string} dateStr YYYY-MM-DD 格式
 * @returns {string} M.D 格式；入参异常时原样返回
 */
function formatDateLabel(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  var parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  var month = parseInt(parts[1], 10);
  var day = parseInt(parts[2], 10);
  if (!month || !day) return dateStr;
  return month + '.' + day;
}

/**
 * 根据数据条数计算 trend-bars 容器宽度。
 * 条数少（如 7 天）时返回 100% 让 flex 等分填满容器；
 * 条数多（如 30 天）时返回固定 rpx 宽度，使外层 scroll-view 可左右滑动。
 *
 * @param {number} count 数据条数
 * @returns {string} CSS width 值（"100%" 或 "Nrpx"）
 */
function computeBarsWidth(count) {
  var n = Number(count) || 0;
  if (n === 0) return '100%';
  var need = n * BAR_MIN_WIDTH_RPX;
  return need > SCROLL_THRESHOLD_RPX ? need + 'rpx' : '100%';
}

/**
 * 根据活动 start_time / end_time 计算活动持续总天数（含首尾）。
 * 如 8/1~8/15 → 15 天。返回 0 表示无法计算（缺时间或缺一端）。
 *
 * @param {object} activity globalData.currentActivity（含 start_time / end_time ISO 字符串）
 * @returns {number} 总天数（≥0）；0 = 无法计算
 */
function computeActivityDays(activity) {
  var a = activity || {};
  if (!a.start_time || !a.end_time) return 0;
  var startMs = Date.parse(a.start_time);
  var endMs = Date.parse(a.end_time);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  if (endMs < startMs) return 0;
  // 向上取整含首尾：如 8/1 00:00 ~ 8/15 23:59 = 14.99 天 → 15 天
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

/**
 * 校正 range：接受任意 ≥1 正整数，缺省/非法 → SHORT_RANGE(7)。
 * @param {*} range
 * @param {number} [def=7]
 * @returns {number}
 */
function selectRange(range, def) {
  var n = Math.floor(Number(range));
  if (n >= 1) return n;
  return Math.floor(Number(def)) >= 1 ? Math.floor(Number(def)) : SHORT_RANGE;
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
    const date = (it && it.date) || '';
    return { date, steps, heightPct, dateLabel: formatDateLabel(date) };
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

module.exports = { SHORT_RANGE, selectRange, normalizeBars, isEmptyTrend, formatDateLabel, computeBarsWidth, computeActivityDays };
