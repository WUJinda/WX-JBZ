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
const { getActivityById } = require('../../cloudfunctions/activity/activityResolver');

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
