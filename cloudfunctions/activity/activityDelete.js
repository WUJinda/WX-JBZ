/**
 * activity.delete 业务纯函数（管理员硬删除活动 + 连带清理该活动的步数/榜单）。
 *
 * 业务规则（与用户确认）：
 *   - 删除 = 硬删除：彻底移除活动文档 + 连带清理该 activity_id 下的 StepRecord/RankCache。
 *     Department 不删——部门是相对固定的组织结构数据，与活动生命周期无关。
 *     区别于 terminate（软终止 terminated=true，文档保留、榜单冻结）。
 *   - 不可恢复（与 terminate 同为危险操作，前端二次确认 + 危险样式）。
 *   - 重置 User.join_status（云轨 resetUserJoinStatusToCloud 把 joined → pending，参与人数归零；
 *     join_status 全局不绑 activity_id，不清则删活动后看板参与人数仍是旧值）。dept_id 不动（部门与活动无关）。
 *   - 找不到活动 → BIZ_PARAM_MISSING。
 *   - 状态守卫（决策1，2026-07-10）：仅 ended（已结束）或 terminated（已终止）活动可删；
 *     进行中 active / 未开始 pending 删活动会丢失在跑数据 → BIZ_ACTIVITY_NOT_REMOVABLE。
 *
 * 与 terminate 的结构差异：
 *   - terminate 纯函数就地改文档（terminated=true）→ 云轨 upsert 写回；
 *   - delete 是 doc.remove（无法 upsert），故纯函数只做「校验 + 返回被删活动定位信息」，
 *     实际批量删除在云轨 deleteActivityToCloud（where().remove() 删 Activity/StepRecord/RankCache）。
 *
 * 红线：
 *   - 管理员鉴权由 handler 经 assertAdmin 承担，本纯函数不做鉴权；
 *   - 不调云 API、不 require wx-server-sdk。
 *
 * 本地轨：store 注入式 { Activity: object[] }，纯函数可单测（校验逻辑）。
 */

const { CODE, BizError } = require('../common/errors');
const { deriveStatus } = require('./activityStatus');

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
 * @param {Date|number} [params.now] 当前时间（状态守卫推算用，注入便于单测；默认 deriveStatus 内部 new Date()）
 * @returns {object} projectDeletedActivity 结果（含 activity_id 供云轨批量 remove）
 * @throws {BizError}
 *   - activity_id 空 / 活动不存在 → BIZ_PARAM_MISSING
 *   - store.Activity 缺失 → SYS_DB_ERROR
 *   - 活动进行中/未开始（非 ended/terminated）→ BIZ_ACTIVITY_NOT_REMOVABLE
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
  // 决策1：仅已结束（ended）或已终止（terminated）活动可删；进行中/未开始删活动会丢失在跑数据，拒绝。
  //   deriveStatus 优先判 terminated→ended，故 terminated 活动 status 必为 ended；显式判 terminated 更清晰。
  const status = deriveStatus(activity, p.now === undefined ? undefined : p.now);
  if (activity.terminated !== true && status !== 'ended') {
    throw BizError(
      CODE.BIZ_ACTIVITY_NOT_REMOVABLE,
      '活动进行中或未开始，不可删除（仅已结束或已终止的活动可删除）'
    );
  }
  return projectDeletedActivity(activity);
}

module.exports = { deleteActivity, projectDeletedActivity };
