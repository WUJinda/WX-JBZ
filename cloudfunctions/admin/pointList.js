/**
 * admin.queryPoints 纯函数（积分台账列表查询，对齐 userList.queryUsers 范式）。
 *
 * 职责：从 store.User 筛选（deptId 等值；keyword 模糊匹配 nickname，大小写不敏感）
 *   → 【按积分降序排序（第一优先级，2026-08-17 需求；同分按 total_steps 降序、_id 升序稳定兜底）】
 *   → 本地分页；join dept_name（Department）+ total_steps（RankCache personal rows 的 user_id→total_steps，辅助展示）。
 *
 * 红线：
 *   - 投影白名单 POINT_USER_FIELDS 逐字段枚举，绝不下发 _openid / phone / sync_count。
 *   - 数组白名单形式可过 grep 红线（敏感字段均以数组元素形式存在，无对象字面量赋值，故红线正则不命中）。
 *   - 不脱敏昵称（admin 后台管理员可见，与 userList 一致）。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const DEFAULT_PAGE_SIZE = 50;

// 投影白名单：逐字段枚举，绝不下发 _openid / phone / sync_count。
const POINT_USER_FIELDS = ['_id', 'nickname', 'real_name', 'dept_id', 'points'];

/**
 * 积分台账用户投影：白名单字段 + join dept_name + total_steps（辅助）。
 * @param {object} u
 * @param {string} deptName 部门名（由 queryPoints 从 Department join 后传入）
 * @param {number} totalSteps 累计步数（由 queryPoints 从 RankCache personal join 后传入；缺省 0）
 * @returns {object}
 */
function projectPointUser(u, deptName, totalSteps) {
  const r = u || {};
  const out = {};
  for (const k of POINT_USER_FIELDS) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  // points 兜底为数字（旧用户无字段时显示 0，台账核心字段不宜 undefined）。
  if (typeof out.points !== 'number') out.points = 0;
  out.dept_name = deptName || '';
  out.total_steps = typeof totalSteps === 'number' && totalSteps >= 0 ? totalSteps : 0;
  return out;
}

/**
 * 查询积分台账列表（筛选 + 本地分页 + join dept_name/total_steps）。
 * @param {object} store mock db（{ User, Department?, RankCache? }）
 * @param {object} params
 * @param {string} [params.activityId] 活动 id（RankCache 按 activity_id 过滤；User 无 activity_id 故不强过滤）
 * @param {string} [params.deptId] 部门 id 等值过滤
 * @param {string} [params.keyword] 关键字模糊匹配 nickname（大小写不敏感）
 * @param {number} [params.page=1] 页码（从 1 起）
 * @param {number} [params.pageSize=50] 每页条数
 * @returns {{list: object[], totalCount: number}}
 *   list 每项: { _id, nickname, dept_id, points, dept_name, total_steps }
 *   排序（筛选后、分页前）：points 数值降序 → 同分 total_steps 降序 → 再同 _id 升序（确定性兜底）。
 */
function queryPoints(store, params) {
  const p = params || {};
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || DEFAULT_PAGE_SIZE);

  const users = (store && Array.isArray(store.User)) ? store.User : [];

  // dept_name 映射：dept_id → name。
  const deptNameMap = new Map();
  (store && Array.isArray(store.Department) ? store.Department : []).forEach((d) => {
    if (d && d.dept_id) deptNameMap.set(d.dept_id, d.name || '');
  });

  // total_steps 映射：openid(=RankCache personal rows 的 user_id) → total_steps。
  const stepsMap = new Map();
  if (store && Array.isArray(store.RankCache)) {
    const personalDoc = store.RankCache.find(
      (d) => d && d.type === 'personal' && (!p.activityId || d.activity_id === p.activityId)
    );
    const rows = (personalDoc && Array.isArray(personalDoc.rows)) ? personalDoc.rows : [];
    rows.forEach((row) => {
      if (row && row.user_id) stepsMap.set(row.user_id, Number(row.total_steps) || 0);
    });
  }

  let filtered = users.filter((u) => u && u._id);

  // deptId 等值过滤。
  if (p.deptId) {
    filtered = filtered.filter((u) => u.dept_id === p.deptId);
  }

  // keyword 模糊匹配 nickname（大小写不敏感）。
  if (p.keyword) {
    const kw = String(p.keyword).toLowerCase();
    filtered = filtered.filter((u) => (u.nickname || '').toLowerCase().indexOf(kw) >= 0);
  }

  const totalCount = filtered.length;

  // 排序（2026-08-17 需求：积分降序为第一优先级，替代原先的 User 插入序）：
  //   1) points 数值降序（旧用户无字段兜底 0，与 projectPointUser 口径一致；负分自然排在末尾）；
  //   2) 同分 → total_steps 降序（步数多者靠前，同分多劳优先展示）；
  //   3) 再同 → _id 升序（确定性兜底，避免同分同步数时列表顺序漂移）。
  // filtered 是 filter 产生的新数组，就地 sort 不影响 store.User。
  const pointOf = (u) => Number(u.points) || 0;
  const stepsOf = (u) => stepsMap.get(u._openid) || 0;
  filtered.sort((a, b) => {
    const d = pointOf(b) - pointOf(a);
    if (d !== 0) return d;
    const s = stepsOf(b) - stepsOf(a);
    if (s !== 0) return s;
    return String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0;
  });

  // 分页。
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);
  const list = slice.map((u) =>
    projectPointUser(u, deptNameMap.get(u.dept_id), stepsMap.get(u._openid))
  );

  return { list, totalCount };
}

module.exports = { queryPoints, projectPointUser, POINT_USER_FIELDS, DEFAULT_PAGE_SIZE };
