/**
 * 后台部门管理页前端纯函数（对齐 PRD F8 部门管理，开发计划阶段 H3）。
 *
 * 把部门名校验、部门展示格式化抽成纯函数，便于在 Node 下单测，不耦合 wx 运行时。
 *
 * 红线：
 *   - 入参仅消费后端 dept.list / admin.deptManage 下发的字段
 *     （dept_id/name/member_count），不下发 _openid / 任何敏感字段。
 *   - 不依赖 wx API、不调云函数（数据由 dept.js 拉取后传入）。
 */

/** 部门名最大长度（与后端 createDept 唯一性校验前端呼应，UI 层防超长）。 */
const MAX_DEPT_NAME_LEN = 30;

/**
 * 校验部门名：非空 + 长度上限。
 * @param {string} name 部门名
 * @returns {{valid:boolean, error:string}} valid=true 表示通过；error 为失败原因（valid=true 时为 ''）
 */
function validateDeptName(name) {
  if (name === null || name === undefined) {
    return { valid: false, error: '部门名不能为空' };
  }
  const s = String(name).trim();
  if (s === '') {
    return { valid: false, error: '部门名不能为空' };
  }
  if (s.length > MAX_DEPT_NAME_LEN) {
    return { valid: false, error: '部门名不超过 ' + MAX_DEPT_NAME_LEN + ' 字' };
  }
  return { valid: true, error: '' };
}

/**
 * 格式化部门展示（成员数文案）。
 * - 入参为 dept.list 下发的 {dept_id,name,member_count} → 返回 {dept_id, name, memberCountText}。
 * - 非对象 → 空对象兜底。
 * @param {object} dept
 * @returns {{dept_id:string, name:string, memberCountText:string}}
 */
function formatDept(dept) {
  const d = (dept && typeof dept === 'object') ? dept : {};
  const mc = Number(d.member_count);
  const cnt = Number.isFinite(mc) && mc >= 0 ? Math.floor(mc) : 0;
  return {
    dept_id: d.dept_id || '',
    name: d.name || '',
    memberCountText: cnt + ' 人'
  };
}

module.exports = { validateDeptName, formatDept, MAX_DEPT_NAME_LEN };
