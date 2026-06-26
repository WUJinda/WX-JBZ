/**
 * tasks.dailyLock 业务纯函数单测（G1）：锁定昨日 / 幂等 / 可配 lockHour/tz / 不动今日不改值。
 */
const {
  lockYesterday,
  computeYesterdayDate,
  LOCK_DEFAULT_CONFIG
} = require('../../cloudfunctions/tasks/dailyLock');

function rec(userId, date, steps, opts) {
  const o = opts || {};
  return {
    user_id: userId,
    activity_id: 'a_demo_001',
    date,
    steps,
    locked: !!o.locked,
    abnormal: !!o.abnormal,
    synced_at: o.synced_at || (date + 'T04:00:00.000Z'),
    sync_count: o.sync_count || 0
  };
}

describe('computeYesterdayDate（时区/昨日判定）', () => {
  it('北京时间 07-03 12:00 → 昨日 07-02', () => {
    // UTC 07-03 04:00 = 北京 07-03 12:00
    const now = new Date('2026-07-03T04:00:00Z');
    expect(computeYesterdayDate(now, 480)).toBe('2026-07-02');
  });

  it('北京时间 07-01 00:30 → 昨日 06-30（跨月）', () => {
    // UTC 06-30 16:30 = 北京 07-01 00:30
    const now = new Date('2026-06-30T16:30:00Z');
    expect(computeYesterdayDate(now, 480)).toBe('2026-06-30');
  });

  it('默认配置 timezoneOffsetMinutes=480', () => {
    expect(LOCK_DEFAULT_CONFIG.timezoneOffsetMinutes).toBe(480);
    expect(LOCK_DEFAULT_CONFIG.lockHour).toBe(12);
  });
});

describe('lockYesterday 锁定昨日（§6.4）', () => {
  // now = 北京 07-03 12:00 → 昨日 07-02
  const NOW = new Date('2026-07-03T04:00:00Z');

  it('锁定昨日全部 StepRecord（locked=true）', async () => {
    const store = { StepRecord: [
      rec('u1', '2026-07-02', 1000, { locked: false }), // 昨日 → 锁
      rec('u2', '2026-07-02', 2000, { locked: false }), // 昨日 → 锁
      rec('u3', '2026-07-03', 500, { locked: false }) // 今日 → 不动
    ] };
    const result = await lockYesterday({ store, now: NOW });
    expect(result.date).toBe('2026-07-02');
    expect(result.lockedCount).toBe(2);
    expect(store.StepRecord[0].locked).toBe(true);
    expect(store.StepRecord[1].locked).toBe(true);
    expect(store.StepRecord[2].locked).toBe(false); // 今日未动
  });

  it('不动今日（today 的记录保持 locked=false）', async () => {
    const store = { StepRecord: [
      rec('u1', '2026-07-03', 500, { locked: false }) // 今日
    ] };
    const result = await lockYesterday({ store, now: NOW });
    expect(result.lockedCount).toBe(0);
    expect(store.StepRecord[0].locked).toBe(false);
  });

  it('不改 steps 值（只置 locked=true）', async () => {
    const store = { StepRecord: [rec('u1', '2026-07-02', 12345, { locked: false })] };
    await lockYesterday({ store, now: NOW });
    expect(store.StepRecord[0].steps).toBe(12345); // steps 不变
    expect(store.StepRecord[0].locked).toBe(true);
  });

  it('幂等：已锁定的记录再跑无变化（lockedCount=0）', async () => {
    const store = { StepRecord: [
      rec('u1', '2026-07-02', 1000, { locked: true }) // 已锁
    ] };
    const r1 = await lockYesterday({ store, now: NOW });
    expect(r1.lockedCount).toBe(0); // 已锁，无新增
    expect(store.StepRecord[0].locked).toBe(true);
  });

  it('跨活动：只锁昨日，不论 activity_id', async () => {
    const store = { StepRecord: [
      rec('u1', '2026-07-02', 1000, { locked: false }), // 昨日 活动 a
      { user_id: 'u2', activity_id: 'other', date: '2026-07-02', steps: 500, locked: false } // 昨日 其他活动
    ] };
    const result = await lockYesterday({ store, now: NOW });
    expect(result.lockedCount).toBe(2);
    expect(store.StepRecord[0].locked).toBe(true);
    expect(store.StepRecord[1].locked).toBe(true);
  });

  it('可配 timezoneOffsetMinutes（UTC+0 → 昨日按 UTC 算）', async () => {
    // now = UTC 07-03 04:00；tz=0 → 今日 07-03，昨日 07-02（同结果，但验证偏移生效）
    // 改用 tz=0 + now=UTC 07-03 00:30 → 今日 07-03，昨日 07-02
    const now = new Date('2026-07-03T00:30:00Z');
    const store = { StepRecord: [rec('u1', '2026-07-02', 100, { locked: false })] };
    const result = await lockYesterday({ store, now, config: { timezoneOffsetMinutes: 0 } });
    expect(result.date).toBe('2026-07-02');
    expect(result.lockedCount).toBe(1);
  });

  it('lockHour 配置项被接受（不影响昨日判定口径，预留扩展）', async () => {
    const store = { StepRecord: [rec('u1', '2026-07-02', 100, { locked: false })] };
    const result = await lockYesterday({ store, now: NOW, config: { lockHour: 6 } });
    expect(result.lockedCount).toBe(1);
  });

  it('缺 store.StepRecord 抛错', async () => {
    await expect(lockYesterday({ store: {} })).rejects.toThrow();
  });
});
