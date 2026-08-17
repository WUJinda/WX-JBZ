/**
 * 活动主页计算纯函数（对齐 PRD F7 R7.3/R7.4，开发计划阶段 C2）。
 *
 * 与微信运行时解耦：now 由调用方注入，便于 Node 下单测。
 * 字段约定：start_time / end_time 为可被 Date.parse 解析的字符串或时间戳或 Date。
 */

const STATUS = {
  PENDING: 'pending', // 未开始
  ACTIVE: 'active', // 进行中
  ENDED: 'ended', // 已结束（自然到期）
  TERMINATED: 'terminated' // 已终止（管理员手动终止，前端红标区别于自然结束）
};

// 业务时区固定为北京时间（UTC+8）：倒计时「当日」对齐、进度天数、时间展示均按东八区日历日，
// 不随运行设备时区漂移（海外手机上看活动页时间/倒计时不变）。
const TZ_OFFSET_MS = 8 * 3600000;

function toTs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  const n = Number(t);
  if (Number.isFinite(n) && /^\d+$/.test(String(t).trim())) return n;
  return Date.parse(t);
}

/**
 * 倒计时计算（R7.3）。
 * 精确到日时分；活动结束当日（end_time 当天）显示到当日 23:59:59；
 * 活动结束后归零并标记已结束。
 *
 * 语义：
 *   - 未开始：倒计时到 start_time（距开始）；
 *   - 进行中：倒计时到 end_time 当日 23:59:59（R7.3：结束当日显示到当日 23:59:59）；
 *   - 已结束：days/hours/minutes 全 0，label='已结束'。
 *
 * 注意：end_time 一般已含 23:59:59，但 R7.3 明确要求「结束当日到当日 23:59:59」，
 *   即无论 end_time 的时分秒是多少，都把倒计时终点对齐到 end_time 当日 23:59:59。
 *   故此函数计算「结束当日 23:59:59」与 now 的差。
 *
 * @param {object} activity { start_time, end_time }
 * @param {Date|number} [now]
 * @returns {{status, label, days, hours, minutes, targetTs}}
 *   - label：未开始='距开始'；进行中='距结束'；已结束='已结束'
 */
function calcCountdown(activity, now) {
  const a = activity || {};
  // 手动终止优先：terminated=true → TERMINATED（红标「已终止」），忽略时间窗。
  // 区别于自然到期 ENDED（灰标「已结束」）：后端 deriveStatus 仍把 terminated 折叠成 ended（排序/索引用），
  // 前端在此单独区分，以红标向用户强调「管理员已终止」；后端已下发 terminated 字段（projectActivity）。
  if (a.terminated === true) {
    const end = toTs(a.end_time);
    return { status: STATUS.TERMINATED, label: '已终止', days: 0, hours: 0, minutes: 0, targetTs: Number.isFinite(end) ? end : NaN };
  }
  const start = toTs(a.start_time);
  const end = toTs(a.end_time);
  const cur = toTs(now === undefined ? new Date() : now);

  // 已结束归零
  if (Number.isFinite(end) && cur > end) {
    return { status: STATUS.ENDED, label: '已结束', days: 0, hours: 0, minutes: 0, targetTs: end };
  }

  // 未开始：倒计时到 start
  if (Number.isFinite(start) && cur < start) {
    const diff = Math.max(0, start - cur);
    return Object.assign(
      { status: STATUS.PENDING, label: '距开始', targetTs: start },
      splitDiff(diff)
    );
  }

  // 进行中：倒计时到结束当日 23:59:59（R7.3）
  if (Number.isFinite(end)) {
    const endOfDay = endOfDayTs(end);
    const diff = Math.max(0, endOfDay - cur);
    return Object.assign(
      { status: STATUS.ACTIVE, label: '距结束', targetTs: endOfDay },
      splitDiff(diff)
    );
  }

  // 兜底：信息不全保守视为未开始（与后端 deriveStatus / 前端 homeStatus 同口径：缺时间→pending）。
  // 原实现返 ENDED：current 失败的 EMPTY_ACTIVITY 兜底（start/end=null）会被算成「已结束」，
  // 与在途的真实活动请求竞态覆盖时，出现「活动未开始 → 活动已结束」的闪烁。改 PENDING 消除该路径。
  return { status: STATUS.PENDING, label: '距开始', days: 0, hours: 0, minutes: 0, targetTs: NaN };
}

/**
 * 把毫秒差拆成「日 / 时 / 分」（向下取整，精确到分）。
 */
function splitDiff(ms) {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  return { days, hours, minutes };
}

/**
 * 取某时间戳「北京当日 23:59:59.999」的时间戳。
 * R7.3 的「当日」指 end_time 所在的东八区日历日：先把时间戳平移到东八区视角
 * （+8h 后用 UTC 日界等价于北京日历日），对齐后再平移回来。
 * 旧实现按纯 UTC 日界对齐，「结束当日」会比北京口径晚 8 小时（7/21 23:59:59+08:00
 * 会被对齐到北京 7/22 07:59:59），活动最后一天倒计时凭空多 8 小时。
 */
function endOfDayTs(ts) {
  const d = new Date(ts + TZ_OFFSET_MS);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime() - TZ_OFFSET_MS;
}

/**
 * 活动进度（R7.1 / 页面进度条）：已进行天数 / 总天数。
 *   - 未开始：0 / 总天数（进度 0）；
 *   - 进行中：已进行天数（含今日）/ 总天数；
 *   - 已结束：总天数 / 总天数（进度满）。
 *
 * 天数按东八区日历日计算（以 start_time / end_time 当日为起止日，含首尾）。
 * 总天数 = end 当日 - start 当日 + 1（含首尾两日）。
 * 已进行天数 = now 当日 - start 当日 + 1（进行中，含今日），下限 1、上限总天数。
 *
 * @param {object} activity { start_time, end_time }
 * @param {Date|number} [now]
 * @returns {{daysElapsed:number, daysTotal:number, percent:number}}
 */
function calcProgress(activity, now) {
  const a = activity || {};
  const start = toTs(a.start_time);
  const end = toTs(a.end_time);
  const cur = toTs(now === undefined ? new Date() : now);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { daysElapsed: 0, daysTotal: 0, percent: 0 };
  }

  const startDay = cnDayIndex(start);
  const endDay = cnDayIndex(end);
  const daysTotal = Math.max(1, endDay - startDay + 1);

  // 未开始
  if (Number.isFinite(cur) && cur < start) {
    return { daysElapsed: 0, daysTotal, percent: 0 };
  }
  // 已结束：满
  if (Number.isFinite(cur) && cur > end) {
    return { daysElapsed: daysTotal, daysTotal, percent: 100 };
  }
  // 进行中
  const curDay = cnDayIndex(cur);
  let daysElapsed = curDay - startDay + 1;
  if (daysElapsed < 1) daysElapsed = 1;
  if (daysElapsed > daysTotal) daysElapsed = daysTotal;
  const percent = Math.round((daysElapsed / daysTotal) * 100);
  return { daysElapsed, daysTotal, percent };
}

/** 取某时间戳的东八区日序号（自 epoch 起按北京日历日计数，向下取整）。
 * 旧实现按纯 UTC 日序号：start_time 固定为北京 00:00（= UTC 前一日 16:00），
 * 总天数恒多算 1 天。平移 +8h 后再取 UTC 日界即北京日历日。 */
function cnDayIndex(ts) {
  return Math.floor((ts + TZ_OFFSET_MS) / 86400000);
}

/**
 * 时间展示格式化：ISO 串 / 时间戳 → 'yyyy-MM-dd HH:mm:ss'（固定东八区）。
 * 不用 Date 的本地 getter（getHours 等）——那会随设备时区漂移（海外设备显示当地时间）；
 * 平移 +8h 后用 UTC getter 取字段，输出恒为北京时间。
 * @param {string|number|Date} value 可被 toTs 解析的时间；非法/空返回 ''。
 * @returns {string} 如 '2026-07-21 23:59:59'
 */
function formatDateTime(value) {
  const ts = toTs(value);
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts + TZ_OFFSET_MS);
  const p2 = (n) => (n < 10 ? '0' + n : String(n));
  return (
    d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) +
    ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds())
  );
}

/**
 * CTA 状态（R7.1 CTA 四态）。
 *   - 未开始 → 置灰「活动未开始」；
 *   - 进行中 + 未报名 → 「报名参加」（跳 login）；
 *   - 进行中 + 已报名 → 「我的步数」（switchTab home）；
 *   - 已结束 → 「查看战绩」（跳 rank）。
 *
 * @param {string} status deriveStatus 结果
 * @param {string} joinStatus 'pending' | 'joined'
 * @param {boolean} [signupEnded] 报名是否已截止（进行中+未报名+已截止→置灰）；默认 false
 * @returns {{text:string, action:string, disabled:boolean}}
 *   action: 'none' | 'login' | 'home' | 'rank'
 */
function deriveCta(status, joinStatus, signupEnded) {
  if (status === STATUS.PENDING) {
    return { text: '活动未开始', action: 'none', disabled: true };
  }
  if (status === STATUS.ENDED) {
    return { text: '查看战绩', action: 'rank', disabled: false };
  }
  // 已终止（手动终止）：与已结束同 CTA，可查看历史排名（终止前聚合的榜单冻结可看）。
  if (status === STATUS.TERMINATED) {
    return { text: '查看战绩', action: 'rank', disabled: false };
  }
  // 进行中
  if (joinStatus === 'joined') {
    return { text: '我的步数', action: 'home', disabled: false };
  }
  // 未报名 + 报名已截止 → 置灰（仅当活动设了 signup_deadline 且已过；不填=结束前可报，由 ENDED 兜底）
  if (signupEnded) {
    return { text: '报名已截止', action: 'none', disabled: true };
  }
  return { text: '报名参加', action: 'login', disabled: false };
}

/**
 * 结算公告弹窗是否展示（比赛结束结算通知，2026-08-17 调整：会话级弹一次，不做持久化记忆）。
 *
 * 判定链（全部满足才弹）：
 *   1. activity.settlement 存在（后端 pointSettle 结算后才写入；进行中/未结算活动天然无此字段）；
 *   2. settlement 有可展示内容（前十名单或部门冠军至少其一）；
 *   3. activity_id 非空（空态活动不弹）。
 *
 * 生命周期语义（「只作为比赛结束的结算通知」）：
 *   - 弹出时机由页面层会话标记控制：每次打开小程序后的会话内，首次进入活动页签时弹一次；
 *     同一会话内重复进入不再弹；「我知道了」仅关闭当前弹窗，不写 storage；
 *   - 重新打开小程序（冷启动）会再次弹出，直到新活动发布顶替：activity.current 切到新活动，
 *     旧活动 settlement 不再下发 → 弹窗自然取消。
 *
 * @param {object} activity activity.current 出参（含 settlement）
 * @returns {boolean}
 */
function shouldShowSettlement(activity) {
  if (!activity || !activity.activity_id) return false;
  const s = activity.settlement;
  if (!s || typeof s !== 'object') return false;
  const hasTop = Array.isArray(s.top) && s.top.length > 0;
  const hasChampion = !!(s.dept_champion && (s.dept_champion.dept_name || s.dept_champion.dept_id));
  return hasTop || hasChampion;
}

module.exports = {
  STATUS,
  calcCountdown,
  calcProgress,
  deriveCta,
  shouldShowSettlement,
  formatDateTime,
  _toTs: toTs,
  _endOfDayTs: endOfDayTs
};
