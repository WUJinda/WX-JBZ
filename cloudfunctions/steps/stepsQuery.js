/**
 * steps.today / steps.history 业务纯函数（对齐技术架构 §6.3/§5.5，PRD F3 R3.1，开发计划 E3）。
 *
 * 区分「有效步数」（参与排名/累计的口径）与「原始步数」：
 *   - 有效步数 = locked=true 的记录 OR 今日（now 所在日）已入库的记录（架构 §6.3「仅 locked 或今日已入库的有效步数」）。
 *   - 历史区间查询返回有效步数；today 返回当日已入库步数。
 *
 * 红线：
 *   - 身份仅 OPENID；不下发 _openid / sync_count 等敏感字段（用 projectStep 投影）。
 *
 * 本地轨：store/now/config 注入式，纯函数可单测；不调真实微信云 API。
 */

const { CODE, BizError } = require('../common/errors');
const { projectStep, dateFromTimestamp, activityStartDate, DEFAULT_CONFIG } = require('./stepsSync');

/**
 * 取某用户某活动的全部 StepRecord（按 date 升序）。
 * @param {object} store
 * @param {string} userId
 * @param {string} activityId
 * @returns {object[]}
 */
function getUserRecords(store, userId, activityId) {
  if (!store || !Array.isArray(store.StepRecord)) return [];
  return store.StepRecord
    .filter((r) => r && r.user_id === userId && r.activity_id === activityId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * steps.today 主逻辑（纯函数）。
 *
 * @param {object} params
 * @param {object} params.store
 * @param {string} params.userId
 * @param {string} params.activityId
 * @param {Date} [params.now]
 * @param {object} [params.config]
 * @returns {Promise<object>} { date, steps, abnormal, synced_at, total }
 * @throws {BizError} 缺参
 */
async function getToday(params) {
  const p = params || {};
  const { store, userId, activityId, activity } = p;
  if (!userId) throw BizError(CODE.AUTH_USER_NOT_FOUND, 'today: userId required');
  if (!activityId) throw BizError(CODE.BIZ_PARAM_MISSING, 'today: activityId required');
  if (!store || !Array.isArray(store.StepRecord)) {
    throw BizError(CODE.SYS_DB_ERROR, 'today: store.StepRecord is required');
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, p.config || {});
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const today = dateFromTimestamp(Math.floor(nowDate.getTime() / 1000), cfg.timezoneOffsetMinutes);

  const recs = getUserRecords(store, userId, activityId);
  const todayRec = recs.find((r) => r.date === today) || null;
  // 累计：仅有效步数（locked 或今日已入库），且在活动期内（过滤活动期外脏记录）。
  const startDate = activityStartDate(activity, cfg.timezoneOffsetMinutes);
  const total = recs
    .filter((r) => (r.locked || r.date === today) && (!startDate || r.date >= startDate))
    .reduce((sum, r) => sum + (Number(r.steps) || 0), 0);

  return {
    date: today,
    steps: todayRec ? Number(todayRec.steps) || 0 : 0,
    abnormal: todayRec ? !!todayRec.abnormal : false,
    synced_at: todayRec ? todayRec.synced_at : null,
    total
  };
}

/**
 * steps.history 主逻辑（纯函数）：区间查询，仅返回有效步数（locked 或今日已入库）。
 *
 * @param {object} params
 * @param {object} params.store
 * @param {string} params.userId
 * @param {string} params.activityId
 * @param {string} [params.from] YYYY-MM-DD（含）
 * @param {string} [params.to]   YYYY-MM-DD（含）
 * @param {Date} [params.now]
 * @param {object} [params.config]
 * @returns {Promise<object>} { list: projectStep[], total: number }
 * @throws {BizError} 缺参
 */
async function getHistory(params) {
  const p = params || {};
  const { store, userId, activityId, activity } = p;
  if (!userId) throw BizError(CODE.AUTH_USER_NOT_FOUND, 'history: userId required');
  if (!activityId) throw BizError(CODE.BIZ_PARAM_MISSING, 'history: activityId required');
  if (!store || !Array.isArray(store.StepRecord)) {
    throw BizError(CODE.SYS_DB_ERROR, 'history: store.StepRecord is required');
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, p.config || {});
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const today = dateFromTimestamp(Math.floor(nowDate.getTime() / 1000), cfg.timezoneOffsetMinutes);
  const from = p.from || '';
  const to = p.to || '';

  const recs = getUserRecords(store, userId, activityId);
  // 有效步数过滤：locked 或今日已入库，且在活动期内（过滤活动期外脏记录）。
  const startDate = activityStartDate(activity, cfg.timezoneOffsetMinutes);
  const valid = recs.filter(
    (r) => (r.locked || r.date === today) && (!startDate || r.date >= startDate)
  );
  // 区间过滤。
  const ranged = valid.filter((r) => {
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    return true;
  });
  const total = ranged.reduce((sum, r) => sum + (Number(r.steps) || 0), 0);
  return { list: ranged.map(projectStep), total };
}

module.exports = { getToday, getHistory, getUserRecords };
