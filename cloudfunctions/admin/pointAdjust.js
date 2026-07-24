/**
 * admin.adjustPoints 纯函数（管理员手动调整用户积分，对齐 changeDept.changeUserDept 范式）。
 *
 * 职责：校验 userId 存在 + delta 为整数 → user.points += delta + updated_at=now；
 *   返回 { userId, points, delta, updatedAt }。
 *
 * 调整方式 = 增减 delta（管理员输入变动值如 +3/-5），与「仅余额字段、无流水」自洽。
 * delta 必须整数（可负）；缺失/非整数抛 BIZ_PARAM_MISSING。允许 0（幂等成功）。
 * 结果 points 允许为负（不强制 ≥0，保持简单）。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。鉴权由 handler 经 assertAdmin 承担（纯函数不做）。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 管理员手动调整用户积分（增减 delta）。
 * @param {object} store mock db（{ User: object[] }）
 * @param {object} params
 * @param {string} params.userId 目标用户 id（User._id）
 * @param {number} params.delta 变动值（整数，可负；event 经 JSON 可能传字符串，内部 Number() 归一）
 * @param {string} params.now 当前时间 ISO
 * @returns {{userId: string, points: number, delta: number, updatedAt: string}}
 * @throws {BizError} AUTH_USER_NOT_FOUND(1002) userId 缺失/用户不存在；BIZ_PARAM_MISSING(2005) delta 缺失/非整数
 */
function adjustPoints(store, params) {
  const p = params || {};
  const { userId, delta, now } = p;

  if (!userId) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'adjustPoints: userId required');
  }
  if (!store || !Array.isArray(store.User)) {
    throw BizError(CODE.SYS_DB_ERROR, 'adjustPoints: store.User is required');
  }

  // delta 校验：必须是整数（可负）。event 经 JSON 可能传字符串，先 Number() 归一。
  const deltaNum = Number(delta);
  if (!Number.isInteger(deltaNum)) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'adjustPoints: delta must be an integer');
  }

  const user = store.User.find((u) => u && u._id === userId);
  if (!user) {
    throw BizError(CODE.AUTH_USER_NOT_FOUND, 'adjustPoints: user not found');
  }

  user.points = (Number(user.points) || 0) + deltaNum;
  user.updated_at = now;

  return { userId, points: user.points, delta: deltaNum, updatedAt: now };
}

module.exports = { adjustPoints };
