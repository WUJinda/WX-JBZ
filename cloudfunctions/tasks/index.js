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
 * 删除旧文档 → 逐条插入新文档。本地轨单测不经此路径。
 * @param {object} cloudSdk
 * @param {string} type
 * @param {string} activityId
 * @param {object[]} cacheAll 已聚合好的全部 RankCache（含 updated_at）
 */
async function overwriteRankCacheToCloud(cloudSdk, type, activityId, cacheAll) {
  const db = cloudSdk.database();
  // 删除旧文档。
  try {
    await db.collection('RankCache').where({ type, activity_id: activityId }).remove();
  } catch (err) {
    // 忽略：集合未创建等。
  }
  // 插入新文档。
  const rows = cacheAll.filter((r) => r && r.type === type && r.activity_id === activityId);
  for (const row of rows) {
    // 复制一份，避免把内存引用直接落库（_id 由库生成）。
    const doc = Object.assign({}, row);
    delete doc._id;
    try {
      await db.collection('RankCache').add({ data: doc });
    } catch (err) {
      // 单条插入失败不阻断整体（幂等可重跑）。
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
        // 忽略单条失败（幂等可重跑）。
      }
    }
  }
}

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'tasks.' + action : 'tasks.<empty>');
      return fail(err.code, err.message);
    }
    // 定时任务为系统级，不取调用者 OPENID 做用户鉴权
    const data = await handler(event);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'tasks error');
  }
};

module.exports = exports;
