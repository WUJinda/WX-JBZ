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

// Node 内置：直接 HTTP 调 jscode2session 取 session_key（code2Session 已改走 HTTP，见下注释）。
const https = require('https');
const querystring = require('querystring');

const { authMiddleware } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { decryptSteps } = require('./decrypt');
const { syncSteps } = require('./stepsSync');
const { getToday, getHistory, getUserRecords } = require('./stepsQuery');
const { buildTrend } = require('./stepsTrend');

/**
 * 当次 code2Session：用前端最新 wx.login code 换 session_key（解密 getWeRunData 用，用后即弃）。
 *
 * ⚠️ 不走 cloud.openapi.auth.code2Session：实测在云开发云函数环境下，微信 openapi 网关持续
 *   返回 -604100 "API not found"（见云函数日志 wxResp.errorCode；SDK 仅原样转述）。已排除：
 *   config.json 已声明 permissions.openapi=["auth.code2Session"]、新代码已部署生效
 *   （/var/user/index.js）、wx-server-sdk 2.6.3 支持该接口——网关侧仍不认（社区同款求助帖：
 *   2.6.3 + 云端安装依赖，持续报错无 openapi 解法）。故改走「直接 HTTP 调 jscode2session」，
 *   生产通用方案，免 openapi 网关、必通。
 *   代价：AppSecret 须以云函数环境变量注入（WX_APPID / WX_APP_SECRET），绝不入源码。
 *
 * 红线不变（架构 §6.2）：session_key 仅本函数返回值短暂存在，调用方立即解密后丢弃，
 *   不落库、不下发前端。
 *
 * @param {string} jsCode wx.login code（须与 getWeRunData 同源登录态，见 home.js onSyncTap）
 * @returns {Promise<{openid:string, sessionKey:string}>}
 */
async function code2Session(jsCode) {
  if (!jsCode) {
    throw BizError(CODE.STEP_DECRYPT_FAILED, 'code2Session: jsCode required');
  }
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_APP_SECRET;
  if (!appid || !secret) {
    throw BizError(
      CODE.SYS_EXTERNAL_ERROR,
      'code2Session: 缺 WX_APPID / WX_APP_SECRET 云函数环境变量（云开发控制台→云函数→steps→配置→环境变量）'
    );
  }
  // GET https://api.weixin.qq.com/sns/jscode2session?appid&secret&js_code&grant_type
  const qs = querystring.stringify({
    appid,
    secret,
    js_code: jsCode,
    grant_type: 'authorization_code'
  });
  const raw = await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.weixin.qq.com', path: '/sns/jscode2session?' + qs, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', (e) => reject(new Error('jscode2session network error: ' + (e && e.message))));
    req.end();
  });
  let r;
  try {
    r = JSON.parse(raw);
  } catch (e) {
    console.error('[steps.code2Session] non-JSON response', String(raw).slice(0, 300));
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'jscode2session 非 JSON 响应: ' + String(raw).slice(0, 200));
  }
  if (r.errcode) {
    // 40029 invalid code / 40163 code been used / 45011 频控 / -1 系统忙。
    console.error('[steps.code2Session] wechat errcode', JSON.stringify(r));
    throw BizError(CODE.SYS_EXTERNAL_ERROR, 'jscode2session errcode ' + r.errcode + ': ' + (r.errmsg || ''));
  }
  if (!r.session_key || !r.openid) {
    throw BizError(CODE.STEP_DECRYPT_FAILED, 'jscode2session: 未返回 session_key/openid');
  }
  // session_key 用后即弃（调用方 decrypt 后不再引用）；不落库、不下发。
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
    const { sessionKey } = await code2Session(jsCode);
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
  },

  // F4: 趋势图（近 7/30 天，纯 CSS 柱状图源数据）。
  // 入参 range 仅接受 7/30，其余按 7 兜底；buildTrend 内部再次兜底。
  trend: async (event, context) => {
    const openid = context && context.openid;
    const userId = (event && event.user_id) || openid;
    const activityId = event && event.activity_id;
    const range = event && event.range;
    const store = { StepRecord: await loadCollection(cloud, 'StepRecord') };
    const records = getUserRecords(store, userId, activityId);
    return buildTrend({ records, range });
  }
};

/**
 * 载入集合全部文档（云轨真实库）。
 * 本地轨/单测不经此 handler，直接调纯函数注入 store。
 *
 * TODO 云轨优化：当前全量拉集合（含 _openid / phone / sync_count 等敏感字段）入内存，
 *   StepRecord 量大时有 OOM 风险。对查询类 action（today/history/trend）改用 DB 端
 *   `.field()` 投影（仅取必要字段）+ `.where()` 过滤（按 user_id / activity_id / date），
 *   避免全量拉敏感集合入内存；当前全量拉取仅为本地轨/早期简化。
 *
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

// 需登录态（requireUser）的 action：sync/today/history/trend 均需 OPENID（与 activity.current 游客通道不同）。
const REQUIRE_USER_ACTIONS = { sync: true, today: true, history: true, trend: true };

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
