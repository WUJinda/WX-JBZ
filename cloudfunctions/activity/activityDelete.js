/**
 * activity.delete 业务纯函数（管理员硬删除活动 + 连带清理该活动的步数/榜单/部门）。
 *
 * 业务规则（与用户确认）：
 *   - 删除 = 硬删除：彻底移除活动文档 + 连带清理该 activity_id 下的 StepRecord/RankCache/Department。
 *     区别于 terminate（软终止 terminated=true，文档保留、榜单冻结）。
 *   - 不可恢复（与 terminate 同为危险操作，前端二次确认 + 危险样式）。
 *   - 不重置 User.join_status/dept_id（用户是全局表，删活动不改用户状态；参加新活动时自然更新）。
 *   - 找不到活动 → BIZ_PARAM_MISSING。
 *
 * 与 terminate 的结构差异：
 *   - terminate 纯函数就地改文档（terminated=true）→ 云轨 upsert 写回；
 *   - delete 是 doc.remove（无法 upsert），故纯函数只做「校验 + 返回被删活动定位信息」，
 *     实际批量删除在云轨 deleteActivityToCloud（where().remove() 删 Activity/StepRecord/RankCache/Department）。
 *
 * 红线：
 *   - 管理员鉴权由 handler 经 assertAdmin 承担，本纯函数不做鉴权；
 *   - 不调云 API、不 require wx-server-sdk。
 *
 * 本地轨：store 注入式 { Activity: object[] }，纯函数可单测（校验逻辑）。
 */

const { CODE, BizError } = require('../common/errors');

/**
 * 被删活动投影（供前端提示 + 云轨定位 activity_id）。
 * @param {object} a Activity 文档
 * @returns {object}
 */
function projectDeletedActivity(a) {
  return {
    activity_id: a.activity_id || '',
    name: a.name || '',
    start_time: a.start_time,
    end_time: a.end_time
  };
}

/**
 * 删除活动主逻辑（纯函数 + 注入式 store）。
 * 职责：校验活动存在 + 返回被删活动定位信息（实际删除在云轨 deleteActivityToCloud）。
 *
 * @param {object} store mock db（{ Activity: object[] }）
 * @param {object} params
 * @param {string} params.activity_id 目标活动 id
 * @returns {object} projectDeletedActivity 结果（含 activity_id 供云轨批量 remove）
 * @throws {BizError}
 *   - activity_id 空 / 活动不存在 → BIZ_PARAM_MISSING
 *   - store.Activity 缺失 → SYS_DB_ERROR
 */
function deleteActivity(store, params) {
  const p = params || {};
  const activityId = typeof p.activity_id === 'string' ? p.activity_id.trim() : '';
  if (!activityId) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'deleteActivity: activity_id required');
  }
  if (!store || !Array.isArray(store.Activity)) {
    throw BizError(CODE.SYS_DB_ERROR, 'deleteActivity: store.Activity is required');
  }
  const activity = store.Activity.find((a) => a && a.activity_id === activityId);
  if (!activity) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'deleteActivity: activity not found');
  }
  return projectDeletedActivity(activity);
}

module.exports = { deleteActivity, projectDeletedActivity };
