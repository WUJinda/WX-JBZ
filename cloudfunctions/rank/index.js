/**
 * rank 云函数入口：排行榜（读缓存，对齐技术架构 §4.1）。
 * Action: personal / dept / deptMembers
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware, assertUserExists } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { readPersonal, readDept, readDeptMembers } = require('./rankQuery');
const { loadByWhere } = require('../common/db');
const { getActiveActivityId } = require('../activity/activityResolver');

const handlers = {
  // G4: 个人榜（读 RankCache，分页 + 我的排名）。需登录态（requireUser）。
  // handler 负责「拉 RankCache → 调纯函数」；本地轨单测直接调 readPersonal 纯函数。
  personal: async (event, context) => {
    const openid = context && context.openid;
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人 myRank）
    const page = event && event.page;
    const pageSize = event && event.page_size;
    // P0-5：按 activity_id 精确拉取该活动 RankCache（单文档形态，每活动 personal/dept 各一个）。
    const store = { RankCache: await loadByWhere(cloud, 'RankCache', { activity_id: activityId }) };
    return readPersonal({ store, activityId, userId, page, pageSize });
  },

  // G5: 部门榜（metric avg/total 可切，读 RankCache）。需登录态。
  dept: async (event, context) => {
    const openid = context && context.openid;
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const metric = event && event.metric;
    const page = event && event.page;
    const pageSize = event && event.page_size;
    // 当前用户所在 dept_id：优先 event.dept_id，否则按 openid 查 User。
    let deptIdOfUser = (event && event.dept_id) || '';
    if (!deptIdOfUser) {
      try {
        const db = cloud.database();
        const uRes = await db.collection('User').where({ _openid: openid }).get();
        const users = (uRes && uRes.data) || [];
        if (users.length) deptIdOfUser = users[0].dept_id || '';
      } catch (err) {
        deptIdOfUser = '';
      }
    }
    // P0-5：按 activity_id 精确拉取该活动 RankCache（单文档形态，每活动 personal/dept 各一个）。
    const store = { RankCache: await loadByWhere(cloud, 'RankCache', { activity_id: activityId }) };
    return readDept({ store, activityId, deptIdOfUser, metric, page, pageSize });
  },

  // G5: 部门内成员排名（按 dept_id 过滤 personal RankCache，本人 is_me）。需登录态。
  deptMembers: async (event, context) => {
    const openid = context && context.openid;
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const deptId = event && event.dept_id;
    const currentUserId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权伪造 is_me）
    const page = event && event.page;
    const pageSize = event && event.page_size;
    // P0-5：按 activity_id 精确拉取该活动 RankCache（单文档形态，每活动 personal/dept 各一个）。
    const store = { RankCache: await loadByWhere(cloud, 'RankCache', { activity_id: activityId }) };
    return readDeptMembers({ store, activityId, deptId, currentUserId, page, pageSize });
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；personal/dept/deptMembers
// 改用 loadByWhere(cloud,'RankCache',{activity_id}) 按活动精确拉取（单文档形态）。

// 需登录态（requireUser）的 action：personal/dept/deptMembers 均需 OPENID（与 activity.current 游客通道不同）。
const REQUIRE_USER_ACTIONS = { personal: true, dept: true, deptMembers: true };

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'rank.' + action : 'rank.<empty>');
      return fail(err.code, err.message);
    }
    // rank.* 全部需登录态（requireUser，必须有 OPENID）。
    // authMiddleware 当前 requireUser 为 TODO 占位，OPENID 缺失会在 getOpenid 阶段抛 AUTH_NO_OPENID。
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
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'rank error');
  }
};

module.exports = exports;

// 导出便于结构校验/测试引用（handler 表挂载点）。
module.exports.handlers = handlers;
module.exports.REQUIRE_USER_ACTIONS = REQUIRE_USER_ACTIONS;
