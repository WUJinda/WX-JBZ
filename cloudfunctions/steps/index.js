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

const { authMiddleware, assertUserExists, assertJoined } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { decryptSteps } = require('./decrypt');
const { syncSteps } = require('./stepsSync');
const { getToday, getHistory, getUserRecords } = require('./stepsQuery');
const { buildTrend } = require('./stepsTrend');
const { loadByWhere } = require('../common/db');
const { triggerRankAggregate } = require('./stepsTriggerRank');

// P0-5：steps handler 只拉「该用户该活动」的 StepRecord（约活动天数条，非全表），
//   投影掉 _openid（不入内存/不下发）；sync 需 sync_count 做频控，其余 handler 多取无害。
const STEP_RECORD_FIELDS = {
  _id: 1, user_id: 1, activity_id: 1, date: 1, steps: 1,
  abnormal: 1, locked: 1, synced_at: 1, sync_count: 1
};

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
    const userId = openid; // P0-1：身份仅用 OPENID，禁止 event.user_id（防越权读写他人步数）
    const activityId = event && event.activity_id;
    const jsCode = event && event.code;
    const iv = event && event.iv;
    const encryptedData = event && event.encrypted_data;
    const activity = event && event.activity; // 可选：传入活动文档（云轨改为按 activity_id 查库）
    const config = event && event.config;

    // P1-1：sync 要求已报名（架构 §4.3：steps.sync 需 join_status=joined）。
    // 用户存在性已由 main 的 requireUser 统一校验（context.user）；此处仅校验报名状态，
    // 未报名用户不浪费 code2Session 外部调用与解密开销。
    assertJoined(context.user);

    // 当次取新鲜 session_key（用后即弃）。
    const { sessionKey } = await code2Session(jsCode);
    // 立即解密 → stepInfoList。
    const { stepInfoList } = decryptSteps({ sessionKey, iv, encryptedData });
    // sessionKey 变量自此不再被引用（GC 回收）；不落库、不下发。

    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    const result = await syncSteps({
      store,
      openid,
      userId,
      activityId,
      stepInfoList,
      activity,
      config
    });
    // P0：把 syncSteps 在内存 store 上的 upsert 改动写回云库（syncSteps 已打 _dirty 标记）。
    // 修复历史 bug——sync 曾只改内存不落库，导致 StepRecord 集合实际为空、dashboard 统计全 0。
    await persistStepRecordsToCloud(cloud, store.StepRecord);
    // 同步成功后即时聚合 RankCache（await 等聚合完成，前端 loadStats 即时拿到新名次）。
    // 容错：聚合失败仅 warn（triggerRankAggregate 内部 catch），不阻断 sync 主返回（StepRecord 已写，定时任务兜底）。
    await triggerRankAggregate(cloud, activityId);
    return result;
  },

  // E3: 当日步数。
  today: async (event, context) => {
    const openid = context && context.openid;
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人步数）
    const activityId = event && event.activity_id;
    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    return getToday({ store, userId, activityId });
  },

  // E3: 历史区间查询。
  history: async (event, context) => {
    const openid = context && context.openid;
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人步数）
    const activityId = event && event.activity_id;
    const from = event && event.from;
    const to = event && event.to;
    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    return getHistory({ store, userId, activityId, from, to });
  },

  // F4: 趋势图（近 7/30 天，纯 CSS 柱状图源数据）。
  // 入参 range 仅接受 7/30，其余按 7 兜底；buildTrend 内部再次兜底。
  trend: async (event, context) => {
    const openid = context && context.openid;
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人步数）
    const activityId = event && event.activity_id;
    const range = event && event.range;
    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    const records = getUserRecords(store, userId, activityId);
    return buildTrend({ records, range });
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；sync/today/history/trend
// 改用 loadByWhere(cloud,'StepRecord',{user_id,activity_id}, STEP_RECORD_FIELDS) 精确拉取。

/**
 * 判定是否唯一索引冲突（并发 upsert 时另一请求已插入同 (user_id,activity_id,date) 文档）。
 * 云开发 errCode -502005 / MongoDB 11000 / errMsg 含 duplicate key。
 */
function isUniqueConflict(err) {
  if (!err) return false;
  const code = err.errCode || err.code;
  const msg = String(err.errMsg || err.message || '');
  return code === -502005 || code === 11000 || /duplicate key|E11000|already exists/i.test(msg);
}

/**
 * 云轨：把 syncSteps 在内存 store 上改动的 StepRecord 写回云库。
 * syncSteps 对每条改动 record 打 _dirty=true；_isNew=true 表示新建。
 *   - _isNew（或无 _id）→ upsert（见下 P0-2）
 *   - 有 _id 且 _dirty  → doc(_id).update()
 * 写回前剔除 _dirty / _isNew / _id 内部字段（不落库；_id 由库管理）。
 *
 * P0-2 并发去重：新建记录走 update-or-insert，防双击同步产生重复 StepRecord（致排行榜翻倍）：
 *   先 where(user_id,activity_id,date).update；updated===0 再 add；add 撞唯一索引
 *   idx_step_user_activity_date（控制台手动建）冲突 → 重试 update（另一并发请求已插入）。
 *   ※ 微信云开发 runTransaction 事务内禁批量 API，故用「唯一索引 + 应用层 upsert」而非事务。
 *
 * P1-3：写库失败不再静默吞——收集失败条数上抛，前端不再假成功（与 admin 写回一致）。
 * 本地轨/单测不经此路径（直接调 syncSteps 纯函数注入 store）。
 *
 * @param {object} cloudSdk
 * @param {object[]} records syncSteps 改过的 store.StepRecord（含 _id / _dirty / _isNew）
 */
async function persistStepRecordsToCloud(cloudSdk, records) {
  const db = cloudSdk.database();
  const dirty = (records || []).filter((r) => r && r._dirty);
  const failed = [];
  for (const r of dirty) {
    // 剔除内部标记 + _id：add 时库生成 _id；update 时用 doc(_id) 定位、_id 不入 data。
    const doc = Object.assign({}, r);
    delete doc._dirty;
    delete doc._isNew;
    delete doc._id;
    try {
      if (r._isNew || !r._id) {
        // P0-2 upsert：先 update，未命中再 add，add 冲突则重试 update。
        const upd = await db
          .collection('StepRecord')
          .where({ user_id: r.user_id, activity_id: r.activity_id, date: r.date })
          .update({ data: doc });
        if (!upd || !upd.stats || upd.stats.updated === 0) {
          try {
            await db.collection('StepRecord').add({ data: doc });
          } catch (addErr) {
            if (isUniqueConflict(addErr)) {
              // 并发：另一请求已插入 → 重试 update 覆盖为最新值。
              await db
                .collection('StepRecord')
                .where({ user_id: r.user_id, activity_id: r.activity_id, date: r.date })
                .update({ data: doc });
            } else {
              throw addErr;
            }
          }
        }
      } else {
        await db.collection('StepRecord').doc(r._id).update({ data: doc });
      }
    } catch (err) {
      // P1-3：留痕 + 收集失败（不再静默吞）。
      console.warn('[写回失败]', 'StepRecord(' + (r._id || 'new:' + r.date) + ')', (err && err.message) || err);
      failed.push(r.date || 'unknown');
    }
  }
  if (failed.length) {
    throw BizError(
      CODE.SYS_DB_ERROR,
      'StepRecord 写回失败 ' + failed.length + ' 条: ' + failed.join(',')
    );
  }
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
    return fail(CODE.SYS_DB_ERROR, (err && err.message) || 'steps error');
  }
};

// 导出便于结构校验/测试引用（handler 表挂载点）。
module.exports.code2Session = code2Session;
module.exports.handlers = handlers;
