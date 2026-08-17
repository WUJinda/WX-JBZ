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

const { authMiddleware, assertUserExists, assertJoined, assertJoinedFresh } = require('../common/authMiddleware');
const { ok, fail } = require('../common/response');
const { CODE, BizError, notImplemented } = require('../common/errors');
const { decryptSteps } = require('./decrypt');
const { syncSteps } = require('./stepsSync');
const { getToday, getHistory, getUserRecords } = require('./stepsQuery');
const { buildTrend } = require('./stepsTrend');
const { loadByWhere } = require('../common/db');
const { triggerRankAggregateFresh } = require('./stepsTriggerRank');
const { getActivityById, getActiveActivityId, getActiveActivity } = require('../activity/activityResolver');

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
      {
        hostname: 'api.weixin.qq.com',
        path: '/sns/jscode2session?' + qs,
        method: 'GET',
        timeout: 5000 // C2：socket 超时 5s，防微信 API 挂起拖垮云函数（默认无超时会一直等到函数 timeout）
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('timeout', () => {
      // socket 空闲超时 → 主动销毁触发 'error' → reject，免长挂耗尽云函数执行时间。
      req.destroy(new Error('jscode2session timeout(5s)'));
    });
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
    // activity_id 兜底（与 today/history/trend 一致）：home 冷启动 getActivityId() 可能返回空串
    //   → 缺失会让 StepRecord 三字段之一为空、撞唯一索引 null 坑。活动文档 + activityId 在下方统一解析
    //   （event.activity_id 有值→getActivityById 精确查；缺省→getActiveActivity 一次拿 doc+id，避免二次全表拉 Activity）。
    const jsCode = event && event.code;
    const iv = event && event.iv;
    const encryptedData = event && event.encrypted_data;
    // C1：config 不取自 event（客户端不可信，防覆盖服务端时区/阈值等配置）；syncSteps 用内置 DEFAULT_CONFIG。

    // P1-1：sync 要求已报名（架构 §4.3：steps.sync 需 join_status=joined）。
    // 用户存在性已由 main 的 requireUser 统一校验（context.user）；此处校验报名状态，
    // 未报名用户不浪费 code2Session 外部调用与解密开销。
    // 用 assertJoinedFresh 吸收「写后读」窗口：user.join 主写 join_status、本函数从读 User，
    // 刚报名副本未同步时会读到旧 'pending' → 单次校验误报未报名（1004），表现为「刚报名立即同步失败」。
    // firstUser=context.user：老用户已 joined 时零额外读；仅刚报名窗口内退避重读到 joined。
    await assertJoinedFresh(cloud.database(), context.openid, { firstUser: context.user });

    // 提前查活动文档：① 判 terminated（终止后立即拒绝，省 code2Session 外部调用与解密开销）；
    // ② 供 syncSteps 活动期过滤（start_date ~ today）——修「累计步数过大」bug 的关键。
    // event.activity_id 有值→getActivityById 精确查（一次）；缺省→getActiveActivity 取当前活动，
    //   activityId 从 doc.activity_id||doc._id 取（省一次全表拉 Activity）。
    let activity;
    let activityId;
    if (event && event.activity_id) {
      activityId = event.activity_id;
      activity = await getActivityById(cloud, activityId);
    } else {
      activity = await getActiveActivity(cloud);
      activityId = (activity && (activity.activity_id || activity._id)) || '';
    }
    if (activity && activity.terminated === true) {
      throw BizError(CODE.STEP_ACTIVITY_CLOSED, '活动已终止，停止同步');
    }

    // 当次取新鲜 session_key（用后即弃）。code2Session 返回的 openid 与调用者 OPENID 交叉校验：
    // 防御「未来 code 与调用者身份错配」回归（如复用他人 code / session 混淆代理）。正常路径两值必然相等。
    const { sessionKey, openid: codeOpenid } = await code2Session(jsCode);
    if (codeOpenid !== context.openid) {
      throw BizError(CODE.STEP_DECRYPT_FAILED, 'code2Session openid 与调用者不一致（code/openid 不匹配）');
    }
    // 立即解密 → stepInfoList。expectedAppid 校验 watermark.appid（微信官方防篡改，见 decrypt.js）。
    const { stepInfoList } = decryptSteps({ sessionKey, iv, encryptedData, expectedAppid: process.env.WX_APPID });
    // 诊断日志：确认解密出来的步数数据长度（为 0 说明微信运动确实没数据或解密失败）。
    console.log('[sync] decrypted stepInfoList length=' + (stepInfoList && stepInfoList.length));
    if (stepInfoList && stepInfoList.length > 0) {
      console.log('[sync] first 3 steps:', JSON.stringify(stepInfoList.slice(0, 3)));
    }
    // sessionKey 变量自此不再被引用（GC 回收）；不落库、不下发。

    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    // activity 已在上方查得（含 terminated 判定）；未命中（activityId 空 / 库无此活动）→ null，
    // syncSteps 退化为「仅过滤未来日」（保持原兜底语义）。
    const result = await syncSteps({
      store,
      openid,
      userId,
      activityId,
      stepInfoList,
      activity
    });
    // 诊断日志：确认 syncSteps 聚合后的结果（today.steps=0 且 total=0 说明确实没步数）。
    console.log('[sync] syncSteps result today.steps=' + (result.today && result.today.steps) + ' total=' + result.total);
    // P0：把 syncSteps 在内存 store 上的 upsert 改动写回云库（syncSteps 已打 _dirty 标记）。
    // 修复历史 bug——sync 曾只改内存不落库，导致 StepRecord 集合实际为空、dashboard 统计全 0。
    await persistStepRecordsToCloud(cloud, store.StepRecord);
    // 同步成功后即时聚合 RankCache（await 等聚合完成）。聚合结果直接取本人 my_rank 随 sync 返回前端，
    // 免前端 loadStats 二次查 RankCache——跨请求「写后读」会命中聚合前旧快照致「同步后排名不更新」。
    // triggerRankAggregateFresh 吸收「跨函数写后读」：steps 写 StepRecord 后 callFunction tasks 读
    // StepRecord，副本同步延迟窗口内 tasks 可能读不到本人刚写的记录 → 聚合缺本人 → RankCache 缺本人
    // （表现：第一个同步者在榜、第二个同步者不在榜）。**即使 0 步也重试聚合**（2026-07-09 修改：
    // 0 步用户也应进榜，只是排在最后），确保本人进 RankCache + sync 返回准确 my_rank。
    // 容错：聚合失败返回 null（triggerRankAggregateFresh 内部 catch），my_rank=null，不阻断 sync 主返回。
    const { myRank } = await triggerRankAggregateFresh(cloud, activityId, openid);
    return Object.assign({}, result, { my_rank: myRank });
  },

  // E3: 当日步数。
  today: async (event, context) => {
    const openid = context && context.openid;
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人步数）
    const activityId = event && event.activity_id;
    // 查活动文档：供 getToday 算活动期起点过滤累计（与 sync/stats 同口径）。
    const activity = await getActivityById(cloud, activityId);
    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    return getToday({ store, userId, activityId, activity });
  },

  // E3: 历史区间查询。
  history: async (event, context) => {
    const openid = context && context.openid;
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人步数）
    const activityId = event && event.activity_id;
    const from = event && event.from;
    const to = event && event.to;
    // 查活动文档：供 getHistory 算活动期起点过滤累计（与 sync/stats 同口径）。
    const activity = await getActivityById(cloud, activityId);
    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    return getHistory({ store, userId, activityId, activity, from, to });
  },

  // F4: 趋势图（近 7 天 / 活动总天数，纯 CSS 柱状图源数据）。
  // 入参 range 接受任意 ≥1 正整数（前端按活动持续天数动态传入）；buildTrend 内部兜底。
  trend: async (event, context) => {
    const openid = context && context.openid;
    const userId = openid; // P0-1：身份仅 OPENID，禁止 event.user_id（防越权读他人步数）
    const range = event && event.range;
    // 活动文档 + activity_id 统一解析（与 sync 同口径）：event.activity_id 有值→getActivityById 精确查；
    //   缺省→getActiveActivity 一次拿当前活动 doc + id，避免 getActiveActivityId + getActivityById 二次全表拉。
    let activity;
    let activityId;
    if (event && event.activity_id) {
      activityId = event.activity_id;
      activity = await getActivityById(cloud, activityId);
    } else {
      activity = await getActiveActivity(cloud);
      activityId = (activity && (activity.activity_id || activity._id)) || '';
    }
    const store = {
      StepRecord: await loadByWhere(
        cloud, 'StepRecord',
        { user_id: openid, activity_id: activityId },
        STEP_RECORD_FIELDS
      )
    };
    const records = getUserRecords(store, userId, activityId);
    return buildTrend({ records, range, activity });
  }
};

// loadCollection 已统一迁移至 common/db.js 的 loadByWhere（P0-5）；sync/today/history/trend
// 改用 loadByWhere(cloud,'StepRecord',{user_id,activity_id}, STEP_RECORD_FIELDS) 精确拉取。

/**
 * 云轨：把 syncSteps 在内存 store 上改动的 StepRecord 写回云库。
 * syncSteps 对每条改动 record 打 _dirty=true；_isNew=true 表示新建。
 *   - _isNew（或无 _id）→ upsert（见下 P0-2）
 *   - 有 _id 且 _dirty  → doc(_id).update()
 * 写回前剔除 _dirty / _isNew / _id 内部字段（不落库；_id 由库管理）。
 *
 * P0-2 并发去重：新建记录走 update-or-insert，防双击同步产生重复 StepRecord（致排行榜翻倍）。
 *   由于云开发控制台手建的唯一索引不可靠（见 docs/排查-StepRecord-null索引冲突.md），
 *   完全依赖应用层去重：先 where().update（第一层） → 未命中则 where().get（第二层），
 *   命中则直接 update 覆盖；否则 add。
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
  // 诊断日志：确认 persist 收到的待写条数（若为 0 说明 syncSteps 未打 _dirty，问题在纯函数侧）。
  console.log('[persist] dirty=' + dirty.length + ' user=' + (dirty[0] && dirty[0].user_id));
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
        const updated = upd && upd.stats && upd.stats.updated;
        if (!updated) {
          // update 未命中 → 先做「写前读」去重（并发控制，防双击同步产生重复）。
          // 验证三字段不为 null（诊断：如果有文档三字段为 null，说明写入在丢字段）。
          const preCheck = await db
            .collection('StepRecord')
            .where({ user_id: r.user_id, activity_id: r.activity_id, date: r.date })
            .get();
          const existing = preCheck && preCheck.data && preCheck.data[0];
          if (existing) {
            // 并发：另一请求已插完 → 直接 update 覆盖为最新值。
            console.log(
              '[persist] pre-check dup found, update date=' + r.date + ' _id=' + (existing._id || '?')
            );
            const upd3 = await db.collection('StepRecord').doc(existing._id).update({ data: doc });
            const updated3 = upd3 && upd3.stats && upd3.stats.updated;
            if (!updated3) {
              // C3：预检查命中但 update 0 行（文档刚被并发删除等罕见情况）→ 计入 failed，不静默（P1-3）。
              console.warn('[persist] pre-check dup update 0 rows date=' + r.date);
              failed.push(r.date || 'unknown');
            }
          } else {
            // 确实不存在 → 安全 add（删掉唯一索引后，并发窗口已被上方的 get 收窄）。
            console.log(
              '[persist] try add user_id=' + JSON.stringify(r.user_id) +
              ' activity_id=' + JSON.stringify(r.activity_id) +
              ' date=' + JSON.stringify(r.date)
            );
            try {
              const addRes = await db.collection('StepRecord').add({ data: doc });
              console.log('[persist] add ok date=' + r.date + ' _id=' + (addRes && addRes._id));
            } catch (addErr) {
              // 非冲突错误（集合/权限/字段问题）→ 上抛带完整错误（P1-3：不假成功）。
              throw BizError(
                CODE.SYS_DB_ERROR,
                'StepRecord add 失败(' + r.date + '): ' + JSON.stringify(addErr)
              );
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
