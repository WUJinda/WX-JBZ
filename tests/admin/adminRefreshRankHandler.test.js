/**
 * admin.refreshRank 云轨粘合函数单测（handleRefreshRank）。
 *
 * 测 handleRefreshRank（独立模块，不 require wx-server-sdk，注入 mock cloud）：
 *   1. 显式 activity_id：callFunction 入参为 tasks.rankAggregate + 透传 activity_id，返回摘要；
 *   2. activity_id 缺省：走 getActiveActivityId 兜底（mock Activity 集合）；
 *   3. tasks 返回 code!==0 → 抛 SYS_DB_ERROR（P1-3 不假成功）；
 *   4. tasks 返回 data 缺 personal/dept → count 0（防御）。
 *
 * 守卫（assertAdmin）在 admin/index.js refreshRank handler 入口完成（与 dashboard 等同范式：
 * index.js 守卫 + 调粘合函数），其纯函数逻辑由 adminGuard.test 覆盖，本文件不重复测。
 *
 * mock cloud：database() 用 createMockDb（getActiveActivityId 兜底时查 Activity）；
 *             callFunction mock tasks.rankAggregate 返回。
 */

const { handleRefreshRank } = require('../../cloudfunctions/admin/refreshRank');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

/**
 * 构造 mock cloud：database() 返回 createMockDb 产的 db；callFunction 可自定义。
 */
function createMockCloud(opts) {
  const { db } = createMockDb(opts.initialStore || {});
  return {
    database: () => db,
    callFunction:
      opts.callFunction ||
      vi.fn().mockResolvedValue({
        result: { code: 0, data: { personal: [], dept: [], updatedAt: 't' } }
      })
  };
}

describe('admin.refreshRank 云轨粘合（handleRefreshRank）', () => {
  it('显式 activity_id：callFunction 入参 tasks.rankAggregate + 透传，返回摘要', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        code: 0,
        data: {
          personal: [
            { rank: 1, user_id: 'u1', total_steps: 1000 },
            { rank: 2, user_id: 'u2', total_steps: 800 }
          ],
          dept: [{ rank: 1, dept_id: 'd1', total_steps: 1800, member_count: 2 }],
          updatedAt: '2026-07-08T04:00:00.000Z'
        }
      }
    });
    const cloud = createMockCloud({ callFunction });
    const out = await handleRefreshRank({ cloud, event: { activity_id: 'a_demo_001' } });
    expect(callFunction).toHaveBeenCalledWith({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: 'a_demo_001' }
    });
    expect(out).toEqual({
      activity_id: 'a_demo_001',
      personal_count: 2,
      dept_count: 1,
      updated_at: '2026-07-08T04:00:00.000Z'
    });
  });

  it('activity_id 缺省：走 getActiveActivityId 兜底（mock Activity 集合取当前活动）', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        code: 0,
        data: { personal: [{ rank: 1, user_id: 'u1' }], dept: [], updatedAt: 't2' }
      }
    });
    const cloud = createMockCloud({
      initialStore: {
        Activity: [
          {
            activity_id: 'a_active',
            start_time: '2026-07-01T00:00:00Z',
            end_time: '2026-07-31T00:00:00Z'
          }
        ]
      },
      callFunction
    });
    const out = await handleRefreshRank({ cloud, event: {} });
    expect(callFunction).toHaveBeenCalledWith({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: 'a_active' }
    });
    expect(out.activity_id).toBe('a_active');
    expect(out.personal_count).toBe(1);
    expect(out.dept_count).toBe(0);
  });

  it('tasks 返回 code!==0 → 抛 SYS_DB_ERROR（P1-3 不假成功）', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { code: 5000, message: 'tasks 聚合异常' }
    });
    const cloud = createMockCloud({ callFunction });
    await expect(handleRefreshRank({ cloud, event: { activity_id: 'a1' } })).rejects.toMatchObject({
      code: CODE.SYS_DB_ERROR
    });
  });

  it('tasks 返回 data 缺 personal/dept → count 0（防御）', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { code: 0, data: {} }
    });
    const cloud = createMockCloud({ callFunction });
    const out = await handleRefreshRank({ cloud, event: { activity_id: 'a1' } });
    expect(out.personal_count).toBe(0);
    expect(out.dept_count).toBe(0);
    expect(out.updated_at).toBe(null);
  });
});
