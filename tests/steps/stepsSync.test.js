/**
 * steps.sync 业务纯函数单测（E2）：upsert 去重 / 异常阈值 / 频控 / 锁定不改值 / 活动结束禁同步。
 */
const {
  syncSteps,
  aggregateByDate,
  dateFromTimestamp,
  activityStartDate,
  isAbnormal,
  projectStep,
  DEFAULT_CONFIG
} = require('../../cloudfunctions/steps/stepsSync');
const { CODE } = require('../../cloudfunctions/common/errors');
const { STATUS } = require('../../cloudfunctions/activity/activityStatus');

const OPENID = 'oU';
const USER_ID = 'u_1';
const ACTIVITY_ID = 'a_demo_001';

// 活动窗口：2026-07-01 ~ 2026-07-21（北京时间）
function mockActivity() {
  return {
    activity_id: ACTIVITY_ID,
    start_time: '2026-07-01T00:00:00+08:00',
    end_time: '2026-07-21T23:59:59+08:00'
  };
}

// 构造 stepInfoList：给定 date(YYYY-MM-DD 北京时间) → timestamp(当日 12:00 北京时间, 秒)
function tsOfDate(dateStr) {
  // dateStr = '2026-07-01' → 北京时间当日 12:00 的秒级时间戳
  const ms = Date.parse(dateStr + 'T12:00:00+08:00');
  return Math.floor(ms / 1000);
}

function stepList(pairs) {
  // pairs: [['2026-07-01', 8521], ...]
  return pairs.map(([d, s]) => ({ timestamp: tsOfDate(d), step: s }));
}

function makeStore(initial) {
  return { StepRecord: Array.isArray(initial) ? initial.slice() : [] };
}

describe('aggregateByDate / dateFromTimestamp / isAbnormal 工具函数', () => {
  it('dateFromTimestamp 北京时间 YYYY-MM-DD', () => {
    // 2026-07-01 12:00 +08:00 = UTC 04:00 → 北京当日 07-01
    expect(dateFromTimestamp(tsOfDate('2026-07-01'), 480)).toBe('2026-07-01');
    // 2026-07-01 00:30 +08:00 = 前一日 UTC 16:30 → 北京 07-01
    const ms = Date.parse('2026-07-01T00:30:00+08:00');
    expect(dateFromTimestamp(Math.floor(ms / 1000), 480)).toBe('2026-07-01');
  });

  it('aggregateByDate 按日聚合', () => {
    const list = stepList([['2026-07-01', 100], ['2026-07-02', 200]]);
    const out = aggregateByDate(list, 480);
    expect(out).toEqual([
      { date: '2026-07-01', steps: 100 },
      { date: '2026-07-02', steps: 200 }
    ]);
  });

  it('isAbnormal 阈值边界：> 阈值 true，≤ 阈值 false', () => {
    expect(isAbnormal(50001, 50000)).toBe(true);
    expect(isAbnormal(50000, 50000)).toBe(false);
    expect(isAbnormal(49999, 50000)).toBe(false);
  });
});

describe('syncSteps upsert 去重（R3.2）', () => {
  const NOW = new Date('2026-07-02T04:00:00Z'); // 北京时间 07-02 12:00

  it('同 (user,activity,date) 多次同步只留一条，取最新值', async () => {
    const store = makeStore();
    // 第一次同步：07-01 = 8000（历史日，落库即锁）, 07-02 = 9000（今日）
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 8000], ['2026-07-02', 9000]]),
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord).toHaveLength(2);

    // 第二次同步：今日 07-02 改为 10000（取最新值覆盖；历史日 07-01 已锁不动）
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-02', 10000]]),
      activity: mockActivity(), now: NOW
    });
    // 仍只有 2 条（07-02 覆盖，不新增）
    expect(store.StepRecord).toHaveLength(2);
    const today = store.StepRecord.find((r) => r.date === '2026-07-02');
    expect(today.steps).toBe(10000);
  });

  it('连续两次 sync 不产生重复（同日多次）', async () => {
    const store = makeStore();
    const list = stepList([['2026-07-02', 9000]]);
    for (let i = 0; i < 3; i++) {
      await syncSteps({
        store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
        stepInfoList: list, activity: mockActivity(), now: NOW
      });
    }
    const d2 = store.StepRecord.filter((r) => r.date === '2026-07-02');
    expect(d2).toHaveLength(1);
  });

  it('sync_count 仅当日累加，非当日 date 保持 0', async () => {
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 8000], ['2026-07-02', 9000]]),
      activity: mockActivity(), now: NOW
    });
    const d1 = store.StepRecord.find((r) => r.date === '2026-07-01');
    const d2 = store.StepRecord.find((r) => r.date === '2026-07-02');
    expect(d1.sync_count).toBe(0); // 非当日
    expect(d2.sync_count).toBe(1); // 当日首次
    // P1：历史日（07-01）落库即锁；今日（07-02）保持 unlocked 可刷新。
    expect(d1.locked).toBe(true);
    expect(d2.locked).toBe(false);
  });
});

describe('syncSteps 异常阈值（R3.6）', () => {
  const NOW = new Date('2026-07-01T04:00:00Z');

  it('>50000 标 abnormal=true', async () => {
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 60000]]),
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord[0].abnormal).toBe(true);
  });

  it('≤50000 不标 abnormal', async () => {
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 50000]]),
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord[0].abnormal).toBe(false);
  });

  it('阈值可配置（覆盖 abnormalThreshold）', async () => {
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 30000]]),
      activity: mockActivity(), now: NOW,
      config: { abnormalThreshold: 20000 }
    });
    expect(store.StepRecord[0].abnormal).toBe(true);
  });

  it('默认阈值 = 50000', () => {
    expect(DEFAULT_CONFIG.abnormalThreshold).toBe(50000);
  });
});

describe('syncSteps 频控（R3.3）', () => {
  const NOW = new Date('2026-07-01T04:00:00Z');

  it('同用户同日 > 6 次落库被拒（第 7 次抛 STEP_SYNC_LIMIT）', async () => {
    const store = makeStore();
    const list = stepList([['2026-07-01', 8000]]);
    // 6 次成功
    for (let i = 0; i < 6; i++) {
      await syncSteps({
        store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
        stepInfoList: list, activity: mockActivity(), now: NOW
      });
    }
    const rec = store.StepRecord.find((r) => r.date === '2026-07-01');
    expect(rec.sync_count).toBe(6);
    // 第 7 次拒绝
    await expect(
      syncSteps({
        store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
        stepInfoList: list, activity: mockActivity(), now: NOW
      })
    ).rejects.toMatchObject({ code: CODE.STEP_SYNC_LIMIT });
  });

  it('maxSyncPerDay 可配置', async () => {
    const store = makeStore();
    const list = stepList([['2026-07-01', 8000]]);
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: list, activity: mockActivity(), now: NOW,
      config: { maxSyncPerDay: 1 }
    });
    await expect(
      syncSteps({
        store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
        stepInfoList: list, activity: mockActivity(), now: NOW,
        config: { maxSyncPerDay: 1 }
      })
    ).rejects.toMatchObject({ code: CODE.STEP_SYNC_LIMIT });
  });

  it('默认 maxSyncPerDay = 6', () => {
    expect(DEFAULT_CONFIG.maxSyncPerDay).toBe(6);
  });

  it('跨日频控独立：新的一天计数重置', async () => {
    const NOW_DAY1 = new Date('2026-07-01T04:00:00Z');
    const NOW_DAY2 = new Date('2026-07-02T04:00:00Z');
    const store = makeStore();
    // 第一天同步 6 次（达上限）
    for (let i = 0; i < 6; i++) {
      await syncSteps({
        store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
        stepInfoList: stepList([['2026-07-01', 8000]]),
        activity: mockActivity(), now: NOW_DAY1
      });
    }
    // 第二天可继续同步（计数独立）
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-02', 9000]]),
      activity: mockActivity(), now: NOW_DAY2
    });
    const d2 = store.StepRecord.find((r) => r.date === '2026-07-02');
    expect(d2.sync_count).toBe(1);
  });
});

describe('syncSteps 锁定不改值（架构 §6.4）', () => {
  const NOW = new Date('2026-07-02T04:00:00Z');

  it('locked=true 的记录 sync 不覆盖', async () => {
    const store = makeStore([
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-07-01', steps: 8000, abnormal: false,
        locked: true, synced_at: '2026-07-02T00:00:00Z', sync_count: 3
      }
    ]);
    // 同步试图把 07-01 改为 10000
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 10000]]),
      activity: mockActivity(), now: NOW
    });
    const d1 = store.StepRecord.find((r) => r.date === '2026-07-01');
    expect(d1.steps).toBe(8000); // 未被覆盖
    expect(d1.locked).toBe(true);
  });

  it('locked=false 的记录 sync 正常覆盖', async () => {
    const store = makeStore([
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-07-01', steps: 8000, abnormal: false,
        locked: false, synced_at: '2026-07-02T00:00:00Z', sync_count: 0
      }
    ]);
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 12345]]),
      activity: mockActivity(), now: NOW
    });
    const d1 = store.StepRecord.find((r) => r.date === '2026-07-01');
    expect(d1.steps).toBe(12345);
    // P1：existing 历史日（locked:false 旧数据）sync 时补锁为 true。
    expect(d1.locked).toBe(true);
  });
});

describe('syncSteps 活动结束禁同步（R3.5）', () => {
  it('活动 ended → sync 拒绝（STEP_ACTIVITY_CLOSED）', async () => {
    const NOW_AFTER = new Date('2026-08-01T04:00:00Z'); // 活动已结束
    const store = makeStore();
    await expect(
      syncSteps({
        store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
        stepInfoList: stepList([['2026-07-01', 8000]]),
        activity: mockActivity(), now: NOW_AFTER
      })
    ).rejects.toMatchObject({ code: CODE.STEP_ACTIVITY_CLOSED });
    // 不落库
    expect(store.StepRecord).toHaveLength(0);
  });

  it('活动 active → sync 正常', async () => {
    const NOW_DURING = new Date('2026-07-05T04:00:00Z'); // 活动进行中
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-05', 8000]]),
      activity: mockActivity(), now: NOW_DURING
    });
    expect(store.StepRecord).toHaveLength(1);
  });
});

describe('syncSteps 参数校验 + 返回结构', () => {
  const NOW = new Date('2026-07-01T04:00:00Z');

  it('缺 openid → AUTH_NO_OPENID', async () => {
    await expect(
      syncSteps({ store: makeStore(), userId: USER_ID, activityId: ACTIVITY_ID, stepInfoList: [] })
    ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
  });

  it('缺 store.StepRecord → SYS_DB_ERROR', async () => {
    await expect(
      syncSteps({ store: {}, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID, stepInfoList: [] })
    ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
  });

  it('返回 today / history / total 结构', async () => {
    const store = makeStore();
    const out = await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-01', 8000]]),
      activity: mockActivity(), now: NOW
    });
    expect(out.today).toEqual({ date: '2026-07-01', steps: 8000, abnormal: false });
    expect(out.history).toHaveLength(1);
    expect(out.history[0]).toMatchObject({ date: '2026-07-01', steps: 8000 });
    expect(out.total).toBe(8000);
  });

  it('projectStep 不下发 _openid / sync_count / _dirty / _isNew', () => {
    const out = projectStep({
      activity_id: 'a', date: '2026-07-01', steps: 100, abnormal: false,
      locked: false, synced_at: 't', _openid: 'oU', sync_count: 3,
      _dirty: true, _isNew: true
    });
    expect(out).not.toHaveProperty('_openid');
    expect(out).not.toHaveProperty('sync_count');
    expect(out).not.toHaveProperty('user_id');
    // P0 写回内部标记绝不下发前端
    expect(out).not.toHaveProperty('_dirty');
    expect(out).not.toHaveProperty('_isNew');
  });

  it('未来日不入库（仅接受 ≤ today）', async () => {
    const store = makeStore();
    // NOW 为 07-01，传 07-03（未来日）
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-03', 5000]]),
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord).toHaveLength(0);
  });
});

describe('syncSteps 历史日即锁（P1：历史日 locked=true，今日 locked=false）', () => {
  const NOW = new Date('2026-07-05T04:00:00Z'); // 北京 07-05 12:00

  it('新建历史日 record → locked=true', async () => {
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-03', 8000]]), // 历史日
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord[0].locked).toBe(true);
  });

  it('新建今日 record → locked=false', async () => {
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-05', 8000]]), // 今日
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord[0].locked).toBe(false);
  });

  it('existing 历史日未锁 → sync 补锁 true 并更新 steps 为本次终值', async () => {
    const store = makeStore([
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-07-03', steps: 5000, abnormal: false,
        locked: false, synced_at: '2026-07-04T00:00:00Z', sync_count: 0
      }
    ]);
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-03', 9000]]),
      activity: mockActivity(), now: NOW
    });
    const d = store.StepRecord.find((r) => r.date === '2026-07-03');
    expect(d.locked).toBe(true); // 补锁
    expect(d.steps).toBe(9000); // 本次同步终值
  });

  it('existing 历史日已锁 → sync 不覆盖不补锁（§6.4 锁定不改值）', async () => {
    const store = makeStore([
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-07-03', steps: 7000, abnormal: false,
        locked: true, synced_at: '2026-07-04T00:00:00Z', sync_count: 0
      }
    ]);
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-03', 99999]]),
      activity: mockActivity(), now: NOW
    });
    const d = store.StepRecord.find((r) => r.date === '2026-07-03');
    expect(d.steps).toBe(7000); // 未被覆盖
    expect(d.locked).toBe(true);
  });
});

describe('syncSteps 写回标记（P0：_dirty 驱动 handler 落库）', () => {
  const NOW = new Date('2026-07-05T04:00:00Z'); // 北京 07-05 12:00

  it('改动 record 打 _dirty；新建带 _isNew', async () => {
    const store = makeStore();
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-03', 8000]]), // 新建历史日
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord[0]._dirty).toBe(true);
    expect(store.StepRecord[0]._isNew).toBe(true);
  });

  it('未改动的 record 不打 _dirty（已锁 continue；模拟 loadCollection 拉回的干净 record）', async () => {
    const store = makeStore([
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-07-03', steps: 7000, abnormal: false,
        locked: true, synced_at: '2026-07-04T00:00:00Z', sync_count: 0
        // 不带 _dirty（loadCollection 拉回的既有 record）
      }
    ]);
    await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-03', 99999]]), // 已锁 → continue 不改
      activity: mockActivity(), now: NOW
    });
    expect(store.StepRecord[0]._dirty).toBeUndefined();
  });
});

describe('activityStartDate 活动期起点', () => {
  it('正常 start_time → 北京时间 YYYY-MM-DD', () => {
    expect(activityStartDate({ start_time: '2026-07-01T00:00:00+08:00' }, 480)).toBe('2026-07-01');
  });
  it('缺 activity → ""（调用方据此跳过过滤）', () => {
    expect(activityStartDate(null, 480)).toBe('');
  });
  it('缺 start_time → ""', () => {
    expect(activityStartDate({}, 480)).toBe('');
  });
  it('start_time 无效 → ""', () => {
    expect(activityStartDate({ start_time: 'not-a-date' }, 480)).toBe('');
  });
});

describe('syncSteps 累计仅算活动期内（过滤活动期外脏记录）', () => {
  const NOW = new Date('2026-07-02T04:00:00Z'); // 北京 07-02 12:00（活动 07-01 开始）

  it('store 含 date<start_date 的脏 locked 记录 → total/history 不含', async () => {
    // 早期 bug 回灌的 06-29/06-30（活动期外，locked=true）残留入库。
    const store = makeStore([
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-06-29', steps: 99999, abnormal: false,
        locked: true, synced_at: '2026-06-29T00:00:00Z', sync_count: 0
      },
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-06-30', steps: 88888, abnormal: false,
        locked: true, synced_at: '2026-06-30T00:00:00Z', sync_count: 0
      }
    ]);
    const out = await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-02', 9000]]),
      activity: mockActivity(), now: NOW
    });
    expect(out.total).toBe(9000); // 脏记录被过滤，仅活动期内 07-02
    expect(out.history.map((r) => r.date)).toEqual(['2026-07-02']);
  });

  it('不传 activity（兜底）→ total 含全部记录（不强加过滤）', async () => {
    const store = makeStore([
      {
        user_id: USER_ID, _openid: OPENID, activity_id: ACTIVITY_ID,
        date: '2026-06-29', steps: 1000, abnormal: false,
        locked: true, synced_at: '2026-06-29T00:00:00Z', sync_count: 0
      }
    ]);
    const out = await syncSteps({
      store, openid: OPENID, userId: USER_ID, activityId: ACTIVITY_ID,
      stepInfoList: stepList([['2026-07-02', 9000]]),
      activity: undefined, now: NOW
    });
    expect(out.total).toBe(1000 + 9000); // 兜底：活动期外记录照算
  });
});
