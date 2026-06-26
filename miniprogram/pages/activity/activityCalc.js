/**
 * 活动主页计算纯函数（对齐 PRD F7 R7.3/R7.4，开发计划阶段 C2）。
 *
 * 与微信运行时解耦：now 由调用方注入，便于 Node 下单测。
 * 字段约定：start_time / end_time 为可被 Date.parse 解析的字符串或时间戳或 Date。
 */

const STATUS = {
  PENDING: 'pending', // 未开始
  ACTIVE: 'active', // 进行中
  ENDED: 'ended' // 已结束
};

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

  // 兜底：信息不全视为已结束归零
  return { status: STATUS.ENDED, label: '已结束', days: 0, hours: 0, minutes: 0, targetTs: NaN };
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
 * 取某时间戳「当日 23:59:59.999」的时间戳（按 UTC 计算）。
 * R7.3 的「当日」指 end_time 所在日历日；为保持纯函数确定性且与时区无关地可测，
 * 此处按 UTC 日界对齐（测试用 UTC 整点时间构造场景，避免夏令时等干扰）。
 * 真实业务时间字符串带 +08:00，Date.parse 后为绝对时间戳，当日对齐以该时间戳所在 UTC 日为准。
 */
function endOfDayTs(ts) {
  const d = new Date(ts);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * 活动进度（R7.1 / 页面进度条）：已进行天数 / 总天数。
 *   - 未开始：0 / 总天数（进度 0）；
 *   - 进行中：已进行天数（含今日）/ 总天数；
 *   - 已结束：总天数 / 总天数（进度满）。
 *
 * 天数按日历日计算（以 start_time / end_time 当日为起止日，含首尾）。
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

  const startDay = utcDayIndex(start);
  const endDay = utcDayIndex(end);
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
  const curDay = utcDayIndex(cur);
  let daysElapsed = curDay - startDay + 1;
  if (daysElapsed < 1) daysElapsed = 1;
  if (daysElapsed > daysTotal) daysElapsed = daysTotal;
  const percent = Math.round((daysElapsed / daysTotal) * 100);
  return { daysElapsed, daysTotal, percent };
}

/** 取某时间戳的 UTC 日序号（自 epoch 起的天数，向下取整）。 */
function utcDayIndex(ts) {
  return Math.floor(ts / 86400000);
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
 * @returns {{text:string, action:string, disabled:boolean}}
 *   action: 'none' | 'login' | 'home' | 'rank'
 */
function deriveCta(status, joinStatus) {
  if (status === STATUS.PENDING) {
    return { text: '活动未开始', action: 'none', disabled: true };
  }
  if (status === STATUS.ENDED) {
    return { text: '查看战绩', action: 'rank', disabled: false };
  }
  // 进行中
  if (joinStatus === 'joined') {
    return { text: '我的步数', action: 'home', disabled: false };
  }
  return { text: '报名参加', action: 'login', disabled: false };
}

module.exports = {
  STATUS,
  calcCountdown,
  calcProgress,
  deriveCta,
  _toTs: toTs,
  _endOfDayTs: endOfDayTs
};
