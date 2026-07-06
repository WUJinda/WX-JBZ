/**
 * user 云函数入口：用户与报名（对齐技术架构 §4.1，开发计划 B5）。
 * Action: profile / join / stats
 *
 * 本轮实现 profile（B5）。join 留 D1（不实现），stats 留后续阶段。
 * 身份完全以 cloud.getWXContext().OPENID 为可信来源，不下发原始 phone / openid。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware, assertUserExists } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, notImplemented } = require('../common/errors');
const { getProfile } = require('./userProfile');
const { joinDepartment } = require('./userJoin');
const { buildStats } = require('./userStats');
const { updateProfile, cancelAccount } = require('./userAccount');
const { setPhone } = require('./userPhone');
const { getActiveActivityId, getActiveActivity } = require('../activity/activityResolver');
const { loadByWhere } = require('../common/db');

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

    // context.user 已由 main 的 requireUser 统一校验查得（P1-1，避免重复查 User）。
    const store = { User: [context.user] };
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
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人统计）
    // F1：缺省 activity_id 查库当前活动（替代 a_demo_001）；activity 缺省查实际活动文档（替代 mock）。
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const activity = (event && event.activity) || (await getActiveActivity(cloud)) || null;
    const records = await loadUserRecords(cloud, 'StepRecord', userId, activityId);
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
  },
  // 手动设置手机号（保底路径：getPhoneNumber 组件未开通 / 唤不出时用）。requireUser。
  // ⚠️ 降级路径，接收前端明文 phone；安全代价与缓解措施见 userPhone.js 顶部注释。
  // 不授予 is_admin（超管冷启动只走 auth.phone 微信解密，避免明文伪造超管号提权）。
  setPhone: async (event, context) => {
    const openid = context && context.openid;
    const db = cloud.database();
    return setPhone({
      openid,
      db,
      phone: event && event.phone,
      now: new Date()
    });
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
const REQUIRE_USER_ACTIONS = { join: true, stats: true, update: true, cancel: true, setPhone: true };

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
