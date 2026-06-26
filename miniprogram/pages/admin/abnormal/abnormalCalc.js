/**
 * 后台异常裁定页前端纯函数（对齐 PRD F8 R8.4，开发计划阶段 H3）。
 *
 * 把裁定文案、步数格式化、分页 hasMore 判定抽成纯函数，
 * 便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 红线：
 *   - 入参仅消费后端 admin.abnormalList 下发的白名单字段
 *     （user_id/date/steps/synced_at/abnormal/locked），不下发 _openid / sync_count。
 *   - 不依赖 wx API、不调云函数（数据由 abnormal.js 拉取后传入）。
 */

const DEFAULT_PAGE_SIZE = 50;

/**
 * 分页 hasMore 判定：本次返回条数 < pageSize → 还有更多（照 rankCalc 口径）。
 * @param {number} returnedCount 本次返回条数
 * @param {number} pageSize 每页条数
 * @returns {boolean}
 */
function hasMore(returnedCount, pageSize) {
  const cnt = Number(returnedCount) || 0;
  const size = Number(pageSize);
  const ps = !Number.isFinite(size) || size < 1 ? DEFAULT_PAGE_SIZE : Math.floor(size);
  return cnt >= ps;
}

/**
 * 裁定按钮文案（ignore/zero）。
 * - ignore → '忽略'
 * - zero → '置零'
 * - 其它/空 → '' （兜底，非法 action 不渲染按钮文案）
 * @param {string} action 'ignore' | 'zero'
 * @returns {string}
 */
function verdictLabel(action) {
  if (action === 'ignore') return '忽略';
  if (action === 'zero') return '置零';
  return '';
}

/**
 * 格式化步数展示（千分位 + 单位）。
 * - 非数字 → '0 步'
 * - 否则 → '12,345 步'
 * @param {number} steps
 * @returns {string}
 */
function formatSteps(steps) {
  const n = Number(steps);
  if (!Number.isFinite(n) || n <= 0) return '0 步';
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 步';
}

module.exports = { hasMore, verdictLabel, formatSteps, DEFAULT_PAGE_SIZE };
