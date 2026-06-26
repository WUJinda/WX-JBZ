/**
 * admin.changeUserDept 纯函数（对齐技术架构 §122，PRD F8 R8.3 修改用户部门）。
 *
 * 职责：
 *   - 校验 userId 存在于 store.User（否则 AUTH_USER_NOT_FOUND）。
 *   - 校验 deptId 存在于 store.Department（否则 BIZ_DEPT_NOT_FOUND）。
 *   - 更新目标 User.dept_id + updated_at=now；返回 { userId, deptId, updatedAt }。
 *   - 幂等：已是该部门则不改 updated_at（视为成功），自洽。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 修改用户部门。
 * @param {object} store mock db（{ User: object[], Department: object[] }）
 * @param {object} params
 * @param {string} params.userId 目标用户 id（User._id）
 * @param {string} params.deptId 目标部门 id（Department.dept_id）
 * @param {string} params.now 当前时间 ISO
 * @returns {{userId: string, deptId: string, updatedAt: string}}
 */
function changeUserDept(store, params) {
  const p = params || {};
  const { userId, deptId, now } = p;

  if (!userId) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'changeUserDept: userId required');
  }
  if (!deptId) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'changeUserDept: deptId required');
  }
  if (!store || !Array.isArray(store.User)) {
    throw BizError(CODE.SYS_DB_ERROR, 'changeUserDept: store.User is required');
  }
  if (!Array.isArray(store.Department)) {
    throw BizError(CODE.SYS_DB_ERROR, 'changeUserDept: store.Department is required');
  }

  const user = store.User.find((u) => u && u._id === userId);
  if (!user) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'changeUserDept: user not found');
  }

  const dept = store.Department.find((d) => d && d.dept_id === deptId);
  if (!dept) {
    throw BizError(CODE.BIZ_DEPT_NOT_FOUND, 'changeUserDept: dept not found');
  }

  // 幂等：已是该部门 → 不改 updated_at，视为成功。
  let updatedAt = user.updated_at;
  if (user.dept_id !== deptId) {
    user.dept_id = deptId;
    user.updated_at = now;
    updatedAt = now;
  }

  return { userId, deptId, updatedAt };
}

module.exports = { changeUserDept };
