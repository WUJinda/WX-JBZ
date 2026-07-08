/**
 * user.join 业务纯函数（纯报名，与选部门解耦）。
 *
 * 业务规则（2026-07-08 解耦后，对齐技术架构 §4.1/§5.1/§6.1，PRD F2）：
 *   - join 只负责报名状态变更 join_status: pending → joined（写 join_status/joined_at），
 *     不要求、不写入 dept_id；部门由 user.chooseDept 在注册向导独立选定（固定不可换）。
 *   - R1.4 防重复报名：同 openid 已 joined 再次 join → 拒绝（无论 dept_id）。
 *
 * 前置条件（join 假设，由 handler/前置流程保证）：
 *   - 用户已通过 auth.phone 白名单验证（登录态）；join 不再校验白名单；
 *   - handler 已 requireUser（必须 OPENID，登录态）。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实微信云 API。
 * joinDepartment 负责业务判定 + 直接更新注入 store 中的 User 文档（单测观察 store 验证落库结果）。
 *
 * 红线：
 *   - 身份仅 OPENID；不下发原始 phone / openid / unionid；
 *   - 防重复报名（已 joined 再次 join 一律拒绝）。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 校验部门存在（供 user.chooseDept 复用）。
 * @param {string} deptId
 * @param {object[]} depts 部门源（{dept_id, name, ...}）
 * @returns {object|null} 命中的部门，否则 null
 */
function findDept(deptId, depts) {
  if (!deptId || !Array.isArray(depts)) return null;
  return depts.find((d) => d && d.dept_id === deptId) || null;
}

/**
 * join 结果投影（脱敏，不下发敏感字段）。
 * 注：join 不碰部门，dept_id/dept_name 透传 user 已有值（部门由 chooseDept 设）。
 * @param {object} user 更新后的 User 文档
 * @returns {object} { join_status, dept_id, dept_name, joined_at }
 */
function projectJoinResult(user) {
  const u = user || {};
  return {
    join_status: u.join_status || 'pending',
    dept_id: u.dept_id || null,
    dept_name: u.dept_name || '',
    joined_at: u.joined_at || null
  };
}

/**
 * join 主逻辑（纯函数 + 注入式 store）—— 纯报名，不依赖部门。
 *
 * 校验 + 更新注入 store 中的 User 文档（单测通过观察 store 验证落库）。
 *
 * @param {object} params
 * @param {object} params.store mock db 的 store 引用（{ User: object[] }）
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @param {Date|number|string} [params.signupDeadline] 报名截止（handler 算好的 effective = activity.signup_deadline ?? end_time；缺省不校验）
 * @param {boolean} [params.activityTerminated] 活动是否已手动终止（handler 从活动文档取 terminated；true→拒绝报名，与 steps.sync 终止拦截同码）
 * @returns {Promise<object>} projectJoinResult 结果
 * @throws {BizError} openid 缺失、用户不存在、已报名拒绝、活动已终止、报名已截止
 */
async function joinDepartment(params) {
  const { store, openid, now, signupDeadline, activityTerminated } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'join: openid required');
  }
  if (!store || !Array.isArray(store.User)) {
    throw BizError(CODE.SYS_DB_ERROR, 'join: store.User is required');
  }

  // 取当前用户（同 openid）
  const user = store.User.find((u) => u && u._openid === openid);
  if (!user) {
    // 理论上 requireUser 已挡住；此处兜底（不暴露 openid 是否存在）
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'join: user not found');
  }

  // R1.4：已报名不可重复（防重复报名；部门由 chooseDept 单独管，此处不涉及）。
  if (user.join_status === 'joined') {
    throw BizError(
      CODE.AUTH_JOIN_STATUS_DENIED,
      '已报名，无需重复报名'
    );
  }

  // 活动已手动终止（terminated 不可恢复）→ 拒绝新报名（与 steps.sync 终止拦截同码同语义）。
  // handler 从活动文档取 terminated 传入；缺省/活动查询失败 → 不校验（降级兼容，不阻断报名）。
  if (activityTerminated === true) {
    throw BizError(CODE.STEP_ACTIVITY_CLOSED, '活动已终止，无法报名');
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

  // 正常报名：pending → joined（只写报名状态，不写 dept_id；部门由 chooseDept 管）。
  const ts = (now instanceof Date ? now : new Date()).toISOString();
  user.join_status = 'joined';
  user.joined_at = ts;
  if (typeof user.updated_at !== 'undefined') user.updated_at = ts;

  return projectJoinResult(user);
}

module.exports = { joinDepartment, findDept, projectJoinResult };
