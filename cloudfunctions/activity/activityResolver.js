/**
 * 活动解析：从云库查当前活动（按时间推算 active 优先）。
 *
 * 供 rank / user / tasks 等 handler 在 event.activity_id 缺省时兜底——
 * 替代旧的硬编码 'a_demo_001'（F1：假数据改实际查库）。
 *
 * 解耦：依赖 loadByWhere（common/db）+ deriveStatus（activityStatus），
 *   不 require wx-server-sdk（cloud 由 handler 注入）。
 */

const { loadByWhere } = require('../common/db');
const { deriveStatus, STATUS } = require('./activityStatus');

/**
 * 查当前活动 id（active 优先；无 active 则取最近一条；库空返回 ''）。
 *
 * @param {object} cloudSdk wx-server-sdk 实例
 * @param {Date} [now] 时间参考（可注入便于测试；默认 new Date()）
 * @returns {Promise<string>} activity_id（库空时 ''，handler 据此返回空榜/空统计）
 */
async function getActiveActivityId(cloudSdk, now) {
  const activities = await loadByWhere(cloudSdk, 'Activity');
  if (!Array.isArray(activities) || !activities.length) return '';
  const cur = now instanceof Date ? now : new Date();
  const active = activities.find((a) => deriveStatus(a, cur) === STATUS.ACTIVE);
  const picked = active || activities[0];
  return (picked && (picked.activity_id || picked._id)) || '';
}

/**
 * 查当前活动文档（active 优先；库空返回 null）。
 * 供 user.stats 的 loadActivity 用（需完整活动文档算活动期天数 total_days）。
 *
 * @param {object} cloudSdk
 * @param {Date} [now]
 * @returns {Promise<object|null>}
 */
async function getActiveActivity(cloudSdk, now) {
  const activities = await loadByWhere(cloudSdk, 'Activity');
  if (!Array.isArray(activities) || !activities.length) return null;
  const cur = now instanceof Date ? now : new Date();
  const active = activities.find((a) => deriveStatus(a, cur) === STATUS.ACTIVE);
  return active || activities[0];
}

module.exports = { getActiveActivityId, getActiveActivity };
