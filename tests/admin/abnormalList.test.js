/**
 * admin.queryAbnormal 单测（H1）：
 *   - 过滤 abnormal===true + activity_id；按 synced_at 降序；本地分页。
 *   - 红线：projectAbnormal 绝不下发 _openid / sync_count。
 */
const { queryAbnormal, projectAbnormal, DEFAULT_PAGE_SIZE } = require('../../cloudfunctions/admin/abnormalList');

const ACT = 'a1';

function rec(_id, extra) {
  return Object.assign(
    {
      _id,
      user_id: 'u_' + _id,
      _openid: 'secret_' + _id,
      sync_count: 5,
      activity_id: ACT,
      date: '2026-06-01',
      steps: 60000,
      abnormal: true,
      locked: false,
      synced_at: '2026-06-01T00:00:00.000Z'
    },
    extra || {}
  );
}

describe('queryAbnormal（异常步数列表过滤+排序+分页）', () => {
  it('仅返回 abnormal===true 的记录', () => {
    const store = {
      StepRecord: [
        rec('r1', { abnormal: true }),
        rec('r2', { abnormal: false }),
        rec('r3', { abnormal: true })
      ]
    };
    const r = queryAbnormal(store, { activityId: ACT });
    expect(r.totalCount).toBe(2);
    expect(r.list.map((x) => x._id).sort()).toEqual(['r1', 'r3']);
  });

  it('按 activity_id 过滤（跨活动不混入）', () => {
    const store = {
      StepRecord: [rec('r1', { abnormal: true }), rec('r2', { abnormal: true, activity_id: 'other' })]
    };
    const r = queryAbnormal(store, { activityId: ACT });
    expect(r.totalCount).toBe(1);
    expect(r.list[0]._id).toBe('r1');
  });

  it('按 synced_at 降序（最新异常在前）', () => {
    const store = {
      StepRecord: [
        rec('r1', { synced_at: '2026-06-01T00:00:00.000Z' }),
        rec('r2', { synced_at: '2026-06-03T00:00:00.000Z' }),
        rec('r3', { synced_at: '2026-06-02T00:00:00.000Z' })
      ]
    };
    const r = queryAbnormal(store, { activityId: ACT });
    expect(r.list.map((x) => x._id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('本地分页', () => {
    const recs = [];
    for (let i = 0; i < 5; i++) recs.push(rec('r' + i, { synced_at: '2026-06-0' + (i + 1) }));
    const store = { StepRecord: recs };
    const r = queryAbnormal(store, { activityId: ACT, page: 1, pageSize: 2 });
    expect(r.totalCount).toBe(5);
    expect(r.list).toHaveLength(2);
    const r2 = queryAbnormal(store, { activityId: ACT, page: 3, pageSize: 2 });
    expect(r2.list).toHaveLength(1);
  });

  it('DEFAULT_PAGE_SIZE=50', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });
});

describe('projectAbnormal 投影红线（绝不下发 _openid / sync_count）', () => {
  it('projectAbnormal 输出对象不含 _openid / sync_count', () => {
    const r = rec('r1', { _openid: 'secret', sync_count: 9 });
    const out = projectAbnormal(r);
    expect(out._openid).toBeUndefined();
    expect(out.sync_count).toBeUndefined();
    // 白名单字段在
    expect(out.user_id).toBe('u_r1');
    expect(out.date).toBe('2026-06-01');
    expect(out.steps).toBe(60000);
    expect(out.abnormal).toBe(true);
    expect(out.locked).toBe(false);
    expect(out.synced_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('queryAbnormal 返回列表中每一项都不含 _openid / sync_count', () => {
    const store = { StepRecord: [rec('r1'), rec('r2')] };
    const r = queryAbnormal(store, { activityId: ACT });
    for (const item of r.list) {
      expect(item._openid).toBeUndefined();
      expect(item.sync_count).toBeUndefined();
    }
  });
});
