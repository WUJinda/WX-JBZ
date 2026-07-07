/**
 * user.join 业务纯函数（对齐技术架构 §4.1/§5.1/§6.1，开发计划阶段 D1，PRD F2）。
 *
 * 业务规则（PRD F2）：
 *   - R2.1 部门即团队，选部门即自动归属该部门队伍，无独立"创建/加入团队"操作；
 *   - R2.2 一个员工仅归属一个部门；报名后部门不可自行更改（已 joined 拒绝任何 join）；
 *   - R1.4 防重复报名：同 openid 已 joined 再次 join → 拒绝。
 *
 * 前置条件（join 假设，由 handler/前置流程保证）：
 *   - 用户已通过 auth.phone 白名单验证（登录态）；join 不再校验白名单；
 *   - handler 已 requireUser（必须 OPENID，登录态），与 activity.current 游客通道不同。
 *
 * 本地轨：store/user/deptId 注入式，纯函数可单测；不调真实微信云 API。
 * joinDepartment 负责业务判定 + 直接更新注入 store 中的 User 文档（单测观察 store 验证落库结果）。
 *
 * 红线：
 *   - 身份仅 OPENID；不下发原始 phone / openid / unionid；
 *   - 报名后不可自改（已 joined 拒绝任何 join，含同/不同 dept_id）。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 校验部门存在（入参 dept_id 必须在部门源中）。
 * @param {string} deptId
 * @param {object[]} depts 部门源（{dept_id, name, ...}）
 * @returns {object|null} 命中的部门，否则 null
 */
function findDept(deptId, depts) {
  if (!deptId || !Array.isArray(depts)) return null;
  return depts.find((d) => d && d.dept_id === deptId) || null;
}

/**
 * join 结果下发投影（脱敏，不下发敏感字段）。
 * @param {object} user 更新后的 User 文档
 * @param {object} dept 命中的部门（用于补 dept_name）
 * @returns {object} { join_status, dept_id, dept_name, joined_at }
 */
function projectJoinResult(user, dept) {
  const u = user || {};
  return {
    join_status: u.join_status || 'pending',
    dept_id: u.dept_id || null,
    dept_name: (dept && dept.name) || '',
    joined_at: u.joined_at || null
  };
}

/**
 * join 主逻辑（纯函数 + 注入式 store）。
 *
 * 校验 + 更新注入 store 中的 User 文档（单测通过观察 store 验证落库）。
 *
 * @param {object} params
 * @param {object} params.store mock db 的 store 引用（{ User: object[], Department?: object[] }）
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {string} params.deptId 报名目标部门 dept_id
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @param {Date|number|string} [params.signupDeadline] 报名截止（handler 算好的 effective = activity.signup_deadline ?? end_time；缺省不校验）
 * @returns {Promise<object>} projectJoinResult 结果
 * @throws {BizError} openid/deptId 缺失、部门不存在、用户不存在、已报名拒绝、报名已截止
 */
async function joinDepartment(params) {
  const { store, openid, deptId, now, signupDeadline } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'join: openid required');
  }
  if (!deptId || typeof deptId !== 'string') {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'join: dept_id required');
  }
  if (!store || !Array.isArray(store.User)) {
    throw BizError(CODE.SYS_DB_ERROR, 'join: store.User is required');
  }

  // F5：部门源用注入的 Department（handler 查真实集合）；不再回退 MOCK_DEPARTMENTS——
  //   避免管理员未录部门时用户 join 到假部门。空数组时 findDept 返回 null → 抛 BIZ_DEPT_NOT_FOUND。
  const depts = Array.isArray(store.Department) ? store.Department : [];
  const dept = findDept(deptId, depts);
  if (!dept) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'join: dept not found');
  }

  // 取当前用户（同 openid）
  const user = store.User.find((u) => u && u._openid === openid);
  if (!user) {
    // 理论上 requireUser 已挡住；此处兜底（不暴露 openid 是否存在）
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'join: user not found');
  }

  // R1.4 / R2.2：已报名不可自改 + 防重复（无论同/不同 dept_id 一律拒绝）
  if (user.join_status === 'joined') {
    throw BizError(
      CODE.AUTH_JOIN_STATUS_DENIED,
      '已报名，部门不可自行修改，如需调整联系管理员'
    );
  }

  // 报名截止校验（仅对新报名；已报名在上一步已拒）：
  // signupDeadline 由 handler 算好传入 = activity.signup_deadline ?? activity.end_time
  // （不填 signup_deadline = 活动结束前都可报名）。缺省/活动缺失 → 不校验（不阻断报名）。
  if (signupDeadline !== undefined && signupDeadline !== null && signupDeadline !== '') {
    const dlTs = signupDeadline instanceof Date ? signupDeadline.getTime() : Date.parse(signupDeadline);
    const curTs = (now instanceof Date ? now : new Date()).getTime();
    if (Number.isFinite(dlTs) && curTs > dlTs) {
      throw BizError(CODE.BIZ_SIGNUP_ENDED, '报名已截止');
    }
  }

  // 正常报名：pending → joined（直接更新注入 store 中的引用对象，便于单测观察）
  const ts = (now instanceof Date ? now : new Date()).toISOString();
  user.dept_id = deptId;
  user.join_status = 'joined';
  user.joined_at = ts;
  if (typeof user.updated_at !== 'undefined') user.updated_at = ts;

  return projectJoinResult(user, dept);
}

module.exports = { joinDepartment, findDept, projectJoinResult };
