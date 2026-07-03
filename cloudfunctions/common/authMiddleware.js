/**
 * 鉴权中间件（对齐技术架构 §4.3）。
 *
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源。
 * 不存储 / 不下发 / 不校验任何自管 token。
 *
 * 职责分层：
 *   - getOpenid(getWXContext)：从注入的 getWXContext 取 OPENID，纯函数可单测；
 *   - authMiddleware(options)：入口中间件，同步取 OPENID + 记录 require* 意图（不查库，零 token）；
 *   - assertUserExists(db, openid)：requireUser 的 DB 实现（异步查 User 存在）；
 *   - assertJoined(user)：requireJoined 的实现（校验报名状态）。
 *   （requireAdmin 由 common/adminGuard.js 的 assertAdmin 承担。）
 */

const { CODE, BizError } = require('./errors');

/**
 * 从 getWXContext 取 OPENID。
 * @param {() => {OPENID?: string, UNIONID?: string}} getWXContext 微信运行时注入的取上下文函数
 * @returns {{openid: string, unionid?: string}}
 * @throws {Error} openid 缺失时抛鉴权错误（CODE.AUTH_NO_OPENID）
 */
function getOpenid(getWXContext) {
  if (typeof getWXContext !== 'function') {
    throw BizError(CODE.AUTH_NO_OPENID, 'getWXContext not provided');
  }
  const ctx = getWXContext() || {};
  const openid = ctx.OPENID;
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'openid missing in wxContext');
  }
  const result = { openid };
  if (ctx.UNIONID) result.unionid = ctx.UNIONID;
  return result;
}

/**
 * 鉴权中间件骨架。
 *
 * @param {object} options
 * @param {() => {OPENID?: string}} options.getWXContext 微信运行时注入
 * @param {object} [options.db]         数据库句柄（本轮留 TODO，可缺省）
 * @param {boolean} [options.requireUser] 是否要求 User 已存在（默认 false，登录前置不要求）
 * @param {boolean} [options.requireAdmin] 是否要求管理员（默认 false）
 * @returns {{openid: string, user?: object}} 鉴权上下文
 *
 * TODO（后续轮次实现）：
 *   - 按 openid 查 User 表确认存在（requireUser=true 时）
 *   - requireAdmin=true 时校验 user.is_admin === true
 *   - 报名状态校验由具体 action 内部按需调用，不在此强制
 */
function authMiddleware(options) {
  const opts = options || {};
  const { openid } = getOpenid(opts.getWXContext);

  const context = { openid };

  // 设计说明（DB 校验由独立函数承担，保持本中间件同步、可单测、零 token）：
  //   - 本中间件职责单一：可信地取 OPENID（微信侧不可伪造）。requireUser/requireAdmin/
  //     requireJoined 仅作「声明式意图标记」（代码自文档化该 action 需要什么），不在此时查库；
  //   - DB 校验由独立异步函数承担，在各 handler 入口显式调用，与 assertAdmin 同范式：
  //       assertUserExists(db, openid) —— requireUser 的实现（查 User 存在并返回 user）；
  //       assertJoined(user)          —— requireJoined 的实现（校验 join_status==='joined'）；
  //       assertAdmin(store, openid)  —— requireAdmin 的实现（见 common/adminGuard.js）。
  //   - 这样中间件签名保持同步，调用方（各 main）与单测零改动，校验仍真实落地。
  if (opts.requireUser || opts.requireAdmin || opts.requireJoined) {
    // 仅记录意图；实际 DB 校验在 handler 内调 assertUserExists/assertAdmin/assertJoined。
    context.requires = {
      user: !!opts.requireUser,
      admin: !!opts.requireAdmin,
      joined: !!opts.requireJoined
    };
  }

  return context;
}

/**
 * 断言 openid 对应的 User 存在（requireUser 的 DB 实现，异步）。
 * 供需要 requireUser 的 handler 入口显式调用（与 assertAdmin 同范式）。
 *
 * @param {object} db 云数据库句柄 cloud.database()
 * @param {string} openid 调用者 openid（来自 wxContext）
 * @returns {Promise<object>} 命中的 User 文档
 * @throws {BizError} AUTH_NO_OPENID（openid 缺失）/ AUTH_USER_NOT_FOUND（无对应用户）
 */
async function assertUserExists(db, openid) {
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'assertUserExists: openid required');
  }
  const res = await db.collection('User').where({ _openid: openid }).limit(1).get();
  const users = (res && res.data) || [];
  if (users.length === 0) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'assertUserExists: user not found for openid');
  }
  return users[0];
}

/**
 * 断言用户已报名（requireJoined 的实现，同步）。配合 assertUserExists 使用。
 * @param {object} user assertUserExists 返回的 User 文档
 * @throws {BizError} AUTH_JOIN_STATUS_DENIED（join_status !== 'joined'）
 */
function assertJoined(user) {
  if (!user || user.join_status !== 'joined') {
    throw BizError(CODE.AUTH_JOIN_STATUS_DENIED, 'assertJoined: user not joined（报名后可用）');
  }
}

module.exports = { getOpenid, authMiddleware, assertUserExists, assertJoined };
