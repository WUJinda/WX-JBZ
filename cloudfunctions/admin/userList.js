/**
 * admin.queryUsers 纯函数（对齐技术架构 §122，PRD F8 用户管理）。
 *
 * 职责：从 store.User 筛选（deptId 等值；keyword 模糊匹配 nickname/invite_code，大小写不敏感）+ 本地分页。
 *   - projectUser 下发白名单字段：nickname/avatar/invite_code/dept_id/join_status/joined_at/created_at/is_admin。
 *   - 绝不下发 _openid（红线，逐字段白名单）。
 *   - DEFAULT_PAGE_SIZE=50。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const DEFAULT_PAGE_SIZE = 50;

// 投影白名单：逐字段枚举，绝不下发 _openid。
const USER_FIELDS = [
  '_id',
  'nickname',
  'avatar',
  'invite_code',
  'dept_id',
  'join_status',
  'joined_at',
  'created_at',
  'is_admin' // 后台需显示角色 + 提供任命/撤销入口（admin.setAdmin）；非敏感字段
];

/**
 * 用户投影：仅下发白名单字段（红线：绝不下发 _openid）。
 * @param {object} u
 * @returns {object}
 */
function projectUser(u) {
  const r = u || {};
  const out = {};
  for (const k of USER_FIELDS) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  return out;
}

/**
 * 查询用户列表（筛选 + 本地分页）。
 * @param {object} store mock db（{ User: object[] }）
 * @param {object} params
 * @param {string} [params.activityId] 活动 id（P0 单期，预留；暂不强过滤）
 * @param {string} [params.deptId] 部门 id 等值过滤
 * @param {string} [params.keyword] 关键字模糊匹配 nickname / invite_code（大小写不敏感）
 * @param {number} [params.page=1] 页码（从 1 起）
 * @param {number} [params.pageSize=50] 每页条数
 * @returns {{list: object[], totalCount: number}}
 */
function queryUsers(store, params) {
  const p = params || {};
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || DEFAULT_PAGE_SIZE);

  const users = (store && Array.isArray(store.User)) ? store.User : [];

  let filtered = users.filter((u) => u && u._id);

  // deptId 等值过滤。
  if (p.deptId) {
    filtered = filtered.filter((u) => u.dept_id === p.deptId);
  }

  // keyword 模糊匹配 nickname / invite_code（大小写不敏感）。
  if (p.keyword) {
    const kw = String(p.keyword).toLowerCase();
    filtered = filtered.filter((u) => {
      const nick = (u.nickname || '').toLowerCase();
      const code = (u.invite_code || '').toLowerCase();
      return nick.indexOf(kw) >= 0 || code.indexOf(kw) >= 0;
    });
  }

  const totalCount = filtered.length;

  // 分页。
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);
  const list = slice.map(projectUser);

  return { list, totalCount };
}

module.exports = { queryUsers, projectUser, DEFAULT_PAGE_SIZE };
