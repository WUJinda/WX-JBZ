/**
 * admin 云函数入口：后台管理（对齐技术架构 §4.1/§122/§152，PRD F8）。
 * Action: inviteCode.generate / inviteCode.list / inviteCode.disable / users / changeDept / abnormalList / verdict / dashboard / deptManage / points / adjustPoints / settlePoints
 *
 * 所有 action 均为管理员类：handler 内先 loadByWhere 拉相关集合到 store →
 * assertAdmin(store, callerOpenid) → 调对应纯函数 → 写回库 → 返回。
 *
 * 云轨粘合照 tasks/index.js 范式（loadByWhere / 写回封装）。
 * P1-3：写库失败上抛（不再静默 console.warn 吞掉致前端假成功）；批量导入收集 failed 计数上报。
 * callerOpenid 来自 authMiddleware({getWXContext: cloud.getWXContext}).openid。
 * requireAdmin 校验由 assertAdmin 纯函数承担（不改 authMiddleware 通用骨架）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { loadByWhere } = require('../common/db');
const { getActivityById, getActiveActivityId } = require('../activity/activityResolver');

const { assertAdmin } = require('./adminGuard');
const { generateCodes, listCodes, disableCode } = require('./inviteCode');
const { queryUsers } = require('./userList');
const { changeUserDept } = require('./changeDept');
const { setAdminRole } = require('./adminRole');
const { queryAbnormal } = require('./abnormalList');
const { applyVerdict } = require('./verdict');
const { createDept, updateDept, deleteDept } = require('./deptManage');
const { buildDashboard } = require('./dashboard');
const { handleRefreshRank } = require('./refreshRank');
const { queryPoints } = require('./pointList');
const { adjustPoints } = require('./pointAdjust');
const { ensureSchema } = require('../schema/initIndexes');

const handlers = {
  // 邀请码批量生成（一人一码准入券）。loadByWhere InviteCode 供纯函数查重去重。
  // assertAdmin → generateCodes（内存去重生成 N 码）→ generateInviteCodesToCloud 批量 add。
  'inviteCode.generate': async (event, context) => {
    const store = {
      User: await loadByWhere(cloud, 'User'),
      InviteCode: await loadByWhere(cloud, 'InviteCode')
    };
    assertAdmin(store, context.openid);

    const result = generateCodes({
      store,
      count: event && event.count,
      createdBy: context.openid,
      now: new Date()
    });
    // 写回 InviteCode（批量 add）。P1-3：written/failed 基于实际写库结果，失败条目上报前端不假成功。
    const writeBack = await generateInviteCodesToCloud(cloud, result.docs);
    return {
      generated: result.generated,
      codes: result.codes,
      duplicate: result.duplicate,
      batch_id: result.batchId,
      written: writeBack.written,
      write_failed: writeBack.failed
    };
  },

  // 邀请码列表（筛选 + 分页 + 投影，不下发 used_by 原始 openid）。
  'inviteCode.list': async (event, context) => {
    const store = {
      User: await loadByWhere(cloud, 'User'),
      InviteCode: await loadByWhere(cloud, 'InviteCode')
    };
    assertAdmin(store, context.openid);

    return listCodes(store, {
      status: event && event.status,
      batchId: event && event.batch_id,
      page: event && event.page,
      pageSize: event && event.page_size
    });
  },

  // 禁用邀请码（仅 unused 可禁用；used 已绑定用户不可改）。
  'inviteCode.disable': async (event, context) => {
    const store = {
      User: await loadByWhere(cloud, 'User'),
      InviteCode: await loadByWhere(cloud, 'InviteCode')
    };
    assertAdmin(store, context.openid);

    const result = disableCode({ store, code: event && event.code });
    await disableInviteCodeToCloud(cloud, result.code);
    return result;
  },

  // 用户列表（筛选 + 分页 + 投影）。
  users: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User')
    };
    assertAdmin(store, context.openid);

    return queryUsers(store, {
      activityId: event && event.activity_id,
      deptId: event && event.dept_id,
      keyword: event && event.keyword,
      page: event && event.page,
      pageSize: event && event.page_size
    });
  },

  // R8.3 修改用户部门。
  changeDept: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User'),
      Department: await loadByWhere(cloud,'Department')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) || new Date().toISOString();
    // 当前活动 id：校验目标部门属同一活动（防跨活动串部门，见 changeUserDept）。
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const result = changeUserDept(store, {
      userId: event && event.user_id,
      deptId: event && event.dept_id,
      now,
      activityId
    });
    // 写回 User.dept_id（幂等）。
    await updateUserDeptToCloud(cloud, result.userId, result.deptId, result.updatedAt);
    return result;
  },

  // 任命/撤销管理员（管理员互任）：assertAdmin → setAdminRole → 写回 User.is_admin。
  // callerOpenid 用于「禁止自我降级」判定（管理员不能取消自己的管理员身份，防误操作后无人可管）。
  setAdmin: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) || new Date().toISOString();
    const result = setAdminRole(store, {
      userId: event && event.user_id,
      isAdmin: !!(event && event.is_admin),
      callerOpenid: context.openid,
      now
    });
    // 写回 User.is_admin（幂等）。
    await updateAdminRoleToCloud(cloud, result.userId, result.isAdmin, result.updatedAt);
    return result;
  },

  // 异常步数列表。
  abnormalList: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User'),
      StepRecord: await loadByWhere(cloud,'StepRecord')
    };
    assertAdmin(store, context.openid);

    return queryAbnormal(store, {
      activityId: event && event.activity_id,
      page: event && event.page,
      pageSize: event && event.page_size
    });
  },

  // R8.4 异常裁定（ignore / zero）。
  verdict: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User'),
      StepRecord: await loadByWhere(cloud,'StepRecord')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) || new Date().toISOString();
    // 业务 action（ignore/zero）改读 event.verdict_action（兼容 verdictAction），
    // 避免与 exports.main 的 dispatch 字段 event.action（='verdict'）冲突——
    // 否则 applyVerdict 永远收到 'verdict' 而非 'ignore'/'zero'（H1 遗留 bug）。
    const result = applyVerdict(store, {
      recordId: event && event.record_id,
      action: event && (event.verdict_action || event.verdictAction),
      now
    });
    // 写回 StepRecord（幂等）。
    await applyVerdictToCloud(cloud, result.recordId, result.action, now);
    // D1：裁定后即时触发聚合刷新 RankCache，否则榜单仍显示裁定前的异常步数（管理员 zero 置零后
    //   用户仍高居榜首直到下次定时任务）。失败不阻断裁定主返回（StepRecord 已落库），定时任务兜底覆盖。
    const rec = store.StepRecord.find((r) => r && r._id === result.recordId);
    const verdictActivityId = rec && rec.activity_id;
    if (verdictActivityId) {
      try {
        await handleRefreshRank({ cloud, event: { activity_id: verdictActivityId } });
      } catch (e) {
        console.warn('[verdict] 裁定后聚合刷新失败，定时任务兜底', (e && e.message) || e);
      }
    }
    return result;
  },

  // R8.5 数据看板（复用 RankCache，不重算）。
  dashboard: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User'),
      InviteCode: await loadByWhere(cloud,'InviteCode'),
      StepRecord: await loadByWhere(cloud,'StepRecord'),
      RankCache: await loadByWhere(cloud,'RankCache')
    };
    assertAdmin(store, context.openid);

    const activityId = event && event.activity_id;
    // 查活动文档：供 buildDashboard 算活动期起点（start_date）过滤活动期外脏记录
    // （与 steps.sync / user.stats / tasks.rankAggregate 同口径）。未命中（id 空 / 库无此活动）→ null → 兜底不过滤。
    const activity = await getActivityById(cloud, activityId);
    const now = (event && event.now) ? new Date(event.now) : new Date();
    return buildDashboard({
      store,
      activityId,
      activity,
      now,
      config: event && event.config
    });
  },

  // 部门管理（增删改）。
  deptManage: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User'),
      Department: await loadByWhere(cloud,'Department')
    };
    assertAdmin(store, context.openid);

    const op = event && event.op;
    const now = (event && event.now) || new Date().toISOString();
    let result;
    if (op === 'create') {
      result = createDept(store, {
        activityId: event && event.activity_id,
        name: event && event.name,
        now
      });
      await writeDeptToCloud(cloud, store.Department, result.deptId);
    } else if (op === 'update') {
      result = updateDept(store, {
        deptId: event && event.dept_id,
        name: event && event.name,
        now
      });
      await updateDeptToCloud(cloud, result.deptId, result.name);
    } else if (op === 'delete') {
      result = deleteDept(store, { deptId: event && event.dept_id });
      await removeDeptToCloud(cloud, result.deptId);
    } else {
      throw BizError(CODE.SYS_DB_ERROR, 'deptManage: invalid op (create|update|delete)');
    }
    return result;
  },

  // 运维：一键刷新排行榜（管理员手动触发 tasks.rankAggregate，覆盖写 RankCache）。
  // 场景：排查榜单问题 / 用户同步后榜单未即时更新时，管理员手动兜底刷新，不必等定时任务。
  // 守卫（assertAdmin）在此完成；聚合转发 handleRefreshRank（callFunction tasks，复用幂等聚合）。
  // 返回摘要（personal_count/dept_count/updated_at）供前端展示，不下发完整 rows。
  refreshRank: async (event, context) => {
    const store = { User: await loadByWhere(cloud, 'User') };
    assertAdmin(store, context.openid);
    return handleRefreshRank({ cloud, event });
  },

  // 积分台账列表（筛选 + 分页 + join dept_name/total_steps，只读）。
  points: async (event, context) => {
    const activityId = (event && event.activity_id) || await getActiveActivityId(cloud);
    const store = {
      // 投影须含 is_admin：assertAdmin 依 user.is_admin===true 判定（adminGuard.js:32），
      //   漏投影则字段 undefined→!==true→必抛 AUTH_NOT_ADMIN(1003)，积分台账列表任何管理员调都失败。
      User: await loadByWhere(cloud, 'User', {}, { _id: 1, _openid: 1, nickname: 1, dept_id: 1, join_status: 1, points: 1, is_admin: 1 }),
      Department: await loadByWhere(cloud, 'Department'),
      RankCache: await loadByWhere(cloud, 'RankCache', { activity_id: activityId })
    };
    assertAdmin(store, context.openid);
    return queryPoints(store, {
      activityId,
      deptId: event && event.dept_id,
      keyword: event && event.keyword,
      page: event && event.page,
      pageSize: event && event.page_size
    });
  },

  // 手动调整用户积分（增减 delta）。仅余额字段、无流水；写回 User.points（幂等覆盖最终值）。
  adjustPoints: async (event, context) => {
    const store = { User: await loadByWhere(cloud, 'User') };
    assertAdmin(store, context.openid);
    const now = (event && event.now) || new Date().toISOString();
    const result = adjustPoints(store, {
      userId: event && event.user_id,
      delta: event && event.delta,
      now
    });
    await updateUserPointsToCloud(cloud, result.userId, result.points, result.updatedAt);
    return result;
  },

  // 手动触发积分结算（转发 tasks.pointSettle，过 assertAdmin）。场景：活动刚结束想立即结算不等定时任务。
  settlePoints: async (event, context) => {
    const store = { User: await loadByWhere(cloud, 'User') };
    assertAdmin(store, context.openid);
    const res = await cloud.callFunction({
      name: 'tasks',
      data: { action: 'pointSettle', activity_id: event && event.activity_id }
    });
    // callFunction 返回 { result: { code, message, data } }；透传 data（含 settled/awards 等）。
    const result = (res && res.result) || {};
    if (result.code !== 0) {
      throw BizError(result.code || CODE.SYS_DB_ERROR, result.message || 'pointSettle 失败');
    }
    const data = result.data === undefined ? null : result.data;
    // 剥离 awards 中的 openid（_openid 是 onlyServer 字段，绝不下发前端；awardPointsToCloud 内部只用 userId，openid 系冗余）。
    if (data && Array.isArray(data.awards)) {
      data.awards = data.awards.map((a) => (a ? { userId: a.userId, delta: a.delta, reason: a.reason } : a));
    }
    return data;
  },

  // 运维：一键建集合 + 索引（幂等可重跑）。
  // 解决云数据库集合不会自动创建（where().get 查不存在集合报 -502005）导致的手动建表踩坑。
  // 守卫：小程序调用（有 openid）→ assertAdmin；云控制台调试（无 openid）→ 跳过守卫直接执行
  // （ensureSchema 是幂等无害的运维操作，且控制台调试本身已具备云开发开发者权限边界）。
  ensureSchema: async (event, context) => {
    if (context && context.openid) {
      // 小程序调用（必有 OPENID）：强制管理员守卫，与其他 action 一致。
      const store = {
        User: await loadByWhere(cloud,'User')
      };
      assertAdmin(store, context.openid);
    } else if (process.env.SCHEMA_DEBUG_BYPASS === '1') {
      // 显式调试旁路：仅当开发者手动设置环境变量 SCHEMA_DEBUG_BYPASS=1 时生效
      // （云控制台无 wxContext 的建表/建索引场景）。默认生产关闭，杜绝匿名通道越权触发写库。
      console.warn('[ensureSchema] SCHEMA_DEBUG_BYPASS=1，跳过管理员守卫（仅限调试，生产勿开）');
    } else {
      // 无 openid 且未开启显式旁路：拒绝。修正「无 openid 即放行」的隐式越权面
      // （原实现假设「无 openid = 云控制台」，但该假设在匿名 HTTP 通道等场景不成立）。
      throw BizError(
        CODE.AUTH_NO_OPENID,
        'ensureSchema: 需管理员身份；云控制台调试请设环境变量 SCHEMA_DEBUG_BYPASS=1'
      );
    }
    return ensureSchema(cloud);
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；各 handler 直接调用
// loadByWhere(cloud, name)（无 where/field = 全量，admin 纯函数需全量内存筛选）。

/**
 * 云轨：批量新增邀请码写回。本地轨单测不经此路径。
 * P1-3：批量操作收集失败计数返回 {written, failed}（不再静默吞），handler 据此上报前端。
 * @param {object} cloudSdk
 * @param {object[]} docs generateCodes 产出的待写入文档（code/status/batch_id/created_by/created_at/note）
 * @returns {Promise<{written: number, failed: string[]}>}
 */
async function generateInviteCodesToCloud(cloudSdk, docs) {
  const db = cloudSdk.database();
  let written = 0;
  const failed = [];
  for (const d of docs) {
    if (!d || !d.code) continue;
    try {
      await db.collection('InviteCode').add({ data: d });
      written += 1;
    } catch (err) {
      // P1-3：收集失败（不阻断其余条目），返回 written/failed 供 handler 上报（部分成功可重跑）。
      console.warn('[写回失败]', 'InviteCode(' + d.code + ')', (err && err.message) || err);
      failed.push(d.code);
    }
  }
  return { written, failed };
}

/**
 * 云轨：禁用邀请码写回（where({code, status:'unused'}).update，幂等）。
 * @param {object} cloudSdk
 * @param {string} code
 */
async function disableInviteCodeToCloud(cloudSdk, code) {
  const db = cloudSdk.database();
  try {
    await db.collection('InviteCode').where({ code, status: 'unused' }).update({
      data: { status: 'disabled' }
    });
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'InviteCode.disable 写回失败(' + code + '): ' + ((err && err.message) || err));
  }
}

/**
 * 云轨：写回 User.dept_id（幂等）。
 */
async function updateUserDeptToCloud(cloudSdk, userId, deptId, updatedAt) {
  const db = cloudSdk.database();
  try {
    await db.collection('User').doc(userId).update({
      data: { dept_id: deptId, updated_at: updatedAt }
    });
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'User.dept_id 写回失败(' + userId + '): ' + ((err && err.message) || err));
  }
}

/**
 * 云轨：写回 User.is_admin（幂等）。
 */
async function updateAdminRoleToCloud(cloudSdk, userId, isAdmin, updatedAt) {
  const db = cloudSdk.database();
  try {
    await db.collection('User').doc(userId).update({
      data: { is_admin: isAdmin, updated_at: updatedAt }
    });
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'User.is_admin 写回失败(' + userId + '): ' + ((err && err.message) || err));
  }
}

/**
 * 云轨：写回 User.points（手动调整，幂等覆盖为最终值）。
 */
async function updateUserPointsToCloud(cloudSdk, userId, points, updatedAt) {
  const db = cloudSdk.database();
  try {
    await db.collection('User').doc(userId).update({
      data: { points: points, updated_at: updatedAt }
    });
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'User.points 写回失败(' + userId + '): ' + ((err && err.message) || err));
  }
}

/**
 * 云轨：写回 StepRecord 裁定结果（幂等）。
 */
async function applyVerdictToCloud(cloudSdk, recordId, action, now) {
  const db = cloudSdk.database();
  // P1-5：不再写 synced_at（它是步数同步时间，rankAggregate 的 first_reach_at 同分排序依赖它；
  //   裁定时改写会污染排序依据）。裁定时间走独立 verdict_at。
  const data = { abnormal: false };
  if (action === 'zero') data.steps = 0;
  // 裁定留痕（与 verdict.js 一致）：区分「同步为 0」与「裁定置 0」，裁定时间用 verdict_at。
  data.verdict_action = action;
  if (now) data.verdict_at = now;
  try {
    await db.collection('StepRecord').doc(recordId).update({ data });
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'StepRecord.verdict 写回失败(' + recordId + '): ' + ((err && err.message) || err));
  }
}

/**
 * 云轨：新增部门写回。
 */
async function writeDeptToCloud(cloudSdk, department, deptId) {
  const db = cloudSdk.database();
  const doc = department.find((d) => d && d.dept_id === deptId);
  if (!doc) return;
  const data = Object.assign({}, doc);
  delete data._id;
  try {
    await db.collection('Department').add({ data });
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'Department.add 写回失败(' + deptId + '): ' + ((err && err.message) || err));
  }
}

/**
 * 云轨：更新部门名写回。
 */
async function updateDeptToCloud(cloudSdk, deptId, name) {
  const db = cloudSdk.database();
  try {
    await db.collection('Department').where({ dept_id: deptId }).update({ data: { name } });
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'Department.update 写回失败(' + deptId + '): ' + ((err && err.message) || err));
  }
}

/**
 * 云轨：删除部门写回。
 */
async function removeDeptToCloud(cloudSdk, deptId) {
  const db = cloudSdk.database();
  try {
    await db.collection('Department').where({ dept_id: deptId }).remove();
  } catch (err) {
    // P1-3：写库失败上抛（不再静默吞致前端假成功）。
    throw BizError(CODE.SYS_DB_ERROR, 'Department.remove 写回失败(' + deptId + '): ' + ((err && err.message) || err));
  }
}

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'admin.' + action : 'admin.<empty>');
      return fail(err.code, err.message);
    }
    // 取调用者 openid（仅取 OPENID，admin 守卫由 assertAdmin 承担）。
    // ensureSchema 允许无 openid 透传到 handler：云控制台调试无 wxContext 时 authMiddleware 抛
    // AUTH_NO_OPENID。handler 内按「有 openid→assertAdmin / 无 openid→须显式设环境变量
    // SCHEMA_DEBUG_BYPASS=1 才放行，否则拒绝」处理，杜绝「无 openid 即放行」的隐式越权面。
    let context;
    try {
      context = authMiddleware({ getWXContext: cloud.getWXContext });
    } catch (e) {
      if (action !== 'ensureSchema') throw e;
      context = { openid: null };
    }
    const data = await handler(event, context);
    return ok(data);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return fail(err.code, err.message);
    }
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'admin error');
  }
};

module.exports = exports;
