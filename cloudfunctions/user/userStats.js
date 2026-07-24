/**
 * user.stats 业务纯函数（对齐 PRD F4 R4.1/R4.4，开发计划阶段 F4）。
 *
 * 个人主页统计：
 *   - today_steps  当日步数（今日已入库）
 *   - total_steps  累计有效步数（活动期内已同步的非未来日）
 *   - total_days   活动期天数（start_date ~ 今日，activity 缺失/未开始 → 0）
 *   - active_days  已参与天数（有效步数记录的不同 date 数）
 *   - my_rank      本地轨占位 null（真实排名留 F5）
 *
 * 复用约定（与 stepsQuery 完全一致，绝不另立口径）：
 *   - 「有效步数」= 活动期内已同步的非未来日（isValidStepRecord，不依赖 locked）。
 *     locked 仅作 syncSteps 写入「禁止覆盖」标记，详见 stepsSync.isValidStepRecord。
 *   - today_steps / total_steps 口径直接复用 stepsQuery.getToday。
 *   - 日期计算复用 stepsSync.dateFromTimestamp。
 *
 * 红线：
 *   - 身份仅 OPENID；不下发 _openid / sync_count / user_id（本函数输出无敏感字段）。
 *
 * 本地轨：records/activity/now/config 注入式，纯函数可单测；不调真实微信云 API。
 */

const { dateFromTimestamp, activityStartDate, activityEndDate, isValidStepRecord, DEFAULT_CONFIG } = require('../steps/stepsSync');

/**
 * 取该用户该活动的全部 StepRecord（按 date 升序）。
 * @param {object[]} records
 * @returns {object[]}
 */
function sortRecords(records) {
  return (records || [])
    .filter((r) => r && typeof r.date === 'string')
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 统计某 activity 的活动期天数：start_date ~ min(end_date, today)（含两端），不足 0 → 0。
 * activity 缺失 / start_time 缺失 / 未开始 → 0。
 * 若有 end_time，右界取 min(end_date, today)（活动结束后天数不再增加）。
 *
 * @param {object} activity { start_time, end_time }
 * @param {string} today YYYY-MM-DD（北京日）
 * @param {number} offsetMinutes 时区偏移
 * @returns {number}
 */
function calcTotalDays(activity, today, offsetMinutes) {
  const a = activity || {};
  if (!a.start_time) return 0;
  const startMs = Date.parse(a.start_time);
  if (!Number.isFinite(startMs)) return 0;
  const startDate = dateFromTimestamp(Math.floor(startMs / 1000), offsetMinutes);
  if (!startDate || !today) return 0;
  if (today < startDate) return 0; // 未开始
  // 右界：若有 end_time，取 min(end_date, today)；无 end_time 则取 today。
  const endDate = activityEndDate(a, offsetMinutes);
  const upperDay = endDate && endDate < today ? endDate : today;
  // 含两端的天数：(upperDay - start) / 天 + 1。
  const upperMs = Date.parse(upperDay + 'T00:00:00+08:00');
  const sMs = Date.parse(startDate + 'T00:00:00+08:00');
  if (!Number.isFinite(upperMs) || !Number.isFinite(sMs)) return 0;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((upperMs - sMs) / dayMs) + 1;
}

/**
 * stats 主逻辑（纯函数）。
 *
 * @param {object} params
 * @param {object[]} params.records 该用户该活动的 StepRecord 子集（含有效与无效，内部按口径过滤）
 * @param {object} [params.activity] 活动文档（含 start_time；缺失则 total_days=0）
 * @param {object} [params.myRank] 本人排名行（P1-11，handler 从 RankCache 查传入；缺省 null=未进榜/未聚合）
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @param {object} [params.config] 配置覆盖（timezoneOffsetMinutes）
 * @returns {{today_steps:number, total_steps:number, total_days:number, active_days:number, my_rank:object|null}}
 */
function buildStats(params) {
  const p = params || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, p.config || {});
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const today = dateFromTimestamp(
    Math.floor(nowDate.getTime() / 1000),
    cfg.timezoneOffsetMinutes
  );

  const recs = sortRecords(p.records);

  // 活动期起点/终点：累计/参与天数仅算活动期内（start_date ~ end_date），过滤活动期外脏记录。
  // activity 缺失 → '' → 不强加过滤（兜底）。
  const startDate = activityStartDate(p.activity, cfg.timezoneOffsetMinutes);
  const endDate = activityEndDate(p.activity, cfg.timezoneOffsetMinutes);

  // 有效步数口径（全链路统一 isValidStepRecord）：活动期内已同步的非未来日，不依赖 locked。
  const valid = recs.filter((r) => isValidStepRecord(r, today, startDate, endDate));

  // today_steps：当日有效步数。
  const todayRec = valid.find((r) => r.date === today);
  const todaySteps = todayRec ? Number(todayRec.steps) || 0 : 0;

  // total_steps：累计有效步数（locked + 今日）。
  const totalSteps = valid.reduce((sum, r) => sum + (Number(r.steps) || 0), 0);

  // active_days：有效记录的不同 date 数。
  const dateSet = new Set(valid.map((r) => r.date));
  const activeDays = dateSet.size;

  // total_days：活动期天数（start_date ~ 今日）。
  const totalDays = calcTotalDays(p.activity, today, cfg.timezoneOffsetMinutes);

  // my_rank：注入的本人排名（P1-11，handler 从 RankCache personal 查传入；null=未进榜/未聚合）。
  return {
    today_steps: todaySteps,
    total_steps: totalSteps,
    total_days: totalDays,
    active_days: activeDays,
    my_rank: p.myRank || null
  };
}

module.exports = { buildStats, calcTotalDays, sortRecords };
