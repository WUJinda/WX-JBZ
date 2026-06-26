/**
 * admin.assertAdmin 纯函数（对齐技术架构 §152，PRD F8 管理员守卫）。
 *
 * 职责：按 openid 查 store.User，确认存在且 is_admin===true，否则抛 AUTH_NOT_ADMIN。
 * 红线：身份仅 OPENID；admin 守卫是 admin 专属，不改 authMiddleware 通用骨架。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 断言调用者为管理员。
 * @param {object} store mock db（{ User: object[] }）
 * @param {string} openid 调用者 openid（来自 cloud.getWXContext().OPENID）
 * @returns {object} 命中的 user 文档
 * @throws {BizError} openid 缺失 → AUTH_NO_OPENID；无对应用户 → AUTH_USER_NOT_FOUND；非 admin → AUTH_NOT_ADMIN
 */
function assertAdmin(store, openid) {
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'assertAdmin: openid required');
  }
  const users = (store && Array.isArray(store.User)) ? store.User : [];
  const user = users.find((u) => u && u._openid === openid);
  if (!user) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'assertAdmin: user not found for openid');
  }
  if (user.is_admin !== true) {
    throw BizError(CODE.AUTH_NOT_ADMIN, 'assertAdmin: caller is not admin');
  }
  return user;
}

module.exports = { assertAdmin };
