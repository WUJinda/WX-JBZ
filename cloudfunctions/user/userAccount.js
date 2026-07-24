/**
 * user.update / user.cancel 业务纯函数（PRD F1 个人资料修改 + 账号注销）。
 *
 * 职责：
 *   - updateProfile：校验昵称/头像 → 更新当前 openid 的 User（nickname/avatar/updated_at）。
 *   - cancelAccount：删本人 StepRecord + User（幂等），关联聚合缓存不强删。
 *
 * 本地轨：db 注入式（mockDb 可单测）；不 require wx-server-sdk，不调真实云 API。
 * 身份仅 OPENID；不下发原始 openid / unionid。
 *
 * 红线：
 *   - 不下发敏感字段（update 仅改昵称头像，cancel 仅返回删除计数）；
 *   - 注销是敏感操作，前端须二次确认；后端按 openid 删本人数据，不越权删他人。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 昵称长度上限（按 Unicode 码点计，兼容 emoji）。
 */
const NICKNAME_MAX_LEN = 20;

/**
 * 头像 URL/fileID 长度上限（防异常超长入库）。
 */
const AVATAR_MAX_LEN = 1024;

/**
 * 校验昵称：trim 后 1..NICKNAME_MAX_LEN 个码点。
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
 * 校验头像：非空字符串且长度不超限（fileID 或 URL 均可）。
 * @param {*} avatar
 * @returns {boolean}
 */
function validateAvatar(avatar) {
  return typeof avatar === 'string' && avatar.length > 0 && avatar.length <= AVATAR_MAX_LEN;
}

/**
 * update 下发投影：仅返回改动的可下发字段（不下发敏感字段）。
 * @param {object} user 更新后的 User 文档
 * @returns {object} { nickname, avatar, updated_at }
 */
function projectUpdateResult(user) {
  const u = user || {};
  return {
    nickname: u.nickname || '',
    avatar: u.avatar || '',
    updated_at: u.updated_at || null
  };
}

/**
 * 更新昵称头像（纯函数 + 注入式 db）。
 *
 * requireUser 由 user/index.js 的 main 统一保证（context.user 已查）；
 * 本函数仍按 _openid 兜底再 update（与 getProfile 同范式，防裸调）。
 *
 * @param {object} params
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {object} params.db 数据库句柄
 * @param {string} params.nickname 新昵称
 * @param {string} params.avatar 新头像（fileID 或 URL）
 * @param {Date|string} [params.now=new Date()] 注入时间（便于单测）
 * @returns {Promise<object>} projectUpdateResult 结果
 * @throws {BizError} AUTH_NO_OPENID / BIZ_PARAM_MISSING / SYS_DB_ERROR / AUTH_USER_NOT_FOUND
 */
async function updateProfile(params) {
  const { openid, db, nickname, avatar, now } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'updateProfile: openid required');
  }
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'updateProfile: db with collection() is required');
  }
  if (!validateNickname(nickname)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'updateProfile: invalid nickname');
  }
  if (!validateAvatar(avatar)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'updateProfile: invalid avatar');
  }

  const ts = now instanceof Date ? now : new Date();
  const userCol = db.collection('User');
  const res = await userCol.where({ _openid: openid }).update({
    data: { nickname, avatar, updated_at: ts }
  });
  const updated = (res && res.stats && res.stats.updated) || 0;
  if (updated === 0) {
    // 理论上 requireUser 已挡；此处兜底（不暴露 openid 是否存在）
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'updateProfile: user not found');
  }
  return projectUpdateResult({ nickname, avatar, updated_at: ts });
}

/**
 * 注销账号（纯函数 + 注入式 db）。
 *
 * 流程：删 StepRecord where user_id=openid → 删 User where _openid=openid。
 * 幂等：删 0 条不抛错（防并发二次点击）。
 *
 * 孤儿数据防护（对齐 admin/deptManage.deleteDept 的注释风格）：
 *   - 不强删 RankCache：聚合缓存，由下次 tasks.rankAggregate 覆盖重建，强删反而引入空窗；
 *   - 无白名单集合（准入改邀请码，见 docs/邀请码机制.md），注销仅清本人数据；
 *   - 不删 Department：member_count 是聚合冗余，下次聚合任务自动校正。
 *
 * 注销后同微信再进入 = 新用户：OPENID 不变但 User 已删，auth.login 重新建号。
 *
 * 注意：wx-server-sdk 的 where().remove() 单次上限 20 条，StepRecord 可能超量。
 *   真实库由 user/index.js 的 wrapRemoveAll 包循环；本纯函数对注入 db 直接 remove 一次
 *   （mockDb 无此限，单测一次即可观察语义）。
 *
 * @param {object} params
 * @param {string} params.openid 当前用户 openid
 * @param {object} params.db 数据库句柄（真实库应为 wrapRemoveAll 包过的代理）
 * @returns {Promise<{deleted_steps: number, deleted_user: number}>}
 * @throws {BizError} AUTH_NO_OPENID / SYS_DB_ERROR
 */
async function cancelAccount(params) {
  const { openid, db } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'cancelAccount: openid required');
  }
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'cancelAccount: db with collection() is required');
  }

  // 先删步数记录（StepRecord.user_id = openid；rankAggregate 以此关联用户）
  const stepRes = await db.collection('StepRecord').where({ user_id: openid }).remove();
  const deleted_steps = (stepRes && stepRes.stats && stepRes.stats.removed) || 0;

  // 再删 User 文档
  const userRes = await db.collection('User').where({ _openid: openid }).remove();
  const deleted_user = (userRes && userRes.stats && userRes.stats.removed) || 0;

  return { deleted_steps, deleted_user };
}

module.exports = {
  validateNickname,
  validateAvatar,
  projectUpdateResult,
  updateProfile,
  cancelAccount,
  NICKNAME_MAX_LEN,
  AVATAR_MAX_LEN
};
