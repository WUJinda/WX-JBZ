/**
 * admin.buildDashboard 数据看板单测（H1 R8.5）：
 *   - participated / whitelistTotal / rate（含除零）；
 *   - totalSteps（有效步数口径 locked||today）；
 *   - validParticipants / avgSteps（含除零）；
 *   - dailyActive（近 trendDays 天，缺日补 0）；
 *   - deptRank 复用 RankCache（不重算）。
 */
const { buildDashboard, isValidRecord } = require('../../cloudfunctions/admin/dashboard');

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

  it('totalSteps：有效步数口径（locked || date===today）求和', () => {
    const store = {
      User: [],
      Whitelist: [],
      StepRecord: [
        rec('u1', '2026-06-25', 1000, { locked: true }), // 有效（locked）
        rec('u2', '2026-06-26', 2000), // 有效（today）
        rec('u3', '2026-06-25', 9999, { locked: false }) // 无效（非 today 且未 locked）
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.totalSteps).toBe(3000);
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
        rec('u3', '2026-06-25', 9999) // 无效
      ],
      RankCache: []
    };
    const r = buildDashboard({ store, activityId: ACT, now: NOW });
    expect(r.validParticipants).toBe(2); // u1, u2
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

describe('isValidRecord 口径与 rankAggregate/stepsQuery 一致', () => {
  it('locked || date===today', () => {
    const today = '2026-06-26';
    expect(isValidRecord({ locked: true, date: '2026-06-01' }, today)).toBe(true);
    expect(isValidRecord({ locked: false, date: today }, today)).toBe(true);
    expect(isValidRecord({ locked: false, date: '2026-06-25' }, today)).toBe(false);
    expect(isValidRecord({ locked: false, date: '' }, today)).toBe(false);
  });
});
