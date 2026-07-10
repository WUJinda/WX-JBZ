/**
 * activity.delete 纯函数单测（管理员硬删除活动 + 连带清理该活动的步数/榜单/部门）。
 *   - 正常：返回被删活动投影（含 activity_id 供云轨批量 remove）；
 *   - 校验：缺 activity_id / 活动不存在 / store 缺失；
 *   - activity_id 自动 trim；
 *   - 状态守卫（决策1）：仅 ended/terminated 可删，active/pending 拒绝。
 *
 * 注：纯函数只做校验 + 返回定位信息；实际批量删除（where().remove 4 集合）在云轨
 *   deleteActivityToCloud，不经单测（与 terminate 的 upsert 写回同口径）。
 */
const { deleteActivity, projectDeletedActivity } = require('../../cloudfunctions/activity/activityDelete');
const { CODE } = require('../../cloudfunctions/common/errors');

function makeStore(activities) {
  return { Activity: activities || [] };
}

const START = '2026-07-01T00:00:00+08:00';
const END = '2026-07-21T23:59:59+08:00';

describe('deleteActivity（硬删除）', () => {
  it('正常：已结束活动（now>end → ended）返回被删活动投影', () => {
    const activity = {
      activity_id: 'a_1', name: '走起', start_time: START, end_time: END, rules: '规则'
    };
    const out = deleteActivity(makeStore([activity]), { activity_id: 'a_1', now: '2026-08-10T00:00:00Z' });
    expect(out.activity_id).toBe('a_1');
    expect(out.name).toBe('走起');
    expect(out.start_time).toBe(START);
    expect(out.end_time).toBe(END);
  });

  it('activity_id 自动 trim（前后空格）', () => {
    const activity = { activity_id: 'a_1', name: '走起', terminated: true };
    const out = deleteActivity(makeStore([activity]), { activity_id: '  a_1  ' });
    expect(out.activity_id).toBe('a_1');
  });

  it('缺 activity_id（空串）→ BIZ_PARAM_MISSING', () => {
    const store = makeStore([{ activity_id: 'a_1' }]);
    let err;
    try {
      deleteActivity(store, { activity_id: '' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('缺 activity_id（params 空）→ BIZ_PARAM_MISSING', () => {
    const store = makeStore([{ activity_id: 'a_1' }]);
    let err;
    try {
      deleteActivity(store, {});
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('活动不存在 → BIZ_PARAM_MISSING', () => {
    const store = makeStore([{ activity_id: 'a_1' }]);
    let err;
    try {
      deleteActivity(store, { activity_id: 'a_nope' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('store.Activity 缺失 → SYS_DB_ERROR', () => {
    let err;
    try {
      deleteActivity({}, { activity_id: 'a_1' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('纯函数不就地改 store（删除实由云轨 remove，纯函数只校验+返回定位）', () => {
    const activity = { activity_id: 'a_1', name: '走起', terminated: true };
    const store = makeStore([activity]);
    deleteActivity(store, { activity_id: 'a_1' });
    // store.Activity 不变（区别于 terminate 就地改 terminated）。
    expect(store.Activity.length).toBe(1);
    expect(store.Activity[0]).toBe(activity);
  });
});

describe('deleteActivity 状态守卫（决策1：仅 ended/terminated 可删）', () => {
  it('进行中 active 活动（start≤now≤end）→ BIZ_ACTIVITY_NOT_REMOVABLE', () => {
    const activity = { activity_id: 'a_1', name: '走', start_time: START, end_time: END };
    let err;
    try {
      deleteActivity(makeStore([activity]), { activity_id: 'a_1', now: '2026-07-10T00:00:00Z' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_ACTIVITY_NOT_REMOVABLE);
  });

  it('未开始 pending 活动（now<start）→ BIZ_ACTIVITY_NOT_REMOVABLE', () => {
    const activity = { activity_id: 'a_1', name: '走', start_time: START, end_time: END };
    let err;
    try {
      deleteActivity(makeStore([activity]), { activity_id: 'a_1', now: '2026-06-10T00:00:00Z' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_ACTIVITY_NOT_REMOVABLE);
  });

  it('已结束 ended 活动（now>end）→ 可删', () => {
    const activity = { activity_id: 'a_1', name: '走', start_time: START, end_time: END };
    const out = deleteActivity(makeStore([activity]), { activity_id: 'a_1', now: '2026-08-10T00:00:00Z' });
    expect(out.activity_id).toBe('a_1');
  });

  it('已终止 terminated 活动 → 可删（即使时间窗仍在 active 期）', () => {
    const activity = { activity_id: 'a_1', name: '走', start_time: START, end_time: END, terminated: true };
    const out = deleteActivity(makeStore([activity]), { activity_id: 'a_1', now: '2026-07-10T00:00:00Z' });
    expect(out.activity_id).toBe('a_1');
  });
});

describe('projectDeletedActivity 投影', () => {
  it('字段缺失兜底（name/start_time/end_time 空值不抛）', () => {
    const out = projectDeletedActivity({ activity_id: 'a_1' });
    expect(out.activity_id).toBe('a_1');
    expect(out.name).toBe('');
    expect(out.start_time).toBeUndefined();
    expect(out.end_time).toBeUndefined();
  });
});
