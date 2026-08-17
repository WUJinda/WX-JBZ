/**
 * 后台数据看板页前端纯函数（对齐 PRD F8 R8.5，开发计划阶段 H2）。
 *
 * 把参与率格式化、看板空态判定抽成纯函数，
 * 便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 入参仅消费后端 admin.dashboard 下发的非敏感字段
 *（participated / inviteCodesTotal / rate / totalSteps / avgSteps /
 *  validParticipants），不下发 _openid / sync_count。
 */

/**
 * 格式化参与率为百分比文案（F8：已报名 / 已发码数）。
 * 入参 rate 为 0~1 小数（后端 buildDashboard 输出 participated/inviteCodesTotal）。
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
 * 看板空态判定：核心指标全 0 → true（无任何数据时占位）。
 * 用于决定是否展示「暂无数据」占位（与后端返回结构对齐）。
 * @param {object} metrics buildDashboard 输出（participated/inviteCodesTotal/totalSteps/validParticipants/...）
 * @returns {boolean}
 */
function isEmptyDashboard(metrics) {
  const m = metrics || {};
  const participated = Number(m.participated) || 0;
  const inviteCodesTotal = Number(m.inviteCodesTotal) || 0;
  const totalSteps = Number(m.totalSteps) || 0;
  const validParticipants = Number(m.validParticipants) || 0;
  return (
    participated === 0 &&
    inviteCodesTotal === 0 &&
    totalSteps === 0 &&
    validParticipants === 0
  );
}

module.exports = { formatRate, isEmptyDashboard };
