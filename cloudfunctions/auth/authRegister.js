/**
 * auth.register 业务纯函数 —— 一次性建号（phone 必填非空）。
 *
 * 背景：原 auth.login 首次建号写 phone='' 占位，撞 idx_user_phone 唯一索引空串键，
 *   导致「库里已有占位用户后，所有新用户登录失败」。本模块取代 login 的建号职责：
 *   注册时一次性提交（昵称 + 头像 + 手机号），phone 必填非空，消灭空占位。
 *
 * 手机号采集方式：**手动填写**（前端明文 input）。
 *   ⚠️ 安全降级（相对 authPhone.verifyPhone 的微信解密路径）：
 *     - 原红线「手机号必经微信解密、禁信前端明文」在此被打破：明文 phone 来自前端，可被伪造。
 *     - 缓解：① 11 位格式校验；② phone 应用层查重（已被他人占用 → BIZ_PHONE_TAKEN）；
 *             ③ DB idx_user_phone 唯一索引兜底（并发撞键时 add 抛 -502001）。
 *     - 残余风险：挡不住「先到先得占用某号」。企业内部活动场景可控；非内部/实名场景勿用，
 *       应改走 auth.phone 微信解密路径。
 *     - **不授予 is_admin**：与 userPhone.setPhone 同口径，避免明文伪造超管号提权。
 *       首个超管冷启动靠云控制台手改 User.is_admin=true（CLAUDE.md 记载的等价方式）。
 *
 * upsert 语义：按 _openid 查——
 *   - 不存在 → add（全新用户，phone 非空）；
 *   - 存在 → update（历史 phone='' 占位用户补全，或重复提交幂等）。
 *
 * 本地轨：db 注入式（mockDb 可单测）；不 require wx-server-sdk。仅同域 require，
 *   不引入跨目录依赖（不改 sync:shared 的 SHARED_MANIFEST）。
 */

const { CODE, BizError } = require('../common/errors');
const { maskPhone } = require('../common/mask');
const { normalizePhoneInput, isValidPhone } = require('./authPhone');
const { buildNewUser } = require('./authLogin');

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
 * 一次性注册建号（纯函数 + 注入式 db，upsert）。
 *
 * 流程：
 *   1. openid / db 校验；
 *   2. 昵称校验（1..20 码点）→ BIZ_PARAM_MISSING；
 *   3. 手机号归一化 + 11 位校验（复用 authPhone，与微信解密路径同源）→ BIZ_PARAM_MISSING；
 *   4. phone 查重：已被别的 _openid 占用 → BIZ_PHONE_TAKEN（本人同号幂等放行）；
 *   5. upsert by _openid：存在 → update 补全；不存在 → add（phone 必填非空）；
 *   6. 返回 { registered, is_new, phone_masked, join_status }（不下发明文 phone）。
 *
 * @param {object} params
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {string} params.nickname 昵称（必填，trim 后 1..20 码点）
 * @param {string} [params.avatar] 头像 fileID/URL（可选，空则存空串，后续 profile.edit 补）
 * @param {string} params.phone 手机号（手动填写，可带 +86/空格等格式，内部归一化）
 * @param {object} params.db 数据库句柄
 * @param {Date|Function} [params.now] 注入时间（便于单测）
 * @returns {Promise<object>} { registered:true, is_new, phone_masked, join_status }
 * @throws {BizError} AUTH_NO_OPENID / SYS_DB_ERROR / BIZ_PARAM_MISSING / BIZ_PHONE_TAKEN
 */
async function registerUser(params) {
  const { openid, nickname, avatar, phone: rawPhone, db, now } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'registerUser: openid required');
  }
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'registerUser: db with collection() is required');
  }

  // 昵称校验（与 userAccount.validateNickname 同口径）。
  if (!validateNickname(nickname)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'registerUser: invalid nickname (1-20 chars)');
  }
  const nicknameTrim = nickname.trim();

  // 手机号归一化 + 11 位校验（复用 authPhone，与微信解密路径同源口径）。
  const phone = normalizePhoneInput(rawPhone);
  if (!isValidPhone(phone)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'registerUser: invalid phone (11 digits required)');
  }
  const phone_masked = maskPhone(phone);
  const avatarVal = typeof avatar === 'string' ? avatar : '';

  const userCol = db.collection('User');

  // phone 应用层查重：已被别的 _openid 占用 → BIZ_PHONE_TAKEN（本人同号幂等放行）。
  // phone 唯一性 = DB idx_user_phone 唯一索引 + 此处查重双保险（与 userPhone.setPhone 同模式）。
  const takenRes = await userCol.where({ phone }).get();
  const taken = (takenRes && takenRes.data) || [];
  for (let i = 0; i < taken.length; i++) {
    if (taken[i] && taken[i]._openid !== openid) {
      throw BizError(CODE.BIZ_PHONE_TAKEN, '该手机号已被其他账号使用');
    }
  }

  // 注入时间：now 为 Date 或函数时取其值，否则 new Date()。buildNewUser 的 now 形参只接受函数。
  const ts = now instanceof Date ? now : typeof now === 'function' ? now() : new Date();

  // upsert by _openid
  const existRes = await userCol.where({ _openid: openid }).get();
  const exist = (existRes && existRes.data) || [];

  if (exist.length > 0) {
    // 已存在（历史 phone='' 占位用户补全 / 重复提交幂等）→ update，不改 join_status/is_admin。
    const res = await userCol.where({ _openid: openid }).update({
      data: { nickname: nicknameTrim, avatar: avatarVal, phone, phone_masked, updated_at: ts }
    });
    const updated = (res && res.stats && res.stats.updated) || 0;
    if (updated === 0) {
      // 并发注销/竞态致 where 命中后 update 0 行 → 不静默假成功（P1-3 写库失败必须上抛）。
      throw BizError(CODE.SYS_DB_ERROR, 'registerUser: update affected 0 rows (concurrent cancel?)');
    }
    return {
      registered: true,
      is_new: false,
      phone_masked,
      join_status: exist[0].join_status || 'pending'
    };
  }

  // 不存在 → add（phone 必填非空，无空占位）。复用 buildNewUser 构造基础文档后覆盖占位空 phone。
  const doc = buildNewUser({ openid }, { nickname: nicknameTrim, avatar: avatarVal }, () => ts);
  doc.phone = phone;
  doc.phone_masked = phone_masked;
  try {
    await userCol.add({ data: doc });
  } catch (e) {
    // 并发同号：应用层查重通过后，DB idx_user_phone 唯一索引兜底撞键（-502001 duplicate key on
    // idx_user_phone）→ 转友好的 BIZ_PHONE_TAKEN（对齐 StepRecord「撞唯一索引」处理约定）；
    // 其它错误（如 idx_user_openid 并发双击撞键）原样上抛，由 main catch 转 SYS_DB_ERROR。
    const msg = (e && (e.errMsg || e.message)) || '';
    if (/idx_user_phone/i.test(msg)) {
      throw BizError(CODE.BIZ_PHONE_TAKEN, '该手机号已被其他账号使用');
    }
    throw e;
  }
  return {
    registered: true,
    is_new: true,
    phone_masked,
    join_status: 'pending'
  };
}

module.exports = { registerUser, validateNickname, NICKNAME_MAX_LEN };
