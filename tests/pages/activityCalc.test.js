const {
  STATUS,
  calcCountdown,
  calcProgress,
  deriveCta,
  shouldShowSettlement,
  formatDateTime,
  _endOfDayTs
} = require('../../miniprogram/pages/activity/activityCalc');

// 活动窗口：2026-07-01 00:00:00 ~ 2026-07-21 23:59:59（北京时间，与真实业务存储格式一致）
const START = Date.parse('2026-07-01T00:00:00+08:00');
const END = Date.parse('2026-07-21T23:59:59+08:00');
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
      // 北京 2026-07-21 00:00:00；结束当日（北京日历日）23:59:59 → 差约 23 时 59 分
      const now = Date.parse('2026-07-21T00:00:00+08:00');
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
      const a = { start_time: Date.parse('2026-07-21T00:00:00+08:00'), end_time: Date.parse('2026-07-21T12:00:00+08:00') };
      const now = Date.parse('2026-07-21T00:00:00+08:00');
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

    it('terminated=true → TERMINATED（红标「已终止」，区别于自然到期 ENDED）', () => {
      // 即便时间窗仍在进行中，terminated 也直接判 TERMINATED（前端单独区分，后端 deriveStatus 仍折叠成 ended）
      const cd = calcCountdown({ start_time: START, end_time: END, terminated: true }, Date.parse('2026-07-10T00:00:00Z'));
      expect(cd.status).toBe(STATUS.TERMINATED);
      expect(cd.label).toBe('已终止');
      expect(cd.days).toBe(0);
      expect(cd.hours).toBe(0);
      expect(cd.minutes).toBe(0);
    });
  });

  describe('calcProgress（进度 R7.1）', () => {
    it('未开始：已进行 0 天，进度 0%', () => {
      const now = Date.parse('2026-06-20T00:00:00+08:00');
      const p = calcProgress(activity, now);
      expect(p.daysElapsed).toBe(0);
      // 总天数 = 21（7-1 至 7-21 含首尾）
      expect(p.daysTotal).toBe(21);
      expect(p.percent).toBe(0);
    });

    it('进行中：已进行天数含今日，在 [1, 总天数] 内', () => {
      // 7-10 当日（北京）：已进行 10 天（7-1..7-10）
      const p = calcProgress(activity, Date.parse('2026-07-10T00:00:00+08:00'));
      expect(p.daysElapsed).toBe(10);
      expect(p.daysTotal).toBe(21);
      expect(p.percent).toBe(Math.round((10 / 21) * 100));
    });

    it('进行中首日：已进行 1 天', () => {
      const p = calcProgress(activity, START);
      expect(p.daysElapsed).toBe(1);
    });

    it('已结束：已进行 = 总天数，进度 100%', () => {
      const p = calcProgress(activity, Date.parse('2026-08-01T00:00:00+08:00'));
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

    it('已终止 → 「查看战绩」（与已结束同 CTA，可看历史排名）', () => {
      const cta = deriveCta(STATUS.TERMINATED, 'joined');
      expect(cta.text).toBe('查看战绩');
      expect(cta.disabled).toBe(false);
      expect(cta.action).toBe('rank');
      // 未报名用户终止后也走查看战绩（不区分报名态）
      const cta2 = deriveCta(STATUS.TERMINATED, 'pending');
      expect(cta2.text).toBe('查看战绩');
      expect(cta2.action).toBe('rank');
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

  describe('shouldShowSettlement（比赛结束结算公告弹窗判定）', () => {
    const settled = {
      activity_id: 'a_001',
      name: '健步走',
      settlement: {
        settled_at: '2026-07-22T00:00:00Z',
        dept_champion: { dept_id: 'd1', dept_name: '综合部' },
        top: [
          { rank: 1, nickname: '甲', delta: 12 },
          { rank: 2, nickname: '乙', delta: 10 }
        ]
      }
    };

    it('结算摘要存在且有内容 → 展示', () => {
      expect(shouldShowSettlement(settled)).toBe(true);
    });

    it('未结算（settlement=null）→ 不展示', () => {
      expect(shouldShowSettlement({ activity_id: 'a_001', settlement: null })).toBe(false);
      expect(shouldShowSettlement({ activity_id: 'a_001' })).toBe(false);
    });

    it('空态活动（activity_id 缺失）→ 不展示', () => {
      expect(shouldShowSettlement({ settlement: settled.settlement })).toBe(false);
      expect(shouldShowSettlement(null)).toBe(false);
    });

    it('摘要无可展示内容（top 空且无部门冠军）→ 不展示', () => {
      const empty = {
        activity_id: 'a_001',
        settlement: { settled_at: 't', dept_champion: null, top: [] }
      };
      expect(shouldShowSettlement(empty)).toBe(false);
      // 仅部门冠军也可展示
      const onlyChampion = {
        activity_id: 'a_001',
        settlement: { settled_at: 't', dept_champion: { dept_id: 'd1', dept_name: '综合部' }, top: [] }
      };
      expect(shouldShowSettlement(onlyChampion)).toBe(true);
    });
  });

  describe('formatDateTime（东八区固定格式化）', () => {
    it("ISO 串（+08:00）→ yyyy-MM-dd HH:mm:ss", () => {
      expect(formatDateTime('2026-07-21T23:59:59+08:00')).toBe('2026-07-21 23:59:59');
      expect(formatDateTime('2026-07-01T00:00:00+08:00')).toBe('2026-07-01 00:00:00');
    });

    it('UTC 时刻也按东八区展示（不随运行设备/测试机时区漂移）', () => {
      // 2026-07-21T16:00:00Z = 北京 2026-07-22 00:00:00
      expect(formatDateTime(Date.parse('2026-07-21T16:00:00Z'))).toBe('2026-07-22 00:00:00');
    });

    it('非法/空 → 空串（空态活动不显示乱码）', () => {
      expect(formatDateTime(null)).toBe('');
      expect(formatDateTime('')).toBe('');
      expect(formatDateTime('abc')).toBe('');
    });
  });

  describe('东八区日界（endOfDayTs / cnDayIndex）', () => {
    it('结束当日 23:59:59 按北京日历日对齐（修最后一天倒计时多 8 小时）', () => {
      // 北京 7/21 12:00 的「当日 23:59:59」是北京 7/21 23:59:59.999，而非 UTC 日界对齐出的北京 7/22 07:59:59
      expect(_endOfDayTs(Date.parse('2026-07-21T12:00:00+08:00'))).toBe(
        Date.parse('2026-07-21T23:59:59.999+08:00')
      );
    });

    it('北京 00:00~08:00 属于当日（非 UTC 前一日），进度总天数不多算 1 天', () => {
      // start 北京 7/1 00:00（= UTC 6/30 16:00，旧 UTC 日序号落在 6/30 → 总天数 22）
      const a = { start_time: '2026-07-01T00:00:00+08:00', end_time: '2026-07-21T23:59:59+08:00' };
      expect(calcProgress(a, Date.parse('2026-07-01T06:00:00+08:00')).daysTotal).toBe(21);
      // 北京 7/2 凌晨 00:30（= UTC 7/1 16:30，旧 UTC 日序号仍是 7/1）已是第 2 天
      expect(calcProgress(a, Date.parse('2026-07-02T00:30:00+08:00')).daysElapsed).toBe(2);
    });
  });
});
