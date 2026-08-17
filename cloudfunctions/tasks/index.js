/**
 * tasks 云函数入口：定时任务（对齐技术架构 §4.1 / §6.5）。
 * Action: rankAggregate / dailyLock / pointSettle
 *
 * 同一逻辑既可被定时触发器调用，也可手动触发，便于本地与回归测试（架构 §6.5）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { loadByWhere } = require('../common/db');
const { getActiveActivityId, getActivityById } = require('../activity/activityResolver');
const { deriveStatus } = require('../activity/activityStatus');
const { aggregateRanking } = require('./rankAggregate');
const { lockYesterday, computeYesterdayDate, LOCK_DEFAULT_CONFIG } = require('./dailyLock');
const { settleActivityPoints } = require('./pointSettle');

// P0-5 字段投影：聚合只需这些字段，投影掉 _openid/phone/sync_count 等敏感字段。
const STEP_FIELDS_AGG = { _id: 1, user_id: 1, activity_id: 1, date: 1, steps: 1, locked: 1, synced_at: 1 };
const USER_FIELDS_AGG = { _id: 1, _openid: 1, nickname: 1, real_name: 1, dept_id: 1, join_status: 1 };
const DEPT_FIELDS_AGG = { _id: 1, dept_id: 1, name: 1, activity_id: 1, member_count: 1, size: 1 };
// pointSettle 投影：结算需读写 User.points（比聚合 USER_FIELDS_AGG 多 points 字段）。
const USER_FIELDS_SETTLE = { _id: 1, _openid: 1, nickname: 1, dept_id: 1, join_status: 1, points: 1 };

const handlers = {
  // G2: 排行榜聚合（每 10 分钟）。系统级，不取调用者 OPENID 做用户鉴权。
  // handler 负责「拉集合 → 调纯函数 → 覆盖写库」；本地轨单测直接调 aggregateRanking 纯函数。
  rankAggregate: async (event) => {
    // F1：缺省 activity_id 时查库当前活动（替代硬编码 a_demo_001，定时任务无 event.activity_id 走此）。
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const config = event && event.config;
    const now = event && event.now ? new Date(event.now) : undefined;

    // 清理历史残留：idx_rankcache_type_activity 索引定义不完整（只按 type，不按 type+activity_id），
    //   导致旧代码可能写入 type=null 的文档，后续 add 撞唯一索引。聚合前先删这类残留（幂等）。
    try {
      await cloud.database().collection('RankCache').where({ type: cloud.database().command.isNull(true) }).remove();
    } catch (e) {
      // 清理失败不影响主流程（残留下次再清）
    }

    // 查活动文档（含 start_time）：供 aggregateRanking 算活动期起点，过滤活动期外脏记录。
    const activity = await getActivityById(cloud, activityId);

    // P0-5：按 activity_id 精确拉取（避免全表扫描 + 敏感字段入内存）。
    //   StepRecord 投影掉 _openid/sync_count；User 投影掉 phone/phone_masked/avatar；
    //   Department/RankCache 按 activity_id 过滤。User 无 activity_id 字段（全局用户表，
    //   经 dept_id 关联活动），故 where {} 全量但 field 投影减泄露面。
    const store = {
      StepRecord: await loadByWhere(cloud, 'StepRecord', { activity_id: activityId }, STEP_FIELDS_AGG),
      User: await loadByWhere(cloud, 'User', {}, USER_FIELDS_AGG),
      // Department 全量拉取（部门是相对固定的组织数据，与活动生命周期无关，不按 activity_id 过滤）。
      Department: await loadByWhere(cloud, 'Department', {}, DEPT_FIELDS_AGG),
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
  },

  // G4: 活动结束积分结算（个人榜前10名平缓曲线 +12/10/8/7/6/5/4/3/2/1（0步跳过不递补），部门榜第1名部门参赛人员每人 +2）。
  // 系统级不鉴权（与 rankAggregate/dailyLock 同）。结算幂等：纯函数判 points_settled + handler CAS 占位防并发重发。
  // 结算成功同时写 settlement 摘要（部门冠军+前十名单）到 Activity，供 activity.current 下发给活动页弹窗。
  pointSettle: async (event) => {
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const activity = await getActivityById(cloud, activityId);
    const now = (event && event.now) ? new Date(event.now) : new Date();
    const store = {
      User: await loadByWhere(cloud, 'User', {}, USER_FIELDS_SETTLE),
      RankCache: await loadByWhere(cloud, 'RankCache', { activity_id: activityId })
    };
    const result = await settleActivityPoints({ store, activityId, activity, now });
    if (!result.settled) return result; // 未结束 / 已结算 / 无 RankCache → 跳过
    // CAS 占位（防并发重发）：未结算 = points_settled 显式 false 或字段缺失（新建活动不落库该字段，
    //   schema default 仅是文档规范；等值 where(false) 不匹配缺失文档，曾致 CAS 永不命中 →
    //   返回 alreadySettled 但从未发奖：台账全 0、永远提示「已结算过」）。
    const db = cloud.database();
    const _ = db.command;
    const upd = await db.collection('Activity')
      .where(_.or([
        { activity_id: activityId, points_settled: false },
        { activity_id: activityId, points_settled: _.exists(false) }
      ]))
      .update({
        data: {
          points_settled: true,
          points_settled_at: result.settledAt,
          settlement: result.settlement
        }
      });
    if (!(upd && upd.stats && upd.stats.updated)) {
      return Object.assign({}, result, { settled: false, alreadySettled: true });
    }
    // 批量发奖（原子 inc，失败收集不阻断）。
    const wb = await awardPointsToCloud(cloud, result.awards, result.settledAt);
    return Object.assign({}, result, { written: wb.written, write_failed: wb.failed });
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；rankAggregate/dailyLock
// 改用 loadByWhere(cloud, name, where, field) 精确拉取（按 activity_id / date 过滤 + 字段投影）。

/**
 * 云轨：覆盖写某 (type, activity_id) 的 RankCache 单文档（P0-3）。
 * 采用与 StepRecord.persistStepRecordsToCloud 相同的三层并发去重：
 *   1. 先 where(type,activity_id).update（命中则直接覆盖，零 add）
 *   2. 未命中则 where().get() 预检查是否存在（防并发窗口）
 *   3. 预检查命中则 doc(id).update，否则 add
 *
 * 由于云开发控制台手建的唯一 idx_rankcache_type_activity 不可靠（只按 type 字段，
 *   不是 type+activity_id），完全依赖应用层去重，不依赖索引约束。
 *   修复见 docs/排查-StepRecord-null索引冲突.md。
 *
 * 写回失败一律上抛（P1-3：不假成功）；rankAggregate 由 tasks 定时/手动触发，
 *   steps.sync 侧的 triggerRankAggregate 会 catch 兜底为 null，不阻断主同步路径。
 * 本地轨单测不经此路径。
 * @param {object} cloudSdk
 * @param {string} type 'personal' | 'dept'
 * @param {string} activityId
 * @param {object[]} cacheAll store.RankCache（含 personal/dept 单文档，纯函数已写入 rows/updated_at）
 */
async function overwriteRankCacheToCloud(cloudSdk, type, activityId, cacheAll) {
  const db = cloudSdk.database();
  // 从纯函数改过的 store.RankCache 取聚合结果（overwriteRankCache 确保该文档存在）。
  const doc = cacheAll.find((d) => d && d.type === type && d.activity_id === activityId);
  if (!doc) {
    // 纯函数未生成文档是逻辑异常，上抛（P1-3 不假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'RankCache(' + type + ') 纯函数未生成文档');
  }
  const rows = doc.rows || [];
  const updatedAt = doc.updated_at || new Date().toISOString();

  // 第一层：先尝试 where(type,activity_id).update（若存在则直接覆盖，无需 add）。
  // 错误一律上抛（P1-3：写回失败不假成功；steps.sync 侧 triggerRankAggregate 会 catch 兜底 null）。
  const upd = await db
    .collection('RankCache')
    .where({ type, activity_id: activityId })
    .update({ data: { rows, updated_at: updatedAt } });
  const updated = upd && upd.stats && upd.stats.updated;
  if (updated) {
    console.log('[写回成功] RankCache(' + type + ') updated existing document');
    return; // 命中并覆盖，完成
  }

  // 第二层：预检查是否存在（防并发窗口：另一聚合可能刚 add 完）。
  const res = await db
    .collection('RankCache')
    .where({ type, activity_id: activityId })
    .limit(1)
    .get();
  const existing = res && res.data && res.data[0];
  if (existing) {
    // 并发：另一请求已插完 → 直接 doc(id).update 覆盖为最新值。
    console.log('[写回] RankCache(' + type + ') pre-check found existing, updating');
    await db.collection('RankCache').doc(existing._id).update({
      data: { rows, updated_at: updatedAt }
    });
    return;
  }

  // 第三层：确实不存在 → add（并发窗口已被上方的 get 收窄）。
  await db.collection('RankCache').add({
    data: { type, activity_id: activityId, rows, updated_at: updatedAt }
  });
  console.log('[写回成功] RankCache(' + type + ') added new document');
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
 * 云轨：批量发奖（按 award 逐条 doc(userId).update inc delta，原子累加；失败收集不阻断）。
 * 本地轨单测不经此路径。
 * P1-3：批量收集 {written, failed}（不静默吞），handler 据此上报前端。
 *
 * 防重发取舍：占位（Activity.points_settled=true）已在调用前 CAS 完成（见 handlers.pointSettle），
 *   故此处即使单条发奖失败也只是「漏发」，不会「重发」——漏发由管理员手动 adjustPoints 补，
 *   绝不重发（积分多发难追回）。
 *
 * @param {object} cloudSdk
 * @param {object[]} awards [{ userId, openid, delta, reason }]（同人叠加会出现多条 → 多次 inc，正确）
 * @param {string} now ISO
 * @returns {Promise<{written: number, failed: string[]}>}
 */
async function awardPointsToCloud(cloudSdk, awards, now) {
  const db = cloudSdk.database();
  const _ = db.command;
  let written = 0;
  const failed = [];
  for (const a of awards || []) {
    if (!a || !a.userId) continue;
    try {
      await db.collection('User').doc(a.userId).update({
        data: { points: _.inc(a.delta), updated_at: now }
      });
      written += 1;
    } catch (err) {
      // P1-3：收集失败（不阻断其余发奖），返回 written/failed 供 handler 上报。
      console.warn('[发奖失败]', 'User(' + a.userId + ')', (err && err.message) || err);
      failed.push(a.userId);
    }
  }
  return { written, failed };
}

/**
 * 定时任务子步骤：遍历所有「已结束且未结算积分」的活动，逐个触发 pointSettle handler。
 *
 * 排在 rankAggregate 之后（同周期），保证结算读到本周期刚刷新的最终 RankCache。
 * 每个活动 try/catch 隔离（单活动失败不影响其他），失败仅 log 不抛（下次定时幂等重跑）。
 *
 * 注意：rankAggregate 只处理「当前活动」，而活动结束后不再是当前活动（pickCurrentActivity 选下一个），
 *   故结算必须遍历所有活动（按 deriveStatus 过滤 ended），不能复用 rankAggregate 的当前活动选择。
 *
 * @returns {Promise<object>} { settled: [{activityId, settled, alreadySettled?, skipped?}], errors: number }
 */
async function settleEndedActivities() {
  const now = new Date();
  const activities = await loadByWhere(cloud, 'Activity');
  const settled = [];
  let errors = 0;
  for (const a of activities) {
    if (!a || !a.activity_id) continue;
    // 仅 ended（含 terminated）且未结算的活动才尝试结算（避免对 active/pending 活动拉库）。
    if (deriveStatus(a, now) !== 'ended') continue;
    if (a.points_settled === true) continue;
    try {
      const r = await handlers.pointSettle({ activity_id: a.activity_id });
      settled.push({
        activityId: a.activity_id,
        settled: !!(r && r.settled),
        alreadySettled: !!(r && r.alreadySettled),
        skipped: r && r.skipped,
        written: r && r.written,
        write_failed: r && r.write_failed
      });
    } catch (err) {
      errors += 1;
      console.error('[定时任务] pointSettle 活动 ' + a.activity_id + ' 失败', (err && err.message) || err);
    }
  }
  return { settled, errors };
}

/**
 * 定时触发（无 action）时的统一入口（§6.5：同一逻辑既被定时触发器调用、也可手动 action 触发）。
 *
 * 微信定时触发器调用云函数时 event 不带 action（也不可靠携带 trigger name），
 * 故 main 在 event.action 缺失时转至此函数。P0-4：单 timer 每 10 分钟触发，三任务均幂等，
 * 每次都跑：
 *   1. rankAggregate：覆盖写 RankCache（§6.3，幂等，重复执行无副作用）；
 *   2. dailyLock：锁昨日 StepRecord（§6.4，幂等，已锁跳过、不改 steps）；
 *   3. pointSettle：遍历结算已结束活动的积分（幂等，已结算跳过，排在 rankAggregate 后读最新榜）。
 *
 * 删除原 beijingHour===12 时刻判断——dailyLockTimer 与 rankAggregateTimer 双 timer 下，
 * 12:00-12:59 间每 10 分钟触发会让 dailyLock 重复跑 6 次；且依赖触发器精确时刻不可靠
 * （延迟则漏锁整天）。改为每次顺带锁，幂等安全。
 *
 * @param {object} event
 * @returns {Promise<object>} { rank, dailyLock, settle }
 */
async function runScheduledTasks(event) {
  // 三任务均幂等，每次都跑；rank/dailyLock 各自 try/catch 隔离，一个失败不影响另一个跑完（A3）。
  let rank = null;
  let rankError = null;
  try {
    rank = await handlers.rankAggregate(event);
  } catch (err) {
    rankError = err;
    console.error('[定时任务] rankAggregate 失败', (err && err.message) || err);
  }

  let dailyLockResult = null;
  let dailyLockError = null;
  try {
    dailyLockResult = await handlers.dailyLock(event);
  } catch (err) {
    dailyLockError = err;
    console.error('[定时任务] dailyLock 失败', (err && err.message) || err);
  }

  // 积分结算：遍历所有 ended && !points_settled 活动（排在 rankAggregate 之后，读最新 RankCache）。
  // settle 失败不上抛（单活动 try/catch 隔离 + 幂等可重跑），避免积分问题拖垮 rank/dailyLock 的成功上报。
  let settleResult = null;
  try {
    settleResult = await settleEndedActivities();
  } catch (err) {
    console.error('[定时任务] pointSettle 失败', (err && err.message) || err);
  }

  // 任一失败上抛（main catch 转 fail，确保失败可见、不静默；已成功任务的副作用已落库保留）。
  // rankAggregate 是主任务，优先抛；dailyLock 失败次之。settle 失败已在上方 catch，不影响此处。
  if (rankError) throw rankError;
  if (dailyLockError) throw dailyLockError;

  return { rank, dailyLock: dailyLockResult, settle: settleResult };
}

exports.main = async (event) => {
  const action = event && event.action;
  try {
    // 显式 action 分发保留（rankAggregate/dailyLock/pointSettle 仍可被手动/测试触发，§6.5）。
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
