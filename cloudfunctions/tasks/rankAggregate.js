/**
 * tasks.rankAggregate 业务纯函数（对齐技术架构 §6.3/§6.6/§5.6，PRD R5/R6）。
 *
 * 职责（聚合个人榜 + 部门榜，覆盖写 RankCache）：
 *   - 个人榜：
 *     · 遍历 StepRecord 按 user 聚合有效步数 total_steps（口径 = 活动期内已同步的非未来日，复用 stepsSync.isValidStepRecord）。
 *     · 算 first_reach_at（R5.1）：按 synced_at 升序遍历该用户有效 StepRecord，累加 steps，
 *       累计值首次 ≥ total_steps 的那条 record 的 synced_at。total_steps=0 的用户 first_reach_at=null。
 *     · 过滤 total_steps=0（R5.5 未产生有效步数不进榜）。
 *     · 按 total_steps desc / first_reach_at asc 排序，赋 rank。
 *     · 附脱敏 nickname + dept_name + dept_id（从 User/Department 关联）。
 *     · 覆盖写 RankCache(personal)。
 *   - 部门榜：
 *     · 按 dept 聚合 total=成员有效步数累加、member_count=有效成员数（R6.2：已报名+至少一次有效同步）、
 *       avg=total/member_count、small_sample=member_count<minMembers。
 *     · 默认按 avg 排（R6.1）；小部门（member_count<minMembers）排主榜之后并标 small_sample=true，但仍展示（§657）。
 *     · 覆盖写 RankCache(dept)。
 *
 * 红线：
 *   - 有效步数口径复用 stepsSync.isValidStepRecord（活动期内已同步即有效，不依赖 locked），与 stepsQuery/buildTrend 一致，禁止另立。
 *   - first_reach_at 必须「按 synced_at 升序累加，首次达到或超过」记录，不是最后一条也不是随便取。
 *   - total_steps=0 不进榜。
 *   - 投影脱敏 nickname，不下发 _openid / phone / sync_count。
 *   - 幂等：覆盖写 RankCache，重复执行无副作用（§6.3）。
 *
 * 本地轨：store/now/config 注入式，纯函数可单测；不调真实微信云 API。
 *
 * 解耦：本模块不 require wx-server-sdk。
 */

const { dateFromTimestamp, activityStartDate, isValidStepRecord, DEFAULT_CONFIG } = require('../steps/stepsSync');
const { maskNickname } = require('../common/mask');

/**
 * 默认配置（可被 params.config 覆盖）。
 */
const RANK_DEFAULT_CONFIG = {
  timezoneOffsetMinutes: DEFAULT_CONFIG.timezoneOffsetMinutes, // 北京时间 UTC+8
  minMembers: 3 // R6 小部门阈值（§657，默认 3，可配）：有效成员数 < 此值的部门不进人均主排名
};

/**
 * 取某活动下全部 StepRecord（store 注入）。
 * @param {object} store
 * @param {string} activityId
 * @returns {object[]}
 */
function getActivityRecords(store, activityId) {
  if (!store || !Array.isArray(store.StepRecord)) return [];
  return store.StepRecord.filter((r) => r && r.activity_id === activityId);
}

/**
 * 有效步数口径（复用 stepsSync.isValidStepRecord：活动期内已同步即有效，不依赖 locked）。
 * @param {object} r StepRecord
 * @param {string} today
 * @returns {boolean}
 */
function isValidRecord(r, today, startDate) {
  // 有效步数口径（全链路统一 isValidStepRecord）：活动期内已同步的非未来日，不依赖 locked。
  // 详见 stepsSync.isValidStepRecord 注释。startDate 缺失 → 不强加左界（兜底）。
  return isValidStepRecord(r, today, startDate);
}

/**
 * 算某用户有效记录的 first_reach_at（R5.1）。
 * 按 synced_at 升序遍历有效 StepRecord，累加 steps，累计值首次 ≥ total_steps 的那条 synced_at。
 * total_steps=0 → null。
 *
 * @param {object[]} validRecs 该用户的有效 StepRecord（口径已过滤）
 * @param {number} totalSteps 该用户有效步数总和
 * @returns {string|null} ISO synced_at 或 null
 */
function computeFirstReachAt(validRecs, totalSteps) {
  if (!totalSteps || totalSteps <= 0) return null;
  // 按 synced_at 升序排序（缺省视为最大，排末尾）。
  const sorted = (validRecs || [])
    .filter((r) => r && Number(r.steps) > 0)
    .slice()
    .sort((a, b) => {
      const sa = a.synced_at || '';
      const sb = b.synced_at || '';
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return 0;
    });
  let acc = 0;
  for (const r of sorted) {
    acc += Number(r.steps) || 0;
    // 累计首次达到或超过 total_steps → 记录该条 synced_at。
    if (acc >= totalSteps) {
      return r.synced_at || null;
    }
  }
  // 浮点累计误差兜底：理论上累加自身记录必然 ≥ total_steps，此处兜底返回最后一条。
  return sorted.length ? sorted[sorted.length - 1].synced_at || null : null;
}

/**
 * 聚合个人榜。
 * @param {object} params
 * @param {object} params.store
 * @param {string} params.activityId
 * @param {string} params.today
 * @returns {object[]} RankRow[]（已排序、赋 rank）
 */
function buildPersonalRanking({ store, activityId, today, startDate }) {
  const records = getActivityRecords(store, activityId);

  // 用户表：_openid → user（便于关联 dept_id/nickname）。
  // 关键：StepRecord.user_id 实际存的是 openid（steps handler 以 openid 作 user_id，
  // 见 steps/index.js `userId = event.user_id || openid`），故必须以 User._openid 为 key 关联；
  // 若误用 User._id（云库自动主键，与 openid 无关）作 key 会查不到 → nickname/dept 全空。
  const userMap = new Map();
  (Array.isArray(store.User) ? store.User : []).forEach((u) => {
    if (u && u._openid) userMap.set(u._openid, u);
  });

  // 按用户分组有效记录。
  const byUser = new Map(); // user_id -> { recs: [], total }
  for (const r of records) {
    if (!isValidRecord(r, today, startDate)) continue;
    const uid = r.user_id;
    if (!byUser.has(uid)) byUser.set(uid, { recs: [], total: 0 });
    const entry = byUser.get(uid);
    entry.recs.push(r);
    entry.total += Number(r.steps) || 0;
  }

  const rows = [];
  for (const [userId, entry] of byUser.entries()) {
    // R5.5：total_steps=0 不进榜。
    if (!entry.total || entry.total <= 0) continue;
    const user = userMap.get(userId) || {};
    const hasUserCollection = Array.isArray(store.User);
    // 仅展示已报名用户（join_status === 'joined'）；查不到 User（未建号/已退出）的裸步数记录不进榜
    // （user 为 {} 时 join_status 为 undefined → !== 'joined' → 不进榜）。
    // 本地轨裸 store（无 User 集合）放行（默认进榜），兼容无 User 的最小 store。
    if (hasUserCollection && user.join_status !== 'joined') continue;

    const firstReachAt = computeFirstReachAt(entry.recs, entry.total);
    const deptId = user.dept_id || '';
    const deptName = lookupDeptName(store, deptId, activityId);

    rows.push({
      user_id: userId,
      total_steps: entry.total,
      first_reach_at: firstReachAt,
      nickname: maskNickname(user.nickname || ''),
      dept_id: deptId,
      dept_name: deptName
    });
  }

  // 排序：total_steps desc / first_reach_at asc（R5.1）。
  // first_reach_at 为 null 理论上不出现（total>0 必有值）；null 排末尾。
  rows.sort((a, b) => {
    if (b.total_steps !== a.total_steps) return b.total_steps - a.total_steps;
    const fa = a.first_reach_at || '';
    const fb = b.first_reach_at || '';
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    return 0;
  });

  // 赋 rank（从 1 起）。
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  return rows;
}

/**
 * 查部门名（store 注入）。
 * @param {object} store
 * @param {string} deptId
 * @param {string} activityId
 * @returns {string}
 */
function lookupDeptName(store, deptId, activityId) {
  if (!deptId || !store || !Array.isArray(store.Department)) return '';
  const dept = store.Department.find(
    (d) => d && d.dept_id === deptId && (!d.activity_id || d.activity_id === activityId)
  );
  return (dept && dept.name) || '';
}

/**
 * 聚合部门榜（R6）。
 * @param {object} params
 * @param {object} params.store
 * @param {string} params.activityId
 * @param {object[]} params.personalRows 已算好的个人榜行（含 dept_id/total_steps，未进榜的 0 步用户不在此列）
 * @param {number} params.minMembers 小部门阈值
 * @returns {object[]} DeptRow[]（已排序、赋 rank）
 */
function buildDeptRanking({ store, activityId, personalRows, minMembers }) {
  // 按部门聚合：total=成员有效步数累加、member_count=有效成员数（已在 personalRows 中的成员即「有效成员」，R6.2）。
  const byDept = new Map(); // dept_id -> { total, members: [] }
  for (const row of personalRows) {
    const did = row.dept_id;
    if (!did) continue; // 无部门的用户不计入部门榜
    if (!byDept.has(did)) byDept.set(did, { total: 0, members: [] });
    const entry = byDept.get(did);
    entry.total += row.total_steps;
    entry.members.push(row);
  }

  const rows = [];
  for (const [deptId, entry] of byDept.entries()) {
    const memberCount = entry.members.length;
    const avg = memberCount > 0 ? Math.round(entry.total / memberCount) : 0;
    const small = memberCount < minMembers;
    rows.push({
      dept_id: deptId,
      total_steps: entry.total,
      member_count: memberCount,
      avg_steps: avg,
      small_sample: small,
      dept_name: lookupDeptName(store, deptId, activityId)
    });
  }

  // 排序（R6.1 + §657）：
  //   主排名按 avg_steps desc；小部门（small_sample）排主榜之后。
  //   小部门内部 / 主榜内部再按 avg_steps desc 兜底，同 avg 按 dept_id asc 稳定。
  rows.sort((a, b) => {
    // 主榜（非小部门）排前，小部门排后。
    if (a.small_sample !== b.small_sample) {
      return a.small_sample ? 1 : -1;
    }
    if (b.avg_steps !== a.avg_steps) return b.avg_steps - a.avg_steps;
    // 同 avg：total_steps 兜底，再 dept_id。
    if (b.total_steps !== a.total_steps) return b.total_steps - a.total_steps;
    const da = a.dept_id || '';
    const db = b.dept_id || '';
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });

  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  return rows;
}

/**
 * 覆盖写 RankCache（幂等，P0-3 单文档）。
 * 每 (type, activity_id) 一个文档 {type, activity_id, rows:[...], updated_at}；
 * 覆盖写 = 找到该文档则替换其 rows+updated_at（保留 _id 库主键），找不到则 push 新文档。
 * 单文档覆盖写 = 一次原子 update，天然无并发 double（旧多文档「先 add 后 remove」在并发聚合时会产生双倍行）。
 *
 * @param {object} store
 * @param {string} type 'personal' | 'dept'
 * @param {string} activityId
 * @param {object[]} rows 整榜行数组（每行含 rank/user_id/total_steps 等，由 buildPersonalRanking/buildDeptRanking 产出）
 * @param {string} updatedAtIso
 */
function overwriteRankCache(store, type, activityId, rows, updatedAtIso) {
  if (!store) return;
  if (!Array.isArray(store.RankCache)) store.RankCache = [];
  const docIdx = store.RankCache.findIndex(
    (d) => d && d.type === type && d.activity_id === activityId
  );
  const newDoc = { type, activity_id: activityId, rows, updated_at: updatedAtIso };
  if (docIdx >= 0) {
    // 保留 _id（库主键），替换 rows/updated_at。
    store.RankCache[docIdx] = Object.assign({}, store.RankCache[docIdx], newDoc);
  } else {
    store.RankCache.push(newDoc);
  }
}

/**
 * rankAggregate 主逻辑（纯函数 + 注入式 store/now/config）。
 *
 * @param {object} params
 * @param {object} params.store mock db（{ StepRecord, User?, Department?, RankCache? }）
 * @param {string} params.activityId 活动 id
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @param {object} [params.config] 配置覆盖（timezoneOffsetMinutes/minMembers）
 * @returns {Promise<object>} { personal: RankRow[], dept: DeptRow[], updatedAt }
 */
async function aggregateRanking(params) {
  const p = params || {};
  const { store, activityId, activity } = p;
  if (!activityId) {
    const { CODE, BizError } = require('../common/errors');
    throw BizError(CODE.BIZ_PARAM_MISSING, 'rankAggregate: activityId required');
  }
  if (!store || !Array.isArray(store.StepRecord)) {
    const { CODE, BizError } = require('../common/errors');
    throw BizError(CODE.SYS_DB_ERROR, 'rankAggregate: store.StepRecord is required');
  }

  const cfg = Object.assign({}, RANK_DEFAULT_CONFIG, p.config || {});
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const today = dateFromTimestamp(Math.floor(nowDate.getTime() / 1000), cfg.timezoneOffsetMinutes);
  // 活动期起点：过滤活动期外脏记录（date<start_date）；activity 缺失 → '' → 兜底不过滤。
  const startDate = activityStartDate(activity, cfg.timezoneOffsetMinutes);
  const updatedAt = nowDate.toISOString();

  // 个人榜。
  const personalRows = buildPersonalRanking({ store, activityId, today, startDate });
  // 部门榜（基于个人榜聚合）。
  const deptRows = buildDeptRanking({
    store,
    activityId,
    personalRows,
    minMembers: cfg.minMembers
  });

  // 覆盖写 RankCache（幂等）。
  overwriteRankCache(store, 'personal', activityId, personalRows, updatedAt);
  overwriteRankCache(store, 'dept', activityId, deptRows, updatedAt);

  return {
    personal: personalRows,
    dept: deptRows,
    updatedAt
  };
}

module.exports = {
  aggregateRanking,
  buildPersonalRanking,
  buildDeptRanking,
  computeFirstReachAt,
  overwriteRankCache,
  RANK_DEFAULT_CONFIG
};
