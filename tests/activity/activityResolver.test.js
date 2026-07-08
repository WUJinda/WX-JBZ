/**
 * activityResolver.getActivityById 单测：按 activity_id 精确查活动文档。
 *
 * 这是「累计步数过大」bug 修复的核心——steps.sync handler 改用本函数查活动文档传给 syncSteps，
 * 活动期过滤才生效。注入 mock cloud（链式 database().collection()[.where][.field].skip().limit().get()），
 * 不 require wx-server-sdk。
 *
 * 覆盖：命中 activity_id / _id 兜底（旧数据）/ 空 id 不查库 / 库空 / 多活动精确命中 / 未命中。
 *
 * vitest globals:true —— describe/it/expect/vi 全局可用，无需 import。
 */
const { getActivityById, getActiveActivity, getActiveActivityId } = require('../../cloudfunctions/activity/activityResolver');

/**
 * 构造 mock cloud：模拟 loadByWhere 的链式调用。
 * @param {object[]} rows Activity 文档列表（get 一次性返回；单页 < 100 即终止分页）
 */
function mockCloud(rows) {
  const get = async () => ({ data: rows });
  const terminal = { get };
  const chain = {
    where: () => chain,
    field: () => chain,
    skip: () => chain,
    limit: () => terminal
  };
  return { database: () => ({ collection: () => chain }) };
}

describe('activityResolver.getActivityById：按 activity_id 精确查活动文档', () => {
  it('命中 activity_id → 返回该文档', async () => {
    const doc = { activity_id: 'a1', name: '健步走', start_time: '2026-07-01T00:00:00+08:00' };
    const cloud = mockCloud([doc]);
    const out = await getActivityById(cloud, 'a1');
    expect(out).toBe(doc);
  });

  it('activity_id 未命中但 _id 匹配（旧数据兜底）→ 返回该文档', async () => {
    const doc = { _id: 'a1', name: '旧活动', start_time: '2026-07-01T00:00:00+08:00' };
    const cloud = mockCloud([doc]);
    const out = await getActivityById(cloud, 'a1');
    expect(out).toBe(doc);
  });

  it('空 activityId → null（不查库）', async () => {
    const cloud = mockCloud([{ activity_id: 'a1' }]);
    const out = await getActivityById(cloud, '');
    expect(out).toBeNull();
  });

  it('库空 → null', async () => {
    const cloud = mockCloud([]);
    const out = await getActivityById(cloud, 'a1');
    expect(out).toBeNull();
  });

  it('多活动中精确命中目标 activity_id', async () => {
    const a1 = { activity_id: 'a1', start_time: '2026-07-01T00:00:00+08:00' };
    const a2 = { activity_id: 'a2', start_time: '2026-08-01T00:00:00+08:00' };
    const cloud = mockCloud([a1, a2]);
    const out = await getActivityById(cloud, 'a2');
    expect(out).toBe(a2);
  });

  it('未命中任何活动 → null', async () => {
    const cloud = mockCloud([{ activity_id: 'a1' }]);
    const out = await getActivityById(cloud, 'not-exist');
    expect(out).toBeNull();
  });
});

describe('activityResolver.getActiveActivity / getActiveActivityId：选当前活动（非终止优先，全终止回退最近终止）', () => {
  // 时间窗：ACTIVE 在期中 / ENDED 已结束；now 锚 07-10（active 期中）
  const ACTIVE = { activity_id: 'a_active', name: '进行中', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z' };
  const ENDED = { activity_id: 'a_ended', name: '已结束', start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-21T23:59:59Z' };
  const now = '2026-07-10T00:00:00Z';

  it('active + ended 并存 → getActiveActivity 返回 active 文档', async () => {
    const cloud = mockCloud([ENDED, ACTIVE]); // 顺序打乱仍选 active
    expect(await getActiveActivity(cloud, now)).toBe(ACTIVE);
  });

  it('active + ended 并存 → getActiveActivityId 返回 active 的 activity_id', async () => {
    const cloud = mockCloud([ENDED, ACTIVE]);
    expect(await getActiveActivityId(cloud, now)).toBe('a_active');
  });

  it('唯一活动 terminated → getActiveActivity 回退该终止活动（员工端展示「已终止」）', async () => {
    const term = { activity_id: 'a_term', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true };
    const cloud = mockCloud([term]);
    expect(await getActiveActivity(cloud, now)).toBe(term);
  });

  it('唯一活动 terminated → getActiveActivityId 返回该终止活动 id', async () => {
    const term = { activity_id: 'a_term', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true };
    const cloud = mockCloud([term]);
    expect(await getActiveActivityId(cloud, now)).toBe('a_term');
  });

  it('全部 terminated → 回退最近终止活动（按 terminated_at 降序）', async () => {
    const t1 = { activity_id: 't1', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true, terminated_at: '2026-07-10T00:00:00Z' };
    const t2 = { activity_id: 't2', start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-21T23:59:59Z', terminated: true, terminated_at: '2026-07-15T00:00:00Z' };
    const cloud = mockCloud([t1, t2]);
    expect(await getActiveActivity(cloud, now)).toBe(t2);
    expect(await getActiveActivityId(cloud, now)).toBe('t2');
  });

  it('terminated 与 active 并存 → 跳过 terminated 选 active', async () => {
    const term = { activity_id: 'a_term', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z', terminated: true };
    const cloud = mockCloud([term, ACTIVE]);
    expect(await getActiveActivity(cloud, now)).toBe(ACTIVE);
    expect(await getActiveActivityId(cloud, now)).toBe('a_active');
  });

  it('库空 → null / 空串', async () => {
    const cloud = mockCloud([]);
    expect(await getActiveActivity(cloud, now)).toBeNull();
    expect(await getActiveActivityId(cloud, now)).toBe('');
  });

  it('文档无 activity_id 时 getActiveActivityId 兜底 _id', async () => {
    const only = { _id: 'doc_active', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-21T23:59:59Z' };
    const cloud = mockCloud([only]);
    expect(await getActiveActivityId(cloud, now)).toBe('doc_active');
  });
});
