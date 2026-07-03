/**
 * tasks.dailyLock 业务纯函数（对齐技术架构 §6.4，PRD 定时任务）。
 *
 * 职责：每日 lockHour（默认 12:00，时区 timezoneOffsetMinutes 默认 480）将
 *   date = 昨日（now 所在日的前一日）的 StepRecord 全部 locked=true。
 *
 * 红线：
 *   - 锁昨日（用 dateFromTimestamp + lockHour/tz 算），不动今日。
 *   - 不改 steps 值（只置 locked=true）。
 *   - 幂等：已锁定的记录再置 true 无副作用。
 *
 * 日期判定口径（§6.4）：
 *   「昨日」= now 所在日的前一日。
 *   lockHour 用于「定时触发器在几点跑」的语义（默认 12:00），但「昨日」的判定
 *   以 now 实际所在日为准——本函数被调用时即视为「该锁昨日了」。
 *   lockHour 在本函数中作为配置项保留（便于未来「未到 lockHour 不锁」的扩展），
 *   当前实现：只要调用就锁昨日（与 §6.5「可手动触发」一致）。
 *
 * 本地轨：store/now/config 注入式，纯函数可单测；不调真实微信云 API。
 *
 * 解耦：本模块不 require wx-server-sdk。
 */

const { dateFromTimestamp, DEFAULT_CONFIG } = require('../steps/stepsSync');

const LOCK_DEFAULT_CONFIG = {
  timezoneOffsetMinutes: DEFAULT_CONFIG.timezoneOffsetMinutes, // 北京时间 UTC+8
  lockHour: 12 // §6.4：每日 12:00 锁定昨日（可配）
};

/**
 * 算「昨日」date（YYYY-MM-DD，按 offsetMinutes 时区）。
 *
 * P1-13 口径：先算「今日」北京日字符串（与 stepsQuery today 一致），再日历减 1 天。
 *   不用「now.getTime()-24h」——中国无 DST 时虽等价，但日历减法语义更明确，
 *   且 event.now 非法（getTime→NaN，dateFromTimestamp 返回 ''）时这里显式抛错，
 *   而非返回空串导致 lockYesterday 去匹配 date==='' 的诡异记录。
 *
 * @param {Date} nowDate
 * @param {number} offsetMinutes 时区偏移（分钟），北京 480
 * @returns {string} YYYY-MM-DD
 * @throws {Error} nowDate 非法（算不出今日字符串）
 */
function computeYesterdayDate(nowDate, offsetMinutes) {
  const todayStr = dateFromTimestamp(Math.floor(nowDate.getTime() / 1000), offsetMinutes);
  if (!todayStr) {
    throw new Error('computeYesterdayDate: invalid nowDate (no today derivable)');
  }
  // 今日 YYYY-MM-DD → Date.UTC 当日 0 点 → 减 1 天 → 按 UTC 格式化昨日。
  const parts = todayStr.split('-').map(Number);
  const todayUtc0 = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const yd = new Date(todayUtc0 - 24 * 60 * 60 * 1000);
  const yy = yd.getUTCFullYear();
  const ym = String(yd.getUTCMonth() + 1).padStart(2, '0');
  const ydd = String(yd.getUTCDate()).padStart(2, '0');
  return yy + '-' + ym + '-' + ydd;
}

/**
 * dailyLock 主逻辑（纯函数 + 注入式 store/now/config）。
 *
 * @param {object} params
 * @param {object} params.store mock db（{ StepRecord }）
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @param {object} [params.config] 配置覆盖（timezoneOffsetMinutes/lockHour）
 * @returns {Promise<object>} { date, lockedCount } date=锁定的昨日 YYYY-MM-DD
 */
async function lockYesterday(params) {
  const p = params || {};
  const { store } = p;
  if (!store || !Array.isArray(store.StepRecord)) {
    const { CODE, BizError } = require('../common/errors');
    throw BizError(CODE.SYS_DB_ERROR, 'dailyLock: store.StepRecord is required');
  }

  const cfg = Object.assign({}, LOCK_DEFAULT_CONFIG, p.config || {});
  const nowDate = p.now instanceof Date ? p.now : new Date();
  const yesterday = computeYesterdayDate(nowDate, cfg.timezoneOffsetMinutes);

  let lockedCount = 0;
  for (const r of store.StepRecord) {
    if (r && r.date === yesterday) {
      // 幂等：已锁再置 true 无副作用；只置 locked，不改 steps。
      if (!r.locked) {
        r.locked = true;
        lockedCount += 1;
      }
    }
  }

  return { date: yesterday, lockedCount };
}

module.exports = {
  lockYesterday,
  computeYesterdayDate,
  LOCK_DEFAULT_CONFIG
};
