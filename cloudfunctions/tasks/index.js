/**
 * tasks 云函数入口：定时任务（对齐技术架构 §4.1 / §6.5）。
 * Action: rankAggregate / dailyLock
 *
 * 同一逻辑既可被定时触发器调用，也可手动触发，便于本地与回归测试（架构 §6.5）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { aggregateRanking } = require('./rankAggregate');
const { lockYesterday } = require('./dailyLock');

const handlers = {
  // G2: 排行榜聚合（每 10 分钟）。系统级，不取调用者 OPENID 做用户鉴权。
  // handler 负责「拉集合 → 调纯函数 → 覆盖写库」；本地轨单测直接调 aggregateRanking 纯函数。
  rankAggregate: async (event) => {
    const activityId = (event && event.activity_id) || 'a_demo_001';
    const config = event && event.config;
    const now = event && event.now ? new Date(event.now) : undefined;

    // 云轨：拉相关集合到内存 store 交给纯函数聚合（StepRecord 量级可控时可全量；
    //       超量级时改为分批聚合，本阶段先全量）。
    const store = {
      StepRecord: await loadCollection(cloud, 'StepRecord'),
      User: await loadCollection(cloud, 'User'),
      Department: await loadCollection(cloud, 'Department'),
      RankCache: await loadCollection(cloud, 'RankCache')
    };
    // 覆盖写回 RankCache（纯函数已就地改 store.RankCache）。
    const result = await aggregateRanking({ store, activityId, now, config });
    await overwriteRankCacheToCloud(cloud, 'personal', activityId, store.RankCache);
    await overwriteRankCacheToCloud(cloud, 'dept', activityId, store.RankCache);
    return result;
  },

  // G3: 每日锁定昨日 StepRecord（默认 12:00，可配）。系统级，不鉴权。
  // 幂等：已锁记录再置 true 无副作用；不动今日、不改 steps 值。
  dailyLock: async (event) => {
    const config = event && event.config;
    const now = event && event.now ? new Date(event.now) : undefined;

    const store = { StepRecord: await loadCollection(cloud, 'StepRecord') };
    const result = await lockYesterday({ store, now, config });
    // 云轨：将锁定的记录写回库（lockYesterday 已就地改 store.StepRecord）。
    // 仅对昨日记录 update locked=true（幂等）。
    await applyLocksToCloud(cloud, store.StepRecord, result.date);
    return result;
  }
};

/**
 * 载入集合全部文档（云轨真实库）。
 * 本地轨/单测不经此 handler，直接调纯函数注入 store。
 *
 * TODO 云轨优化：当前全量拉集合（含 _openid / phone / sync_count 等敏感字段）入内存，
 *   StepRecord 量大时有 OOM 风险。聚合类 action 改用 DB 端 `.field()` 投影（仅取必要字段）
 *   + `.where()` 过滤 / 聚合管道，避免全量拉敏感集合入内存；当前全量拉取仅为本地轨/早期简化。
 *
 * @param {object} cloudSdk
 * @param {string} name
 * @returns {Promise<object[]>}
 */
async function loadCollection(cloudSdk, name) {
  let all = [];
  try {
    const db = cloudSdk.database();
    const PAGE = 100;
    let skip = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await db.collection(name).skip(skip).limit(PAGE).get();
      const data = (res && res.data) || [];
      all = all.concat(data);
      if (data.length < PAGE) break;
      skip += PAGE;
    }
  } catch (err) {
    // 集合未创建（如 RankCache 首次）：返回空数组兜底。
    all = [];
  }
  return all;
}

/**
 * 云轨：覆盖写某 (type, activity_id) 的 RankCache。
 * 顺序：先查旧文档 _id 集合 → 逐条插入新文档 → 全部 add 成功后才删除旧 _id。
 * 保证任意 add 失败都不丢榜（失败则保留旧榜，下次聚合幂等重跑覆盖）。
 * 本地轨单测不经此路径。
 * @param {object} cloudSdk
 * @param {string} type
 * @param {string} activityId
 * @param {object[]} cacheAll 已聚合好的全部 RankCache（含 updated_at）
 */
async function overwriteRankCacheToCloud(cloudSdk, type, activityId, cacheAll) {
  const db = cloudSdk.database();
  const rows = cacheAll.filter((r) => r && r.type === type && r.activity_id === activityId);

  // 1. 先取旧文档 _id 集合（在 add 之前取，避免把刚 add 的新文档误纳入待删集合）。
  let oldIds = [];
  try {
    const oldRes = await db
      .collection('RankCache')
      .where({ type, activity_id: activityId })
      .field({ _id: true })
      .get();
    oldIds = ((oldRes && oldRes.data) || []).map((d) => d && d._id).filter((id) => !!id);
  } catch (err) {
    // 集合未创建等：视为无旧榜，oldIds 留空继续 add。
    console.warn('[写回失败]', 'RankCache(' + type + ') list old', (err && err.message) || err);
  }

  // 2. 逐条插入新文档（任一失败即中止本次 remove，保留旧榜不删）。
  for (const row of rows) {
    // 复制一份，避免把内存引用直接落库（_id 由库生成）。
    const doc = Object.assign({}, row);
    delete doc._id;
    try {
      await db.collection('RankCache').add({ data: doc });
    } catch (err) {
      // 单条 add 失败：中止本次 remove，保留旧榜（下次聚合幂等重跑覆盖）。
      console.warn('[写回失败]', 'RankCache(' + type + ') add', (err && err.message) || err);
      return;
    }
  }

  // 3. 全部 add 成功后才删除旧文档（按步骤 1 取到的旧 _id 精确删除，不误删新文档）。
  for (const id of oldIds) {
    try {
      await db.collection('RankCache').doc(id).remove();
    } catch (err) {
      // 单条 remove 失败不阻断（旧榜残留下次覆盖，幂等可重跑）。
      console.warn('[写回失败]', 'RankCache(' + type + ') remove ' + id, (err && err.message) || err);
    }
  }
}

/**
 * 云轨：将昨日记录的 locked 写回库（幂等）。
 * 本地轨单测不经此路径。
 * @param {object} cloudSdk
 * @param {object[]} records 已就地改 locked 的 StepRecord（含 _id）
 * @param {string} date 昨日 YYYY-MM-DD
 */
async function applyLocksToCloud(cloudSdk, records, date) {
  const db = cloudSdk.database();
  const targets = records.filter((r) => r && r.date === date && r._id);
  for (const r of targets) {
    if (r.locked) {
      try {
        await db.collection('StepRecord').doc(r._id).update({ data: { locked: true } });
      } catch (err) {
        // 单条失败不阻断（幂等可重跑），仅留痕。
        console.warn('[写回失败]', 'StepRecord.lock(' + r._id + ')', (err && err.message) || err);
      }
    }
  }
}

/**
 * dailyLock 触发时点（§6.4：默认 12:00，可配）。
 * 与 dailyLock.LOCK_DEFAULT_CONFIG.lockHour 对齐——本常量用于「定时触发时
 * 判断当前小时是否到锁点」；dailyLock 纯函数内部 lockHour 仅作配置项保留。
 */
const DAILY_LOCK_HOUR = 12;

/**
 * 定时触发（无 action）时的统一入口（§6.5：同一逻辑既被定时触发器调用、也可手动 action 触发）。
 *
 * 微信定时触发器调用云函数时 event 不带 action（也不可靠携带 trigger name），
 * 故 main 在 event.action 缺失时转至此函数：
 *   1. 每次必跑 rankAggregate（§6.3 每 10 分钟覆盖写 RankCache，幂等）；
 *   2. 判断当前小时是否到 DAILY_LOCK_HOUR（用 event.now 优先，否则 new Date()，
 *      统一按北京时间口径算小时，与 dailyLock/rankAggregate 的 timezoneOffsetMinutes 一致），
 *      到点则跑 dailyLock（§6.4 幂等：已锁记录跳过，安全）。
 *
 * 安全前提：dailyLock 幂等（见 dailyLock.js —— 已锁再置 true 无副作用、不改 steps）。
 *
 * @param {object} event
 * @returns {Promise<object>} { rank: <rankAggregate 结果>, dailyLock?: <dailyLock 结果|null> }
 */
async function runScheduledTasks(event) {
  // 1. rankAggregate 每次必跑（幂等覆盖写）。
  const rank = await handlers.rankAggregate(event);

  // 2. 判断是否到 dailyLock 时点。优先用 event.now（注入/触发器时间），否则当前时刻。
  const nowMs =
    event && typeof event.now === 'number'
      ? event.now
      : event && event.now
        ? new Date(event.now).getTime()
        : Date.now();
  // 北京时间（UTC+8）的小时数：复用 dailyLock/rankAggregate 的 tz 口径（480 分钟）。
  const beijingHour = Math.floor((nowMs / 3600000 + 8) % 24);

  let dailyLockResult = null;
  if (beijingHour === DAILY_LOCK_HOUR) {
    dailyLockResult = await handlers.dailyLock(event);
  }

  return { rank, dailyLock: dailyLockResult };
}

exports.main = async (event) => {
  const action = event && event.action;
  try {
    // 显式 action 分发保留（rankAggregate/dailyLock 仍可被手动/测试触发，§6.5）。
    if (action) {
      const handler = handlers[action];
      if (typeof handler !== 'function') {
        const err = notImplemented('tasks.' + action);
        return fail(err.code, err.message);
      }
      // 定时任务为系统级，不取调用者 OPENID 做用户鉴权
      const data = await handler(event);
      return ok(data);
    }
    // 无 action：定时触发器特征 -> 走统一调度入口。
    const data = await runScheduledTasks(event);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'tasks error');
  }
};

module.exports = exports;
