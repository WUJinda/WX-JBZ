/**
 * user.profile 业务纯函数（对齐技术架构 §5/§8，开发计划 B5，PRD F1 个人资料页）。
 *
 * 红线：
 *   - 不下发原始 phone / openid / unionid（§8 敏感字段）；
 *   - 只下发：脱敏手机号、部门、累计步数、昵称、头像、报名状态、管理员标志 is_admin。
 *
 * 本地轨：db 以依赖注入方式传入（mock 集合可单测）；步数为占位（真实聚合留后续阶段）。
 */

const { CODE, BizError } = require('../common/errors');
const { maskPhone } = require('../common/mask');

/**
 * 累计步数投影：当前阶段步数为占位（真实聚合在 E/G 阶段）。
 * 对 null / undefined / 非数字统一兜底为 0。
 * @param {*} raw
 * @returns {number}
 */
function projectSteps(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * profile 下发投影：从 User 文档摘出可下发前端的字段。
 * 纯函数：不写库、不下发敏感字段。
 *
 * 入参 user 形态（来自 User 集合读取结果）：
 *   { nickname, avatar, phone, phone_masked?, dept_id, join_status, is_admin?, ... }
 *
 * @param {object} user
 * @returns {object} { nickname, avatar, phone_masked, dept_id, dept_name?, join_status, is_admin, total_steps }
 */
function projectProfile(user) {
  const u = user || {};
  return {
    nickname: u.nickname || '',
    avatar: u.avatar || '',
    // 优先用已存储的 phone_masked；缺失时按完整 phone 兜底脱敏
    // （绝不直接下发完整 phone）
    phone_masked: u.phone_masked || (u.phone ? maskPhone(u.phone) : ''),
    dept_id: u.dept_id || null,
    dept_name: u.dept_name || '', // 可选，需 join 时补（B5 阶段为占位空串）
    join_status: u.join_status || 'pending',
    // is_admin 非敏感（布尔标志），下发供前端 admin 入口门禁（profile.js adminVisible）。
    // 严格 ===true：只认布尔 true，防止字符串 'true'/1 等误判管理员（控制台须填布尔）。
    is_admin: u.is_admin === true,
    total_steps: projectSteps(u.total_steps)
  };
}

/**
 * profile 主逻辑（纯函数 + 注入式 db）。
 *
 * @param {object} params
 * @param {string} params.openid 当前用户 openid（由 handler 从 wxContext 取）
 * @param {object} params.db 数据库句柄
 * @returns {Promise<object>} projectProfile 结果
 * @throws {BizError} User 不存在
 */
async function getProfile(params) {
  const { openid, db } = params || {};
  if (!openid || typeof openid !== 'string') {
    throw BizError(CODE.AUTH_NO_OPENID, 'getProfile: openid required');
  }
  if (!db || typeof db.collection !== 'function') {
    throw BizError(CODE.SYS_DB_ERROR, 'getProfile: db with collection() is required');
  }

  const res = await db.collection('User').where({ _openid: openid }).get();
  const users = (res && res.data) || [];
  if (users.length === 0) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'getProfile: user not found');
  }
  return projectProfile(users[0]);
}

module.exports = { projectProfile, projectSteps, getProfile };
