/**
 * home 活动状态感知纯函数（对齐 homeSync / homeTrend 模式：纯函数可单测）。
 *
 * home 是个人主页（tabBar），需按当前活动状态切换显示模式：
 *   - active   进行中：完整展示（步数 / 同步 / 趋势 / 排名）
 *   - ended    已结束：战绩归档（最终累计 + 趋势 + 排名）；
 *              2026-10-26 起：到期未终止 = 补同步窗口开放（canSyncSteps=true，仍可同步活动期内步数），
 *              仅 terminated（已终止）才禁同步
 *   - pending  未开始（有活动）：空态预告
 *   - none     无活动（activity_id 空）：空态
 *   - unknown  状态未知（globalData 尚未写入）：触发补调 activity.current
 *
 * 状态推算口径（与后端 activityStatus.deriveStatus 同源）：
 *   优先用 globalData.currentActivity 的 start_time / end_time + 当前时间实时推算，
 *   不读 status 字符串快照——后者是 activity 页某次 current 调用瞬间的时间推算结果，
 *   活动跨 end_time 后会过时（卡在 pending），且 home 多次 onShow 时易与在途的
 *   fetchActivityStatus 竞态（pending 一闪 → ended）。用时间窗口实时算可同时消除这两个问题。
 *
 * 状态来源：globalData.currentActivity（activity 页 applyActivity 写入
 *   { activity_id, name, start_time, end_time, status }）。
 *   无时间窗口时（冷启动 globalData 未写入 / 旧 mock）退化到 status 字符串。
 *
 * 区分 pending vs none：时间推算为 pending 时，有 activity_id = 已发布未开始，无 = 无活动
 *   （无活动时 current 返回 start_time / end_time = null → 退化路径 status='pending' + id 空 → none）。
 *
 * 红线：本模块不 require wx / getApp，纯数据进出，便于 Node 下单测。
 */

const STATUS = {
  UNKNOWN: 'unknown',
  ACTIVE: 'active',
  ENDED: 'ended',
  PENDING: 'pending',
  NONE: 'none'
};

/** 活动三态（与后端 activityStatus.STATUS 同值，用于时间推算中间结果）。 */
const ACTIVITY_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  ENDED: 'ended'
};

/**
 * 安全转时间戳。入参 Date / number(毫秒) / string(可解析) / null；非法返回 NaN。
 * 与后端 activityStatus._toTs 同口径（保证前后端状态推算一致）。
 */
function toTs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  const n = Number(t);
  if (Number.isFinite(n) && /^\d+$/.test(String(t).trim())) return n;
  return Date.parse(t);
}

/**
 * 用时间窗口实时推算活动三态（与后端 deriveStatus 同口径）。
 * @param {*} start_time
 * @param {*} end_time
 * @param {Date|number} [now] 当前时间（默认 new Date()）；测试注入固定值
 * @returns {'pending'|'active'|'ended'} 缺时间信息保守 pending
 */
function deriveStatusFromTime(start_time, end_time, now) {
  const start = toTs(start_time);
  const end = toTs(end_time);
  const cur = toTs(now === undefined ? new Date() : now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(cur)) {
    return ACTIVITY_STATUS.PENDING;
  }
  if (cur < start) return ACTIVITY_STATUS.PENDING;
  if (cur > end) return ACTIVITY_STATUS.ENDED;
  return ACTIVITY_STATUS.ACTIVE;
}

/**
 * 从 globalData.currentActivity 推导 home 显示态。
 * 优先用 start_time/end_time 实时推算（注入 now）；无时间窗口才退化到 status 字符串。
 * terminated===true 优先判 ended（与后端 deriveStatus 同口径：手动终止不可恢复，忽略时间窗）。
 * @param {object} [activity] { activity_id?, start_time?, end_time?, terminated?, status? }
 * @param {Date|number} [now] 当前时间（实时推算用；测试注入固定值）
 * @returns {string} STATUS.*
 */
function deriveHomeStatus(activity, now) {
  const a = activity || {};
  // 手动终止优先（提前终止时时间窗仍是 active/pending，须以 terminated 为准）：
  // 与后端 activityStatus.deriveStatus 同口径，homeStatus 需 terminated 字段（activity.applyActivity 已写入）。
  if (a.terminated === true) return STATUS.ENDED;
  const hasTime = a.start_time != null || a.end_time != null;
  if (hasTime) {
    const s = deriveStatusFromTime(a.start_time, a.end_time, now);
    if (s === ACTIVITY_STATUS.ACTIVE) return STATUS.ACTIVE;
    if (s === ACTIVITY_STATUS.ENDED) return STATUS.ENDED;
    // pending：有 activity_id = 已发布未开始；无 = 无活动
    return a.activity_id ? STATUS.PENDING : STATUS.NONE;
  }
  // 无时间信息（冷启动 globalData 未写入 / 旧 mock）：退化 status 字符串
  if (a.status === STATUS.ACTIVE) return STATUS.ACTIVE;
  if (a.status === STATUS.ENDED) return STATUS.ENDED;
  if (a.status === STATUS.PENDING) {
    return a.activity_id ? STATUS.PENDING : STATUS.NONE;
  }
  return STATUS.UNKNOWN;
}

/**
 * 是否需要补调 activity.current。
 * 既无时间窗口又无 status 字符串（冷启动初始 globalData）才补调——
 * 有时间窗口即可实时推算，不再依赖可能过时的 status 快照。
 * @param {object} [activity]
 * @returns {boolean}
 */
function needsFetchStatus(activity) {
  const a = activity || {};
  const hasTime = a.start_time != null || a.end_time != null;
  const hasStatus = !!a.status;
  return !hasTime && !hasStatus;
}

/**
 * 该状态是否需要加载业务数据（user.stats / steps.trend）。
 * 仅 active / ended 有可展示数据；pending / none 走空态不加载（避免无谓请求 + 全 0 误导）。
 * @param {string} status deriveHomeStatus 结果
 * @returns {boolean}
 */
function shouldLoadData(status) {
  return status === STATUS.ACTIVE || status === STATUS.ENDED;
}

/**
 * 是否允许同步步数（2026-10-26 补同步窗口，与后端 stepsSync R3.5 闸门同口径）。
 *
 * 口径：
 *   - terminated（管理员终止）→ false：同步关闭，步数固化；
 *   - active（进行中）→ true：常规同步；
 *   - ended（到期未终止）→ true：补同步窗口开放，仍可同步活动期内步数
 *     （后端写入侧按活动期过滤，活动期外/未来日不入库；微信运动仅保留近 30 天日步数）；
 *   - pending / none / unknown → false。
 *
 * @param {object} [activity] globalData.currentActivity（含 terminated）
 * @param {Date|number} [now] 当前时间（测试注入固定值）
 * @returns {boolean}
 */
function canSyncSteps(activity, now) {
  const a = activity || {};
  if (a.terminated === true) return false;
  const status = deriveHomeStatus(a, now);
  return status === STATUS.ACTIVE || status === STATUS.ENDED;
}

module.exports = {
  STATUS,
  deriveHomeStatus,
  deriveStatusFromTime,
  needsFetchStatus,
  shouldLoadData,
  canSyncSteps
};
