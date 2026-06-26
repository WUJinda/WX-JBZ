/**
 * auth.login 业务纯函数（对齐技术架构 §4.3 / §6.1，开发计划 B2）。
 *
 * 本地轨：与 wx-server-sdk 解耦，db 以依赖注入方式传入（mock 集合可单测）。
 * 身份完全以 wxContext.OPENID 为准 —— 不接收、不返回任何自管 token。
 *
 * 入口约定（薄封装由 handler 负责）：
 *   - 从 mock/真实 wxContext 取 openid（复用 common/authMiddleware.getOpenid）；
 *   - 查/建 User（upsert 去重，同 openid 不重复建号）；
 *   - 返回登录态（是否已注册 / 是否已报名 / 是否管理员），不下发 token / openid / phone。
 */

const { CODE, BizError } = require('../common/errors');
const { maskPhone } = require('../common/mask');

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
    // 首次登录尚未验证手机号
    phone: '',
    phone_masked: '',
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
 * 红线：不下发原始 phone / openid / unionid（仅脱敏与状态）。
 *
 * 语义：registered 表示「该账号是否已完成手机号验证（即真实注册）」。
 *   - 首次 login 仅建号占位（phone 为空）→ registered=false；
 *   - 完成 auth.phone 后写入 phone → 再次 login 返回 registered=true。
 * 这与 PRD F1 R1.1「一个 openid 对应一个员工账号、需手机号验证才视作注册」一致。
 *
 * @param {object} user User 文档（可为 null 表示首次登录尚未持久化）
 * @returns {object} { registered, join_status, is_admin, phone_masked, nickname, avatar, dept_id }
 */
function projectLoginState(user) {
  if (!user) {
    return {
      registered: false,
      join_status: 'pending',
      is_admin: false,
      phone_masked: '',
      nickname: '',
      avatar: '',
      dept_id: null
    };
  }
  // registered：是否已完成手机号验证（phone 非空），而非仅「User 记录存在」
  const registered = !!(user.phone && user.phone_masked);
  return {
    registered,
    join_status: user.join_status || 'pending',
    is_admin: !!user.is_admin,
    phone_masked: user.phone_masked || '',
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    dept_id: user.dept_id || null
  };
}

/**
 * login 主逻辑（纯函数 + 注入式 db）。
 *
 * 流程：
 *   1. resolveIdentity 取 openid；
 *   2. 按 _openid 查 User；
 *   3. 不存在则 buildNewUser 并 add（upsert 去重 —— 同 openid 不重复建号）；
 *   4. projectLoginState 摘可下发字段返回。
 *
 * db 形态约定（mock 与真实 wx-server-sdk 一致的最小子集）：
 *   db.collection(name).where(cond).get() -> Promise<{ data: object[] }>
 *   db.collection(name).add({ data })      -> Promise<{ _id }>
 *
 * @param {object} params
 * @param {() => object} params.getWXContext
 * @param {object} params.db 数据库句柄
 * @param {object} [params.profile] { nickname?, avatar? }
 * @param {function} [params.now] 时间工厂
 * @returns {Promise<object>} projectLoginState 结果
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
    // 已存在：不重复建号，直接返回登录态
    return projectLoginState(list[0]);
  }

  // 不存在：首次登录建号
  const doc = buildNewUser(identity, params.profile, params.now);
  await col.add({ data: doc });
  return projectLoginState(doc);
}

module.exports = {
  resolveIdentity,
  buildNewUser,
  projectLoginState,
  login,
  // 便于其它模块复用（不重复 require format）
  _maskPhone: maskPhone
};
