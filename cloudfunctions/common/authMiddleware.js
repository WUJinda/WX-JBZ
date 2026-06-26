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
  //
  // 占位说明（当前行为）：
  //   - requireUser / requireAdmin 当前为占位空骨架，传 true 不做任何 DB 校验；
  //   - User 存在性由各 handler 内按 _openid 查库保证（见 user/index.js 的 getProfile、
  //     rank/index.js 的 personal/dept 查询等，查不到即抛 AUTH_USER_NOT_FOUND）；
  //   - 管理员权限由 admin/index.js 内的 assertAdmin(store, openid) 承担
  //     （非 is_admin===true 抛 AUTH_NOT_ADMIN）；
  //   - 云轨联调如需在入口统一校验（而非每个 handler 各自查库），再在此实现：
  //       requireUser → db.collection('User').where({_openid: openid}).get() 校验存在；
  //       requireAdmin → 在 requireUser 基础上校验 user.is_admin === true。
  if (opts.requireUser) {
    // 占位：见上方说明，当前不在此查库。
  }
  if (opts.requireAdmin) {
    // 占位：见上方说明，管理员校验由各 handler 的 assertAdmin 承担。
  }

  return context;
}

module.exports = { getOpenid, authMiddleware };
