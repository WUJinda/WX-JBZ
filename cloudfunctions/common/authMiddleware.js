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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 按 openid 读 User 文档（不抛错，返回 doc|null）。
 * 复用 assertUserExists 的查询形态，供 assertJoinedFresh 重试循环每次重读最新值。
 *
 * @param {object} db 云数据库句柄
 * @param {string} openid
 * @returns {Promise<object|null>}
 */
async function findUserByOpenid(db, openid) {
  const res = await db.collection('User').where({ _openid: openid }).limit(1).get();
  const arr = (res && res.data) || [];
  return arr.length > 0 ? arr[0] : null;
}

/**
 * 断言用户已报名（吸收云库「写后读」最终一致性窗口的实现）。
 *
 * 背景：user.join 落库走主节点写 join_status='joined'，本函数（steps.sync 鉴权用）走从节点读 User，
 *   副本同步延迟窗口内可能读到注册初值 'pending' → 单次 assertJoined 会误判「未报名」抛 1004，
 *   表现为「刚报名立即同步失败，十几秒后才正常」。本函数读不到 joined 时短退避重读，窗口内自愈。
 *
 * 稳态（用户早已报名）：firstUser（调用方已查得的 user，如 main 的 context.user）为 joined 时直接
 *   返回，零额外读、零 sleep，无性能回归。仅「刚报名且副本未同步」才进入重读循环（最坏 retries×delayMs）。
 *
 * @param {object} db cloud.database()
 * @param {string} openid 调用者 openid
 * @param {object} [options]
 * @param {number} [options.retries=3] 读不到 joined 时的退避重读次数（每次先 sleep）
 * @param {number} [options.delayMs=400] 退避间隔（ms）
 * @param {object} [options.firstUser] 调用方已查得的 User 文档；为 joined 时跳过首次读库
 * @param {(ms:number)=>Promise} [options.sleepFn] 注入 sleep（便于单测；默认 Promise+setTimeout）
 * @returns {Promise<object>} join_status==='joined' 的 User 文档
 * @throws {BizError} AUTH_USER_NOT_FOUND(1002) / AUTH_JOIN_STATUS_DENIED(1004，复用 assertJoined)
 */
async function assertJoinedFresh(db, openid, options) {
  const opts = options || {};
  const retries = Number.isFinite(opts.retries) ? opts.retries : 3;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 400;
  const sleep = typeof opts.sleepFn === 'function' ? opts.sleepFn : defaultSleep;

  let user = opts.firstUser || null;
  // 首次判定：firstUser 已是 joined 则零读零 sleep 直接返回。
  if (!user || user.join_status !== 'joined') {
    user = await findUserByOpenid(db, openid);
    if (!user) {
      throw BizError(CODE.AUTH_USER_NOT_FOUND, 'assertJoinedFresh: user not found for openid');
    }
  }
  if (user.join_status === 'joined') return user;

  // 退避重读：副本同步窗口内反复读最新值，直到 joined 或用尽重试。
  for (let i = 0; i < retries; i++) {
    await sleep(delayMs);
    user = await findUserByOpenid(db, openid);
    if (!user) {
      throw BizError(CODE.AUTH_USER_NOT_FOUND, 'assertJoinedFresh: user not found for openid');
    }
    if (user.join_status === 'joined') return user;
  }
  // 重试用尽仍非 joined：真未报名（或副本延迟超窗口，罕见）→ 复用 assertJoined 抛 1004。
  assertJoined(user);
}

module.exports = { getOpenid, authMiddleware, assertUserExists, assertJoined, assertJoinedFresh };
