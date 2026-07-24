/**
 * auth.register 业务纯函数 —— 消费邀请码 + 一次性建号。
 *
 * 背景：准入凭证从「手机号白名单」改为「一人一码邀请码」。用户注册向导提交
 *   （昵称 + 头像 + 邀请码），后端原子消费邀请码（unused→used 绑定 openid）后建号。
 *
 * 安全要点：
 *   - 邀请码消费在纯函数内针对注入 db 跑（where+update+stats 原子，依赖 idx_invite_code
 *     唯一索引确保并发仅一个命中），避免 handler 处理 store 快照的 TOCTOU；
 *   - 消费失败按码状态精确报错（INVALID/USED/DISABLED），见 auth/inviteCode.consumeCode；
 *   - 不授予 is_admin：与原口径一致，首个超管冷启动靠云控制台手改 User.is_admin=true。
 *
 * 流程顺序：先查 User——已存在（重复提交/竞态）幂等返回，不重复消费邀请码；
 *   不存在才校验昵称/码 → 消费邀请码 → add。
 *
 * 已知边界：消费码后若 add 失败（极罕见）会浪费一张码，管理员重生成即可；
 *   不做回滚（回滚引入新竞态，得不偿失）。
 *
 * 本地轨：db 注入式（mockDb 可单测）；不 require wx-server-sdk。同域 require
 *   auth/inviteCode（consumeCode）与 auth/authLogin（buildNewUser），不引入跨目录依赖
 *   （不改 sync:shared 的 SHARED_MANIFEST）。
 */

const { CODE, BizError } = require('../common/errors');
const { buildNewUser } = require('./authLogin');
const { normalizeInviteCode, validateInviteCode, consumeCode } = require('./inviteCode');

/** 昵称长度上限（按 Unicode 码点计，与 userAccount.NICKNAME_MAX_LEN 同口径）。 */
const NICKNAME_MAX_LEN = 20;

/**
 * 校验昵称：trim 后 1..NICKNAME_MAX_LEN 个码点。
 * 与 userAccount.validateNickname / 前端 editCalc.validateNickname 同源（前后端口径一致）。
 * @param {*} nickname
 * @returns {boolean}
 */
function validateNickname(nickname) {
  if (typeof nickname !== 'string') return false;
  const s = nickname.trim();
  const len = Array.from(s).length;
  return len >= 1 && len <= NICKNAME_MAX_LEN;
}

/**
 * 消费邀请码 + 一次性注册建号（纯函数 + 注入式 db）。
 *
 * 流程：
 *   1. openid / db 校验；
 *   2. 先查 User——已存在（重复提交/竞态）→ 幂等返回（is_new:false），不重复消费码；
 *   3. 不存在 → 校验昵称（1..20 码点）→ BIZ_PARAM_MISSING；
 *   4. 邀请码归一化 + 校验；缺码 → BIZ_PARAM_MISSING，格式错 → BIZ_INVITE_CODE_INVALID；
 *   5. consumeCode 原子消费（unused→used 绑定 openid）→ 失败按状态抛
 *      BIZ_INVITE_CODE_INVALID / USED / DISABLED；
 *   6. add User（写 invite_code）；
 *   7. 返回 { registered, is_new, invite_code, join_status }。
 *
 * @param {object} params
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {string} params.nickname 昵称（必填，trim 后 1..20 码点）
 * @param {string} [params.avatar] 头像 fileID/URL（可选，空则存空串，后续 profile.edit 补）
 * @param {string} params.inviteCode 邀请码（用户输入，内部归一化）
 * @param {object} params.db 数据库句柄
 * @param {Date|Function} [params.now] 注入时间（便于单测）
 * @returns {Promise<object>} { registered:true, is_new, invite_code, join_status }
 * @throws {BizError} AUTH_NO_OPENID / SYS_DB_ERROR / BIZ_PARAM_MISSING / BIZ_INVITE_CODE_*
 */
async function registerUser(params) {
  const { openid, nickname, avatar, inviteCode: rawCode, db, now } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'registerUser: openid required');
  }
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'registerUser: db with collection() is required');
  }

  const userCol = db.collection('User');

  // 先查 User：已存在（重复提交/竞态）→ 幂等返回，不重复消费邀请码。
  // （login 对已存在用户返回 registered:true，前端不会再走向导；此分支仅竞态/重复触发。）
  const existRes = await userCol.where({ _openid: openid }).get();
  const exist = (existRes && existRes.data) || [];
  if (exist.length > 0) {
    return {
      registered: true,
      is_new: false,
      invite_code: exist[0].invite_code || '',
      join_status: exist[0].join_status || 'pending'
    };
  }

  // 新用户：校验昵称。
  if (!validateNickname(nickname)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'registerUser: invalid nickname (1-20 chars)');
  }
  const nicknameTrim = nickname.trim();

  // 邀请码归一化 + 校验（缺码 → BIZ_PARAM_MISSING）。
  if (rawCode == null || String(rawCode).trim() === '') {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'registerUser: invite code required');
  }
  const code = normalizeInviteCode(rawCode);
  if (!validateInviteCode(code)) {
    throw BizError(CODE.BIZ_INVITE_CODE_INVALID, 'registerUser: invalid invite code format');
  }
  const avatarVal = typeof avatar === 'string' ? avatar : '';

  // 注入时间。
  const ts = now instanceof Date ? now : typeof now === 'function' ? now() : new Date();

  // 原子消费邀请码（unused→used，绑定 openid）。失败按码状态精确抛错。
  await consumeCode({ db, code, openid, now: ts });

  // 建号。复用 buildNewUser 构造基础文档后写入 invite_code。
  const doc = buildNewUser({ openid }, { nickname: nicknameTrim, avatar: avatarVal }, () => ts);
  doc.invite_code = code;
  try {
    await userCol.add({ data: doc });
  } catch (e) {
    // idx_user_openid 并发双击撞键等异常原样上抛，由 main catch 转 SYS_DB_ERROR。
    // （已无 idx_user_phone；invite_code 无唯一索引，不在此撞键。）
    throw e;
  }
  return {
    registered: true,
    is_new: true,
    invite_code: code,
    join_status: 'pending'
  };
}

module.exports = { registerUser, validateNickname, NICKNAME_MAX_LEN };
