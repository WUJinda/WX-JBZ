/**
 * user 云函数入口：用户与报名（对齐技术架构 §4.1，开发计划 B5）。
 * Action: profile / join / stats
 *
 * 本轮实现 profile（B5）。join 留 D1（不实现），stats 留后续阶段。
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源，不下发原始 phone / openid。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { getProfile } = require('./userProfile');
const { joinDepartment } = require('./userJoin');
const { buildStats } = require('./userStats');
const { mockCurrentActivity } = require('../activity/activityStatus');

// handler 表：action -> handler。
const handlers = {
  // B5: 个人资料（脱敏手机号 / 部门 / 累计步数占位，不下发敏感字段）
  profile: async (event, context) => {
    const db = cloud.database();
    return getProfile({ openid: context && context.openid, db });
  },
  // D1: 报名归属（选部门）。需登录态（requireUser，必须 OPENID），与 activity.current 游客通道不同。
  // handler 只做「取上下文 → 取当前 user → 调纯函数 → 落库」。
  // 本地轨：单测直接调 joinDepartment 纯函数（注入 store），不经此 handler；
  //         云轨联调用真实 cloud.database() 按 _openid 查/更新 User。
  join: async (event, context) => {
    const openid = context && context.openid;
    const deptId = event && event.dept_id;
    const db = cloud.database();

    // 按 _openid 取当前 user（云轨真实库；单测不经此路径）
    const userRes = await db.collection('User').where({ _openid: openid }).get();
    const users = (userRes && userRes.data) || [];
    if (users.length === 0) {
      const e = require('../common/errors');
      throw e.BizError(e.CODE.AUTH_USER_NOT_FOUND, 'join: user not found');
    }
    // 取部门源（Department 集合可能未初始化 → 用 mock 兜底，joinDepartment 内部处理）
    const store = { User: users };
    try {
      const deptRes = await db.collection('Department').get();
      store.Department = (deptRes && deptRes.data) || [];
    } catch (err) {
      store.Department = [];
    }
    const result = await joinDepartment({ store, openid, deptId });
    // 落库：将更新写回云数据库（joinDepartment 已就地改 store 中的引用对象）
    await db.collection('User').where({ _openid: openid }).update({
      data: {
        dept_id: result.dept_id,
        join_status: result.join_status,
        joined_at: result.joined_at,
        updated_at: result.joined_at
      }
    });
    return result;
  },
  // F4: 个人主页统计（当日/累计/参与天数/活动期天数/排名占位）。
  // 需登录态（requireUser）。复用有效步数口径（与 steps.today/history 一致）。
  stats: async (event, context) => {
    const openid = context && context.openid;
    const userId = (event && event.user_id) || openid;
    const activityId = (event && event.activity_id) || 'a_demo_001';
    const activity = (event && event.activity) || loadActivity(cloud);
    const records = await loadUserRecords(cloud, 'StepRecord', userId, activityId);
    return buildStats({ records, activity });
  }
};

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
 * 载入活动文档（本地轨用 mock；云轨按 activity_id 查库）。
 * @param {object} cloudSdk
 * @returns {object}
 */
function loadActivity(cloudSdk) {
  // 本地轨：用 mockCurrentActivity（与 activity.current 一致）。
  // 云轨：可按 activity_id 查 Activity 集合；本阶段先以 mock 兜底，保证 total_days 可算。
  return mockCurrentActivity();
}

// 需登录态（requireUser）的 action：必须有 OPENID 且 User 存在。
// 与 activity.current 游客通道不同——join/stats 必须登录态。
const REQUIRE_USER_ACTIONS = { join: true, stats: true };

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
