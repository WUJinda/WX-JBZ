/**
 * 后台用户管理页前端纯函数（对齐 PRD F8 R8.3，开发计划阶段 H3）。
 *
 * 把部门选项构造、报名状态格式化抽成纯函数，
 * 便于在 Node 下单测，不耦合 wx 运行时。
 * 分页 hasMore 判定已抽到公共 utils/pagination.js，本页直接复用。
 *
 * 红线：
 *   - 入参仅消费后端 admin.users / dept.list 下发的脱敏字段
 *     （dept_id/name/phone_masked/join_status 等），不下发 _openid / 完整 phone。
 *   - 不依赖 wx API、不调云函数（数据由 users.js 拉取后传入）。
 */

const { hasMore } = require('../../../utils/pagination');

const DEFAULT_PAGE_SIZE = 50;

/**
 * 从 dept.list 返回的部门列表构造筛选/改部门 picker 选项（提取 {dept_id, name}）。
 * 入参为 dept.list 下发的 {list:[{dept_id,name,member_count}]} 或数组。
 * - 非数组 / 空 → 空数组。
 * - 仅摘取 dept_id/name（picker 不需要 member_count）。
 * @param {object|Array} deptListOrRes
 * @returns {Array<{dept_id:string, name:string}>}
 */
function buildDeptOptions(deptListOrRes) {
  const arr = Array.isArray(deptListOrRes)
    ? deptListOrRes
    : (deptListOrRes && Array.isArray(deptListOrRes.list) ? deptListOrRes.list : []);
  return arr
    .map((d) => (d && typeof d === 'object' ? { dept_id: d.dept_id || '', name: d.name || '' } : null))
    .filter((d) => d && d.dept_id);
}

/**
 * 格式化报名状态文案（join_status：joined/quit/pending 等）。
 * - joined → 已报名
 * - quit → 已退出
 * - pending → 待报名
 * - 其它/空 → 未报名
 * @param {string} status
 * @returns {string}
 */
function formatJoinStatus(status) {
  if (status === 'joined') return '已报名';
  if (status === 'quit') return '已退出';
  if (status === 'pending') return '待报名';
  return '未报名';
}

module.exports = { buildDeptOptions, hasMore, formatJoinStatus, DEFAULT_PAGE_SIZE };
