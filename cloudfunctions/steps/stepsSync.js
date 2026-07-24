/**
 * steps.sync 业务纯函数（对齐技术架构 §5.5/§6.2/§6.4/§5.5，PRD F3 R3.1~R3.6）。
 *
 * 职责（按日 upsert 去重 + 异常阈值 + 频控 + 锁定不改值 + 活动结束禁同步）：
 *   - R3.2 去重：同一 (user_id, activity_id, date) 仅一条，取最新同步值覆盖；
 *     锁定记录（locked=true）不覆盖（架构 §6.4）。
 *   - R3.6 异常阈值：单日 steps > 阈值（默认 50000）→ abnormal=true（仅标记不剔除），可配置。
 *   - R3.3 频控：同用户同日 sync_count > MAX（默认 6）→ 拒绝落库，可配置。
 *   - R3.5 活动结束：activity 已 ended → sync 拒绝。
 *   - 记 synced_at。
 *
 * 红线：
 *   - session_key 不进入本函数（解密在 handler 完成后传入 stepInfoList）。
 *   - 不下发 session_key / _openid 等敏感字段。
 *
 * 本地轨：store/now/config 注入式，纯函数可单测；不调真实微信云 API。
 * syncSteps 直接更新注入 store 中的 StepRecord 文档（单测观察 store 验证落库结果）。
 *
 * 解耦：本模块不 require wx-server-sdk；decrypt 在 handler 完成后传入 stepInfoList。
 */

const { CODE, BizError } = require('../common/errors');
const { deriveStatus, STATUS } = require('../activity/activityStatus');

/**
 * 默认配置（均可被 params.config 覆盖，便于单测与活动级配置）。
 */
const DEFAULT_CONFIG = {
  abnormalThreshold: 50000, // R3.6：单日 > 此值标 abnormal（可配置）
  maxSyncPerDay: 6, // R3.3：同用户同日 sync_count 上限（可配置）
  timezoneOffsetMinutes: 480 // 北京时间 UTC+8（date 取本地日，offset 为「UTC→本地」需加的分钟数）
};

/**
 * 按 timestamp（秒）+ 时区偏移算出 YYYY-MM-DD（北京时间）。
 * @param {number} tsSec 秒级时间戳
 * @param {number} offsetMinutes 时区偏移（分钟），北京 -480
 * @returns {string} YYYY-MM-DD
 */
function dateFromTimestamp(tsSec, offsetMinutes) {
  const ms = Number(tsSec) * 1000;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + offsetMinutes * 60 * 1000); // 偏移到目标时区
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/**
 * 算活动开始日（北京时间 YYYY-MM-DD），供累计步数/排名的活动期过滤统一复用。
 *
 * 业务口径（PRD / 架构 §6.3）：累计步数 = 活动期内（start_date ~ today）有效步数之和。
 * 早期 sync bug 曾把微信运动近 30 天步数全量回灌（活动期外也入库），这些脏记录虽 locked=true，
 * 但 date<start_date 不应计入累计/排名。本函数统一算 start_date，各累计计算点据此过滤。
 *
 * @param {object} activity 活动文档（含 start_time ISO 字符串）；缺失/无效则返回 ''
 * @param {number} offsetMinutes 时区偏移（分钟）
 * @returns {string} YYYY-MM-DD 或 ''（返回 '' 时调用方跳过过滤，保持兜底）
 */
function activityStartDate(activity, offsetMinutes) {
  const a = activity || {};
  if (!a.start_time) return '';
  const ms = Date.parse(a.start_time);
  if (!Number.isFinite(ms)) return '';
  return dateFromTimestamp(Math.floor(ms / 1000), offsetMinutes);
}

/**
 * 算活动结束日（北京时间 YYYY-MM-DD），供累计步数/排名的活动期右界过滤。
 *
 * 与 activityStartDate 对称：活动期有效范围 = [startDate, endDate]。
 * 排行榜/统计仅计入活动期内的步数，超出结束日的记录（如管理员缩短 end_time 后残留的旧记录）应排除。
 *
 * @param {object} activity 活动文档（含 end_time ISO 字符串）；缺失/无效则返回 ''
 * @param {number} offsetMinutes 时区偏移（分钟）
 * @returns {string} YYYY-MM-DD 或 ''（返回 '' 时调用方跳过右界过滤，保持兜底）
 */
function activityEndDate(activity, offsetMinutes) {
  const a = activity || {};
  if (!a.end_time) return '';
  const ms = Date.parse(a.end_time);
  if (!Number.isFinite(ms)) return '';
  return dateFromTimestamp(Math.floor(ms / 1000), offsetMinutes);
}

/**
 * 有效步数口径（全链路统一，buildStats/rankAggregate/stepsQuery/stepsTrend/syncSteps 共用）。
 *
 * 新口径（2026-07-08 起）：**活动期内已同步的非未来日** = `date >= startDate && date <= today`，
 * **不再依赖 locked**。
 * 2026-07-23 新增 endDate 右界：`date <= endDate`（活动结束日后记录不计入排名/统计）。
 *   背景：管理员可能缩短 end_time，旧记录残留在 DB 中，应排除在活动期外。
 *
 * 变更背景：旧口径 `(locked || date===today) && date>=startDate` 要求历史日必须 locked 才算有效；
 * 但 tasks 定时触发器（dailyLock）未部署时历史日永不锁定 → 用户已同步的历史步数被口径过滤
 * → home「累计/参与天数/排名/趋势」进入即全 0（仅 sync 当下用 sync 返回值才正常）。
 *
 * 语义调整：`locked` 降级为 syncSteps 写入时「禁止覆盖」的标记（防活动后期篡改），不再是
 * 「是否有效」的前置。理由：步数解密自微信运动（真实不可伪造）+ 每日频控 + 活动结束 sync 拒绝
 * （STEP_ACTIVITY_CLOSED）→ 活动期内允许 sync 用最新真实值刷新历史日，结束后自然固化。
 *
 * @param {object} r StepRecord（须含 date 字符串）
 * @param {string} today YYYY-MM-DD（北京日）
 * @param {string} [startDate] 活动期起点 YYYY-MM-DD（空串/缺省 → 不强加左界，兜底向后兼容）
 * @param {string} [endDate] 活动期终点 YYYY-MM-DD（空串/缺省 → 不强加右界，兜底向后兼容）
 * @returns {boolean}
 */
function isValidStepRecord(r, today, startDate, endDate) {
  if (!r || typeof r.date !== 'string' || !r.date) return false;
  if (r.date > today) return false; // 非未来日
  if (startDate && r.date < startDate) return false; // 活动期左界
  if (endDate && r.date > endDate) return false; // 活动期右界（结束日后不计入）
  return true;
}

/**
 * 异常阈值判定（R3.6）。
 * @param {number} steps
 * @param {number} threshold
 * @returns {boolean}
 */
function isAbnormal(steps, threshold) {
  const s = Number(steps);
  const t = Number(threshold);
  if (!Number.isFinite(s) || !Number.isFinite(t)) return false;
  return s > t;
}

/**
 * 单日步数聚合（活动期内 stepInfoList → 按日 sum）。
 * 注：微信运动 stepInfoList 每条为一日；理论上同一 date 不会重复，但聚合更稳健。
 * @param {Array<{timestamp:number, step:number}>} stepInfoList
 * @param {number} offsetMinutes 时区偏移
 * @returns {Array<{date:string, steps:number}>}
 */
function aggregateByDate(stepInfoList, offsetMinutes) {
  const map = new Map();
  (stepInfoList || []).forEach((it) => {
    const date = dateFromTimestamp(it.timestamp, offsetMinutes);
    if (!date) return;
    const step = Number(it.step) || 0;
    map.set(date, (map.get(date) || 0) + step);
  });
  return Array.from(map.entries())
    .map(([date, steps]) => ({ date, steps }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 下发投影：从 StepRecord 文档摘出可下发前端字段（不下发 _openid / sync_count）。
 * @param {object} rec
 * @returns {object}
 */
function projectStep(rec) {
  const r = rec || {};
  return {
    activity_id: r.activity_id || '',
    date: r.date || '',
    steps: typeof r.steps === 'number' ? r.steps : Number(r.steps) || 0,
    abnormal: !!r.abnormal,
    locked: !!r.locked,
    synced_at: r.synced_at || null
  };
}

/**
 * sync 主逻辑（纯函数 + 注入式 store/now/config）。
 *
 * 流程：
 *   1. 活动状态判定：ended → 拒绝（R3.5）。
 *   2. 解密后的 stepInfoList 按日聚合（仅活动期内 date）。
 *   3. 频控：对「当日」(now 所在日) 检查同用户 sync_count 上限（R3.3）。
 *   4. 逐日 upsert（R3.2 去重）：
 *      - 命中已有记录：locked=true 不覆盖（§6.4）；否则更新 steps/abnormal/synced_at（sync_count 仅当日累加）。
 *      - 无记录：插入。
 *   5. 返回当日 + 累计。
 *
 * @param {object} params
 * @param {object} params.store mock db 的 store 引用（{ StepRecord: object[], Activity?: object[] }）
 * @param {string} params.openid 当前用户 openid（handler 从 wxContext 取）
 * @param {string} params.userId 用户 id（业务键，= openid；handler 以 openid 传入，rankAggregate 以 User._openid 关联）
 * @param {string} params.activityId 活动 id
 * @param {Array<{timestamp:number, step:number}>} params.stepInfoList 解密后的近 30 天步数
 * @param {object} [params.activity] 活动文档（含 start_time/end_time）；缺省则不强加活动期过滤
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @param {object} [params.config] 配置覆盖（abnormalThreshold/maxSyncPerDay/timezoneOffsetMinutes）
 * @returns {Promise<object>} { today: {date, steps, abnormal}, history: projectStep[], total: number }
 * @throws {BizError} 缺参 / 活动结束 / 频控超限
 */
async function syncSteps(params) {
  const p = params || {};
  const { store, openid, userId, activityId, stepInfoList, activity, now, config } = p;

  if (!openid) throw BizError(CODE.AUTH_NO_OPENID, 'sync: openid required');
  if (!userId) throw BizError(CODE.AUTH_USER_NOT_FOUND, 'sync: userId required');
  if (!activityId) throw BizError(CODE.BIZ_PARAM_MISSING, 'sync: activityId required');
  if (!store || !Array.isArray(store.StepRecord)) {
    throw BizError(CODE.SYS_DB_ERROR, 'sync: store.StepRecord is required');
  }

  const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});

  // R3.5：活动结束禁同步（复用阶段 C 的 deriveStatus）。
  if (activity) {
    const status = deriveStatus(activity, now === undefined ? undefined : now);
    if (status === STATUS.ENDED) {
      throw BizError(CODE.STEP_ACTIVITY_CLOSED, 'sync: activity ended, sync disabled');
    }
  }

  const nowDate = now instanceof Date ? now : new Date();
  const today = dateFromTimestamp(Math.floor(nowDate.getTime() / 1000), cfg.timezoneOffsetMinutes);

  // 频控（R3.3）：仅针对「当日」的同步计数。取当日已有记录的 sync_count（去重后每用户当日一条）。
  // 计数口径：以「当日最近一次 sync 落库后的 sync_count」为准，每次同步 +1，> MAX 拒绝。
  const todayRec = store.StepRecord.find(
    (r) => r && r.user_id === userId && r.activity_id === activityId && r.date === today
  );
  const todayCount = todayRec ? Number(todayRec.sync_count) || 0 : 0;
  if (todayCount >= cfg.maxSyncPerDay) {
    throw BizError(CODE.STEP_SYNC_LIMIT, 'sync: exceed daily sync limit (' + cfg.maxSyncPerDay + ')');
  }

  // 按日聚合 stepInfoList。
  const byDate = aggregateByDate(stepInfoList, cfg.timezoneOffsetMinutes);

  // 活动期起点/终点（北京时间 YYYY-MM-DD）：写入 upsert 与 total 累计均按此过滤活动期外记录。
  // 复用 activityStartDate/activityEndDate（与 userStats/rankAggregate/stepsQuery 同口径）。
  // activity 缺失 → '' → 退化为「仅过滤未来日」（保持原兜底语义）。
  const startDate = activityStartDate(activity, cfg.timezoneOffsetMinutes);
  const endDate = activityEndDate(activity, cfg.timezoneOffsetMinutes);

  // 逐日 upsert（R3.2 去重）。
  const syncedAtIso = nowDate.toISOString();
  const newCount = todayCount + 1;
  for (const item of byDate) {
    // 区间过滤：未来日不入库；早于活动开始日不入库；晚于活动结束日不入库。
    // 注：结束日后的记录不入库（直接丢弃）。活动期一经确定不再延长，故不存在「日后延长需回补」
    //   的数据丢失风险（产品确认）；读侧 isValidStepRecord 同样按 endDate 过滤，写侧不过量存储
    //   活动期外记录，与 startDate 写入过滤同口径。若未来允许延长活动期，需改为「写全量、读侧过滤」。
    if (item.date > today) continue;
    if (startDate && item.date < startDate) continue;
    if (endDate && item.date > endDate) continue;

    const abnormal = isAbnormal(item.steps, cfg.abnormalThreshold);

    const existing = store.StepRecord.find(
      (r) => r && r.user_id === userId && r.activity_id === activityId && r.date === item.date
    );

    if (existing) {
      // 锁定不改值（架构 §6.4）：locked=true 的记录 sync 不覆盖。
      if (existing.locked) continue;
      existing.steps = item.steps;
      existing.abnormal = abnormal;
      existing.synced_at = syncedAtIso;
      // sync_count：仅当日累加；非当日 date 不增加计数（按日频控）。
      if (item.date === today) {
        existing.sync_count = newCount;
      }
      // P1 历史日补锁：早期落库的历史日 record 可能 locked=false（dailyLock 只锁「昨天」，
      // 锁不到回灌的更早历史日）。本次同步补锁为 true（历史日步数已固化）；今日记录保持
      // unlocked 可刷新。补锁仅发生一次——下次同步该 record 已 locked 走上方 continue。
      if (item.date < today) {
        existing.locked = true;
      }
      // P0 写回标记：handler 据此把改动持久化（existing 自带库 _id → update）。
      existing._dirty = true;
    } else {
      const rec = {
        user_id: userId,
        _openid: openid,
        activity_id: activityId,
        date: item.date,
        steps: item.steps,
        abnormal,
        // P1 历史日即锁：date<today → locked=true。新口径（isValidStepRecord）下 locked 不再决定
        // 「是否有效」（历史日已同步即有效），仅作 sync 写入「禁止覆盖」标记防活动后期篡改；
        // 今日 locked=false（当日可多次同步刷新）。与 dailyLock（锁昨日）互补、幂等不冲突。
        locked: item.date < today,
        synced_at: syncedAtIso,
        sync_count: item.date === today ? newCount : 0,
        // P0 写回标记：handler 据此 .add()（新建无 _id）；projectStep 白名单投影不下发此字段。
        _isNew: true,
        _dirty: true
      };
      store.StepRecord.push(rec);
    }
  }

  // 返回当日 + 历史（该用户该活动，仅活动期内）。
  const userRecs = store.StepRecord
    .filter((r) => r && r.user_id === userId && r.activity_id === activityId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const todayRecord = userRecs.find((r) => r.date === today) || null;
  // total/history 用全链路统一有效步数口径 isValidStepRecord（活动期内已同步的非未来日）。
  // sync 写入已过滤未来日/活动期外，store 内本就只有合法记录；此处显式用统一口径，与
  // buildStats/getToday 完全一致，消除「sync total（旧宽松）vs stats total（旧严格 locked||today）」
  // 的分叉（曾是「同步后累计正常、刷新后又变小」根因）。
  const inRangeRecs = userRecs.filter((r) => isValidStepRecord(r, today, startDate, endDate));
  const total = inRangeRecs.reduce((sum, r) => sum + (Number(r.steps) || 0), 0);

  return {
    today: todayRecord
      ? { date: today, steps: todayRecord.steps, abnormal: todayRecord.abnormal }
      : { date: today, steps: 0, abnormal: false },
    history: inRangeRecs.map(projectStep),
    total
  };
}

module.exports = {
  syncSteps,
  aggregateByDate,
  dateFromTimestamp,
  activityStartDate,
  activityEndDate,
  isValidStepRecord,
  isAbnormal,
  projectStep,
  DEFAULT_CONFIG
};
