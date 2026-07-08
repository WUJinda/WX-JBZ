/**
 * admin 云函数入口：后台管理（对齐技术架构 §4.1/§122/§152，PRD F8）。
 * Action: whitelistImport / users / changeDept / abnormalList / verdict / dashboard / deptManage
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
const { getActivityById } = require('../activity/activityResolver');

const { assertAdmin } = require('./adminGuard');
const { parseWhitelist } = require('./whitelistParse');
const { applyWhitelistImport } = require('./whitelistImport');
const { queryUsers } = require('./userList');
const { changeUserDept } = require('./changeDept');
const { setAdminRole } = require('./adminRole');
const { queryAbnormal } = require('./abnormalList');
const { applyVerdict } = require('./verdict');
const { createDept, updateDept, deleteDept } = require('./deptManage');
const { buildDashboard } = require('./dashboard');
const { handleRefreshRank } = require('./refreshRank');
const { ensureSchema } = require('../schema/initIndexes');

const handlers = {
  // R8.2 白名单导入：raw_text → parseWhitelist → applyWhitelistImport → 写回 Whitelist。
  whitelistImport: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User'),
      Whitelist: await loadByWhere(cloud,'Whitelist')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) || new Date().toISOString();
    const rawText = (event && (event.raw_text || event.rawText)) || '';
    const delimiter = event && event.delimiter;

    const parsed = parseWhitelist(rawText, { delimiter });
    const result = applyWhitelistImport(store, { phones: parsed.phones, now });

    // 写回 Whitelist（upsert：按 phone 覆盖 imported_at；新增条目 add）。
    // P1-3：written/failed 基于实际写库结果（非纯函数估算），失败条目上报前端不假成功。
    const writeBack = await upsertWhitelistToCloud(cloud, store.Whitelist, now);
    return Object.assign({}, result, {
      duplicate: parsed.duplicate,
      invalid: parsed.invalid,
      written: writeBack.written,
      write_failed: writeBack.failed
    });
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
    const result = changeUserDept(store, {
      userId: event && event.user_id,
      deptId: event && event.dept_id,
      now
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
    return result;
  },

  // R8.5 数据看板（复用 RankCache，不重算）。
  dashboard: async (event, context) => {
    const store = {
      User: await loadByWhere(cloud,'User'),
      Whitelist: await loadByWhere(cloud,'Whitelist'),
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
 * 云轨：白名单 upsert 写回（新增条目 add；已存在条目按 phone update imported_at）。
 * 本地轨单测不经此路径。
 * P1-3：批量操作收集失败计数返回 {written, failed}（不再静默吞），handler 据此上报前端。
 * @param {object} cloudSdk
 * @param {object[]} whitelist 已就地改的 Whitelist（含 phone/imported_at）
 * @param {string} now
 * @returns {Promise<{written: number, failed: string[]}>}
 */
async function upsertWhitelistToCloud(cloudSdk, whitelist, now) {
  const db = cloudSdk.database();
  let written = 0;
  const failed = [];
  for (const w of whitelist) {
    if (!w || !w.phone) continue;
    try {
      const existing = await db.collection('Whitelist').where({ phone: w.phone }).limit(1).get();
      const data = (existing && existing.data) || [];
      if (data.length > 0 && data[0]._id) {
        await db.collection('Whitelist').doc(data[0]._id).update({ data: { imported_at: now } });
      } else {
        await db.collection('Whitelist').add({ data: { phone: w.phone, imported_at: now } });
      }
      written += 1;
    } catch (err) {
      // P1-3：收集失败（不阻断其余条目），返回 written/failed 供 handler 上报（部分成功可重跑）。
      console.warn('[写回失败]', 'Whitelist(' + w.phone + ')', (err && err.message) || err);
      failed.push(w.phone);
    }
  }
  return { written, failed };
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
