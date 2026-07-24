/**
 * rank.personalDaily 业务纯函数（F5 个人榜「今日榜」按日切换）。
 *
 * 职责（按日实时聚合当天步数排名 + 分页 + 我的当日排名）：
 *   - 从 store.StepRecord 过滤 (activity_id, date) 当天记录，按 user 聚合当日 steps。
 *   - 按 user_id 去重取最大 steps（生产无唯一索引，防重复记录翻倍，同 rankAggregate.buildPersonalRanking B1 口径）。
 *   - 仅列当天有记录（已同步）的用户（产品口径：当日已同步者进榜；不遍历 User 表补 0 步/未同步用户）。
 *   - 关联 User 拿脱敏 nickname + dept_name/dept_id；投影不下发 _openid/phone/sync_count。
 *   - 排序：steps desc / synced_at asc（同分先达者列前，类比 first_reach_at 口径）；赋 rank。
 *
 * ===== 与累计榜（readPersonal）的区别（架构决策，记录于 plan: imperative-wishing-frost）=====
 *   累计榜读 RankCache 中间表（tasks.rankAggregate 预聚合）；按日榜**实时从 StepRecord 聚合**，
 *   不经 RankCache。理由：① 纯增量，零触碰累计榜/部门榜/聚合逻辑（用户硬约束「不影响其他功能」）；
 *   ② 今日榜要求实时（今天数据高频变化），走 10 分钟聚合缓存会带来写后读延迟；直接读 StepRecord
 *   主数据天然最新、无写后读问题；③ 单日数据量小（=当日同步用户数），实时排序成本可控。
 *   对 CLAUDE.md「读榜单只读 RankCache」约定的例外：该约定针对累计榜全量聚合（成本高+一致性），
 *   对「按日单日」场景不成立。
 *
 * 红线：
 *   - 有效步数口径复用 stepsSync.isValidStepRecord（活动期内已同步的非未来日，不依赖 locked），禁止另立。
 *   - date 口径与前端 rankDayList.bjDateStr 同 +480（与后端 dateFromTimestamp 一致），前后端直传不漂移。
 *   - 投影脱敏 nickname，不下发 _openid / phone / sync_count（_openid 是关联键必须入内存，但不下发）。
 *
 * 本地轨：store/now 注入式，纯函数可单测；不调真实微信云 API。
 *
 * 解耦：本模块不 require wx-server-sdk。
 */

const { dateFromTimestamp, activityStartDate, activityEndDate, isValidStepRecord, DEFAULT_CONFIG } = require('../steps/stepsSync');
const { maskNickname } = require('../common/mask');
const { CODE, BizError } = require('../common/errors');

const DEFAULT_PAGE_SIZE = 50; // 与 rankQuery.readPersonal 同（前端 rankCalc.DEFAULT_PAGE_SIZE 一致）

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD（与 StepRecord.date / rankDayList.key 同格式）

/**
 * 查部门名（store 注入；实现同 rankQuery.lookupDeptName，内联避免跨模块耦合）。
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
 * 今日榜投影：剔除敏感字段，规整输出。
 * 当日步数字段命名为 total_steps（复用前端 wxml {{item.total_steps}} 绑定，今日榜/累计榜共用 rank-row 模板）。
 * RankCache 无关；StepRecord 的 _openid/user_id 均不入下发（_openid 是关联键，仅内存使用）。
 * @param {object} row
 * @returns {object}
 */
function projectPersonalDaily(row) {
  const r = row || {};
  return {
    rank: r.rank,
    user_id: r.user_id,
    ref_id: r.user_id,
    total_steps: r.steps, // 当日步数（字段名沿用 total_steps 复用前端模板）
    synced_at: r.synced_at || null,
    nickname: r.nickname || '',
    dept_id: r.dept_id || '',
    dept_name: r.dept_name || ''
  };
}

/**
 * readPersonalDaily：按日实时聚合当天步数排名 + 分页 + 我的当日排名。
 *
 * @param {object} params
 * @param {object} params.store mock db（{ StepRecord, User?, Department? }）
 * @param {string} params.activityId 活动 id
 * @param {string} params.date 查询日 YYYY-MM-DD（前端 selectedDay 直传，同 +480 口径）
 * @param {string} [params.userId] 当前用户 id（= openid，定位 myRank）
 * @param {number} [params.page=1] 页码（从 1 起）
 * @param {number} [params.pageSize=50] 每页条数
 * @param {object} [params.activity] 活动文档（含 start_time，算 startDate 过滤活动期外脏记录）
 * @param {Date} [params.now] 注入时间（算 today；测试注入固定值）
 * @param {object} [params.config] { timezoneOffsetMinutes }（默认 480 北京）
 * @returns {Promise<object>} { list, myRank, totalCount, updatedAt }
 * @throws {BizError} date 格式非法（BIZ_PARAM_MISSING）
 */
async function readPersonalDaily(params) {
  const p = params || {};
  const { store, activityId, date } = p;
  if (!DATE_RE.test(date || '')) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'personalDaily: date (YYYY-MM-DD) required');
  }
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.max(1, Number(p.pageSize) || DEFAULT_PAGE_SIZE);
  const cfg = Object.assign({}, DEFAULT_CONFIG, p.config || {});
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const today = dateFromTimestamp(Math.floor(nowDate.getTime() / 1000), cfg.timezoneOffsetMinutes);
  const startDate = activityStartDate(p.activity, cfg.timezoneOffsetMinutes);
  const endDate = activityEndDate(p.activity, cfg.timezoneOffsetMinutes);

  // 当天记录：activity_id + date 匹配且有效（活动期内已同步的非未来日，口径同 isValidStepRecord）。
  const records = (store && Array.isArray(store.StepRecord) ? store.StepRecord : []).filter(
    (r) => r && r.activity_id === activityId && r.date === date && isValidStepRecord(r, today, startDate, endDate)
  );

  // 按 user_id 去重取最大 steps（生产无唯一索引，写侧偶发重复 StepRecord 会翻倍；聚合侧按 user 去重兜底，
  //   下次查询即自愈历史重复）。单 date 下即按 user 去重（同 buildPersonalRanking 的 (user,date) 口径退化）。
  const byUser = new Map(); // user_id -> StepRecord（该 user 当天最大 steps）
  for (const r of records) {
    const prev = byUser.get(r.user_id);
    if (!prev || (Number(r.steps) || 0) > (Number(prev.steps) || 0)) {
      byUser.set(r.user_id, r);
    }
  }

  // User 关联：_openid -> user（StepRecord.user_id 实存 openid，见 rankAggregate 注释，须以 _openid 为 key）。
  const userMap = new Map();
  (store && Array.isArray(store.User) ? store.User : []).forEach((u) => {
    if (u && u._openid) userMap.set(u._openid, u);
  });

  // 收集行：只列有当天记录的用户（产品口径 A：当日已同步者进榜，不遍历 User 表补 0 步/未同步用户）。
  const rows = [];
  for (const [uid, rec] of byUser) {
    const u = userMap.get(uid) || {};
    const deptId = u.dept_id || '';
    rows.push({
      user_id: uid,
      steps: Number(rec.steps) || 0,
      synced_at: rec.synced_at || null,
      nickname: maskNickname(u.nickname || ''),
      dept_id: deptId,
      dept_name: lookupDeptName(store, deptId, activityId)
    });
  }

  // 排序：steps desc / synced_at asc（同分先达者列前，类比 first_reach_at 口径）。
  rows.sort((a, b) => {
    if (b.steps !== a.steps) return b.steps - a.steps;
    const sa = a.synced_at || '';
    const sb = b.synced_at || '';
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // 我的当日排名：按 user_id 定位；当天未同步（不在榜）→ null（前端隐藏排名条）。
  let myRank = null;
  if (p.userId) {
    const mine = rows.find((r) => r.user_id === p.userId);
    if (mine) myRank = projectPersonalDaily(mine);
  }

  // updatedAt：当天记录里最新 synced_at（表示「数据截至最近一次同步」）。
  let updatedAt = null;
  for (const r of rows) {
    if (r.synced_at && (!updatedAt || r.synced_at > updatedAt)) updatedAt = r.synced_at;
  }

  // 分页（已按 rank 升序）。
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  const list = slice.map(projectPersonalDaily);

  return {
    list,
    myRank,
    totalCount: rows.length,
    updatedAt
  };
}

module.exports = {
  readPersonalDaily,
  projectPersonalDaily,
  DEFAULT_PAGE_SIZE
};
