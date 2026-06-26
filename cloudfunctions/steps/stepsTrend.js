/**
 * steps.trend 业务纯函数（对齐 PRD F4 R4.2，开发计划阶段 F4）。
 *
 * 趋势图：返回最近 `range` 天（含今日）的每日有效步数序列，按 date 升序；
 * 区间内无记录的日期补 steps:0；无任何有效记录时 empty=true（R4.3 空态）。
 *
 * 复用约定（与 stepsQuery 一致，绝不另立口径）：
 *   - 「有效步数」= locked=true 的记录 OR 今日（now 所在日）已入库的记录（架构 §6.3）。
 *   - 日期计算复用 stepsSync.dateFromTimestamp(ts, timezoneOffsetMinutes)。
 *   - 配置复用 stepsSync.DEFAULT_CONFIG。
 *
 * 红线：
 *   - 身份仅 OPENID；不下发 _openid / sync_count 等敏感字段（用 projectTrend 投影）。
 *
 * 本地轨：records/now/config 注入式，纯函数可单测；不调真实微信云 API。
 */

const { dateFromTimestamp, DEFAULT_CONFIG } = require('./stepsSync');

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
 * @param {number} [params.range=7] 区间天数，仅接受 7 / 30，其余按 7 兜底（调用方兜底；此处再次兜底）
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

  // range 兜底：仅接受 7 / 30，其余按 7。
  let range = Number(p.range);
  range = range === 30 ? 30 : 7;

  const recs = sortRecords(p.records);

  // 有效步数口径：locked || date===today（与 stepsQuery 完全一致）。
  const valid = recs.filter((r) => r.locked || r.date === today);

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
