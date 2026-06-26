/**
 * rank 云函数入口：排行榜（读缓存，对齐技术架构 §4.1）。
 * Action: personal / dept / deptMembers
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { readPersonal, readDept, readDeptMembers } = require('./rankQuery');

const handlers = {
  // G4: 个人榜（读 RankCache，分页 + 我的排名）。需登录态（requireUser）。
  // handler 负责「拉 RankCache → 调纯函数」；本地轨单测直接调 readPersonal 纯函数。
  personal: async (event, context) => {
    const openid = context && context.openid;
    const activityId = (event && event.activity_id) || 'a_demo_001';
    const userId = (event && event.user_id) || openid; // 本地轨：无独立 user 表时用 openid 作 user_id
    const page = event && event.page;
    const pageSize = event && event.page_size;
    const store = { RankCache: await loadCollection(cloud, 'RankCache') };
    return readPersonal({ store, activityId, userId, page, pageSize });
  },

  // G5: 部门榜（metric avg/total 可切，读 RankCache）。需登录态。
  dept: async (event, context) => {
    const openid = context && context.openid;
    const activityId = (event && event.activity_id) || 'a_demo_001';
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
    const store = { RankCache: await loadCollection(cloud, 'RankCache') };
    return readDept({ store, activityId, deptIdOfUser, metric, page, pageSize });
  },

  // G5: 部门内成员排名（按 dept_id 过滤 personal RankCache，本人 is_me）。需登录态。
  deptMembers: async (event, context) => {
    const openid = context && context.openid;
    const activityId = (event && event.activity_id) || 'a_demo_001';
    const deptId = event && event.dept_id;
    const currentUserId = (event && event.user_id) || openid;
    const page = event && event.page;
    const pageSize = event && event.page_size;
    const store = { RankCache: await loadCollection(cloud, 'RankCache') };
    return readDeptMembers({ store, activityId, deptId, currentUserId, page, pageSize });
  }
};

/**
 * 载入集合全部文档（云轨真实库）。
 * 本地轨/单测不经此 handler，直接调纯函数注入 store。
 *
 * TODO 云轨优化：当前全量拉集合（含 _openid / phone / sync_count 等敏感字段）入内存，
 *   RankCache 量大时有 OOM 风险。对查询类 action 改用 DB 端 `.field()` 投影（仅取必要字段）
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
    all = [];
  }
  return all;
}

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
