/**
 * admin.buildDashboard 数据看板纯函数（对齐技术架构 §122/§6.6，PRD F8 R8.5）。
 *
 * 指标（PRD F8 数据看板指标定义 §420–428）：
 *   - participated：store.User 中 join_status==='joined' 计数。
 *   - whitelistTotal：store.Whitelist 计数。
 *   - rate：participated / whitelistTotal，除零→0。
 *   - totalSteps：store.StepRecord 中有效步数口径（locked || date===today）的 steps 求和。
 *   - validParticipants：至少有一条有效 StepRecord 的不同 user_id 数。
 *   - avgSteps：totalSteps / validParticipants，除零→0。
 *   - dailyActive：按 date 分组，每日 count distinct user_id（有同步行为）；近 trendDays 天升序，缺日补 0。
 *   - deptRank：直接读 store.RankCache（type==='dept' && activity_id）按 rank 升序（R8.5 复用，不重算）。
 *
 * 红线：
 *   - 有效步数口径复用 `locked || date===today`（与 stepsQuery/rankAggregate 一致，禁止另立）。
 *   - deptRank 复用 RankCache，绝不重算（R8.5）。
 *   - 投影脱敏，不下发 _openid / phone / sync_count。
 *
 * 本地轨：store/now/config 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

const { dateFromTimestamp, DEFAULT_CONFIG } = require('../steps/stepsSync');

const DEFAULT_TREND_DAYS = 30;

/**
 * 有效步数口径（复用 stepsQuery / rankAggregate：locked || date===today）。
 * @param {object} r StepRecord
 * @param {string} today
 * @returns {boolean}
 */
function isValidRecord(r, today) {
  return !!r.locked || r.date === today;
}

/**
 * dept 榜投影：透传 RankCache 已聚合字段，不下发敏感字段。
 * @param {object} row RankCache(dept) 文档
 * @returns {object}
 */
function projectDeptRank(row) {
  const r = row || {};
  return {
    rank: r.rank,
    dept_id: r.dept_id,
    total_steps: r.total_steps,
    avg_steps: r.avg_steps,
    member_count: r.member_count,
    small_sample: !!r.small_sample,
    dept_name: r.dept_name || ''
  };
}

/**
 * 构建数据看板。
 *
 * @param {object} params
 * @param {object} params.store mock db（{ User, Whitelist, StepRecord, RankCache }）
 * @param {string} [params.activityId] 活动 id（用于过滤 StepRecord / RankCache）
 * @param {Date} [params.now=new Date()] 注入时间
 * @param {object} [params.config] 配置覆盖（timezoneOffsetMinutes / trendDays）
 * @returns {object} { participated, whitelistTotal, rate, totalSteps, avgSteps, validParticipants, dailyActive, deptRank }
 */
function buildDashboard(params) {
  const p = params || {};
  const store = p.store || {};
  const activityId = p.activityId;

  const cfg = Object.assign(
    {},
    { timezoneOffsetMinutes: DEFAULT_CONFIG.timezoneOffsetMinutes, trendDays: DEFAULT_TREND_DAYS },
    p.config || {}
  );
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const today = dateFromTimestamp(Math.floor(nowDate.getTime() / 1000), cfg.timezoneOffsetMinutes);

  const users = Array.isArray(store.User) ? store.User : [];
  const whitelist = Array.isArray(store.Whitelist) ? store.Whitelist : [];
  const records = Array.isArray(store.StepRecord) ? store.StepRecord : [];
  const rankCache = Array.isArray(store.RankCache) ? store.RankCache : [];

  // 1. 参与人数（已报名）。
  const participated = users.filter((u) => u && u.join_status === 'joined').length;

  // 2. 白名单总人数。
  const whitelistTotal = whitelist.length;

  // 3. 参与率（除零→0）。
  const rate = whitelistTotal > 0 ? participated / whitelistTotal : 0;

  // 4. 有效步数（口径 locked || date===today），按 activity_id 过滤。
  const activityRecords = records.filter(
    (r) => r && (activityId == null || r.activity_id === activityId)
  );
  const validRecords = activityRecords.filter((r) => isValidRecord(r, today));

  const totalSteps = validRecords.reduce((sum, r) => sum + (Number(r.steps) || 0), 0);

  // 5. 有效参与人数（至少一条有效 StepRecord 的不同 user_id）。
  const validUserSet = new Set();
  for (const r of validRecords) {
    if (r.user_id) validUserSet.add(r.user_id);
  }
  const validParticipants = validUserSet.size;

  // 6. 人均步数（除零→0）。
  const avgSteps = validParticipants > 0 ? totalSteps / validParticipants : 0;

  // 7. 日活：按 date 分组，每日 count distinct user_id（有同步行为）。
  //    口径：以「有同步行为」为准 → 即所有 StepRecord（不限有效，只要有记录即视为当日有同步）。
  //    返回近 trendDays 天升序，缺日补 0。
  const dailyMap = new Map(); // date -> Set(user_id)
  for (const r of activityRecords) {
    if (!r || !r.date || !r.user_id) continue;
    if (!dailyMap.has(r.date)) dailyMap.set(r.date, new Set());
    dailyMap.get(r.date).add(r.user_id);
  }

  const dailyActive = buildDailyActiveTrend(dailyMap, today, cfg.trendDays);

  // 8. deptRank：复用 RankCache（type==='dept'），按 rank 升序（R8.5 不重算）。
  let deptRows = rankCache
    .filter((r) => r && r.type === 'dept' && (activityId == null || r.activity_id === activityId))
    .slice()
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const deptRank = deptRows.map(projectDeptRank);

  return {
    participated,
    whitelistTotal,
    rate,
    totalSteps,
    avgSteps,
    validParticipants,
    dailyActive,
    deptRank
  };
}

/**
 * 由 dailyMap 构建近 trendDays 天的趋势（含今日，升序，缺日补 0）。
 * @param {Map<string, Set<string>>} dailyMap
 * @param {string} today YYYY-MM-DD
 * @param {number} trendDays
 * @returns {Array<{date: string, count: number}>}
 */
function buildDailyActiveTrend(dailyMap, today, trendDays) {
  const days = Math.max(1, Number(trendDays) || DEFAULT_TREND_DAYS);
  // 解析 today 为 Date（基于 today 字符串 YYYY-MM-DD，按本地午夜构造，逐日回退）。
  const parts = String(today).split('-').map((x) => Number(x));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return [];
  }
  const result = [];
  // 从 trendDays-1 天前到今天，逐日构造 YYYY-MM-DD。
  // 用 UTC 构造避免时区抖动（仅做日期字符串运算）。
  const baseMs = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(baseMs - i * 24 * 60 * 60 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const dateStr = y + '-' + m + '-' + day;
    const set = dailyMap.get(dateStr);
    result.push({ date: dateStr, count: set ? set.size : 0 });
  }
  return result;
}

module.exports = {
  buildDashboard,
  buildDailyActiveTrend,
  projectDeptRank,
  isValidRecord,
  DEFAULT_TREND_DAYS
};
