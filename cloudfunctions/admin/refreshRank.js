/**
 * admin.refreshRank 云轨粘合函数 —— 管理员一键刷新排行榜的业务部分。
 *
 * 职责：复用 tasks.rankAggregate（callFunction 转发）→ 返回摘要。
 *   不重复聚合逻辑（tasks 已封装 loadByWhere + aggregateRanking + 覆盖写 RankCache，幂等）。
 *
 * 守卫（assertAdmin）在 admin/index.js 的 refreshRank handler 入口完成（与 dashboard 等
 *   admin action 同范式：index.js 守卫 + 调纯函数/粘合函数），故本函数不做鉴权。
 *
 * 场景：排查榜单问题 / 用户同步后榜单未即时更新时，管理员手动兜底刷新，不必等 10 分钟定时任务。
 *
 * 独立成文件（不 require wx-server-sdk，cloud 注入）便于本地单测注入 mock cloud——
 *   admin/index.js 顶部模块级 require wx-server-sdk + cloud.init，本地无 sdk 时整个 index.js
 *   无法在测试环境 require；本模块把「刷新」动作抽成可注入 cloud 的纯包装，符合双轨可测约定
 *   （与 auth/index.js handleRegister 同范式）。
 *
 * 解耦：本模块不 require wx-server-sdk，cloud 由调用方（admin/index.js）注入。
 */

const { CODE, BizError } = require('../common/errors');
const { loadByWhere } = require('../common/db');
const { deriveStatus } = require('../activity/activityStatus');

/**
 * 查找当前「进行中」（active）的活动，返回其 activity_id。
 *
 * pickCurrentActivity 按 active→pending→ended 优先级选当前活动，
 * 当有未开始的新活动（pending）时它会顶替旧活动成为 current——
 * 但排行榜刷新必须针对「进行中」的活动聚合才有意义。
 *
 * @param {object} cloud
 * @returns {Promise<object|null>} 进行中的活动文档，或 null（无进行中活动）
 */
async function findActiveActivity(cloud) {
  const activities = await loadByWhere(cloud, 'Activity', {});
  if (!Array.isArray(activities) || !activities.length) return null;
  const now = new Date();
  return activities.find((a) => a && deriveStatus(a, now) === 'active') || null;
}

/**
 * 触发 tasks.rankAggregate 聚合并返回摘要（覆盖写 RankCache，幂等）。
 *
 * 活动绑定规则：强制绑定到「进行中」（active）的活动。
 *   - 忽略前端传入的 activity_id（可能是 pending 新活动）；
 *   - 从库中查找 status==='active' 的活动，找到则用它；
 *   - 无进行中活动 → 抛 BIZ_PARAM_MISSING，前端提示「没有进行中的活动」。
 *
 * @param {object} params
 * @param {object} params.cloud 注入的 wx-server-sdk cloud 实例（callFunction / database）
 * @param {object} [params.event] { activity_id? }（已忽略，强制使用进行中活动）
 * @returns {Promise<object>} { activity_id, personal_count, dept_count, updated_at }
 * @throws {BizError} BIZ_PARAM_MISSING（无进行中活动）/ SYS_DB_ERROR（tasks 聚合异常）
 */
async function handleRefreshRank({ cloud, event }) {
  const active = await findActiveActivity(cloud);
  if (!active) {
    throw BizError(
      CODE.BIZ_PARAM_MISSING,
      '没有进行中的活动，无法刷新排行榜（当前活动可能未开始或已结束）'
    );
  }
  const activityId = active.activity_id || active._id;
  const res = await cloud.callFunction({
    name: 'tasks',
    data: { action: 'rankAggregate', activity_id: activityId }
  });
  const result = res && res.result;
  if (!result || result.code !== 0) {
    // tasks 聚合异常（缺集合 / 超时等）→ 上抛，前端提示失败（P1-3 不假成功）。
    throw BizError(
      CODE.SYS_DB_ERROR,
      '刷新榜单失败：' + ((result && result.message) || 'tasks 聚合异常')
    );
  }
  const rankData = (result && result.data) || {};
  const personal = Array.isArray(rankData.personal) ? rankData.personal : [];
  const dept = Array.isArray(rankData.dept) ? rankData.dept : [];
  return {
    activity_id: activityId,
    personal_count: personal.length,
    dept_count: dept.length,
    updated_at: rankData.updatedAt || null
  };
}

module.exports = { handleRefreshRank };
