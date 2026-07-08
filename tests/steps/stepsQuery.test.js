/**
 * steps.today / steps.history 聚合纯函数单测（E3）。
 * 有效步数（活动期内已同步即有效，不依赖 locked）参与累计/历史返回。
 */
const { getToday, getHistory } = require('../../cloudfunctions/steps/stepsQuery');
const { CODE } = require('../../cloudfunctions/common/errors');

const USER_ID = 'u_1';
const ACTIVITY_ID = 'a_demo_001';

function rec(overrides) {
  return Object.assign(
    {
      user_id: USER_ID, _openid: 'oU', activity_id: ACTIVITY_ID,
      date: '2026-07-01', steps: 8000, abnormal: false,
      locked: false, synced_at: '2026-07-01T10:00:00Z', sync_count: 1
    },
    overrides || {}
  );
}

const NOW = new Date('2026-07-03T04:00:00Z'); // 北京时间 07-03 12:00

describe('getToday 今日步数（E3）', () => {
  it('返回当日已入库步数 + 累计（活动期内已同步即有效）', async () => {
    const store = {
      StepRecord: [
        rec({ date: '2026-07-01', steps: 8000, locked: true }),
        rec({ date: '2026-07-02', steps: 9000, locked: false }), // 活动期内已同步 → 有效（新口径）
        rec({ date: '2026-07-03', steps: 7000, locked: false }) // 今日
      ]
    };
    const out = await getToday({ store, userId: USER_ID, activityId: ACTIVITY_ID, now: NOW });
    expect(out.date).toBe('2026-07-03');
    expect(out.steps).toBe(7000);
    expect(out.total).toBe(8000 + 9000 + 7000); // 三条全有效
  });

  it('无当日记录 → steps=0', async () => {
    const store = {
      StepRecord: [rec({ date: '2026-07-01', steps: 8000, locked: true })]
    };
    const out = await getToday({ store, userId: USER_ID, activityId: ACTIVITY_ID, now: NOW });
    expect(out.steps).toBe(0);
    expect(out.total).toBe(8000); // 仅 locked
  });

  it('缺 userId → AUTH_USER_NOT_FOUND', async () => {
    await expect(
      getToday({ store: { StepRecord: [] }, activityId: ACTIVITY_ID, now: NOW })
    ).rejects.toMatchObject({ code: CODE.AUTH_USER_NOT_FOUND });
  });
});

describe('getHistory 区间查询（E3，仅 locked/今日有效）', () => {
  it('返回区间内有效步数 + total', async () => {
    const store = {
      StepRecord: [
        rec({ date: '2026-07-01', steps: 8000, locked: true }),
        rec({ date: '2026-07-02', steps: 9000, locked: false }), // 新口径有效
        rec({ date: '2026-07-03', steps: 7000, locked: false }) // 今日有效
      ]
    };
    const out = await getHistory({
      store, userId: USER_ID, activityId: ACTIVITY_ID,
      from: '2026-07-01', to: '2026-07-03', now: NOW
    });
    expect(out.list).toHaveLength(3); // 三条全有效
    expect(out.total).toBe(24000);
  });

  it('from/to 区间裁剪', async () => {
    const store = {
      StepRecord: [
        rec({ date: '2026-07-01', steps: 8000, locked: true }),
        rec({ date: '2026-07-02', steps: 9000, locked: true })
      ]
    };
    const out = await getHistory({
      store, userId: USER_ID, activityId: ACTIVITY_ID,
      from: '2026-07-02', to: '2026-07-02', now: NOW
    });
    expect(out.list).toHaveLength(1);
    expect(out.list[0].date).toBe('2026-07-02');
  });

  it('历史返回项不下发 _openid / sync_count', async () => {
    const store = {
      StepRecord: [rec({ date: '2026-07-01', steps: 8000, locked: true })]
    };
    const out = await getHistory({ store, userId: USER_ID, activityId: ACTIVITY_ID, now: NOW });
    expect(out.list[0]).not.toHaveProperty('_openid');
    expect(out.list[0]).not.toHaveProperty('sync_count');
  });

  it('缺 activityId → BIZ_PARAM_MISSING（参数缺失，非活动结束）', async () => {
    await expect(
      getHistory({ store: { StepRecord: [] }, userId: USER_ID, now: NOW })
    ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
  });
});

describe('getToday 缺参（E3，参数缺失错误码）', () => {
  it('缺 activityId → BIZ_PARAM_MISSING（today 路径，非 STEP_ACTIVITY_CLOSED）', async () => {
    await expect(
      getToday({ store: { StepRecord: [] }, userId: USER_ID, now: NOW })
    ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
  });

  it('缺 activityId 错误码 ≠ STEP_ACTIVITY_CLOSED（语义分离：参数缺失 vs 活动结束）', async () => {
    let err;
    try {
      await getHistory({ store: { StepRecord: [] }, userId: USER_ID, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err.code).not.toBe(CODE.STEP_ACTIVITY_CLOSED);
  });
});

describe('getToday/getHistory 累计仅算活动期内（过滤活动期外脏记录）', () => {
  const ACTIVITY = {
    activity_id: ACTIVITY_ID,
    start_time: '2026-07-01T00:00:00+08:00',
    end_time: '2026-07-21T23:59:59+08:00'
  };

  it('getToday.total 过滤 date<start_date 脏 locked 记录', async () => {
    const store = {
      StepRecord: [
        rec({ date: '2026-06-29', steps: 99999, locked: true }), // 脏（活动期外）
        rec({ date: '2026-07-01', steps: 8000, locked: true }),  // 活动期内
        rec({ date: '2026-07-03', steps: 7000, locked: false })  // 今日
      ]
    };
    const out = await getToday({
      store, userId: USER_ID, activityId: ACTIVITY_ID, activity: ACTIVITY, now: NOW
    });
    expect(out.total).toBe(8000 + 7000); // 脏 99999 被过滤
    expect(out.steps).toBe(7000);        // 今日步数不受影响
  });

  it('getHistory 过滤 date<start_date 脏 locked 记录', async () => {
    const store = {
      StepRecord: [
        rec({ date: '2026-06-29', steps: 99999, locked: true }),
        rec({ date: '2026-07-01', steps: 8000, locked: true }),
        rec({ date: '2026-07-03', steps: 7000, locked: false })
      ]
    };
    const out = await getHistory({
      store, userId: USER_ID, activityId: ACTIVITY_ID, activity: ACTIVITY,
      from: '2026-06-29', to: '2026-07-03', now: NOW
    });
    expect(out.list.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-03']);
    expect(out.total).toBe(8000 + 7000);
  });

  it('不传 activity（兜底）→ 脏记录照常计入', async () => {
    const store = {
      StepRecord: [
        rec({ date: '2026-06-29', steps: 99999, locked: true }),
        rec({ date: '2026-07-01', steps: 8000, locked: true })
      ]
    };
    const out = await getToday({ store, userId: USER_ID, activityId: ACTIVITY_ID, now: NOW });
    expect(out.total).toBe(99999 + 8000);
  });
});
