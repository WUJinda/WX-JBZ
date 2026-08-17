/**
 * steps.trend 业务纯函数（对齐 PRD F4 R4.2，开发计划阶段 F4）。
 *
 * 趋势图：返回最近 `range` 天（含今日）的每日有效步数序列，按 date 升序；
 * 区间内无记录的日期补 steps:0；无任何有效记录时 empty=true（R4.3 空态）。
 *
 * 复用约定（与 stepsQuery 一致，绝不另立口径）：
 *   - 「有效步数」= 活动期内已同步的非未来日（isValidStepRecord，不依赖 locked；activity 缺失→不过滤活动期）。
 *   - 日期计算复用 stepsSync.dateFromTimestamp(ts, timezoneOffsetMinutes)。
 *   - 配置复用 stepsSync.DEFAULT_CONFIG。
 *
 * 红线：
 *   - 身份仅 OPENID；不下发 _openid / sync_count 等敏感字段（用 projectTrend 投影）。
 *
 * 本地轨：records/now/config 注入式，纯函数可单测；不调真实微信云 API。
 */

const { dateFromTimestamp, activityStartDate, activityEndDate, isValidStepRecord, DEFAULT_CONFIG } = require('./stepsSync');

/**
 * 取某用户某活动的全部 StepRecord（按 date 升序）。
 * 与 stepsQuery.getUserRecords 同口径，这里独立导出避免循环依赖耦合。
 * @param {object[]} records StepRecord 数组（已按 user/activity 过滤的子集）
 * @returns {object[]}
 */
function sortRecords(records) {
  return (records || [])
    .filter((r) => r && typeof r.date === 'string')
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 趋势项下发投影：从 StepRecord 摘出可下发前端的字段。
 * 红线：不下发 _openid / sync_count / user_id。
 * @param {object} rec
 * @returns {{date:string, steps:number}}
 */
function projectTrend(rec) {
  const r = rec || {};
  return {
    date: r.date || '',
    steps: typeof r.steps === 'number' ? r.steps : Number(r.steps) || 0
  };
}

/**
 * 构造最近 `range` 天的日期序列（含 today），按 date 升序。
 * @param {string} today YYYY-MM-DD
 * @param {number} range 天数（≥1）
 * @returns {string[]}
 */
function buildDateRange(today, range) {
  const n = Math.max(1, Math.floor(Number(range) || 0));
  if (!today) return [];
  // today 为北京时间 YYYY-MM-DD；用 UTC 安全构造「当日 0 点 + 偏移」再减天。
  const ms = Date.parse(today + 'T00:00:00+08:00');
  if (!Number.isFinite(ms)) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(ms - i * dayMs);
    // 复用 dateFromTimestamp：把「北京日 0 点」对应的时间戳按北京时区再格式化，确保日期对齐。
    out.push(dateFromTimestamp(Math.floor(d.getTime() / 1000), 480));
  }
  return out;
}

/**
 * trend 主逻辑（纯函数）。
 *
 * @param {object} params
 * @param {object[]} params.records 该用户该活动的 StepRecord 子集（含有效与无效，内部按口径过滤）
 * @param {number} [params.range=7] 区间天数（≥1 正整数，由调用方按活动持续天数动态传入）
 * @param {object} [params.activity] 活动文档（含 start_time；算活动期起点过滤活动期外脏记录）
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @param {object} [params.config] 配置覆盖（timezoneOffsetMinutes）
 * @returns {{list:{date:string,steps:number}[], range:number, empty:boolean}}
 */
function buildTrend(params) {
  const p = params || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, p.config || {});
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const today = dateFromTimestamp(
    Math.floor(nowDate.getTime() / 1000),
    cfg.timezoneOffsetMinutes
  );

  // range 兜底：接受任意 ≥1 正整数（活动总天数动态传入），缺省/非法 → 7。
  let range = Math.floor(Number(p.range));
  range = range >= 1 ? range : 7;

  const recs = sortRecords(p.records);

  // 有效步数口径（全链路统一 isValidStepRecord）：活动期内已同步的非未来日，不依赖 locked。
  // activity 缺失 → startDate='' → 不强加左界（兜底，与 today/history 同口径）。
  const startDate = activityStartDate(p.activity, cfg.timezoneOffsetMinutes);
  const endDate = activityEndDate(p.activity, cfg.timezoneOffsetMinutes);
  const valid = recs.filter((r) => isValidStepRecord(r, today, startDate, endDate));

  // 按 date 聚合：同日多条求和（理论上 (user,date) 唯一，聚合稳健）。
  const map = new Map();
  valid.forEach((r) => {
    const s = Number(r.steps) || 0;
    map.set(r.date, (map.get(r.date) || 0) + s);
  });

  const dates = buildDateRange(today, range);
  const list = dates.map((date) =>
    projectTrend({ date, steps: map.get(date) || 0 })
  );

  // empty=true 当且仅当区间内全部为 0（区间内无任何有效步数数据，R4.3 空态）。
  // 区间外的有效记录不影响趋势图空态判定（趋势图只看区间内）。
  const empty = list.every((it) => it.steps === 0);

  return { list, range, empty };
}

module.exports = { buildTrend, buildDateRange, projectTrend, sortRecords };
