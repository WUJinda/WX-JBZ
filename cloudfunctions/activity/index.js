/**
 * activity 云函数入口：活动（对齐技术架构 §4.1 / §5.4，开发计划阶段 C/I，PRD F7/F8）。
 * Action: current（游客可调，F7）/ save（管理员，F8）
 *
 * 红线（游客可见）：
 *   - current 允许游客访问（无 OPENID 也能取活动信息）——不强制 authMiddleware；
 *   - 身份完全以 cloud.getWXContext().OPENID 为可信来源，不使用任何自管 token；
 *   - save（I 后台发布）为管理员 action：handler 内取 openid（强制非空）+ assertAdmin。
 *
 * 鉴权路由：
 *   - current：handler 内用 safeOpenid（无 OPENID 不抛，游客 join_status=pending）；
 *   - save：handler 内用 authMiddleware（缺 OPENID 抛 AUTH_NO_OPENID）+ assertAdmin（非管理员 AUTH_NOT_ADMIN）。
 *     exports.main 对所有 action 直接 dispatch 到 handler，鉴权在各 handler 内按需触发，
 *     以保证 current 游客通道不被入口 authMiddleware 拦截。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { authMiddleware } = require('../common/authMiddleware');
const { assertAdmin } = require('../common/adminGuard');
const { getCurrent } = require('./activityStatus');
const { saveActivity } = require('./activitySave');

/**
 * 游客友好地取 openid：无 OPENID 不抛错，返回空串。
 * （current 不强制身份；仅当后续需要「我的报名状态」时才用 openid。）
 * @param {() => {OPENID?: string}} getWXContext
 * @returns {string}
 */
function safeOpenid(getWXContext) {
  try {
    const ctx = (typeof getWXContext === 'function' ? getWXContext() : {}) || {};
    return ctx.OPENID || '';
  } catch (e) {
    return '';
  }
}

// handler 表：action -> handler。handler 只做「取上下文 → 调纯函数 → 组装出入参」。
const handlers = {
  // C1: 当前活动 + 状态推算 + 全员概览（游客可调）
  // 本地轨：mock 当前活动 / 概览 / join_status（真实云读留云轨联调 / D1 / G）
  current: async (event) => {
    const openid = safeOpenid(cloud.getWXContext);
    // 游客 join_status 恒为 pending（本地轨 mock；真实 user.join 留 D1）
    const joinStatus = 'pending';
    return getCurrent({
      openid,
      joinStatus,
      overview: { total_steps: 0, participant_count: 0 }
    });
  },

  // I: 活动配置/发布（管理员）。R8.1 由 deriveStatus 天然满足，无 published 字段。
  save: async (event) => {
    // 管理员鉴权：取 openid（强制非空）+ assertAdmin（非管理员 AUTH_NOT_ADMIN）。
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const store = {
      User: await loadCollection(cloud, 'User'),
      Activity: await loadCollection(cloud, 'Activity')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) || new Date().toISOString();
    // publish 字段后端忽略（可见性纯由 start_time+now 推算）。
    const result = saveActivity(store, {
      activity: {
        activity_id: event && event.activity_id,
        name: event && event.name,
        cover_url: event && event.cover_url,
        start_time: event && event.start_time,
        end_time: event && event.end_time,
        rules: event && event.rules
      },
      now
    });

    // 云轨：写回 Activity（upsert：存在 update，不存在 add）。单条失败不阻断、幂等可重跑。
    await upsertActivityToCloud(cloud, store.Activity, result.activity_id, now);
    return result;
  }
};

/**
 * 载入集合全部文档（云轨真实库，照 tasks/index.js 范式）。
 * 本地轨/单测不经此 handler，直接调纯函数注入 store。
 *
 * TODO 云轨优化：当前全量拉集合（含 _openid / phone 等敏感字段）入内存，
 *   User 量大时有 OOM 风险。对查询类 action 改用 DB 端 `.field()` 投影（仅取必要字段）
 *   + `.where()` 过滤，避免全量拉敏感集合入内存；当前全量拉取仅为本地轨/早期简化。
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
    // 集合未创建：返回空数组兜底。
    all = [];
  }
  return all;
}

/**
 * 云轨：Activity upsert 写回（存在则 update，不存在则 add）。本地轨单测不经此路径。
 * @param {object} cloudSdk
 * @param {object[]} activity 已就地改的 Activity（含 activity_id）
 * @param {string} activityId 目标 activity_id
 * @param {string} now 当前时间 ISO（用于落库 updated_at 已由纯函数写入）
 */
async function upsertActivityToCloud(cloudSdk, activity, activityId, now) {
  const db = cloudSdk.database();
  const doc = activity.find((a) => a && a.activity_id === activityId);
  if (!doc) return;
  try {
    const existing = await db.collection('Activity').where({ activity_id: activityId }).limit(1).get();
    const data = (existing && existing.data) || [];
    if (data.length > 0 && data[0]._id) {
      const payload = {
        name: doc.name,
        cover_url: doc.cover_url,
        start_time: doc.start_time,
        end_time: doc.end_time,
        status: doc.status,
        rules: doc.rules,
        updated_at: now
      };
      await db.collection('Activity').doc(data[0]._id).update({ data: payload });
    } else {
      const payload = Object.assign({}, doc);
      delete payload._id;
      await db.collection('Activity').add({ data: payload });
    }
  } catch (err) {
    // 单条失败不阻断（幂等可重跑），仅留痕。
    console.warn('[写回失败]', 'Activity.upsert(' + activityId + ')', (err && err.message) || err);
  }
}

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'activity.' + action : 'activity.<empty>');
      return fail(err.code, err.message);
    }
    // current 游客可调：不经 authMiddleware（避免无 OPENID 抛 AUTH_NO_OPENID）。
    // 后续需鉴权的 action（如 save）在此分支内单独走 authMiddleware。
    const data = await handler(event, {});
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'activity error');
  }
};

module.exports = exports;
