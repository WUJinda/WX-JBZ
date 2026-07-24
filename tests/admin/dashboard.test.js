/**
 * admin.buildDashboard 数据看板单测（H1 R8.5）：
 *   - participated / whitelistTotal / rate（含除零）；
 *   - totalSteps（有效步数口径：活动期内已同步即有效，不依赖 locked）；
 *   - validParticipants / avgSteps（含除零）；
 *   - dailyActive（近 trendDays 天，缺日补 0）；
 *   - deptRank 复用 RankCache（不重算）。
 */
const { buildDashboard, isValidRecord, buildDailyActiveTrend, projectDeptRank } = require('../../cloudfunctions/admin/dashboard');

const ACT = 'a1';
// 北京时间 06-26 12:00 = UTC 06-26 04:00
const NOW = new Date('2026-06-26T04:00:00Z'); // today = 2026-06-26

function u(_id, joined, deptId) {
  return { _id, _openid: 'op_' + _id, join_status: joined ? 'joined' : 'pending', dept_id: deptId || '' };
}

function rec(userId, date, steps, opts) {
  const o = opts || {};
  return {
    user_id: userId,
    _openid: 'op_' + userId,
    activity_id: ACT,
    date,
    steps,
    abnormal: !!o.abnormal,
    locked: !!o.locked,
    synced_at: o.synced_at || (date + 'T04:00:00.000Z')
  };
}

describe('buildDashboard（数据看板指标）', () => {
  it('participated：join_status===joined 计数', () => {
    const store = {
      User: [u('u1', true), u('u2', true), u('u3', false)],
      Whitelist: [],
      StepRecord: [],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.participated).toBe(2);
  });

  it('whitelistTotal + rate（participated/whitelistTotal）', () => {
    const store = {
      User: [u('u1', true), u('u2', false)], // participated=1
      Whitelist: [{ phone: 'p1' }, { phone: 'p2' }, { phone: 'p3' }, { phone: 'p4' }], // 4
      StepRecord: [],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.whitelistTotal).toBe(4);
    expect(r.rate).toBeCloseTo(0.25, 5);
  });

  it('rate 除零→0（whitelist 为空）', () => {
    const store = { User: [u('u1', true)], Whitelist: [], StepRecord: [], RankCache: [] };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.rate).toBe(0);
  });

  it('totalSteps：有效步数口径（活动期内已同步即有效，不依赖 locked）求和', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-25', 1000, { locked: true }),
        rec('u2', '2026-06-26', 2000), // today
        rec('u3', '2026-06-25', 9999, { locked: false }) // 新口径：已同步 → 有效
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.totalSteps).toBe(1000 + 2000 + 9999);
  });

  it('totalSteps/dailyActive 排除活动结束日后的残留记录（endDate 右界）', () => {
    // activity end_time=06-25 → endDate=2026-06-25；today=06-26 已在结束日之后。
    const activity = { start_time: '2026-06-20T00:00:00+08:00', end_time: '2026-06-25T23:59:59+08:00' };
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-24', 1000), // 活动期内 → 计入
        rec('u2', '2026-06-25', 2000), // 结束当日 → 计入（date===end 保留）
        rec('u3', '2026-06-26', 9999) // 结束日后(today) → 剔除
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, activity, now: NOW });
    expect(r.totalSteps).toBe(1000 + 2000); // 不含 06-26 残留记录
    // dailyActive：今日(06-26)无活跃（u3 被 endDate 剔除，不进趋势）
    const todayItem = r.dailyActive.find((x) => x.date === '2026-06-26');
    expect(todayItem.count).toBe(0);
  });

  it('totalSteps 跨活动不混入（按 activity_id 过滤）', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-26', 2000), // today
        rec('u2', '2026-06-26', 5000, { }) // today
      ],
      RankCache: []
    };
    // 把第二条改成别的活动
    store.StepRecord[1].activity_id = 'other';
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.totalSteps).toBe(2000);
  });

  it('validParticipants：至少一条有效 StepRecord 的不同 user_id 数', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-26', 1000), // 有效 today
        rec('u1', '2026-06-25', 1000, { locked: true }), // 同一 u1 有效
        rec('u2', '2026-06-26', 2000), // 有效
        rec('u3', '2026-06-25', 9999) // 新口径：已同步 → 有效
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.validParticipants).toBe(3); // u1, u2, u3（新口径 u3 已同步即有效）
  });

  it('avgSteps = totalSteps / validParticipants', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-26', 1000), // 有效
        rec('u2', '2026-06-26', 3000) // 有效
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.totalSteps).toBe(4000);
    expect(r.validParticipants).toBe(2);
    expect(r.avgSteps).toBe(2000);
  });

  it('avgSteps 除零→0（无有效参与人）', () => {
    const store = { User: [], Whitelist: [], StepRecord: [], RankCache: [] };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.avgSteps).toBe(0);
  });
});

describe('buildDashboard 口径对齐（活动期过滤 / 异常排除 / join_status）', () => {
  it('totalSteps：活动期外脏记录（locked 但 date<start_date）不计入（与 userStats/rankAggregate 同口径）', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-25', 9999, { locked: true }), // 期外（活动 06-26 开始）→ 剔除
        rec('u1', '2026-06-26', 2000), // today 期内 → 计入
        rec('u2', '2026-06-26', 3000) // today → 计入
      ],
      RankCache: []
    };
    const activity = { activity_id: ACT, start_time: '2026-06-26T00:00:00+08:00' };
    const r = buildDashboard({ store, activityId: ACT, activity, now: NOW });
    expect(r.totalSteps).toBe(5000); // 仅活动期内两条（9999 被期外过滤剔除）
  });

  it('totalSteps：activity 缺失 → 兜底不过滤（向后兼容）', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-25', 1000, { locked: true }), // 无 activity → 不过滤 → 计入
        rec('u1', '2026-06-26', 2000) // today → 计入
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW }); // 不传 activity
    expect(r.totalSteps).toBe(3000);
  });

  it('abnormal（待裁定异常）不计入 totalSteps / dailyActive', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-26', 1000), // 正常 today
        rec('u2', '2026-06-26', 9999, { abnormal: true }), // 异常 → 不计入
        rec('u2', '2026-06-25', 8888, { abnormal: true, locked: true }) // 异常 → 不计入
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW, config: { trendDays: 3 } });
    expect(r.totalSteps).toBe(1000);
    const byDate = {};
    r.dailyActive.forEach((x) => { byDate[x.date] = x.count; });
    expect(byDate['2026-06-26']).toBe(1); // 仅 u1（u2 异常不计日活）
    expect(byDate['2026-06-25']).toBe(0); // u2 异常不计日活
  });

  it('validParticipants/totalSteps：未 joined 或未注册用户的裸步数不计入（User 非空时校验，对齐 rankAggregate）', () => {
    const store = {
      User: [
        { _openid: 'u1', join_status: 'joined' },
        { _openid: 'u2', join_status: 'pending' }
        // u3 无 User（未注册/已注销）
      ],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-26', 1000), // joined → 计入
        rec('u2', '2026-06-26', 2000), // pending → 不计入
        rec('u3', '2026-06-26', 3000) // 无 User → 不计入
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.validParticipants).toBe(1); // 仅 u1
    expect(r.totalSteps).toBe(1000); // u2/u3 被 join_status 过滤，与 validParticipants 同口径
  });
});

describe('buildDashboard dailyActive（日活趋势）', () => {
  it('按 date 分组，每日 count distinct user_id；近 trendDays 天升序', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-26', 1000), // today
        rec('u2', '2026-06-26', 1000), // today → 2 人
        rec('u1', '2026-06-25', 1000), // 昨 → 1 人
        rec('u3', '2026-06-20', 1000) // 更早 → 1 人
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW, config: { trendDays: 3 } });
    // 近 3 天：06-24, 06-25, 06-26（升序）
    expect(r.dailyActive.map((x) => x.date)).toEqual(['2026-06-24', '2026-06-25', '2026-06-26']);
    const byDate = {};
    r.dailyActive.forEach((x) => { byDate[x.date] = x.count; });
    expect(byDate['2026-06-26']).toBe(2);
    expect(byDate['2026-06-25']).toBe(1);
    expect(byDate['2026-06-24']).toBe(0); // 缺日补 0
  });

  it('默认近 30 天', () => {
    const store = { User: [], Whitelist: [], StepRecord: [], RankCache: [] };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.dailyActive).toHaveLength(30);
    expect(r.dailyActive[0].count).toBe(0); // 全补 0
    expect(r.dailyActive[29].date).toBe('2026-06-26'); // 末尾为今天
  });

  it('同日同用户多记录只计 1（distinct）', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-26', 1000),
        rec('u1', '2026-06-26', 2000), // 同 u1 同日
        rec('u2', '2026-06-26', 3000)
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW, config: { trendDays: 1 } });
    expect(r.dailyActive[0].date).toBe('2026-06-26');
    expect(r.dailyActive[0].count).toBe(2);
  });
});

describe('buildDashboard deptRank（复用 RankCache，不重算）', () => {
  it('直接读 RankCache(type===dept) 按 rank 升序透传', () => {
    const rankCache = [
      { type: 'dept', activity_id: ACT, rank: 2, dept_id: 'd_02', total_steps: 8000, avg_steps: 2000, member_count: 4, small_sample: false, dept_name: '二部' },
      { type: 'dept', activity_id: ACT, rank: 1, dept_id: 'd_01', total_steps: 10000, avg_steps: 2500, member_count: 4, small_sample: false, dept_name: '一部' },
      { type: 'personal', activity_id: ACT, rank: 1, user_id: 'u1', total_steps: 999 } // personal 不混入
    ];
    const store = { User: [], Whitelist: [], StepRecord: [], RankCache: rankCache };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.deptRank).toHaveLength(2);
    expect(r.deptRank[0].dept_id).toBe('d_01'); // rank=1 在前
    expect(r.deptRank[1].dept_id).toBe('d_02');
    // 透传字段
    expect(r.deptRank[0].avg_steps).toBe(2500);
    expect(r.deptRank[0].member_count).toBe(4);
    expect(r.deptRank[0].small_sample).toBe(false);
    expect(r.deptRank[0].dept_name).toBe('一部');
  });

  it('deptRank 不重算：StepRecord 改动不影响 deptRank（只读 RankCache）', () => {
    const rankCache = [
      { type: 'dept', activity_id: ACT, rank: 1, dept_id: 'd_01', total_steps: 100, avg_steps: 50, member_count: 2, dept_name: '一部' }
    ];
    // StepRecord 实际步数巨大，但 deptRank 仍读 RankCache 的 100（不复算）
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [rec('u1', '2026-06-26', 999999)],
      RankCache: rankCache
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.deptRank[0].total_steps).toBe(100);
  });

  it('deptRank 投影不下发敏感字段（无 _openid/phone/sync_count）', () => {
    const rankCache = [
      { type: 'dept', activity_id: ACT, rank: 1, dept_id: 'd_01', total_steps: 100, dept_name: '一部' }
    ];
    const store = { User: [], Whitelist: [], StepRecord: [], RankCache: rankCache };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    for (const item of r.deptRank) {
      expect(item._openid).toBeUndefined();
      expect(item.phone).toBeUndefined();
      expect(item.sync_count).toBeUndefined();
    }
  });
});

describe('isValidRecord 口径与 rankAggregate/stepsQuery/userStats 一致', () => {
  const today = '2026-06-26';

  it('活动期内已同步即有效（date<=today），不依赖 locked', () => {
    expect(isValidRecord({ locked: true, date: '2026-06-01' }, today)).toBe(true);
    expect(isValidRecord({ locked: false, date: today }, today)).toBe(true);
    expect(isValidRecord({ locked: false, date: '2026-06-25' }, today)).toBe(true); // 新口径：已同步即有效
    expect(isValidRecord({ locked: false, date: '' }, today)).toBe(false);
  });

  it('abnormal=true 一律不计入（待裁定异常，无论 locked/today）', () => {
    expect(isValidRecord({ locked: true, date: '2026-06-01', abnormal: true }, today)).toBe(false);
    expect(isValidRecord({ locked: false, date: today, abnormal: true }, today)).toBe(false);
  });

  it('活动期过滤：startDate 缺失→不过滤；有 startDate 且 date<start→剔除', () => {
    const start = '2026-06-26';
    // 缺失 startDate：locked 的早期记录仍计入（兜底，向后兼容）
    expect(isValidRecord({ locked: true, date: '2026-06-01' }, today)).toBe(true);
    // 有 startDate：locked 但 date<start → 剔除（早期 sync bug 回灌的脏记录）
    expect(isValidRecord({ locked: true, date: '2026-06-25' }, today, start)).toBe(false);
    // date>=start 且 today → 计入
    expect(isValidRecord({ locked: false, date: today }, today, start)).toBe(true);
  });

  it('活动期右界：有 endDate 且 date>end→剔除；date===end 保留结束当日；endDate 缺失→不过滤', () => {
    const start = '2026-06-20';
    const end = '2026-06-25';
    // date>end → 剔除（活动结束后残留记录）
    expect(isValidRecord({ date: '2026-06-26' }, today, start, end)).toBe(false);
    // date===end → 保留（结束当日含两端）
    expect(isValidRecord({ date: end }, today, start, end)).toBe(true);
    // endDate 缺失 → 不过滤右界（兜底，与 startDate 同口径）
    expect(isValidRecord({ date: '2026-06-26' }, today, start)).toBe(true);
  });
});

describe('buildDailyActiveTrend（独立断言：日期升序 / 缺日补 0 / 空数据 / 非法）', () => {
  it('输出按日期升序（从 trendDays-1 天前到 today）', () => {
    const dailyMap = new Map([['2026-06-26', new Set(['u1', 'u2'])]]);
    const trend = buildDailyActiveTrend(dailyMap, '2026-06-26', 3);
    expect(trend.map((x) => x.date)).toEqual(['2026-06-24', '2026-06-25', '2026-06-26']);
  });

  it('缺日补 0（无数据日期 count=0）', () => {
    const dailyMap = new Map([['2026-06-26', new Set(['u1'])]]);
    const trend = buildDailyActiveTrend(dailyMap, '2026-06-26', 3);
    const byDate = {};
    trend.forEach((x) => { byDate[x.date] = x.count; });
    expect(byDate['2026-06-24']).toBe(0); // 缺日
    expect(byDate['2026-06-25']).toBe(0); // 缺日
    expect(byDate['2026-06-26']).toBe(1);
  });

  it('空 dailyMap → 全补 0，长度仍为 trendDays', () => {
    const trend = buildDailyActiveTrend(new Map(), '2026-06-26', 5);
    expect(trend).toHaveLength(5);
    expect(trend.every((x) => x.count === 0)).toBe(true);
    expect(trend[4].date).toBe('2026-06-26'); // 末尾为今天
  });

  it('trendDays=1 → 仅今天', () => {
    const trend = buildDailyActiveTrend(new Map([['2026-06-26', new Set(['u1'])]]), '2026-06-26', 1);
    expect(trend).toEqual([{ date: '2026-06-26', count: 1 }]);
  });

  it('trendDays 缺省/非法 → 兜底默认（DEFAULT_TREND_DAYS=30）', () => {
    const trendDefault = buildDailyActiveTrend(new Map(), '2026-06-26');
    expect(trendDefault).toHaveLength(30);
    const trendNan = buildDailyActiveTrend(new Map(), '2026-06-26', NaN);
    expect(trendNan).toHaveLength(30);
    // 实现用 Number(trendDays) || DEFAULT：0 为 falsy → 兜底 30（不是 1）。
    const trendZero = buildDailyActiveTrend(new Map(), '2026-06-26', 0);
    expect(trendZero).toHaveLength(30);
  });

  it('today 非法日期（无法解析为三段数字）→ 返回空数组（不抛错）', () => {
    expect(buildDailyActiveTrend(new Map(), 'not-a-date', 3)).toEqual([]);
    expect(buildDailyActiveTrend(new Map(), '', 3)).toEqual([]);
    expect(buildDailyActiveTrend(new Map(), '2026-06', 3)).toEqual([]); // 仅两段
  });

  it('today 为可解析三段数字（含非零填充如 2026-6-1）→ 正常构造（输出端零填充规范）', () => {
    // 实现仅校验 split('-') 后三段均为有限数，不校验输入零填充；输出端 padStart 规范为 YYYY-MM-DD。
    const trend = buildDailyActiveTrend(new Map(), '2026-6-1', 1);
    expect(trend).toEqual([{ date: '2026-06-01', count: 0 }]);
  });

  it('跨月 / 跨年回退正确（2026-01-03 回退含 2025-12 末）', () => {
    const trend = buildDailyActiveTrend(new Map(), '2026-01-03', 5);
    expect(trend.map((x) => x.date)).toEqual([
      '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03'
    ]);
  });
});

describe('projectDeptRank（独立断言：字段白名单 + small_sample 标记）', () => {
  it('返回白名单字段：rank/dept_id/total_steps/avg_steps/member_count/small_sample/dept_name', () => {
    const out = projectDeptRank({
      rank: 1, dept_id: 'd_1', total_steps: 1000, avg_steps: 250,
      member_count: 4, small_sample: false, dept_name: '一部'
    });
    expect(out).toEqual({
      rank: 1, dept_id: 'd_1', total_steps: 1000, avg_steps: 250,
      member_count: 4, small_sample: false, dept_name: '一部'
    });
  });

  it('不下发敏感字段（_openid / phone / sync_count）', () => {
    const out = projectDeptRank({
      rank: 1, dept_id: 'd_1', total_steps: 1000,
      _openid: 'op', phone: '13800000000', sync_count: 9
    });
    expect(out).not.toHaveProperty('_openid');
    expect(out).not.toHaveProperty('phone');
    expect(out).not.toHaveProperty('sync_count');
  });

  it('small_sample 标记透传：true → true，假值 → false（强制布尔）', () => {
    expect(projectDeptRank({ small_sample: true }).small_sample).toBe(true);
    expect(projectDeptRank({ small_sample: false }).small_sample).toBe(false);
    expect(projectDeptRank({ small_sample: 0 }).small_sample).toBe(false);
    expect(projectDeptRank({ small_sample: undefined }).small_sample).toBe(false);
    expect(projectDeptRank({ small_sample: 1 }).small_sample).toBe(true);
  });

  it('空输入兜底（row 缺失 → 全默认值，不抛错）', () => {
    const out = projectDeptRank(null);
    expect(out).toEqual({
      rank: undefined, dept_id: undefined, total_steps: undefined,
      avg_steps: undefined, member_count: undefined,
      small_sample: false, dept_name: ''
    });
  });

  it('dept_name 缺失 → 空串', () => {
    expect(projectDeptRank({ rank: 1 }).dept_name).toBe('');
    expect(projectDeptRank({ rank: 1, dept_name: null }).dept_name).toBe('');
  });
});
