/**
 * admin.assertAdmin 共享守卫（对齐技术架构 §152，PRD F8 管理员守卫）。
 *
 * 职责：按 openid 查 store.User，确认存在且 is_admin===true，否则抛对应鉴权错。
 * 红线：身份仅 OPENID；admin 守卫是管理员专属，不改 authMiddleware 通用骨架。
 *
 * 解耦：本模块不 require wx-server-sdk，纯函数 store 注入式可单测。
 * 多云函数（admin / activity）经「跨云函数 require common」范式共享此守卫。
 *
 * 历史：原实现位于 admin/adminGuard.js，现提取到 common 供 activity.save 复用；
 * admin/adminGuard.js 改为 re-export 本模块，保持既有 require 路径与测试不变。
 */

const { CODE, BizError } = require('./errors');

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
