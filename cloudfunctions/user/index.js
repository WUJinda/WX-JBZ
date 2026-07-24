/**
 * user 云函数入口：用户与报名（对齐技术架构 §4.1，开发计划 B5）。
 * Action: profile / join / chooseDept / stats
 *
 * 本轮实现 profile（B5）。join 留 D1（不实现），stats 留后续阶段。
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源，不下发原始 openid。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware, assertUserExists } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { getProfile } = require('./userProfile');
const { joinDepartment } = require('./userJoin');
const { chooseDepartment } = require('./userChooseDept');
const { buildStats } = require('./userStats');
const { updateProfile, cancelAccount } = require('./userAccount');
const { getActiveActivityId, getActiveActivity } = require('../activity/activityResolver');
const { loadByWhere } = require('../common/db');

// handler 表：action -> handler。
const handlers = {
  // B5: 个人资料（邀请码 / 部门 / 累计步数，不下发敏感字段）。
  // 累计步数由 buildStats 实时聚合 StepRecord 得来（与 user.stats / home 同源），不再读
  //   User.total_steps 幽灵字段（该字段从不被写、恒 0，曾致「我的」页与首页累计步数对不上）。
  profile: async (event, context) => {
    const openid = context && context.openid;
    const db = cloud.database();
    // totalSteps 与 stats 同源（loadStatsInput + buildStats），保证「我的」页与首页数字一致。
    const { records, activity } = await loadStatsInput(cloud, openid);
    const stats = buildStats({ records, activity });
    return getProfile({ openid, db, totalSteps: stats.total_steps });
  },
  // D1: 报名归属（选部门）。需登录态（requireUser，必须 OPENID），与 activity.current 游客通道不同。
  // handler 只做「取上下文 → 取当前 user → 调纯函数 → 落库」。
  // 本地轨：单测直接调 joinDepartment 纯函数（注入 store），不经此 handler；
  //         云轨联调用真实 cloud.database() 按 _openid 查/更新 User。
  // D1：报名活动（纯报名，与选部门解耦）。需登录态（requireUser，必须 OPENID）。
  // join 只写 join_status: pending→joined，不取 dept_id、不拉 Department（部门由 chooseDept 管）。
  // handler 只做「取上下文 → 取活动终止/截止 → 调纯函数 → 落库」。
  // 本地轨：单测直接调 joinDepartment 纯函数（注入 store），不经此 handler。
  join: async (event, context) => {
    const openid = context && context.openid;
    const db = cloud.database();

    // context.user 已由 main 的 requireUser 统一校验查得（P1-1，避免重复查 User）。
    const store = { User: [context.user] };

    // 活动终止 + 报名截止校验：取当前活动文档。
    //   - terminated=true → 拒绝报名（joinDepartment 抛 STEP_ACTIVITY_CLOSED，与 steps.sync 同码）；
    //   - effective 截止 = signup_deadline ?? end_time（不填 signup_deadline = 活动结束前都可报名）。
    //   活动查询失败/缺失 → 两项都不传（降级兼容，不阻断报名）。
    let signupDeadline, activityTerminated;
    try {
      const activity = await getActiveActivity(cloud);
      if (activity) {
        activityTerminated = activity.terminated === true;
        signupDeadline = activity.signup_deadline || activity.end_time;
      }
    } catch (err) {
      // 活动查询失败不阻断报名（降级为不校验终止/截止）。
    }
    const result = await joinDepartment({ store, openid, signupDeadline, activityTerminated });
    // 落库：只写报名状态（不写 dept_id，部门由 chooseDept 管）。
    await db.collection('User').where({ _openid: openid }).update({
      data: {
        join_status: result.join_status,
        joined_at: result.joined_at,
        updated_at: result.joined_at
      }
    });
    return result;
  },
  // 选部门（注册向导用）：写 dept_id，不碰 join_status；选完固定不可换。需登录态。
  // handler 只做「取上下文 → 拉 Department → 调纯函数 → 落库（仅 dept_id）」。
  // 本地轨：单测直接调 chooseDepartment 纯函数（注入 store），不经此 handler。
  chooseDept: async (event, context) => {
    const openid = context && context.openid;
    const deptId = event && event.dept_id;
    const db = cloud.database();

    const store = { User: [context.user] };
    try {
      const deptRes = await db.collection('Department').get();
      store.Department = (deptRes && deptRes.data) || [];
    } catch (err) {
      store.Department = [];
    }
    const result = chooseDepartment({ store, openid, deptId, now: new Date() });
    // 落库：只写 dept_id（不写 join_status，报名状态由 join 管）。
    await db.collection('User').where({ _openid: openid }).update({
      data: {
        dept_id: result.dept_id,
        updated_at: result.updated_at
      }
    });
    return result;
  },
  // F4: 个人主页统计（当日/累计/参与天数/活动期天数/排名）。
  // 需登录态（requireUser）。复用有效步数口径（与 steps.today/history 一致）。
  // records/activity 加载与 profile handler 共用 loadStatsInput（同源，避免口径分叉）。
  stats: async (event, context) => {
    const openid = context && context.openid;
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人统计）
    const { records, activity, activityId } = await loadStatsInput(cloud, userId, {
      activityId: event && event.activity_id,
      activity: event && event.activity
    });
    // P1-11：从 RankCache personal 单文档查本人排名（替代 buildStats 写死 null）。
    const myRank = await loadMyRank(cloud, activityId, userId);
    return buildStats({ records, activity, myRank });
  },
  // 修改账号信息（昵称+头像）。requireUser（context.user 已由 main 统一查得，P1-1）。
  // handler 只做「取上下文 → 调纯函数」，落库在 updateProfile 内完成。
  update: async (event, context) => {
    const openid = context && context.openid;
    const db = cloud.database();
    return updateProfile({
      openid,
      db,
      nickname: event && event.nickname,
      avatar: event && event.avatar,
      now: new Date()
    });
  },
  // 注销账号（删本人 User + StepRecord）。requireUser。
  // wrapRemoveAll：真实库 where().remove() 单次上限 20 条，循环删除；cancelAccount 纯函数无感。
  cancel: async (event, context) => {
    const openid = context && context.openid;
    const db = cloud.database();
    return cancelAccount({ openid, db: wrapRemoveAll(db) });
  }
};

/**
 * 包裹真实云数据库：where().remove() 循环删除直到清空。
 *
 * wx-server-sdk 的 collection().where().remove() 单次最多删 20 条；StepRecord 可能超量，
 * 直接 remove 一次会漏删。本代理把 remove 语义改为「循环删到 removed=0」，
 * 保持 cancelAccount 纯函数的调用形态不变（纯函数对注入 db 直接 remove 一次，mockDb 无此限）。
 *
 * 仅覆盖 collection(name).where(c).remove() 链路（cancelAccount 唯一用到的删除路径）；
 * 其它链式方法不经过本代理（cancelAccount 不调 get/update/add）。
 *
 * @param {object} db cloud.database()
 * @returns {object} 代理 db
 */
function wrapRemoveAll(db) {
  return {
    collection(name) {
      const col = db.collection(name);
      return {
        where(c) {
          const w = col.where(c);
          return {
            remove: async () => {
              let total = 0;
              // 循环上限保护：单用户 StepRecord 不可能超 2 万条（1000 轮×20）。
              // 超限即异常库状态（权限/索引故障致 remove 持续返回非零但不实删），break 防死循环耗尽云函数超时。
              let guard = 0;
              while (guard++ < 1000) {
                const r = await w.remove();
                const n = (r && r.stats && r.stats.removed) || 0;
                total += n;
                if (n === 0) break; // 无更多匹配 → 终止
              }
              return { stats: { removed: total } };
            }
          };
        }
      };
    }
  };
}

/**
 * 载入某用户某活动的 StepRecord（云轨真实库）。
 * 本地轨/单测不经此 handler，直接调纯函数注入 records。
 * @param {object} cloudSdk
 * @param {string} name
 * @param {string} userId
 * @param {string} activityId
 * @returns {Promise<object[]>}
 */
async function loadUserRecords(cloudSdk, name, userId, activityId) {
  const db = cloudSdk.database();
  const PAGE = 100;
  let all = [];
  let skip = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await db
      .collection(name)
      .where({ user_id: userId, activity_id: activityId })
      .skip(skip)
      .limit(PAGE)
      .get();
    const data = (res && res.data) || [];
    all = all.concat(data);
    if (data.length < PAGE) break;
    skip += PAGE;
  }
  return all;
}

/**
 * 加载 buildStats 的共用输入：当前活动 + 该用户该活动的 StepRecord。
 * stats / profile 两个 handler 共用此函数，保证「我的累计步数」与「首页累计步数」同源同口径
 * （避免任一 handler 另立查询路径导致两页数字分叉）。
 *
 * @param {object} cloudSdk
 * @param {string} userId（= openid）
 * @param {object} [opts]
 * @param {string} [opts.activityId] 显式 activity_id（stats 接 event.activity_id；缺省查当前活动）
 * @param {object} [opts.activity] 显式 activity 文档（测试注入用；缺省查 getActiveActivity）
 * @returns {Promise<{records:object[], activity:object|null, activityId:string}>}
 */
async function loadStatsInput(cloudSdk, userId, opts) {
  const o = opts || {};
  // activity / activityId 独立兜底；两者都不传（最常见：stats 不带 activity_id）时共享一次 getActiveActivity，
  //   避免全表拉 Activity 两次（原 getActiveActivityId + getActiveActivity 各拉一次）。显式只传其一时保持原语义。
  let activityId = o.activityId;
  let activity = o.activity || null;
  if (!activityId && !activity) {
    const activeDoc = await getActiveActivity(cloudSdk);
    activity = activeDoc || null;
    activityId = (activeDoc && (activeDoc.activity_id || activeDoc._id)) || '';
  } else if (!activityId) {
    activityId = await getActiveActivityId(cloudSdk);
  } else if (!activity) {
    activity = (await getActiveActivity(cloudSdk)) || null;
  }
  const records = await loadUserRecords(cloudSdk, 'StepRecord', userId, activityId);
  return { records, activity, activityId };
}

/**
 * 从 RankCache personal 单文档查本人排名行（P1-11，供 user.stats 的 my_rank）。
 * @param {object} cloudSdk
 * @param {string} activityId
 * @param {string} userId
 * @returns {Promise<object|null>} 本人排名行 {rank,total_steps,...} 或 null（未进榜/未聚合/查询失败）
 */
async function loadMyRank(cloudSdk, activityId, userId) {
  if (!activityId || !userId) return null;
  try {
    const docs = await loadByWhere(cloudSdk, 'RankCache', { type: 'personal', activity_id: activityId });
    const doc = docs[0];
    return (doc && Array.isArray(doc.rows)
      ? doc.rows.find((r) => r && r.user_id === userId) || null
      : null);
  } catch (err) {
    return null;
  }
}

// 需登录态（requireUser）的 action：必须有 OPENID 且 User 存在。
// 与 activity.current 游客通道不同——join/stats/update/cancel 必须登录态。
const REQUIRE_USER_ACTIONS = { join: true, chooseDept: true, stats: true, update: true, cancel: true };

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'user.' + action : 'user.<empty>');
      return fail(err.code, err.message);
    }
    // join 需登录态：requireUser=true（必须有 OPENID，与游客通道区分）。
    // authMiddleware 当前 requireUser 为 TODO 占位，OPENID 缺失会在 getOpenid 阶段抛 AUTH_NO_OPENID；
    // User 存在性由 join handler 内部按 _openid 查库兜底校验。
    const requireUser = !!REQUIRE_USER_ACTIONS[action];
    const context = authMiddleware({
      getWXContext: cloud.getWXContext,
      requireUser
    });
    // P1-1：requireUser 的 DB 校验（统一入口，避免每个 handler 重复查 User）。
    if (requireUser) {
      context.user = await assertUserExists(cloud.database(), context.openid);
    }
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'user error');
  }
};

module.exports = exports;
