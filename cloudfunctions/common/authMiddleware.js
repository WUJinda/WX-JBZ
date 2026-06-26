/**
 * 鉴权中间件（对齐技术架构 §4.3）。
 *
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源。
 * 不存储 / 不下发 / 不校验任何自管 token。
 *
 * 本轮只做「取 OPENID」骨架：
 *   - getOpenid(getWXContext)：从注入的 getWXContext 取 OPENID，纯函数可单测；
 *   - authMiddleware(options)：入口中间件骨架，本轮不实现查 User 表的 DB 逻辑（留 TODO）。
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

  // TODO: requireUser / requireAdmin 的 DB 校验逻辑留给后续轮次。
  // 本轮只保证能可信地拿到 openid，绝不引入任何 token 概念。
  if (opts.requireUser) {
    // 后续：const user = await db.collection('User').where({_openid: openid}).get();
    // if (!user) throw BizError(CODE.AUTH_USER_NOT_FOUND, 'user not found');
  }
  if (opts.requireAdmin) {
    // 后续：校验 user.is_admin === true，否则 throw BizError(CODE.AUTH_NOT_ADMIN, ...)
  }

  return context;
}

module.exports = { getOpenid, authMiddleware };
