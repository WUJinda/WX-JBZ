/**
 * 活动解析：从云库查当前活动（排除 terminated，active 优先）。
 *
 * 供 rank / user / tasks 等 handler 在 event.activity_id 缺省时兜底——
 * 替代旧的硬编码 'a_demo_001'（F1：假数据改实际查库）。
 *
 * 选「当前活动」口径与 activity.current handler 一致（均用 pickCurrentActivity）：
 *   非终止活动按 active → pending → ended 优先；无非终止活动时回退最近终止活动
 *   （员工端展示「已终止」tag + 查看战绩。终止活动作 current 时 steps.sync 经 terminated
 *   拦截拒绝同步、rank 聚合冻结数据，均安全）。getActivityById 则按 id 精确查
 *   （供 steps.sync 取活动文档传 syncSteps 做活动期过滤，与选取规则无关）。
 *
 * 解耦：依赖 loadByWhere（common/db）+ pickCurrentActivity（activityStatus），
 *   不 require wx-server-sdk（cloud 由 handler 注入）。
 */

const { loadByWhere } = require('../common/db');
const { pickCurrentActivity } = require('./activityStatus');

/**
 * 查当前活动 id（非终止优先 active→pending→ended；无非终止时回退最近终止活动；库空返回 ''）。
 *
 * @param {object} cloudSdk wx-server-sdk 实例
 * @param {Date|number} [now] 时间参考（可注入便于测试；默认 new Date()）
 * @returns {Promise<string>} activity_id（库空时 ''，handler 据此返回空榜/空统计）
 */
async function getActiveActivityId(cloudSdk, now) {
  const activities = await loadByWhere(cloudSdk, 'Activity');
  const picked = pickCurrentActivity(activities, now);
  return (picked && (picked.activity_id || picked._id)) || '';
}

/**
 * 查当前活动文档（非终止优先；无非终止时回退最近终止活动；库空返回 null）。
 * 供 user.stats 的 loadActivity 用（需完整活动文档算活动期天数 total_days）。
 *
 * @param {object} cloudSdk
 * @param {Date|number} [now]
 * @returns {Promise<object|null>}
 */
async function getActiveActivity(cloudSdk, now) {
  const activities = await loadByWhere(cloudSdk, 'Activity');
  return pickCurrentActivity(activities, now);
}

/**
 * 按 activity_id 精确查活动文档（供 steps.sync 等「需特定活动 start_time/end_time」的 handler）。
 *
 * 修复「累计步数过大」bug 的关键：sync handler 此前只读 event.activity（前端不传）→ undefined
 * → syncSteps 活动期过滤失效 → 微信运动近 30 天步数全量回灌。改由 handler 按 activity_id 查库
 * 取真实活动文档传入，活动期过滤（start_date ~ today）才生效，累计步数回到「活动期内累计」口径。
 *
 * Activity 集合小（单活动场景），一次全表拉取后内存匹配；兼容 activity_id 字段缺失、用 _id 作 id 的旧数据。
 *
 * @param {object} cloudSdk
 * @param {string} activityId
 * @returns {Promise<object|null>} 活动文档（含 start_time/end_time/status）或 null（空 id / 库空 / 未命中）
 */
async function getActivityById(cloudSdk, activityId) {
  if (!activityId) return null;
  const activities = await loadByWhere(cloudSdk, 'Activity');
  if (!Array.isArray(activities) || !activities.length) return null;
  return activities.find((a) => a && (a.activity_id === activityId || a._id === activityId)) || null;
}

module.exports = { getActiveActivityId, getActiveActivity, getActivityById };
