/**
 * steps.trend 聚合纯函数单测（F4）。
 * 区间=最近 range 天（含今日），无记录日期补 0，按 date 升序；
 * 复用有效步数口径（活动期内已同步即有效，不依赖 locked；activity 缺失→不过滤活动期）；empty=true 当且仅当区间全 0。
 */
const { buildTrend, buildDateRange, projectTrend } = require('../../cloudfunctions/steps/stepsTrend');

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

describe('buildDateRange 日期序列', () => {
  it('近 7 天含今日，按 date 升序', () => {
    const dates = buildDateRange('2026-07-03', 7);
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-06-27');
    expect(dates[6]).toBe('2026-07-03');
    // 升序
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] > dates[i - 1]).toBe(true);
    }
  });

  it('近 30 天含今日', () => {
    const dates = buildDateRange('2026-07-03', 30);
    expect(dates).toHaveLength(30);
    expect(dates[29]).toBe('2026-07-03');
    expect(dates[0]).toBe('2026-06-04');
  });

  it('跨月边界正确（07-01 → 06 含 6 月尾）', () => {
    const dates = buildDateRange('2026-07-01', 3);
    expect(dates).toEqual(['2026-06-29', '2026-06-30', '2026-07-01']);
  });
});

describe('buildTrend 趋势（F4）', () => {
  it('range=7：区间内无记录日期补 0，有记录按有效步数', () => {
    const records = [
      rec({ date: '2026-07-01', steps: 8000, locked: true }),
      rec({ date: '2026-07-03', steps: 7000, locked: false }) // 今日有效
    ];
    const out = buildTrend({ records, range: 7, now: NOW });
    expect(out.range).toBe(7);
    expect(out.list).toHaveLength(7);
    expect(out.list.map((i) => i.date)).toEqual([
      '2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30',
      '2026-07-01', '2026-07-02', '2026-07-03'
    ]);
    const byDate = new Map(out.list.map((i) => [i.date, i.steps]));
    expect(byDate.get('2026-07-01')).toBe(8000);
    expect(byDate.get('2026-07-02')).toBe(0); // 无记录补 0
    expect(byDate.get('2026-07-03')).toBe(7000);
    expect(byDate.get('2026-06-27')).toBe(0);
    expect(out.empty).toBe(false);
  });

  it('range=30：区间 30 天，含今日', () => {
    const records = [rec({ date: '2026-07-03', steps: 5000, locked: true })];
    const out = buildTrend({ records, range: 30, now: NOW });
    expect(out.range).toBe(30);
    expect(out.list).toHaveLength(30);
    expect(out.list[29].date).toBe('2026-07-03');
    expect(out.list[29].steps).toBe(5000);
  });

  it('range 仅接受 7/30，其余按 7 兜底', () => {
    const out = buildTrend({ records: [], range: 100, now: NOW });
    expect(out.range).toBe(7);
    expect(out.list).toHaveLength(7);
    const out2 = buildTrend({ records: [], range: 'abc', now: NOW });
    expect(out2.range).toBe(7);
  });

  it('复用有效步数口径：活动期内已同步即有效（不依赖 locked）', () => {
    const records = [
      rec({ date: '2026-07-02', steps: 9000, locked: false }), // 非今日未锁 → 新口径仍有效
      rec({ date: '2026-07-01', steps: 8000, locked: true })
    ];
    const out = buildTrend({ records, range: 7, now: NOW });
    const byDate = new Map(out.list.map((i) => [i.date, i.steps]));
    expect(byDate.get('2026-07-02')).toBe(9000); // 新口径有效
    expect(byDate.get('2026-07-01')).toBe(8000);
  });

  it('activity 过滤：活动期外记录不计入趋势（与 today/history 同口径）', () => {
    const records = [
      rec({ date: '2026-06-29', steps: 9999, locked: true }), // 区间内但 date<start_date → 无效
      rec({ date: '2026-07-01', steps: 8000, locked: true }), // 活动期内
      rec({ date: '2026-07-03', steps: 7000, locked: false }) // 今日
    ];
    const out = buildTrend({
      records, range: 7, now: NOW,
      activity: { start_time: '2026-07-01T00:00:00+08:00' }
    });
    const byDate = new Map(out.list.map((i) => [i.date, i.steps]));
    expect(byDate.get('2026-06-29')).toBe(0); // 活动期外被过滤
    expect(byDate.get('2026-07-01')).toBe(8000);
    expect(byDate.get('2026-07-03')).toBe(7000);
  });

  it('空态：区间内仅活动期外记录 → empty=true（R4.3）', () => {
    const records = [
      rec({ date: '2026-07-01', steps: 9000, locked: true }) // 区间内但 date<start_date → 无效
    ];
    const out = buildTrend({
      records, range: 7, now: NOW,
      activity: { start_time: '2026-07-02T00:00:00+08:00' }
    });
    expect(out.empty).toBe(true);
    expect(out.list.every((i) => i.steps === 0)).toBe(true);
  });

  it('空态：完全无记录 → empty=true', () => {
    const out = buildTrend({ records: [], range: 7, now: NOW });
    expect(out.empty).toBe(true);
    expect(out.list).toHaveLength(7);
  });

  it('非空：有今日已入库记录（未锁）→ empty=false', () => {
    const records = [rec({ date: '2026-07-03', steps: 5000, locked: false })];
    const out = buildTrend({ records, range: 7, now: NOW });
    expect(out.empty).toBe(false);
  });

  it('区间外的有效记录不出现在序列里（区间裁剪）', () => {
    // 远早于区间起始（2026-06-27 之前）
    const records = [rec({ date: '2026-06-01', steps: 9999, locked: true })];
    const out = buildTrend({ records, range: 7, now: NOW });
    expect(out.list.every((i) => i.steps === 0)).toBe(true);
    // 区间内全 0 → empty=true（R4.3 空态，趋势图只看区间内）
    expect(out.empty).toBe(true);
  });

  it('projectTrend 不下发 _openid / sync_count / user_id', () => {
    const item = projectTrend(rec({ date: '2026-07-03', steps: 5000 }));
    expect(item).not.toHaveProperty('_openid');
    expect(item).not.toHaveProperty('sync_count');
    expect(item).not.toHaveProperty('user_id');
    expect(item).toEqual({ date: '2026-07-03', steps: 5000 });
  });

  it('trend 输出项不下发敏感字段（整列校验）', () => {
    const records = [rec({ date: '2026-07-03', steps: 5000, locked: true })];
    const out = buildTrend({ records, range: 7, now: NOW });
    out.list.forEach((i) => {
      expect(i).not.toHaveProperty('_openid');
      expect(i).not.toHaveProperty('sync_count');
      expect(i).not.toHaveProperty('user_id');
    });
  });

  it('同日多条记录求和聚合', () => {
    const records = [
      rec({ date: '2026-07-03', steps: 3000, locked: true }),
      rec({ date: '2026-07-03', steps: 4000, locked: true })
    ];
    const out = buildTrend({ records, range: 7, now: NOW });
    const today = out.list.find((i) => i.date === '2026-07-03');
    expect(today.steps).toBe(7000);
  });

  it('now 默认当前时间不报错', () => {
    const out = buildTrend({ records: [], range: 7 });
    expect(out.list).toHaveLength(7);
  });
});
