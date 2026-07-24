/**
 * auth.login 业务纯函数（对齐技术架构 §4.3 / §6.1，开发计划 B2）。
 *
 * 本地轨：与 wx-server-sdk 解耦，db 以依赖注入方式传入（mock 集合可单测）。
 * 身份完全以 wxContext.OPENID 为准 —— 不接收、不返回任何自管 token。
 *
 * 入口约定（薄封装由 handler 负责）：
 *   - 从 mock/真实 wxContext 取 openid（复用 common/authMiddleware.getOpenid）；
 *   - 只查 User by openid（**不建号**——建号移至 auth.register，消费邀请码后建号）；
 *   - 返回登录态（是否新用户 / 是否已注册 / 是否已报名 / 是否管理员），不下发 token / openid。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 从 wxContext 解析身份（OPENID / UNIONID）。
 * 纯函数：getWXContext 由调用方注入（mock 或真实 cloud.getWXContext）。
 *
 * @param {() => {OPENID?: string, UNIONID?: string}} getWXContext
 * @returns {{openid: string, unionid?: string}}
 * @throws {Error} OPENID 缺失时抛 AUTH_NO_OPENID
 */
function resolveIdentity(getWXContext) {
  if (typeof getWXContext !== 'function') {
    throw BizError(CODE.AUTH_NO_OPENID, 'getWXContext not provided');
  }
  const ctx = getWXContext() || {};
  const openid = ctx.OPENID;
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'openid missing in wxContext');
  }
  const identity = { openid };
  if (ctx.UNIONID) identity.unionid = ctx.UNIONID;
  return identity;
}

/**
 * 构造新 User 文档（首次登录）。
 * 纯函数：不写库，仅返回待写入的对象。
 *
 * @param {object} identity { openid, unionid? }
 * @param {object} [profile] { nickname?, avatar? }（getUserProfile 传入，可缺省）
 * @param {function} [now] 时间工厂，便于测试（默认 Date）
 * @returns {object} User 文档（不含 _id）
 */
function buildNewUser(identity, profile, now) {
  const p = profile || {};
  const ts = (typeof now === 'function' ? now() : new Date());
  const doc = {
    _openid: identity.openid,
    nickname: p.nickname || '',
    avatar: p.avatar || '',
    // 注册时使用的邀请码（auth.register 消费邀请码后写入；buildNewUser 阶段尚未消费故空串）
    invite_code: '',
    join_status: 'pending',
    is_admin: false,
    created_at: ts,
    updated_at: ts
  };
  if (identity.unionid) doc.unionid = identity.unionid;
  return doc;
}

/**
 * 登录态投影：从 User 文档摘出可下发前端的字段。
 * 红线：不下发原始 openid / unionid（仅状态）。
 *
 * 语义：
 *   - is_new 表示「该 openid 是否尚无 User 记录」（前端据此引导走注册向导）；
 *   - registered 表示「该账号是否已通过邀请码准入并建号」（即 User 文档存在）。
 *
 * 注意：login 现只查不建，故 is_new=true 时库内无该用户；建号由 auth.register 完成
 *   （消费邀请码后建号）。registered = !!user（User 存在即已准入），老用户天然兼容。
 *
 * @param {object} user User 文档（可为 null 表示尚未持久化）
 * @returns {object} { is_new, registered, join_status, is_admin, nickname, avatar, dept_id }
 */
function projectLoginState(user) {
  if (!user) {
    return {
      is_new: true,
      registered: false,
      join_status: 'pending',
      is_admin: false,
      nickname: '',
      avatar: '',
      dept_id: null
    };
  }
  // registered：User 文档存在即代表已通过邀请码准入建号（去手机号后口径）
  return {
    is_new: false,
    registered: true,
    join_status: user.join_status || 'pending',
    is_admin: !!user.is_admin,
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    dept_id: user.dept_id || null
  };
}

/**
 * login 主逻辑（纯函数 + 注入式 db）——**只查不建**。
 *
 * 流程：
 *   1. resolveIdentity 取 openid；
 *   2. 按 _openid 查 User；
 *   3. 命中 → 返回登录态（is_new:false）；未命中 → 返回未注册态（is_new:true），**不建号**。
 *
 * 建号已移至 auth.register（消费邀请码后一次性建号）。login 不再 add User。
 *
 * db 形态约定（mock 与真实 wx-server-sdk 一致的最小子集）：
 *   db.collection(name).where(cond).get() -> Promise<{ data: object[] }>
 *
 * @param {object} params
 * @param {() => object} params.getWXContext
 * @param {object} params.db 数据库句柄
 * @returns {Promise<object>} projectLoginState 结果（is_new 标识新老用户）
 */
async function login(params) {
  const { getWXContext, db } = params || {};
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'login: db with collection() is required');
  }
  const identity = resolveIdentity(getWXContext);

  const col = db.collection('User');
  const found = await col.where({ _openid: identity.openid }).get();
  const list = (found && found.data) || [];

  if (list.length > 0) {
    // 老用户：返回登录态（is_new:false），不建号
    return projectLoginState(list[0]);
  }

  // 新用户：不建号（建号移至 auth.register）。返回 is_new:true，前端引导走注册向导。
  return projectLoginState(null);
}

module.exports = {
  resolveIdentity,
  buildNewUser,
  projectLoginState,
  login
};
