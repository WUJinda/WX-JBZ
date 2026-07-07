/**
 * user.stats 聚合纯函数单测（F4）。
 * active_days=有效记录不同日期数；total_days=start_date~今日天数（缺 activity/未开始→0）；
 * today_steps/total_steps 与 stepsQuery 一致；my_rank 本地轨占位 null。
 */
const { buildStats, calcTotalDays } = require('../../cloudfunctions/user/userStats');

const USER_ID = 'u_1';
const ACTIVITY_ID = 'a_demo_001';

function rec(overrides) {
  return Object.assign(
    {
      user_id: USER_ID, _openid: 'oU', activity_id: ACTIVITY_ID,
      date: '2026-07-03', steps: 8000, abnormal: false,
      locked: true, synced_at: '2026-07-03T10:00:00Z', sync_count: 1
    },
    overrides || {}
  );
}

const NOW = new Date('2026-07-03T04:00:00Z'); // 北京时间 07-03 12:00
const ACTIVITY = {
  activity_id: ACTIVITY_ID,
  name: '2026 健步走',
  start_time: '2026-07-01T00:00:00+08:00',
  end_time: '2026-07-21T23:59:59+08:00'
};

describe('calcTotalDays 活动期天数', () => {
  it('start=07-01, today=07-03 → 3 天（含两端）', () => {
    expect(calcTotalDays(ACTIVITY, '2026-07-03', 480)).toBe(3);
  });

  it('today === start → 1 天', () => {
    expect(calcTotalDays(ACTIVITY, '2026-07-01', 480)).toBe(1);
  });

  it('未开始（today < start）→ 0', () => {
    expect(calcTotalDays(ACTIVITY, '2026-06-30', 480)).toBe(0);
  });

  it('缺 activity → 0', () => {
    expect(calcTotalDays(null, '2026-07-03', 480)).toBe(0);
  });

  it('缺 start_time → 0', () => {
    expect(calcTotalDays({}, '2026-07-03', 480)).toBe(0);
  });
});

describe('buildStats 统计（F4）', () => {
  it('today_steps/total_steps 与 stepsQuery 口径一致（locked + 今日）', () => {
    const records = [
      rec({ date: '2026-07-01', steps: 8000, locked: true }),
      rec({ date: '2026-07-02', steps: 9000, locked: false }), // 未锁且非今日 → 无效
      rec({ date: '2026-07-03', steps: 7000, locked: false }) // 今日有效
    ];
    const out = buildStats({ records, activity: ACTIVITY, now: NOW });
    expect(out.today_steps).toBe(7000);
    expect(out.total_steps).toBe(8000 + 7000); // locked(07-01) + 今日(07-03)
  });

  it('active_days = 有效记录的不同 date 数', () => {
    const records = [
      rec({ date: '2026-07-01', steps: 8000, locked: true }),
      rec({ date: '2026-07-02', steps: 9000, locked: true }),
      rec({ date: '2026-07-03', steps: 7000, locked: false }) // 今日
    ];
    const out = buildStats({ records, activity: ACTIVITY, now: NOW });
    expect(out.active_days).toBe(3);
  });

  it('active_days 不计无效记录', () => {
    const records = [
      rec({ date: '2026-07-01', steps: 8000, locked: true }),
      rec({ date: '2026-07-02', steps: 9000, locked: false }) // 未锁且非今日 → 无效
    ];
    const out = buildStats({ records, activity: ACTIVITY, now: NOW });
    expect(out.active_days).toBe(1);
  });

  it('total_days = start_date~今日天数', () => {
    const records = [rec({ date: '2026-07-03', steps: 5000, locked: true })];
    const out = buildStats({ records, activity: ACTIVITY, now: NOW });
    expect(out.total_days).toBe(3);
  });

  it('缺 activity → total_days=0', () => {
    const records = [rec({ date: '2026-07-03', steps: 5000, locked: true })];
    const out = buildStats({ records, now: NOW });
    expect(out.total_days).toBe(0);
  });

  it('活动未开始（now < start）→ total_days=0', () => {
    const records = [];
    const beforeStart = new Date('2026-06-30T04:00:00Z'); // 北京 06-30
    const out = buildStats({ records, activity: ACTIVITY, now: beforeStart });
    expect(out.total_days).toBe(0);
  });

  it('my_rank 本地轨占位 null（R4.4）', () => {
    const out = buildStats({ records: [], activity: ACTIVITY, now: NOW });
    expect(out.my_rank).toBeNull();
  });

  it('无记录：today/total=0, active_days=0', () => {
    const out = buildStats({ records: [], activity: ACTIVITY, now: NOW });
    expect(out.today_steps).toBe(0);
    expect(out.total_steps).toBe(0);
    expect(out.active_days).toBe(0);
  });

  it('buildStats 输出不下发 _openid / sync_count / user_id', () => {
    const records = [rec({ date: '2026-07-03', steps: 5000, locked: true })];
    const out = buildStats({ records, activity: ACTIVITY, now: NOW });
    expect(out).not.toHaveProperty('_openid');
    expect(out).not.toHaveProperty('sync_count');
    expect(out).not.toHaveProperty('user_id');
  });

  it('now 默认当前时间不报错', () => {
    const out = buildStats({ records: [], activity: ACTIVITY });
    expect(out).toHaveProperty('today_steps');
    expect(out).toHaveProperty('my_rank', null);
  });

  it('与 PRD 字段命名一致（today_steps/total_steps/total_days/active_days/my_rank）', () => {
    const out = buildStats({ records: [], activity: ACTIVITY, now: NOW });
    expect(Object.keys(out).sort()).toEqual(
      ['active_days', 'my_rank', 'today_steps', 'total_days', 'total_steps'].sort()
    );
  });

  it('total_steps/active_days 仅算活动期内（过滤 date<start_date 脏 locked 记录）', () => {
    const records = [
      rec({ date: '2026-06-29', steps: 99999, locked: true }), // 脏（活动期外）
      rec({ date: '2026-07-01', steps: 8000, locked: true }),  // 活动期内
      rec({ date: '2026-07-03', steps: 7000, locked: false })  // 今日
    ];
    const out = buildStats({ records, activity: ACTIVITY, now: NOW });
    expect(out.total_steps).toBe(8000 + 7000); // 脏 99999 不计入
    expect(out.active_days).toBe(2);           // 07-01 + 07-03
  });

  it('不传 activity（兜底）→ total_steps 含全部 locked+today（不过滤）', () => {
    const records = [
      rec({ date: '2026-06-29', steps: 99999, locked: true }),
      rec({ date: '2026-07-01', steps: 8000, locked: true }),
      rec({ date: '2026-07-03', steps: 7000, locked: false })
    ];
    const out = buildStats({ records, now: NOW }); // 无 activity → 兜底
    expect(out.total_steps).toBe(99999 + 8000 + 7000);
  });
});
