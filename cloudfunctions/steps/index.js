/**
 * steps 云函数入口：步数同步与查询（对齐技术架构 §4.1/§5.5/§6.2，PRD F3 R3.1~R3.6）。
 * Action: sync / today / history
 *
 * 红线（架构 §6.2）：
 *   - session_key 主路径：每次同步前端带最新 wx.login code → 当次 code2Session 取新鲜 session_key
 *     → 立即解密 → session_key 用后即弃，**绝不写入任何表、不下发前端**。
 *   - 身份仅 OPENID；sync/today/history 均走 requireUser（需 OPENID）；无自管 token。
 *   - 不下发 _openid / sync_count 等敏感字段（用 projectStep 投影）。
 *
 * 解耦：decrypt/syncSteps/getToday/getHistory 均为纯函数（注入式），
 *       单测直接调纯函数，不经本 handler；本 handler 负责当次 code2Session 取 key + 调纯函数。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { decryptSteps } = require('./decrypt');
const { syncSteps } = require('./stepsSync');
const { getToday, getHistory } = require('./stepsQuery');

/**
 * 当次 code2Session：用前端最新 wx.login code 换 openid + session_key（新鲜，用后即弃）。
 * 真实环境走 cloud.callCloud / openapi；本地轨/单测不经此路径。
 *
 * @param {object} cloudSdk
 * @param {string} jsCode wx.login code
 * @returns {Promise<{openid:string, sessionKey:string}>}
 */
async function code2Session(cloudSdk, jsCode) {
  if (!cloudSdk || !cloudSdk.openapi || typeof cloudSdk.openapi.auth !== 'function') {
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'code2Session: cloud openapi not available');
  }
  if (!jsCode) {
    throw BizError(CODE.STEP_DECRYPT_FAILED, 'code2Session: jsCode required');
  }
  // wx-server-sdk openapi 形态：cloud.openapi.auth.code2Session({ code })
  let res;
  try {
    res = await cloudSdk.openapi.auth.code2Session({ code: jsCode });
  } catch (e) {
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'code2Session: ' + ((e && e.errMsg) || (e && e.message) || 'failed'));
  }
  const r = (res && res.result) || res || {};
  if (!r.session_key || !r.openid) {
    throw BizError(CODE.STEP_DECRYPT_FAILED, 'code2Session: no session_key/openid returned');
  }
  // 注意：session_key 仅在此返回值中短暂存在，调用方用完立即丢弃，不落库不下发。
  return { openid: r.openid, sessionKey: r.session_key };
}

// handler 表：action -> handler。
const handlers = {
  // E2: 步数同步（当次 code2Session 取新鲜 session_key → 立即解密 → upsert）。
  // session_key 绝不落库 / 不下发（架构 §6.2）。
  sync: async (event, context) => {
    const openid = context && context.openid;
    const userId = (event && event.user_id) || openid; // 本地轨：无独立 user 表时用 openid 作 user_id
    const activityId = event && event.activity_id;
    const jsCode = event && event.code;
    const iv = event && event.iv;
    const encryptedData = event && event.encrypted_data;
    const activity = event && event.activity; // 可选：传入活动文档（云轨改为按 activity_id 查库）
    const config = event && event.config;

    // 当次取新鲜 session_key（用后即弃）。
    const { sessionKey } = await code2Session(cloud, jsCode);
    // 立即解密 → stepInfoList。
    const { stepInfoList } = decryptSteps({ sessionKey, iv, encryptedData });
    // sessionKey 变量自此不再被引用（GC 回收）；不落库、不下发。

    const store = { StepRecord: await loadCollection(cloud, 'StepRecord') };
    return syncSteps({
      store,
      openid,
      userId,
      activityId,
      stepInfoList,
      activity,
      config
    });
  },

  // E3: 当日步数。
  today: async (event, context) => {
    const openid = context && context.openid;
    const userId = (event && event.user_id) || openid;
    const activityId = event && event.activity_id;
    const store = { StepRecord: await loadCollection(cloud, 'StepRecord') };
    return getToday({ store, userId, activityId });
  },

  // E3: 历史区间查询。
  history: async (event, context) => {
    const openid = context && context.openid;
    const userId = (event && event.user_id) || openid;
    const activityId = event && event.activity_id;
    const from = event && event.from;
    const to = event && event.to;
    const store = { StepRecord: await loadCollection(cloud, 'StepRecord') };
    return getHistory({ store, userId, activityId, from, to });
  }
};

/**
 * 载入集合全部文档（云轨真实库）。
 * 本地轨/单测不经此 handler，直接调纯函数注入 store。
 * @param {object} cloudSdk
 * @param {string} name
 * @returns {Promise<object[]>}
 */
async function loadCollection(cloudSdk, name) {
  const db = cloudSdk.database();
  const PAGE = 100;
  let all = [];
  let skip = 0;
  // 简单分页拉取（StepRecord 量级可控）。
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await db
      .collection(name)
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

// 需登录态（requireUser）的 action：sync/today/history 均需 OPENID（与 activity.current 游客通道不同）。
const REQUIRE_USER_ACTIONS = { sync: true, today: true, history: true };

exports.main = async (event) => {
  const action = event && event.action;
  try {
    const handler = handlers[action];
    if (typeof handler !== 'function') {
      const err = notImplemented(action ? 'steps.' + action : 'steps.<empty>');
      return fail(err.code, err.message);
    }
    // sync/today/history 需登录态：requireUser=true（必须有 OPENID，与游客通道区分）。
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
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'steps error');
  }
};

// 导出便于结构校验/测试引用（handler 表挂载点）。
module.exports.code2Session = code2Session;
module.exports.handlers = handlers;
