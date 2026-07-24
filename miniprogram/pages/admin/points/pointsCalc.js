/**
 * 后台积分台账页前端纯函数（积分规则 + 台账展示）。
 *
 * 把部门选项构造、积分格式化抽成纯函数，便于在 Node 下单测，不耦合 wx 运行时。
 * 分页 hasMore 判定复用公共 utils/pagination.js。
 *
 * 红线：
 *   - 入参仅消费后端 admin.points / dept.list 下发的字段（dept_id/name/points/total_steps），
 *     不下发 _openid / 完整 phone / sync_count。
 *   - 不依赖 wx API、不调云函数（数据由 points.js 拉取后传入）。
 */

const { hasMore } = require('../../../utils/pagination');

const DEFAULT_PAGE_SIZE = 50;

/**
 * 从 dept.list 返回的部门列表构造筛选 picker 选项（提取 {dept_id, name}）。
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
 * 格式化积分展示（带「分」单位；负数前缀「-」）。
 * @param {number} points
 * @returns {string}
 */
function formatPoints(points) {
  const n = Number(points) || 0;
  return (n < 0 ? '-' : '') + Math.abs(n) + ' 分';
}

module.exports = { buildDeptOptions, hasMore, formatPoints, DEFAULT_PAGE_SIZE };
