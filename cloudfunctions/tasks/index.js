/**
 * tasks 云函数入口：定时任务（对齐技术架构 §4.1 / §6.5）。
 * Action: rankAggregate / dailyLock
 *
 * 同一逻辑既可被定时触发器调用，也可手动触发，便于本地与回归测试（架构 §6.5）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { loadByWhere } = require('../common/db');
const { getActiveActivityId, getActivityById } = require('../activity/activityResolver');
const { aggregateRanking } = require('./rankAggregate');
const { lockYesterday, computeYesterdayDate, LOCK_DEFAULT_CONFIG } = require('./dailyLock');

// P0-5 字段投影：聚合只需这些字段，投影掉 _openid/phone/sync_count 等敏感字段。
const STEP_FIELDS_AGG = { _id: 1, user_id: 1, activity_id: 1, date: 1, steps: 1, locked: 1, synced_at: 1 };
const USER_FIELDS_AGG = { _id: 1, _openid: 1, nickname: 1, dept_id: 1, join_status: 1 };
const DEPT_FIELDS_AGG = { _id: 1, dept_id: 1, name: 1, activity_id: 1, member_count: 1 };

const handlers = {
  // G2: 排行榜聚合（每 10 分钟）。系统级，不取调用者 OPENID 做用户鉴权。
  // handler 负责「拉集合 → 调纯函数 → 覆盖写库」；本地轨单测直接调 aggregateRanking 纯函数。
  rankAggregate: async (event) => {
    // F1：缺省 activity_id 时查库当前活动（替代硬编码 a_demo_001，定时任务无 event.activity_id 走此）。
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const config = event && event.config;
    const now = event && event.now ? new Date(event.now) : undefined;
    // 查活动文档（含 start_time）：供 aggregateRanking 算活动期起点，过滤活动期外脏记录。
    const activity = await getActivityById(cloud, activityId);

    // P0-5：按 activity_id 精确拉取（避免全表扫描 + 敏感字段入内存）。
    //   StepRecord 投影掉 _openid/sync_count；User 投影掉 phone/phone_masked/avatar；
    //   Department/RankCache 按 activity_id 过滤。User 无 activity_id 字段（全局用户表，
    //   经 dept_id 关联活动），故 where {} 全量但 field 投影减泄露面。
    const store = {
      StepRecord: await loadByWhere(cloud, 'StepRecord', { activity_id: activityId }, STEP_FIELDS_AGG),
      User: await loadByWhere(cloud, 'User', {}, USER_FIELDS_AGG),
      Department: await loadByWhere(cloud, 'Department', { activity_id: activityId }, DEPT_FIELDS_AGG),
      RankCache: await loadByWhere(cloud, 'RankCache', { activity_id: activityId })
    };
    // 覆盖写回 RankCache（纯函数已就地改 store.RankCache）。
    const result = await aggregateRanking({ store, activityId, activity, now, config });
    await overwriteRankCacheToCloud(cloud, 'personal', activityId, store.RankCache);
    await overwriteRankCacheToCloud(cloud, 'dept', activityId, store.RankCache);
    return result;
  },

  // G3: 每日锁定昨日 StepRecord（默认 12:00，可配）。系统级，不鉴权。
  // 幂等：已锁记录再置 true 无副作用；不动今日、不改 steps 值。
  dailyLock: async (event) => {
    const config = event && event.config;
    const now = event && event.now ? new Date(event.now) : new Date();

    // P1-13：算昨日（日历减 1 天；now 非法时 computeYesterdayDate 显式抛错）。
    const cfg = Object.assign({}, LOCK_DEFAULT_CONFIG, config || {});
    const yesterday = computeYesterdayDate(now, cfg.timezoneOffsetMinutes);

    // P0-5：只拉昨日记录（少量），传纯函数算 lockedCount（避免全量拉 StepRecord）。
    const store = {
      StepRecord: await loadByWhere(cloud, 'StepRecord', { date: yesterday }, { _id: 1, date: 1, locked: 1 })
    };
    const result = await lockYesterday({ store, now, config });
    // P0-5：批量写回 where(昨日, locked=false).update({locked:true})（幂等，无需逐条 update/事务）。
    await applyLocksToCloud(cloud, result.date);
    return result;
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；rankAggregate/dailyLock
// 改用 loadByWhere(cloud, name, where, field) 精确拉取（按 activity_id / date 过滤 + 字段投影）。

/**
 * 云轨：覆盖写某 (type, activity_id) 的 RankCache 单文档（P0-3）。
 * 从聚合产物 cacheAll（store.RankCache）里取该 (type, activity_id) 的文档，整体 upsert：
 *   where(type, activity_id) 命中 → doc(id).update({rows, updated_at})；否则 add 单文档。
 * 一次原子写，无并发 double（替代旧「查旧id→逐条add→删旧」非原子流程，并发聚合会双倍）。
 * 定时任务容错：失败 warn 留痕（下次聚合幂等覆盖），不上抛以免一次失败致整次定时任务报错。
 * 本地轨单测不经此路径。
 * @param {object} cloudSdk
 * @param {string} type
 * @param {string} activityId
 * @param {object[]} cacheAll store.RankCache（含 personal/dept 单文档）
 */
async function overwriteRankCacheToCloud(cloudSdk, type, activityId, cacheAll) {
  const db = cloudSdk.database();
  const doc = cacheAll.find((d) => d && d.type === type && d.activity_id === activityId);
  const rows = (doc && doc.rows) || [];
  const updatedAt = (doc && doc.updated_at) || new Date().toISOString();

  let existingId = null;
  try {
    const res = await db
      .collection('RankCache')
      .where({ type, activity_id: activityId })
      .limit(1)
      .get();
    existingId = res && res.data && res.data[0] && res.data[0]._id;
  } catch (err) {
    console.warn('[写回失败]', 'RankCache(' + type + ') lookup', (err && err.message) || err);
  }
  try {
    if (existingId) {
      await db.collection('RankCache').doc(existingId).update({
        data: { rows, updated_at: updatedAt }
      });
    } else {
      await db.collection('RankCache').add({
        data: { type, activity_id: activityId, rows, updated_at: updatedAt }
      });
    }
  } catch (err) {
    console.warn('[写回失败]', 'RankCache(' + type + ') upsert', (err && err.message) || err);
  }
}

/**
 * 云轨：批量将昨日记录的 locked 写回库（幂等）。
 * 本地轨单测不经此路径。
 *
 * P0-5：一条 where.update 锁所有「昨日 + 未锁」记录（替代旧「全量拉 + 逐条 doc(id).update」）。
 *   已锁记录 updated=0 无副作用（幂等）；where().update 为云数据库原生批量写，非事务批量 API，可用。
 *
 * @param {object} cloudSdk
 * @param {string} date 昨日 YYYY-MM-DD
 * @returns {Promise<number>} 实际更新条数
 */
async function applyLocksToCloud(cloudSdk, date) {
  const db = cloudSdk.database();
  try {
    const upd = await db
      .collection('StepRecord')
      .where({ date, locked: false })
      .update({ data: { locked: true } });
    return (upd && upd.stats && upd.stats.updated) || 0;
  } catch (err) {
    // P1-3：写回失败上抛（定时任务 main catch 兜底 fail，下次幂等重跑覆盖）。
    throw BizError(CODE.SYS_DB_ERROR, 'dailyLock 批量写回失败(date=' + date + '): ' + ((err && err.message) || err));
  }
}

/**
 * 定时触发（无 action）时的统一入口（§6.5：同一逻辑既被定时触发器调用、也可手动 action 触发）。
 *
 * 微信定时触发器调用云函数时 event 不带 action（也不可靠携带 trigger name），
 * 故 main 在 event.action 缺失时转至此函数。P0-4：单 timer 每 10 分钟触发，两任务均幂等，
 * 每次都跑：
 *   1. rankAggregate：覆盖写 RankCache（§6.3，幂等，重复执行无副作用）；
 *   2. dailyLock：锁昨日 StepRecord（§6.4，幂等，已锁跳过、不改 steps）。
 *
 * 删除原 beijingHour===12 时刻判断——dailyLockTimer 与 rankAggregateTimer 双 timer 下，
 * 12:00-12:59 间每 10 分钟触发会让 dailyLock 重复跑 6 次；且依赖触发器精确时刻不可靠
 * （延迟则漏锁整天）。改为每次顺带锁，幂等安全。
 *
 * @param {object} event
 * @returns {Promise<object>} { rank, dailyLock }
 */
async function runScheduledTasks(event) {
  // 两任务均幂等，每次都跑；dailyLock 已锁记录跳过，无副作用。
  const rank = await handlers.rankAggregate(event);
  const dailyLockResult = await handlers.dailyLock(event);
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
