/**
 * auth.phone 业务纯函数（对齐技术架构 §5/§6.1，开发计划 B3，PRD F1 R1.2/R1.5）。
 *
 * 本地轨：与 wx-server-sdk / getPhoneNumber 解密链路解耦。
 *   - 真实 getPhoneNumber / encryptedData 解密留云轨；
 *   - 本模块以「已解密得到的手机号」为输入做：归一化 + 脱敏 + 白名单校验 + 更新 User。
 *
 * 红线：
 *   - 完整手机号仅后端做白名单匹配，不下发前端；
 *   - 白名单校验在后端（PRD R1.5）；
 *   - 不在白名单 → 抛 BIZ_NOT_IN_WHITELIST。
 *
 * 手机号归一化（#7）：白名单匹配两侧统一过 normalizePhoneInput——
 *   去 +86/86 国家码前缀 + 去空格/横线等分隔，仅留数字。这样白名单录入带格式
 *   （+86、空格、横线）或微信侧返回带国家码时也能正确匹配，避免合法员工被误杀。
 */

const { CODE, BizError } = require('../common/errors');
const { maskPhone } = require('../common/mask');

/**
 * 手机号归一化：trim + 去 +86/86 国家码前缀 + 仅保留数字。
 * 用于白名单匹配两侧统一口径（录入/解密侧带 +86、空格、横线等格式时也能匹配）。
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
 * 手机号合法性校验（11 位数字）。
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhone(phone) {
  return typeof phone === 'string' && /^\d{11}$/.test(phone);
}

/**
 * 白名单校验纯函数：判断手机号是否命中白名单。
 * 匹配两侧均经 normalizePhoneInput 归一化（#7），容忍白名单录入格式差异。
 * @param {string} phone
 * @param {Array<{phone?: string}>} whitelist 白名单记录（含 phone 字段）
 * @returns {boolean}
 */
function isInWhitelist(phone, whitelist) {
  const normalized = normalizePhoneInput(phone);
  if (!isValidPhone(normalized)) return false;
  if (!Array.isArray(whitelist)) return false;
  return whitelist.some((item) => item && normalizePhoneInput(item.phone) === normalized);
}

/**
 * 手机号校验结果数据（更新 User 时持久化的字段）。
 * 纯函数：不写库，返回归一化后的 { phone, phone_masked }。
 *
 * @param {string} phone 完整手机号（已解密，可带 +86/空格等格式）
 * @returns {{phone: string, phone_masked: string}} phone 为归一化后的 11 位纯数字
 * @throws {Error} 归一化后仍非合法手机号抛 SYS_EXTERNAL_ERROR（视为解密/输入异常）
 */
function normalizePhone(phone) {
  const normalized = normalizePhoneInput(phone);
  if (!isValidPhone(normalized)) {
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'invalid phone number');
  }
  return { phone: normalized, phone_masked: maskPhone(normalized) };
}

/**
 * phone 校验主逻辑（纯函数 + 注入式 db）。
 *
 * 流程：
 *   1. 由调用方传入「已解密的完整手机号」（本地轨 mock 解密结果）；
 *   2. normalizePhone 归一化（去 +86 等）+ 合法性 + 脱敏；
 *   3. 查 Whitelist（按归一化手机号匹配，PRD R1.5）；
 *   4. 不在白名单 → 抛 BIZ_NOT_IN_WHITELIST；
 *   5. 更新当前 openid 的 User（写归一化 phone + phone_masked）；
 *   6. 返回校验结果（仅脱敏手机号，不下发完整手机号）。
 *
 * @param {object} params
 * @param {string} params.openid 当前用户 openid（由 handler 从 wxContext 取）
 * @param {string} params.phone 已解密的完整手机号（可带 +86/空格等格式）
 * @param {object} params.db 数据库句柄
 * @returns {Promise<object>} { verified: true, phone_masked }
 * @throws {BizError} 非白名单 / 非合法手机号 / User 不存在
 */
async function verifyPhone(params) {
  const { openid, phone: rawPhone, db } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'verifyPhone: openid required');
  }
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'verifyPhone: db with collection() is required');
  }

  // 归一化（去 +86/空格/横线）+ 校验 11 位 + 脱敏；phone 为归一化后的纯 11 位号。
  const { phone, phone_masked } = normalizePhone(rawPhone);

  // 白名单校验（后端按归一化完整手机号匹配；isInWhitelist 内部两侧再归一化兜底）
  const wlRes = await db.collection('Whitelist').where({ phone }).get();
  const wl = (wlRes && wlRes.data) || [];
  if (!isInWhitelist(phone, wl)) {
    throw BizError(CODE.BIZ_NOT_IN_WHITELIST, '非企业员工：手机号不在白名单');
  }

  // 更新当前 openid 的 User（写归一化 phone，保证库内手机号格式一致）
  const userCol = db.collection('User');
  const userRes = await userCol.where({ _openid: openid }).get();
  const users = (userRes && userRes.data) || [];
  if (users.length === 0) {
    // 正常流程下 phone 校验发生在 login 之后，User 必然已存在
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'verifyPhone: user not found, login first');
  }

  await userCol.where({ _openid: openid }).update({
    data: { phone, phone_masked, updated_at: new Date() }
  });

  // 仅下发脱敏手机号（红线：完整手机号留在后端）
  return { verified: true, phone_masked };
}

module.exports = { normalizePhoneInput, isValidPhone, isInWhitelist, normalizePhone, verifyPhone };
