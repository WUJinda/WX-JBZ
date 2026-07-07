/**
 * activity.terminate 业务纯函数（活动配置完善：管理员手动终止活动，不可恢复）。
 *
 * 业务规则（与用户确认）：
 *   - 终止 = 提前结束·不可恢复：置 terminated=true + terminated_at=now + status=ENDED；
 *     deriveStatus 优先判 terminated → 员工端立即见「已结束」，steps.sync 见 terminated 拒绝同步。
 *   - 幂等：已 terminated 再次调用不报错，保留首次 terminated_at（仅返回当前态）。
 *   - 找不到活动 → BIZ_PARAM_MISSING。
 *
 * 红线：
 *   - 管理员鉴权由 handler 经 assertAdmin 承担，本纯函数不做鉴权；
 *   - 不调云 API、不 require wx-server-sdk。
 *
 * 本地轨：store 注入式 { Activity: object[] }，纯函数可单测。
 */

const { CODE, BizError } = require('../common/errors');
const { STATUS } = require('./activityStatus');

/**
 * 终止活动投影（与 projectSavedActivity 风格一致，补 terminated/terminated_at）。
 * @param {object} a Activity 文档
 * @returns {object}
 */
function projectTerminatedActivity(a) {
  return {
    activity_id: a.activity_id || '',
    name: a.name || '',
    start_time: a.start_time,
    end_time: a.end_time,
    signup_deadline: a.signup_deadline || null,
    status: STATUS.ENDED,
    terminated: true,
    terminated_at: a.terminated_at || null,
    rules: a.rules || ''
  };
}

/**
 * 终止活动主逻辑（纯函数 + 注入式 store，就地改 store 中的活动文档）。
 *
 * @param {object} store mock db（{ Activity: object[] }）
 * @param {object} params
 * @param {string} params.activity_id 目标活动 id
 * @param {Date|number} [params.now] 当前时间（默认 new Date()）
 * @returns {object} projectTerminatedActivity 结果
 * @throws {BizError}
 *   - activity_id 空 / 活动不存在 → BIZ_PARAM_MISSING
 *   - store.Activity 缺失 → SYS_DB_ERROR
 */
function terminateActivity(store, params) {
  const p = params || {};
  const activityId = typeof p.activity_id === 'string' ? p.activity_id.trim() : '';
  if (!activityId) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'terminateActivity: activity_id required');
  }
  if (!store || !Array.isArray(store.Activity)) {
    throw BizError(CODE.SYS_DB_ERROR, 'terminateActivity: store.Activity is required');
  }
  const activity = store.Activity.find((a) => a && a.activity_id === activityId);
  if (!activity) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'terminateActivity: activity not found');
  }

  // 幂等：已终止则保持首次 terminated_at 不变，仅返回当前态。
  if (activity.terminated === true) {
    return projectTerminatedActivity(activity);
  }

  const nowIso = p.now != null
    ? (p.now instanceof Date ? p.now.toISOString() : new Date(p.now).toISOString())
    : new Date().toISOString();
  activity.terminated = true;
  activity.terminated_at = nowIso;
  activity.status = STATUS.ENDED;
  activity.updated_at = nowIso;
  return projectTerminatedActivity(activity);
}

module.exports = { terminateActivity, projectTerminatedActivity };
