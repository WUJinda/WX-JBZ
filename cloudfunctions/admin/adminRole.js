/**
 * admin.setAdminRole 纯函数（PRD F8，管理员任命/撤销管理员）。
 *
 * 职责：
 *   - 校验目标 userId 存在于 store.User（否则 AUTH_USER_NOT_FOUND）。
 *   - 禁止自我降级：caller 不能把自己的 is_admin 设为 false
 *     （防管理员误操作把自己降级后无人可管）。判定依据：目标 user._openid === callerOpenid。
 *   - 就地改 store.User 对应文档的 is_admin + updated_at=now。
 *   - 幂等：已是目标状态则不改 updated_at，视为成功（与 changeUserDept 同口径）。
 *
 * 红线：
 *   - 管理员鉴权由 handler 经 assertAdmin 承担，本纯函数不做鉴权；
 *   - 身份仅 OPENID（callerOpenid 仅用于自我降级判定，与全链一致防越权）；
 *   - 不 require wx-server-sdk（云轨写回在 handler 层）。
 *
 * 本地轨：store 注入式，纯函数可单测。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 任命/撤销管理员。
 * @param {object} store mock db（{ User: object[] }）
 * @param {object} params
 * @param {string} params.userId 目标用户 id（User._id）
 * @param {boolean} params.isAdmin true=任命为管理员，false=撤销
 * @param {string} params.callerOpenid 调用者 openid（assertAdmin 已校验为管理员；用于自我降级判定）
 * @param {string} params.now 当前时间 ISO
 * @returns {{userId: string, isAdmin: boolean, updatedAt: string}}
 */
function setAdminRole(store, params) {
  const p = params || {};
  const { userId, isAdmin, callerOpenid, now } = p;

  if (!userId) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'setAdminRole: userId required');
  }
  if (typeof isAdmin !== 'boolean') {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'setAdminRole: isAdmin (boolean) required');
  }
  if (!store || !Array.isArray(store.User)) {
    throw BizError(CODE.SYS_DB_ERROR, 'setAdminRole: store.User is required');
  }

  const user = store.User.find((u) => u && u._id === userId);
  if (!user) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'setAdminRole: user not found');
  }

  // 禁止自我降级：caller 不能取消自己的管理员身份（防误操作后无人可管）。
  // caller 身份已由 handler 的 assertAdmin 校验为管理员；这里只拦「降自己」。
  if (isAdmin === false && user._openid && user._openid === callerOpenid) {
    throw BizError(CODE.BIZ_SELF_DEMOTE_FORBIDDEN, 'setAdminRole: 不能取消自己的管理员身份');
  }

  // 幂等：已是目标状态 → 不改 updated_at，视为成功。
  let updatedAt = user.updated_at;
  if (user.is_admin !== isAdmin) {
    user.is_admin = isAdmin;
    user.updated_at = now;
    updatedAt = now;
  }

  return { userId, isAdmin, updatedAt };
}

module.exports = { setAdminRole };
