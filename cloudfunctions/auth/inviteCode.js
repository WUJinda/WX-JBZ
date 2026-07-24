/**
 * auth 域邀请码工具 + 消费纯函数（注册准入路径）。
 *
 * 邀请码格式：6 位 Crockford Base32（字母表 0123456789ABCDEFGHJKMNPQRSTVWXYZ，
 * 排除 I/L/O/U 易混字符），大写、无横线存储。
 *
 * 跨域说明：本模块与 admin/inviteCode.js 各自独立（sync-shared 的 SHARED_DIRS 不含
 * auth/admin，跨域 require 须改 SHARED_MANIFEST）。Crockford 归一化/校验/生成逻辑在
 * 两域各保留一份（符合 normalizePhoneInput 双份惯例）。
 *
 * 本地轨：consumeCode 注入式 db（mockDb 可单测）；不 require wx-server-sdk。
 */

const { CODE, BizError } = require('../common/errors');

/** Crockford Base32 字母表（排除 I/L/O/U）。 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;

/**
 * 归一化邀请码：转大写 + 宽容解码（O→0/I→1/L→1/U→V）+ 去空格/横线。
 * 因生成的码不含 O/I/L/U，输入出现这些字符即误读，宽容处理减少支持工单。
 * @param {*} raw
 * @returns {string} 归一化后的码（大写，仅含 Crockford 字母表字符）
 */
function normalizeInviteCode(raw) {
  if (raw == null) return '';
  let s = String(raw).toUpperCase();
  // 去分隔（空格/横线）
  s = s.replace(/[\s-]/g, '');
  // 宽容解码常见误读（生成的码从不包含这些字符）
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  return s;
}

/**
 * 校验邀请码格式：6 位，每位在 Crockford 字母表内。
 * @param {string} code 归一化后的码
 * @returns {boolean}
 */
function validateInviteCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (CROCKFORD_ALPHABET.indexOf(code[i]) < 0) return false;
  }
  return true;
}

/**
 * 原子消费邀请码：unused→used 并绑定 openid。
 *
 * 原子性：where({code, status:'unused'}).update(...) 依赖 idx_invite_code 唯一索引，
 * 确保并发仅一个文档被命中。updated===1 成功；updated===0 时二次 where({code}).get()
 * 消歧，按码实际状态抛对应业务码。
 *
 * 在注入 db 的纯函数内针对真实库跑（云轨 handler 传真实 cloud db；单测传 mockDb）。
 *
 * @param {object} params
 * @param {object} params.db 数据库句柄
 * @param {string} params.code 归一化后的邀请码
 * @param {string} params.openid 使用者 openid
 * @param {Date} [params.now] 使用时间（默认 new Date()）
 * @returns {Promise<{code: string, used_at: Date}>}
 * @throws {BizError} BIZ_INVITE_CODE_INVALID / USED / DISABLED
 */
async function consumeCode(params) {
  const { db, code, openid, now } = params || {};
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'consumeCode: db with collection() is required');
  }
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'consumeCode: openid required');
  }
  if (!validateInviteCode(code)) {
    throw BizError(CODE.BIZ_INVITE_CODE_INVALID, 'consumeCode: invalid invite code format');
  }
  const usedAt = now instanceof Date ? now : new Date();

  const col = db.collection('InviteCode');
  // 原子消费：仅 unused 码被更新。
  const res = await col.where({ code, status: 'unused' }).update({
    data: { status: 'used', used_by: openid, used_at: usedAt }
  });
  const updated = (res && res.stats && res.stats.updated) || 0;
  if (updated === 1) {
    return { code, used_at: usedAt };
  }

  // updated===0：码不存在 / 已用 / 已禁用，二次查询消歧。
  const found = await col.where({ code }).get();
  const list = (found && found.data) || [];
  if (list.length === 0) {
    throw BizError(CODE.BIZ_INVITE_CODE_INVALID, '邀请码不存在');
  }
  const status = list[0].status;
  if (status === 'used') {
    throw BizError(CODE.BIZ_INVITE_CODE_USED, '邀请码已被使用');
  }
  if (status === 'disabled') {
    throw BizError(CODE.BIZ_INVITE_CODE_DISABLED, '邀请码已被禁用');
  }
  // 理论上不会到这（unused 应已 update 命中）；防御性抛 INVALID。
  throw BizError(CODE.BIZ_INVITE_CODE_INVALID, '邀请码不可用');
}

module.exports = {
  normalizeInviteCode,
  validateInviteCode,
  consumeCode,
  CROCKFORD_ALPHABET,
  CODE_LENGTH
};
