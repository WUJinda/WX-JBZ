/**
 * user.chooseDept 业务纯函数（报名/选部门解耦后，注册向导选部门）。
 *
 * 业务规则（2026-07-08 解耦，用户确认）：
 *   - 选部门与报名活动拆成两个独立动作：本 action 只写 dept_id，不碰 join_status；
 *     报名（join_status→joined）由 user.join 在活动页独立触发。
 *   - 部门在注册向导选定，选完固定不可换：已选过不同部门 → 拒绝；同部门幂等成功。
 *
 * 参考 admin/changeDept.js 范式（校验 + 改 store 引用 + 返回投影），但按 _openid 查
 * （user 域约定：join/update/setPhone/profile 均按 _openid 键），且仅未选/同部门时可设。
 *
 * 红线：身份仅 OPENID；不下发原始 phone / openid / unionid。
 */

const { CODE, BizError } = require('../common/errors');
const { findDept } = require('./userJoin');

/**
 * chooseDept 结果投影（脱敏）。
 * @param {object} user 更新后的 User 文档
 * @param {object} dept 命中的部门（用于补 dept_name）
 * @returns {{dept_id, dept_name, join_status, updated_at}}
 */
function projectChooseDeptResult(user, dept) {
  const u = user || {};
  return {
    dept_id: u.dept_id || null,
    dept_name: (dept && dept.name) || '',
    join_status: u.join_status || 'pending',
    updated_at: u.updated_at || null
  };
}

/**
 * chooseDept 主逻辑（纯函数 + 注入式 store，同步）。
 *
 * 校验 + 直接更新注入 store 中的 User 文档（单测通过观察 store 验证落库）。
 *
 * @param {object} params
 * @param {object} params.store mock db（{ User: object[], Department?: object[] }）
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {string} params.deptId 目标部门 dept_id
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @returns {object} projectChooseDeptResult 结果
 * @throws {BizError} openid/deptId 缺失、部门不存在、用户不存在、部门已选定不可换
 */
function chooseDepartment(params) {
  const { store, openid, deptId, now } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'chooseDept: openid required');
  }
  if (!deptId || typeof deptId !== 'string') {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'chooseDept: dept_id required');
  }
  if (!store || !Array.isArray(store.User)) {
    throw BizError(CODE.SYS_DB_ERROR, 'chooseDept: store.User is required');
  }

  // 部门源用注入的 Department（handler 查真实集合）；空数组时 findDept 返回 null → 抛 BIZ_DEPT_NOT_FOUND。
  const depts = Array.isArray(store.Department) ? store.Department : [];
  const dept = findDept(deptId, depts);
  if (!dept) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'chooseDept: dept not found');
  }

  // 取当前用户（同 openid）。
  const user = store.User.find((u) => u && u._openid === openid);
  if (!user) {
    // 理论上 requireUser 已挡住；此处兜底（不暴露 openid 是否存在）。
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'chooseDept: user not found');
  }

  // 部门已选定不可换：已选不同部门 → 拒绝；同部门 → 幂等成功（不改 updated_at）。
  if (user.dept_id && user.dept_id !== deptId) {
    throw BizError(
      CODE.AUTH_JOIN_STATUS_DENIED,
      '部门已选定，不可更换，如需调整联系管理员'
    );
  }

  // 设部门（首次选择）。幂等：已是该部门则不改 updated_at，视为成功。
  if (user.dept_id !== deptId) {
    const ts = (now instanceof Date ? now : new Date()).toISOString();
    user.dept_id = deptId;
    if (typeof user.updated_at !== 'undefined') user.updated_at = ts;
  }

  return projectChooseDeptResult(user, dept);
}

module.exports = { chooseDepartment, projectChooseDeptResult };
