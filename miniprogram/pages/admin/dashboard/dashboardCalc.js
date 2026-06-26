/**
 * 后台数据看板页前端纯函数（对齐 PRD F8 R8.5，开发计划阶段 H2）。
 *
 * 把参与率格式化、日活趋势柱高归一化、看板空态判定抽成纯函数，
 * 便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 入参仅消费后端 admin.dashboard 下发的非敏感字段
 *（participated / whitelistTotal / rate / totalSteps / avgSteps /
 *  validParticipants / dailyActive / deptRank），不下发 _openid / phone / sync_count。
 *
 * 柱状图渲染为纯 CSS（百分比高度），不引任何图表库（照 homeTrend.normalizeBars 思路）。
 */

/**
 * 格式化参与率为百分比文案（F8：参与人数 / 白名单总数）。
 * 入参 rate 为 0~1 小数（后端 buildDashboard 输出 participated/whitelistTotal）。
 * - 非数字 / NaN / Infinity → '0%'
 * - 负数 → '0%'（兜底）
 * - >1 → '100%'（兜底，理论上不应出现）
 * - 否则四舍五入取整百分比。
 * @param {number} rate 0~1
 * @returns {string} 如 '42%'
 */
function formatRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n >= 1) return '100%';
  return Math.round(n * 100) + '%';
}

/**
 * 日活趋势柱高归一化（F8：每日有同步行为的用户数趋势）。
 * 入参为后端 buildDashboard.dailyActive（[{date, count}]），返回带 heightPct 的副本数组。
 * - 最大 count → 100% 高度；全 0 时给统一最小高度（1）避免柱状图塌陷（照 homeTrend.normalizeBars）。
 * - 非数组 / 空数组 → 空数组。
 * @param {Array<{date:string, count:number}>} list
 * @returns {Array<{date:string, count:number, heightPct:number}>}
 */
function normalizeDailyActive(list) {
  const arr = Array.isArray(list) ? list : [];
  const max = arr.reduce((m, it) => {
    const c = Number(it && it.count) || 0;
    return c > m ? c : m;
  }, 0);
  return arr.map((it) => {
    const count = Number(it && it.count) || 0;
    const heightPct = max > 0 ? Math.round((count / max) * 100) : 1;
    return { date: (it && it.date) || '', count, heightPct };
  });
}

/**
 * 看板空态判定：核心指标全 0 → true（无任何数据时占位）。
 * 用于决定是否展示「暂无数据」占位（与后端返回结构对齐）。
 * @param {object} metrics buildDashboard 输出（participated/whitelistTotal/totalSteps/validParticipants/...）
 * @returns {boolean}
 */
function isEmptyDashboard(metrics) {
  const m = metrics || {};
  const participated = Number(m.participated) || 0;
  const whitelistTotal = Number(m.whitelistTotal) || 0;
  const totalSteps = Number(m.totalSteps) || 0;
  const validParticipants = Number(m.validParticipants) || 0;
  // 部门榜为空也算无数据。
  const deptRankEmpty = !Array.isArray(m.deptRank) || m.deptRank.length === 0;
  return (
    participated === 0 &&
    whitelistTotal === 0 &&
    totalSteps === 0 &&
    validParticipants === 0 &&
    deptRankEmpty
  );
}

module.exports = { formatRate, normalizeDailyActive, isEmptyDashboard };
