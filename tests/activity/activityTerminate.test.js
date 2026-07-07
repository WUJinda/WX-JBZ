/**
 * activity.terminate 纯函数单测（活动配置完善：管理员手动终止活动，不可恢复）。
 *   - 正常终止：置 terminated/terminated_at/status=ended，就地落库；
 *   - 幂等：已终止再次调用不报错，保留首次 terminated_at；
 *   - 校验：缺 activity_id / 活动不存在 / store 缺失。
 */
const { terminateActivity } = require('../../cloudfunctions/activity/activityTerminate');
const { CODE } = require('../../cloudfunctions/common/errors');
const { STATUS } = require('../../cloudfunctions/activity/activityStatus');

function makeStore(activities) {
  return { Activity: activities || [] };
}

const START = '2026-07-01T00:00:00+08:00';
const END = '2026-07-21T23:59:59+08:00';

describe('terminateActivity（手动终止）', () => {
  it('正常终止：置 terminated/terminated_at/status=ended，就地落库', () => {
    const activity = {
      activity_id: 'a_1', name: '走起', start_time: START, end_time: END,
      status: STATUS.ACTIVE, terminated: false
    };
    const store = makeStore([activity]);
    const out = terminateActivity(store, { activity_id: 'a_1', now: '2026-07-10T00:00:00Z' });
    expect(out.terminated).toBe(true);
    expect(out.status).toBe(STATUS.ENDED);
    expect(out.terminated_at).toBe('2026-07-10T00:00:00.000Z');
    // 就地落库
    expect(activity.terminated).toBe(true);
    expect(activity.status).toBe(STATUS.ENDED);
    expect(activity.terminated_at).toBe('2026-07-10T00:00:00.000Z');
    expect(activity.updated_at).toBe('2026-07-10T00:00:00.000Z');
  });

  it('幂等：已终止再次调用不报错，保留首次 terminated_at', () => {
    const activity = {
      activity_id: 'a_1', name: '走起', start_time: START, end_time: END,
      status: STATUS.ENDED, terminated: true, terminated_at: '2026-07-09T00:00:00Z'
    };
    const store = makeStore([activity]);
    const out = terminateActivity(store, { activity_id: 'a_1', now: '2026-07-10T00:00:00Z' });
    expect(out.terminated).toBe(true);
    // 首次终止时间保留，不被新 now 覆盖
    expect(out.terminated_at).toBe('2026-07-09T00:00:00Z');
  });

  it('缺 activity_id → BIZ_PARAM_MISSING', () => {
    const store = makeStore([{ activity_id: 'a_1' }]);
    let err;
    try {
      terminateActivity(store, { activity_id: '', now: '2026-07-10T00:00:00Z' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('活动不存在 → BIZ_PARAM_MISSING', () => {
    const store = makeStore([{ activity_id: 'a_1' }]);
    let err;
    try {
      terminateActivity(store, { activity_id: 'a_nope', now: '2026-07-10T00:00:00Z' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('store.Activity 缺失 → SYS_DB_ERROR', () => {
    let err;
    try {
      terminateActivity({}, { activity_id: 'a_1', now: '2026-07-10T00:00:00Z' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('投影含 signup_deadline（终止保留原截止信息）', () => {
    const activity = {
      activity_id: 'a_1', name: '走起', start_time: START, end_time: END,
      signup_deadline: '2026-06-30T23:59:59+08:00', status: STATUS.ACTIVE
    };
    const out = terminateActivity(makeStore([activity]), { activity_id: 'a_1', now: '2026-07-10T00:00:00Z' });
    expect(out.signup_deadline).toBe('2026-06-30T23:59:59+08:00');
  });
});
