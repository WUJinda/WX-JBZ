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
const { getActiveActivityId } = require('../activity/activityResolver');

/**
 * 触发 tasks.rankAggregate 聚合并返回摘要（覆盖写 RankCache，幂等）。
 *
 * @param {object} params
 * @param {object} params.cloud 注入的 wx-server-sdk cloud 实例（callFunction / database）
 * @param {object} [params.event] { activity_id? }（缺省走 getActiveActivityId 兜底当前活动）
 * @returns {Promise<object>} { activity_id, personal_count, dept_count, updated_at }
 * @throws {BizError} SYS_DB_ERROR（tasks 聚合异常 / activity_id 兜底失败）
 */
async function handleRefreshRank({ cloud, event }) {
  const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
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
