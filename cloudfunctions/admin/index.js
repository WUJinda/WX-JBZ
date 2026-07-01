/**
 * admin 云函数入口：后台管理（对齐技术架构 §4.1/§122/§152，PRD F8）。
 * Action: whitelistImport / users / changeDept / abnormalList / verdict / dashboard / deptManage
 *
 * 所有 action 均为管理员类：handler 内先 loadCollection 拉相关集合到 store →
 * assertAdmin(store, callerOpenid) → 调对应纯函数 → 写回库 → 返回。
 *
 * 云轨粘合照 tasks/index.js 范式（loadCollection / 写回封装，单条失败不阻断、幂等可重跑）。
 * callerOpenid 来自 authMiddleware({getWXContext: cloud.getWXContext}).openid。
 * requireAdmin 校验由 assertAdmin 纯函数承担（不改 authMiddleware 通用骨架）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');

const { assertAdmin } = require('./adminGuard');
const { parseWhitelist } = require('./whitelistParse');
const { applyWhitelistImport } = require('./whitelistImport');
const { queryUsers } = require('./userList');
const { changeUserDept } = require('./changeDept');
const { queryAbnormal } = require('./abnormalList');
const { applyVerdict } = require('./verdict');
const { createDept, updateDept, deleteDept } = require('./deptManage');
const { buildDashboard } = require('./dashboard');
const { ensureSchema } = require('../schema/initIndexes');

const handlers = {
  // R8.2 白名单导入：raw_text → parseWhitelist → applyWhitelistImport → 写回 Whitelist。
  whitelistImport: async (event, context) => {
    const store = {
      User: await loadCollection(cloud, 'User'),
      Whitelist: await loadCollection(cloud, 'Whitelist')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) || new Date().toISOString();
    const rawText = (event && (event.raw_text || event.rawText)) || '';
    const delimiter = event && event.delimiter;

    const parsed = parseWhitelist(rawText, { delimiter });
    const result = applyWhitelistImport(store, { phones: parsed.phones, now });

    // 写回 Whitelist（upsert：按 phone 覆盖 imported_at；新增条目 add）。
    await upsertWhitelistToCloud(cloud, store.Whitelist, now);
    return Object.assign({}, result, { duplicate: parsed.duplicate, invalid: parsed.invalid });
  },

  // 用户列表（筛选 + 分页 + 投影）。
  users: async (event, context) => {
    const store = {
      User: await loadCollection(cloud, 'User')
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
      User: await loadCollection(cloud, 'User'),
      Department: await loadCollection(cloud, 'Department')
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

  // 异常步数列表。
  abnormalList: async (event, context) => {
    const store = {
      User: await loadCollection(cloud, 'User'),
      StepRecord: await loadCollection(cloud, 'StepRecord')
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
      User: await loadCollection(cloud, 'User'),
      StepRecord: await loadCollection(cloud, 'StepRecord')
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
      User: await loadCollection(cloud, 'User'),
      Whitelist: await loadCollection(cloud, 'Whitelist'),
      StepRecord: await loadCollection(cloud, 'StepRecord'),
      RankCache: await loadCollection(cloud, 'RankCache')
    };
    assertAdmin(store, context.openid);

    const now = (event && event.now) ? new Date(event.now) : new Date();
    return buildDashboard({
      store,
      activityId: event && event.activity_id,
      now,
      config: event && event.config
    });
  },

  // 部门管理（增删改）。
  deptManage: async (event, context) => {
    const store = {
      User: await loadCollection(cloud, 'User'),
      Department: await loadCollection(cloud, 'Department')
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

  // 运维：一键建集合 + 索引（幂等可重跑）。仅管理员。
  // 解决云数据库集合不会自动创建（where().get 查不存在集合报 -502005）导致的手动建表踩坑。
  ensureSchema: async (event, context) => {
    const store = {
      User: await loadCollection(cloud, 'User')
    };
    assertAdmin(store, context.openid);
    return ensureSchema(cloud);
  }
};

/**
 * 载入集合全部文档（云轨真实库，照 tasks/index.js 范式）。
 * 本地轨/单测不经此 handler，直接调纯函数注入 store。
 *
 * TODO 云轨优化：当前全量拉集合（含 _openid / phone / sync_count 等敏感字段）入内存，
 *   StepRecord / User 量大时有 OOM 风险。对查询类 action 改用 DB 端 `.field()` 投影
 *   （仅取必要字段）+ `.where()` 过滤，避免全量拉敏感集合入内存；
 *   当前全量拉取仅为本地轨（store 注入）/早期简化，后续按 action 精细化投影。
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
 * 云轨：白名单 upsert 写回（新增条目 add；已存在条目按 phone update imported_at）。
 * 本地轨单测不经此路径。
 * @param {object} cloudSdk
 * @param {object[]} whitelist 已就地改的 Whitelist（含 phone/imported_at）
 * @param {string} now
 */
async function upsertWhitelistToCloud(cloudSdk, whitelist, now) {
  const db = cloudSdk.database();
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
    } catch (err) {
      // 单条失败不阻断（幂等可重跑），仅留痕。
      console.warn('[写回失败]', 'Whitelist(' + w.phone + ')', (err && err.message) || err);
    }
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
    // 单条失败不阻断（幂等可重跑），仅留痕。
    console.warn('[写回失败]', 'User.dept_id(' + userId + ')', (err && err.message) || err);
  }
}

/**
 * 云轨：写回 StepRecord 裁定结果（幂等）。
 */
async function applyVerdictToCloud(cloudSdk, recordId, action, now) {
  const db = cloudSdk.database();
  const data = { abnormal: false, synced_at: now };
  if (action === 'zero') data.steps = 0;
  // 裁定留痕（与 verdict.js 一致）：区分「同步为 0」与「裁定置 0」。
  data.verdict_action = action;
  if (now) data.verdict_at = now;
  try {
    await db.collection('StepRecord').doc(recordId).update({ data });
  } catch (err) {
    // 单条失败不阻断（幂等可重跑），仅留痕。
    console.warn('[写回失败]', 'StepRecord.verdict(' + recordId + ')', (err && err.message) || err);
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
    // 单条失败不阻断（幂等可重跑），仅留痕。
    console.warn('[写回失败]', 'Department.add(' + deptId + ')', (err && err.message) || err);
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
    // 单条失败不阻断（幂等可重跑），仅留痕。
    console.warn('[写回失败]', 'Department.update(' + deptId + ')', (err && err.message) || err);
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
    // 单条失败不阻断（幂等可重跑），仅留痕。
    console.warn('[写回失败]', 'Department.remove(' + deptId + ')', (err && err.message) || err);
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
    const context = authMiddleware({ getWXContext: cloud.getWXContext });
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
