/**
 * 排行榜「今日榜」日期选择器纯函数（F5 个人榜按日切换）。
 *
 * 生成活动期内（start ~ min(end, 今天)）的日期列表，供底部日期选择器渲染。
 * - key 与后端 StepRecord.date 同口径：北京时间 YYYY-MM-DD（offset=480，与
 *   stepsSync.DEFAULT_CONFIG.timezoneOffsetMinutes / dateFromTimestamp 一致），
 *   后续按日榜单接入时直接作为 date 查询参数，前后端口径不漂移。
 * - label 为展示用 M.D（月日不补零，如 7.10）。
 * - 未来日期（> 今天）不列出：今日榜只看已有数据的过去/当天。
 *
 * 红线：本模块不 require wx / getApp，纯数据进出，便于 Node 下单测（同 rankCalc）。
 */

const BJ_OFFSET_MIN = 480; // 北京时间 UTC+8（与后端 dateFromTimestamp 同值）

/**
 * 安全转毫秒时间戳。入参 number(毫秒) / Date / 可解析字符串 / 纯数字字符串；非法返回 NaN。
 * 与 homeStatus.toTs 同口径。
 */
function toMs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  const s = String(t).trim();
  if (/^\d+$/.test(s)) return Number(s);
  return Date.parse(t);
}

/**
 * 毫秒时间戳 → 北京时间 YYYY-MM-DD（与后端 dateFromTimestamp 同口径）。
 * 思路：ms + offset*60*1000 偏移到目标时区后取 UTC 分量。
 * @param {number} ms 毫秒时间戳
 * @param {number} [offsetMinutes] 时区偏移（分钟），默认 480
 * @returns {string} YYYY-MM-DD；ms 非法 → ''
 */
function bjDateStr(ms, offsetMinutes) {
  if (!Number.isFinite(ms)) return '';
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : BJ_OFFSET_MIN;
  const d = new Date(ms + off * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/**
 * 毫秒时间戳 → 北京时间 M.D（展示用 label，月日均不补零，如 7.10）。
 * @param {number} ms
 * @param {number} [offsetMinutes]
 * @returns {string} M.D；ms 非法 → ''
 */
function bjLabel(ms, offsetMinutes) {
  if (!Number.isFinite(ms)) return '';
  const off = Number.isFinite(offsetMinutes) ? offsetMinutes : BJ_OFFSET_MIN;
  const d = new Date(ms + off * 60 * 1000);
  return d.getUTCMonth() + 1 + '.' + d.getUTCDate();
}

/**
 * 生成活动期日期列表（start ~ min(end, 今天)），每天一项，升序（最早→最近）。
 *
 * - 进行中：start ~ 今天（含今天，今天标 isToday）。
 * - 已结束：start ~ end（今天已超出活动期，不出现，无 isToday 项）。
 * - 未开始（start > 今天）：返回 []（无任何可选日）。
 * - start/end/now 任一缺失或非法：返回 []。
 *
 * 逐天 +86400000 推进：中国无夏令时，固定 24h 偏移不跨日漂移，与后端固定 offset 思路一致。
 *
 * @param {object} activity { start_time, end_time }（毫秒/Date/ISO 字符串均可）
 * @param {number|string|Date} [now] 当前时间（默认 new Date()；测试注入固定值）
 * @param {object} [opts] { offsetMinutes }
 * @returns {Array<{key:string,label:string,ts:number,isToday:boolean}>}
 */
function buildDayList(activity, now, opts) {
  const a = activity || {};
  const startMs = toMs(a.start_time);
  const endMs = toMs(a.end_time);
  const nowMs = toMs(now === undefined ? new Date() : now);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(nowMs)) return [];
  const off = opts && Number.isFinite(opts.offsetMinutes) ? opts.offsetMinutes : BJ_OFFSET_MIN;
  const upperMs = Math.min(endMs, nowMs); // 截止到今天（未来日不列出）
  if (startMs > upperMs) return []; // 活动未开始
  const todayKey = bjDateStr(nowMs, off);
  const list = [];
  let cur = startMs;
  let guard = 0; // 安全上限，防极端配置（如 start/end 跨度极大）无限循环
  while (cur <= upperMs && guard < 400) {
    const key = bjDateStr(cur, off);
    list.push({
      key,
      label: bjLabel(cur, off),
      ts: cur,
      isToday: key === todayKey
    });
    cur += 86400000;
    guard++;
  }
  return list;
}

/**
 * 默认选中日期 key：优先今天；今天不在列表（活动已结束）→ 取最后一项（最近一天）。
 * @param {Array<{key:string,isToday:boolean}>} dayList buildDayList 输出
 * @returns {string} key；列表空 → ''
 */
function defaultDayKey(dayList) {
  const arr = Array.isArray(dayList) ? dayList : [];
  const today = arr.find((d) => d && d.isToday);
  if (today) return today.key;
  if (arr.length > 0) return arr[arr.length - 1].key;
  return '';
}

module.exports = {
  BJ_OFFSET_MIN,
  toMs,
  bjDateStr,
  bjLabel,
  buildDayList,
  defaultDayKey
};
