/**
 * activity 云函数入口：活动（对齐技术架构 §4.1 / §5.4，开发计划阶段 C/I，PRD F7/F8）。
 * Action: current（游客可调，F7）/ save（管理员，F8）/ get / list / terminate（管理员）
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
const { CODE, BizError, notImplemented } = require('../common/errors');
const { authMiddleware } = require('../common/authMiddleware');
const { loadByWhere } = require('../common/db');
const { assertAdmin } = require('../common/adminGuard');
const { getCurrent, deriveStatus, pickCurrentActivity } = require('./activityStatus');
const { saveActivity } = require('./activitySave');
const { terminateActivity } = require('./activityTerminate');
const { listActivities } = require('./activityList');

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
  // C1: 当前活动 + 状态推算 + 全员概览（游客可调）。
  // 云轨：读真实 Activity / User / RankCache（修复硬伤：原硬编码 joinStatus=pending、overview=0）。
  // getCurrent 纯函数在 activity/overview 缺省时走本地 mock（供本地轨/单测），此处显式注入真实数据。
  current: async (event) => {
    const openid = safeOpenid(cloud.getWXContext);
    const now = (event && event.now) || undefined;
    const db = cloud.database();

    // 1. 真实活动：读 Activity 集合（管理员经 save 发布），选「当前活动」。
    //    pickCurrentActivity：排除 terminated，按 active→pending→ended 优先（与 listActivities
    //    排序同源）。新增活动据此顶替旧活动；终止活动被排除；全终止/库空→null→走空态。
    //    旧逻辑取 activities[0]：loadByWhere 返回顺序无保证且不排除 terminated →
    //    「新增活动不更新 + 终止活动仍展示」根因。
    //    F2：空集合不回退 mock（旧 mock 带假时间窗 2026-07-01~07-21 会误导用户），
    //    返回空态让前端显示"活动未发布/未开始"。
    const activities = await loadByWhere(cloud, 'Activity');
    const activity = pickCurrentActivity(activities, now) || {
      activity_id: '', name: '', start_time: null, end_time: null, signup_deadline: null, rules: ''
    };

    // 2. 真实报名状态：按 openid 查 User（游客 openid 空 → pending）。
    let joinStatus = 'pending';
    if (openid) {
      try {
        const uRes = await db.collection('User').where({ _openid: openid }).limit(1).get();
        const users = (uRes && uRes.data) || [];
        if (users.length && users[0].join_status === 'joined') joinStatus = 'joined';
      } catch (err) {
        joinStatus = 'pending';
      }
    }

    // 3. 真实概览：participant_count=已报名人数；total_steps=个人榜有效步数之和（tasks 预聚合）。
    //    任一查询失败 → 该项降级 0（不阻断活动主页展示）。
    let overview = { total_steps: 0, participant_count: 0 };
    try {
      const joinedRes = await db.collection('User').where({ join_status: 'joined' }).count();
      const participantCount = (joinedRes && joinedRes.total) || 0;
      const aid = activity.activity_id || '';
      // P0-3 单文档：personal 榜存为一个文档 {type,activity_id,rows:[...]}，total_steps 在 rows 内。
      //   旧多文档逻辑（直接读 r.total_steps）在单文档化后恒 undefined → overview.total_steps 恒 0（已修）。
      const rankDocs = await loadByWhere(cloud, 'RankCache', { type: 'personal', activity_id: aid });
      const pDoc = rankDocs[0];
      const personalTotal = (pDoc && Array.isArray(pDoc.rows))
        ? pDoc.rows.reduce((s, r) => s + (Number(r.total_steps) || 0), 0)
        : 0;
      overview = { total_steps: personalTotal, participant_count: participantCount };
    } catch (err) {
      // 降级：overview 保持 { total_steps: 0, participant_count: 0 }。
    }

    return getCurrent({ activity, openid, joinStatus, overview, now });
  },

  // I: 活动配置/发布（管理员）。R8.1 由 deriveStatus 天然满足，无 published 字段。
  save: async (event) => {
    // 管理员鉴权：取 openid（强制非空）+ assertAdmin（非管理员 AUTH_NOT_ADMIN）。
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const store = {
      User: await loadByWhere(cloud, 'User'),
      Activity: await loadByWhere(cloud, 'Activity')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) || new Date().toISOString();
    // publish 字段后端忽略（可见性纯由 start_time+now 推算）。
    const result = saveActivity(store, {
      activity: {
        activity_id: event && event.activity_id,
        name: event && event.name,
        start_time: event && event.start_time,
        end_time: event && event.end_time,
        signup_deadline: event && event.signup_deadline,
        rules: event && event.rules
      },
      now
    });

    // 云轨：写回 Activity（upsert：存在 update，不存在 add）。单条失败不阻断、幂等可重跑。
    await upsertActivityToCloud(cloud, store.Activity, result.activity_id, now);
    return result;
  },

  // 编辑页回填：返回完整活动字段（含 signup_deadline/terminated/terminated_at）。管理员（assertAdmin）。
  get: async (event) => {
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const store = {
      User: await loadByWhere(cloud, 'User'),
      Activity: await loadByWhere(cloud, 'Activity')
    };
    assertAdmin(store, context.openid);
    // activity_id 缺省取首条（P0 单期活动仅一个）；编辑页一般显式传当前 activity_id。
    const activityId = (event && event.activity_id) || '';
    const activity = activityId
      ? store.Activity.find((a) => a && a.activity_id === activityId)
      : (store.Activity[0] || null);
    if (!activity) {
      throw BizError(CODE.BIZ_PARAM_MISSING, 'activity.get: activity not found');
    }
    return {
      activity_id: activity.activity_id || activity._id || '',
      name: activity.name || '',
      start_time: activity.start_time,
      end_time: activity.end_time,
      signup_deadline: activity.signup_deadline || null,
      status: deriveStatus(activity),
      terminated: activity.terminated === true,
      terminated_at: activity.terminated_at || null,
      rules: activity.rules || ''
    };
  },

  // 活动列表（管理员）：返回全部活动 + 推算状态（active 优先），供后台「活动配置」列表页。
  list: async (event) => {
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const store = {
      User: await loadByWhere(cloud, 'User'),
      Activity: await loadByWhere(cloud, 'Activity')
    };
    assertAdmin(store, context.openid); // 非管理员 AUTH_NOT_ADMIN
    const now = (event && event.now) || undefined;
    return listActivities(store, { now });
  },

  // 手动终止活动（不可恢复）：置 terminated/terminated_at + status=ended。管理员（assertAdmin）。
  terminate: async (event) => {
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
    const store = {
      User: await loadByWhere(cloud, 'User'),
      Activity: await loadByWhere(cloud, 'Activity')
    };
    assertAdmin(store, context.openid);
    const activityId = (event && event.activity_id) || '';
    const now = (event && event.now) || new Date().toISOString();
    const result = terminateActivity(store, { activity_id: activityId, now });
    await upsertActivityToCloud(cloud, store.Activity, result.activity_id, now);
    return result;
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；current/save 改用
// loadByWhere（current 的 RankCache 按 type+activity_id 精确查单文档算 overview）。

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
        start_time: doc.start_time,
        end_time: doc.end_time,
        signup_deadline: doc.signup_deadline,
        status: doc.status,
        terminated: doc.terminated === true,
        terminated_at: doc.terminated_at || null,
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
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'Activity.upsert 写回失败(' + activityId + '): ' + ((err && err.message) || err));
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
