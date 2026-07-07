const {
  STATUS,
  calcCountdown,
  calcProgress,
  deriveCta,
  _endOfDayTs
} = require('../../miniprogram/pages/activity/activityCalc');

// 活动窗口：2026-07-01 00:00:00 ~ 2026-07-21 23:59:59（UTC）
const START = Date.parse('2026-07-01T00:00:00Z');
const END = Date.parse('2026-07-21T23:59:59Z');
const activity = { start_time: START, end_time: END };

describe('活动主页计算纯函数（C2）', () => {
  describe('calcCountdown（倒计时 R7.3）', () => {
    it('未开始：倒计时到 start，label=距开始', () => {
      // 距开始 2 天 3 小时 30 分
      const now = START - (2 * 86400 + 3 * 3600 + 30 * 60) * 1000;
      const cd = calcCountdown(activity, now);
      expect(cd.status).toBe(STATUS.PENDING);
      expect(cd.label).toBe('距开始');
      expect(cd.days).toBe(2);
      expect(cd.hours).toBe(3);
      expect(cd.minutes).toBe(30);
    });

    it('进行中：倒计时到结束当日 23:59:59，label=距结束', () => {
      // 假设 now 在结束当日（2026-07-21）早上 00:00:00
      // 结束当日 23:59:59.999 → 差约 23 时 59 分
      const now = Date.parse('2026-07-21T00:00:00Z');
      const cd = calcCountdown(activity, now);
      expect(cd.status).toBe(STATUS.ACTIVE);
      expect(cd.label).toBe('距结束');
      // 目标为结束当日 23:59:59
      expect(cd.targetTs).toBe(_endOfDayTs(END));
      expect(cd.days).toBe(0);
      expect(cd.hours).toBe(23);
      expect(cd.minutes).toBe(59);
    });

    it('结束当日：即使 end_time 早于当日 23:59:59，仍按当日 23:59:59 倒计时（R7.3）', () => {
      // 构造一个 end_time 在当日中午的活动，验证倒计时仍对齐到当日 23:59:59
      const a = { start_time: Date.parse('2026-07-21T00:00:00Z'), end_time: Date.parse('2026-07-21T12:00:00Z') };
      const now = Date.parse('2026-07-21T00:00:00Z');
      const cd = calcCountdown(a, now);
      // 仍处于进行中（cur ≤ end），倒计时对齐到当日 23:59:59
      expect(cd.status).toBe(STATUS.ACTIVE);
      expect(cd.hours).toBe(23);
      expect(cd.minutes).toBe(59);
    });

    it('已结束：days/hours/minutes 全 0，label=已结束', () => {
      const now = Date.parse('2026-08-01T00:00:00Z');
      const cd = calcCountdown(activity, now);
      expect(cd.status).toBe(STATUS.ENDED);
      expect(cd.label).toBe('已结束');
      expect(cd.days).toBe(0);
      expect(cd.hours).toBe(0);
      expect(cd.minutes).toBe(0);
    });

    it('恰好 now=end+1ms 视为已结束（归零）', () => {
      const cd = calcCountdown(activity, END + 1);
      expect(cd.status).toBe(STATUS.ENDED);
      expect(cd.minutes).toBe(0);
    });

    it('进行中差值不会为负（now 已超过结束当日 23:59:59 但未超 end 不可能；此处测兜底）', () => {
      const cd = calcCountdown(activity, END);
      expect(cd.status).toBe(STATUS.ACTIVE);
      expect(cd.days).toBeGreaterThanOrEqual(0);
      expect(cd.hours).toBeGreaterThanOrEqual(0);
      expect(cd.minutes).toBeGreaterThanOrEqual(0);
    });

    it('精确到分（不出现秒字段）', () => {
      const cd = calcCountdown(activity, START - 1);
      expect(cd).not.toHaveProperty('seconds');
    });

    it('纯函数：不修改入参', () => {
      const a = { start_time: START, end_time: END };
      const snap = JSON.stringify(a);
      calcCountdown(a, '2026-07-10T00:00:00Z');
      expect(JSON.stringify(a)).toBe(snap);
    });

    it('缺时间信息（start/end=null）兜底 PENDING（不误显示已结束——修复「未开始→已结束」闪烁）', () => {
      // EMPTY_ACTIVITY（current 失败兜底）start/end=null，须保守视为未开始，
      // 不能算成已结束（否则与在途的真实活动请求竞态覆盖时会出「未开始 → 已结束」闪烁）。
      const cd = calcCountdown({ start_time: null, end_time: null }, Date.now());
      expect(cd.status).toBe(STATUS.PENDING);
      expect(cd.label).toBe('距开始');
    });

    it('start/end 字段缺失（undefined）兜底 PENDING', () => {
      const cd = calcCountdown({}, Date.now());
      expect(cd.status).toBe(STATUS.PENDING);
    });

    it('terminated=true 一律 ended（与后端 deriveStatus 同口径）', () => {
      const cd = calcCountdown({ start_time: START, end_time: END, terminated: true }, Date.parse('2026-07-10T00:00:00Z'));
      expect(cd.status).toBe(STATUS.ENDED);
      expect(cd.label).toBe('已结束');
    });
  });

  describe('calcProgress（进度 R7.1）', () => {
    it('未开始：已进行 0 天，进度 0%', () => {
      const p = calcProgress(activity, Date.parse('2026-06-20T00:00:00Z'));
      expect(p.daysElapsed).toBe(0);
      // 总天数 = 21（7-1 至 7-21 含首尾）
      expect(p.daysTotal).toBe(21);
      expect(p.percent).toBe(0);
    });

    it('进行中：已进行天数含今日，在 [1, 总天数] 内', () => {
      // 7-10 当日：已进行 10 天（7-1..7-10）
      const p = calcProgress(activity, Date.parse('2026-07-10T00:00:00Z'));
      expect(p.daysElapsed).toBe(10);
      expect(p.daysTotal).toBe(21);
      expect(p.percent).toBe(Math.round((10 / 21) * 100));
    });

    it('进行中首日：已进行 1 天', () => {
      const p = calcProgress(activity, START);
      expect(p.daysElapsed).toBe(1);
    });

    it('已结束：已进行 = 总天数，进度 100%', () => {
      const p = calcProgress(activity, Date.parse('2026-08-01T00:00:00Z'));
      expect(p.daysElapsed).toBe(21);
      expect(p.daysTotal).toBe(21);
      expect(p.percent).toBe(100);
    });

    it('结束当日：视为满进度（cur > end 前一日仍在进行中）', () => {
      // end 当日（7-21）仍 ≤ end → 进行中，已进行 21 天 → 100%
      const p = calcProgress(activity, END);
      expect(p.daysElapsed).toBe(21);
      expect(p.percent).toBe(100);
    });

    it('时间信息缺失返回 0/0/0', () => {
      const p = calcProgress({}, '2026-07-10T00:00:00Z');
      expect(p.daysElapsed).toBe(0);
      expect(p.daysTotal).toBe(0);
      expect(p.percent).toBe(0);
    });

    it('纯函数：不修改入参', () => {
      const a = { start_time: START, end_time: END };
      const snap = JSON.stringify(a);
      calcProgress(a, '2026-07-10T00:00:00Z');
      expect(JSON.stringify(a)).toBe(snap);
    });
  });

  describe('deriveCta（CTA 四态 R7.1）', () => {
    it('未开始 → 置灰「活动未开始」', () => {
      const cta = deriveCta(STATUS.PENDING, 'pending');
      expect(cta.text).toBe('活动未开始');
      expect(cta.disabled).toBe(true);
      expect(cta.action).toBe('none');
    });

    it('进行中 + 未报名 → 「报名参加」（跳 login）', () => {
      const cta = deriveCta(STATUS.ACTIVE, 'pending');
      expect(cta.text).toBe('报名参加');
      expect(cta.disabled).toBe(false);
      expect(cta.action).toBe('login');
    });

    it('进行中 + 已报名 → 「我的步数」（switchTab home）', () => {
      const cta = deriveCta(STATUS.ACTIVE, 'joined');
      expect(cta.text).toBe('我的步数');
      expect(cta.disabled).toBe(false);
      expect(cta.action).toBe('home');
    });

    it('已结束 → 「查看战绩」（跳 rank）', () => {
      const cta = deriveCta(STATUS.ENDED, 'joined');
      expect(cta.text).toBe('查看战绩');
      expect(cta.disabled).toBe(false);
      expect(cta.action).toBe('rank');
    });

    it('未开始即使已报名仍置灰（状态优先于报名）', () => {
      const cta = deriveCta(STATUS.PENDING, 'joined');
      expect(cta.disabled).toBe(true);
      expect(cta.text).toBe('活动未开始');
    });

    it('进行中 + 未报名 + 报名已截止 → 置灰「报名已截止」', () => {
      const cta = deriveCta(STATUS.ACTIVE, 'pending', true);
      expect(cta.text).toBe('报名已截止');
      expect(cta.disabled).toBe(true);
      expect(cta.action).toBe('none');
    });

    it('进行中 + 未报名 + 未截止（默认）→ 「报名参加」', () => {
      const cta = deriveCta(STATUS.ACTIVE, 'pending');
      expect(cta.text).toBe('报名参加');
      expect(cta.disabled).toBe(false);
    });
  });
});
