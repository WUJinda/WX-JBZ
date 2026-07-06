/**
 * user.setPhone 业务纯函数（手机号手动填写保底路径）。
 *
 * 背景：getPhoneNumber「手机号快速验证组件」需企业认证 + 后台开通，未开通时唤不出
 *   授权框、回调不触发（profile/login 的微信验证链路完全不可用）。本模块提供降级：
 *   用户手动填写手机号 → 后端归一化 + 格式校验 + 唯一性查重 → 写入当前 openid 的 User。
 *
 * ⚠️ 安全降级（相对 authPhone.verifyPhone 的微信解密路径）：
 *   - 原红线「手机号必经微信解密、禁信前端明文」在此被打破：明文 phone 来自前端，可被伪造。
 *   - 缓解：① 11 位格式校验；② 唯一性查重（该 phone 已被他人占用 → BIZ_PHONE_TAKEN）；
 *           ③ 降级开关 PHONE_MANUAL_FALLBACK_ENABLED（开通微信组件后置 false 重部署即关）。
 *   - 残余风险：挡不住「先到先得占用某号」。企业内部活动场景可控；非内部/实名场景勿用。
 *   - 本路径**不授予 is_admin**：超管冷启动只走 auth.phone 微信解密路径，避免明文伪造超管号提权。
 *
 * 归一化逻辑与 authPhone.js 的 normalizePhoneInput/isValidPhone 同源（内联复制，避免跨域
 *   require 改 sync:shared manifest）；脱敏复用 common/mask.maskPhone（与微信路径同口径）。
 *
 * 本地轨：db 注入式（mockDb 可单测）；不 require wx-server-sdk。身份仅 OPENID，不下发明文 phone。
 */

const { CODE, BizError } = require('../common/errors');
const { maskPhone } = require('../common/mask');

/**
 * 手机号手动填写降级开关。
 *   true  = 允许 setPhone（保底路径生效，开发 / 未开通微信组件阶段）；
 *   false = 拒绝（开通「手机号快速验证组件」后应置 false，强制走微信解密 auth.phone）。
 * 安全约定：写死后端源码，变更只改这一行重新部署（与 authPhone.PHONE_WHITELIST_REQUIRED 同口径，
 *   前端 event 不可控此值，否则任意前端可绕过）。
 */
const PHONE_MANUAL_FALLBACK_ENABLED = true;

/**
 * 手机号归一化：trim + 去 +86/86 国家码前缀 + 仅保留数字。
 * 与 authPhone.normalizePhoneInput 同源（查重两侧统一口径，容忍录入格式差异）。
 * @param {*} phone
 * @returns {string} 归一化后的手机号（纯数字，可能非 11 位；合法性由 isValidPhone 判定）
 */
function normalizePhoneInput(phone) {
  if (phone == null) return '';
  let s = String(phone).trim();
  // 去国际前缀 +86 / 86（仅当其后紧跟 11 位国内号时，避免误吃号段）
  s = s.replace(/^\+?86(?=\d{11})/, '');
  // 仅保留数字（去空格 / 横线 / 括号等分隔）
  s = s.replace(/\D+/g, '');
  return s;
}

/**
 * 手机号合法性校验（11 位数字）。与 authPhone.isValidPhone 同源。
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhone(phone) {
  return typeof phone === 'string' && /^\d{11}$/.test(phone);
}

/**
 * 手动设置手机号（纯函数 + 注入式 db）。
 *
 * 流程：
 *   1. 降级开关关闭 → 拒绝（SYS_NOT_IMPLEMENTED，提示走微信验证）；
 *   2. 归一化 + 11 位校验 → 非法抛 BIZ_PARAM_MISSING；
 *   3. 查重：该 phone 已被别的 _openid 占用 → 抛 BIZ_PHONE_TAKEN（本人同号幂等放行）；
 *   4. 写当前 openid 的 User（phone + phone_masked + updated_at）；
 *   5. 返回 { phone_masked }（不下发明文）。
 *
 * @param {object} params
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {string} params.phone 用户手动填写的手机号（可带 +86/空格等格式）
 * @param {object} params.db 数据库句柄
 * @param {Date|string} [params.now=new Date()] 注入时间（便于单测）
 * @param {boolean} [params.allowFallback] 仅单测显式覆盖降级开关；handler 永不透传
 * @returns {Promise<object>} { phone_masked }
 * @throws {BizError} 开关关闭 / 格式非法 / 撞号 / User 不存在 / 缺 openid/db
 */
async function setPhone(params) {
  const { openid, phone: rawPhone, db, now } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'setPhone: openid required');
  }
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'setPhone: db with collection() is required');
  }
  // 降级开关：关闭时拒绝，强制走微信验证（auth.phone）。
  // allowFallback 形参仅供单测显式覆盖，handler 永不透传（与 authPhone.requireWhitelist 同约定）。
  const allowFallback =
    typeof params.allowFallback === 'boolean' ? params.allowFallback : PHONE_MANUAL_FALLBACK_ENABLED;
  if (!allowFallback) {
    throw BizError(CODE.SYS_NOT_IMPLEMENTED, 'setPhone: manual fallback disabled, use auth.phone');
  }

  // 归一化 + 格式校验（手动填写场景：非合法 → BIZ_PARAM_MISSING，区别于微信解密的 SYS_EXTERNAL_ERROR）
  const phone = normalizePhoneInput(rawPhone);
  if (!isValidPhone(phone)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'setPhone: invalid phone (11 digits required)');
  }
  const phone_masked = maskPhone(phone);

  const userCol = db.collection('User');

  // 唯一性查重：该 phone 是否已被其他账号占用。本人同号（幂等更新）放行。
  // 微信解密路径靠 DB 唯一索引兜底撞号；手动填写撞号概率高，显式查重给明确业务码。
  const takenRes = await userCol.where({ phone }).get();
  const taken = (takenRes && takenRes.data) || [];
  for (let i = 0; i < taken.length; i++) {
    if (taken[i] && taken[i]._openid !== openid) {
      throw BizError(CODE.BIZ_PHONE_TAKEN, '该手机号已被其他账号使用');
    }
  }

  // 写当前 openid 的 User（与 verifyPhone/updateProfile 同范式：where(_openid).update）
  const ts = now instanceof Date ? now : new Date();
  const res = await userCol.where({ _openid: openid }).update({
    data: { phone, phone_masked, updated_at: ts }
  });
  const updated = (res && res.stats && res.stats.updated) || 0;
  if (updated === 0) {
    // 理论上 requireUser 已挡；此处兜底（不暴露 openid 是否存在）
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'setPhone: user not found');
  }

  return { phone_masked };
}

module.exports = {
  setPhone,
  normalizePhoneInput,
  isValidPhone,
  PHONE_MANUAL_FALLBACK_ENABLED
};
