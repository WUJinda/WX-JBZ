/**
 * activity 云函数入口：活动（对齐技术架构 §4.1 / §5.4，开发计划阶段 C，PRD F7）。
 * Action: current / save
 *
 * 红线（游客可见）：
 *   - current 允许游客访问（无 OPENID 也能取活动信息）——不强制 authMiddleware；
 *   - 身份完全以 cloud.getWXContext().OPENID 为可信来源，不使用任何自管 token；
 *   - save（H1 后台发布）需鉴权，本轮不实现。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { getCurrent } = require('./activityStatus');

/**
 * 游客友好地取 openid：无 OPENID 不抛错，返回空串。
 * （current 不强制身份；仅当后续需要「我的报名状态」时才用 openid。）
 * @param {() => {OPENID?: string}} getWXContext
 * @returns {string}
 */
function safeOpenid(getWXContext) {
  try {
    const ctx = (typeof getWXContext === 'function' ? getWXContext() : {}) || {};
    return ctx.OPENID || '';
  } catch (e) {
    return '';
  }
}

// handler 表：action -> handler。handler 只做「取上下文 → 调纯函数 → 组装出入参」。
const handlers = {
  // C1: 当前活动 + 状态推算 + 全员概览（游客可调）
  // 本地轨：mock 当前活动 / 概览 / join_status（真实云读留云轨联调 / D1 / G）
  current: async (event) => {
    const openid = safeOpenid(cloud.getWXContext);
    // 游客 join_status 恒为 pending（本地轨 mock；真实 user.join 留 D1）
    const joinStatus = openid ? 'pending' : 'pending';
    return getCurrent({
      openid,
      joinStatus,
      overview: { total_steps: 0, participant_count: 0 }
    });
  }
  // save: async (event, context) => { ... }   // H1 (admin)
};

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'activity.' + action : 'activity.<empty>');
      return fail(err.code, err.message);
    }
    // current 游客可调：不经 authMiddleware（避免无 OPENID 抛 AUTH_NO_OPENID）。
    // 后续需鉴权的 action（如 save）在此分支内单独走 authMiddleware。
    const data = await handler(event, {});
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'activity error');
  }
};

module.exports = exports;
