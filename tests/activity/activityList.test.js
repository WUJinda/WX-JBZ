/**
 * activity.list 纯函数单测（PRD F8 后台活动管理）：
 *   - 正常：空库 / 单活动 / 多活动排序（active→pending→ended）；
 *   - terminated 归 ended 且保留 terminated:true；
 *   - now 注入控制状态推算；
 *   - 同档按 start_time 降序；
 *   - 投影白名单（不下发 _id/created_at 等服务端字段）、activity_id 兜底 _id；
 *   - store 缺失 → SYS_DB_ERROR；
 *   - 纯函数：不 require wx-server-sdk / 不调 cloud / 复用 deriveStatus。
 */
const fs = require('fs');
const path = require('path');

const { listActivities, projectListActivity, RANK_WEIGHT } = require('../../cloudfunctions/activity/activityList');
const { CODE } = require('../../cloudfunctions/common/errors');
const { STATUS } = require('../../cloudfunctions/activity/activityStatus');

function makeStore(activities) {
  return { Activity: activities || [] };
}

// 活动窗口：2026-07-01 ~ 2026-07-21（与 activityStatus/save 测试对齐）
const START = '2026-07-01T00:00:00+08:00';
const END = '2026-07-21T23:59:59+08:00';
// now 锚点：活动期前 / 期中 / 期后
const BEFORE = new Date('2026-06-20T00:00:00Z');
const WITHIN = new Date('2026-07-10T00:00:00Z');
const AFTER = new Date('2026-08-10T00:00:00Z');

describe('listActivities（空库 / store 校验）', () => {
  it('空库 → { list: [] }', () => {
    const out = listActivities(makeStore([]));
    expect(out).toEqual({ list: [] });
  });

  it('store.Activity 缺失 → SYS_DB_ERROR', () => {
    let err;
    try {
      listActivities({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('store 为 undefined → SYS_DB_ERROR', () => {
    let err;
    try {
      listActivities(undefined);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });
});

describe('listActivities（状态推算 + 投影）', () => {
  it('单活动 now<start → status=pending，投影仅含白名单字段', () => {
    const store = makeStore([
      {
        activity_id: 'a_1',
        name: '健步走',
        start_time: START,
        end_time: END,
        signup_deadline: '2026-06-30T23:59:59+08:00',
        rules: '规则',
        terminated: false,
        // 服务端字段：投影不应下发
        _id: 'doc_1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z'
      }
    ]);
    const out = listActivities(store, { now: BEFORE });
    expect(out.list.length).toBe(1);
    expect(out.list[0]).toEqual({
      activity_id: 'a_1',
      name: '健步走',
      start_time: START,
      end_time: END,
      signup_deadline: '2026-06-30T23:59:59+08:00',
      status: STATUS.PENDING,
      terminated: false
    });
  });

  it('now 注入：同活动期前/期中/期后 → pending/active/ended', () => {
    const store = makeStore([{ activity_id: 'a_1', name: 'x', start_time: START, end_time: END }]);
    expect(listActivities(store, { now: BEFORE }).list[0].status).toBe(STATUS.PENDING);
    expect(listActivities(store, { now: WITHIN }).list[0].status).toBe(STATUS.ACTIVE);
    expect(listActivities(store, { now: AFTER }).list[0].status).toBe(STATUS.ENDED);
  });

  it('terminated=true 即使在活动期内 → status=ended 且 terminated 保留', () => {
    const store = makeStore([
      { activity_id: 'a_1', name: 'x', start_time: START, end_time: END, terminated: true }
    ]);
    const out = listActivities(store, { now: WITHIN });
    expect(out.list[0].status).toBe(STATUS.ENDED);
    expect(out.list[0].terminated).toBe(true);
  });
});

describe('listActivities（多活动排序）', () => {
  it('active 排在 pending / ended 之前', () => {
    const store = makeStore([
      { activity_id: 'a_ended', name: '已结束', start_time: '2026-05-01T00:00:00+08:00', end_time: '2026-05-21T23:59:59+08:00' },
      { activity_id: 'a_active', name: '进行中', start_time: START, end_time: END },
      { activity_id: 'a_pending', name: '未开始', start_time: '2026-08-01T00:00:00+08:00', end_time: '2026-08-21T23:59:59+08:00' }
    ]);
    const out = listActivities(store, { now: WITHIN });
    expect(out.list.map((x) => x.activity_id)).toEqual(['a_active', 'a_pending', 'a_ended']);
  });

  it('同档（都 active）按 start_time 降序：更晚开始的靠前', () => {
    const store = makeStore([
      { activity_id: 'a_early', name: '早开始', start_time: '2026-07-01T00:00:00+08:00', end_time: '2026-07-21T23:59:59+08:00' },
      { activity_id: 'a_late', name: '晚开始', start_time: '2026-07-05T00:00:00+08:00', end_time: '2026-07-25T23:59:59+08:00' }
    ]);
    const out = listActivities(store, { now: new Date('2026-07-10T00:00:00Z') });
    // 两者均在 07-10 处于 active；start 晚的(a_late 07-05) 排前
    expect(out.list[0].status).toBe(STATUS.ACTIVE);
    expect(out.list.map((x) => x.activity_id)).toEqual(['a_late', 'a_early']);
  });

  it('terminated 活动归入 ended 档，与自然 ended 同档按 start_time 降序', () => {
    const store = makeStore([
      { activity_id: 'a_term', name: '已终止', start_time: START, end_time: END, terminated: true },
      { activity_id: 'a_natural', name: '自然结束', start_time: '2026-05-01T00:00:00+08:00', end_time: '2026-05-21T23:59:59+08:00' }
    ]);
    const out = listActivities(store, { now: WITHIN });
    // 都归 ended 档；a_term 的 start(07-01) 晚于 a_natural(05-01) → a_term 靠前
    expect(out.list.map((x) => x.activity_id)).toEqual(['a_term', 'a_natural']);
    expect(out.list[0].terminated).toBe(true);
    expect(out.list[1].terminated).toBe(false);
  });
});

describe('listActivities（投影兜底）', () => {
  it('文档无 activity_id → 兜底用 _id', () => {
    const store = makeStore([{ _id: 'doc_only', name: 'x', start_time: START, end_time: END }]);
    const out = listActivities(store, { now: WITHIN });
    expect(out.list[0].activity_id).toBe('doc_only');
  });

  it('signup_deadline 缺失 → 投影为 null', () => {
    const store = makeStore([{ activity_id: 'a_1', name: 'x', start_time: START, end_time: END }]);
    const out = listActivities(store, { now: WITHIN });
    expect(out.list[0].signup_deadline).toBeNull();
  });

  it('过滤掉非对象脏数据（null / 基本类型不入列表）', () => {
    const store = makeStore([
      null,
      { activity_id: 'a_1', name: 'x', start_time: START, end_time: END },
      'junk',
      undefined
    ]);
    const out = listActivities(store, { now: WITHIN });
    expect(out.list.length).toBe(1);
    expect(out.list[0].activity_id).toBe('a_1');
  });
});

describe('projectListActivity（投影白名单，不下发服务端字段）', () => {
  it('返回对象仅含白名单字段', () => {
    const out = projectListActivity(
      {
        activity_id: 'a_1',
        name: '活动',
        start_time: START,
        end_time: END,
        signup_deadline: '2026-06-30T23:59:59+08:00',
        terminated: false,
        _id: 'doc_1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        status: 'stale', // 库内冗余，投影应被传入的 status 覆盖
        rules: 'r'
      },
      STATUS.ACTIVE
    );
    expect(out).toEqual({
      activity_id: 'a_1',
      name: '活动',
      start_time: START,
      end_time: END,
      signup_deadline: '2026-06-30T23:59:59+08:00',
      status: STATUS.ACTIVE,
      terminated: false
    });
  });
});

describe('listActivities（纯函数 / 红线 grep）', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../../cloudfunctions/activity/activityList.js'),
    'utf-8'
  );

  it('activityList.js 不 require wx-server-sdk', () => {
    expect(SRC).not.toMatch(/require\(['"]wx-server-sdk['"]\)/);
  });

  it('activityList.js 不调 cloud.database() / cloud.callFunction', () => {
    expect(SRC).not.toMatch(/cloud\.database\(\)/);
    expect(SRC).not.toMatch(/cloud\.callFunction/);
  });

  it('activityList.js 复用 activityStatus（deriveStatus / STATUS / _toTs）', () => {
    expect(SRC).toMatch(/require\(['"]\.\/activityStatus['"]\)/);
    expect(SRC).toMatch(/deriveStatus/);
  });

  it('listActivities 是同步纯函数（返回值非 Promise）', () => {
    const out = listActivities(makeStore([]));
    expect(typeof out).toBe('object');
    expect(typeof out.then).toBe('undefined');
  });

  it('RANK_WEIGHT：active < pending < ended（档位权重单调）', () => {
    expect(RANK_WEIGHT[STATUS.ACTIVE]).toBeLessThan(RANK_WEIGHT[STATUS.PENDING]);
    expect(RANK_WEIGHT[STATUS.PENDING]).toBeLessThan(RANK_WEIGHT[STATUS.ENDED]);
  });
});
