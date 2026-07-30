/**
 * admin.refreshRank 云轨粘合函数单测（handleRefreshRank）。
 *
 * 测 handleRefreshRank（独立模块，不 require wx-server-sdk，注入 mock cloud）：
 *   1. 有进行中活动 → callFunction 入参为 tasks.rankAggregate + 该 active 活动 id；
 *   2. 忽略前端传入的 activity_id（强制绑定进行中活动）；
 *   3. 无进行中活动（仅有 pending / ended）→ 抛 BIZ_PARAM_MISSING；
 *   4. tasks 返回 code!==0 → 抛 SYS_DB_ERROR（P1-3 不假成功）；
 *   5. tasks 返回 data 缺 personal/dept → count 0（防御）。
 *
 * 守卫（assertAdmin）在 admin/index.js refreshRank handler 入口完成（与 dashboard 等同范式：
 * index.js 守卫 + 调粘合函数），其纯函数逻辑由 adminGuard.test 覆盖，本文件不重复测。
 *
 * mock cloud：database() 用 createMockDb（findActiveActivity 查 Activity）；
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

/**
 * 造一个「进行中」活动文档（start 在过去，end 在未来）。
 */
function activeActivity(id) {
  return {
    activity_id: id,
    start_time: '2026-07-01T00:00:00Z',
    end_time: '2026-12-31T23:59:59Z'
  };
}

/**
 * 造一个「未开始」活动文档（start 在未来）。
 */
function pendingActivity(id) {
  return {
    activity_id: id,
    start_time: '2026-12-01T00:00:00Z',
    end_time: '2026-12-31T23:59:59Z'
  };
}

/**
 * 造一个「已结束」活动文档（end 在过去）。
 */
function endedActivity(id) {
  return {
    activity_id: id,
    start_time: '2026-06-01T00:00:00Z',
    end_time: '2026-06-30T23:59:59Z'
  };
}

describe('admin.refreshRank 云轨粘合（handleRefreshRank）', () => {
  it('有进行中活动 → 用该活动 id 调 tasks.rankAggregate，返回摘要', async () => {
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
    const cloud = createMockCloud({
      initialStore: { Activity: [activeActivity('a_active')] },
      callFunction
    });
    const out = await handleRefreshRank({ cloud, event: {} });
    expect(callFunction).toHaveBeenCalledWith({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: 'a_active' }
    });
    expect(out).toEqual({
      activity_id: 'a_active',
      personal_count: 2,
      dept_count: 1,
      updated_at: '2026-07-08T04:00:00.000Z'
    });
  });

  it('忽略前端传入的 activity_id，强制使用进行中活动', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { code: 0, data: { personal: [], dept: [], updatedAt: 't' } }
    });
    const cloud = createMockCloud({
      initialStore: {
        Activity: [
          activeActivity('a_active'),
          pendingActivity('a_pending')
        ]
      },
      callFunction
    });
    // 前端传了 pending 活动的 id，但后端应忽略它，用 active 活动
    const out = await handleRefreshRank({ cloud, event: { activity_id: 'a_pending' } });
    expect(callFunction).toHaveBeenCalledWith({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: 'a_active' }
    });
    expect(out.activity_id).toBe('a_active');
  });

  it('无进行中活动（仅有 pending 新活动）→ 抛 BIZ_PARAM_MISSING', async () => {
    const cloud = createMockCloud({
      initialStore: { Activity: [pendingActivity('a_pending')] }
    });
    await expect(handleRefreshRank({ cloud, event: {} })).rejects.toMatchObject({
      code: CODE.BIZ_PARAM_MISSING
    });
  });

  it('无进行中活动（仅有 ended 旧活动）→ 抛 BIZ_PARAM_MISSING', async () => {
    const cloud = createMockCloud({
      initialStore: { Activity: [endedActivity('a_ended')] }
    });
    await expect(handleRefreshRank({ cloud, event: {} })).rejects.toMatchObject({
      code: CODE.BIZ_PARAM_MISSING
    });
  });

  it('无进行中活动（pending + ended 混合）→ 抛 BIZ_PARAM_MISSING', async () => {
    const cloud = createMockCloud({
      initialStore: {
        Activity: [pendingActivity('a_pending'), endedActivity('a_ended')]
      }
    });
    await expect(handleRefreshRank({ cloud, event: {} })).rejects.toMatchObject({
      code: CODE.BIZ_PARAM_MISSING
    });
  });

  it('Activity 集合为空 → 抛 BIZ_PARAM_MISSING', async () => {
    const cloud = createMockCloud({ initialStore: {} });
    await expect(handleRefreshRank({ cloud, event: {} })).rejects.toMatchObject({
      code: CODE.BIZ_PARAM_MISSING
    });
  });

  it('tasks 返回 code!==0 → 抛 SYS_DB_ERROR（P1-3 不假成功）', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { code: 5000, message: 'tasks 聚合异常' }
    });
    const cloud = createMockCloud({
      initialStore: { Activity: [activeActivity('a_active')] },
      callFunction
    });
    await expect(handleRefreshRank({ cloud, event: {} })).rejects.toMatchObject({
      code: CODE.SYS_DB_ERROR
    });
  });

  it('tasks 返回 data 缺 personal/dept → count 0（防御）', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: { code: 0, data: {} }
    });
    const cloud = createMockCloud({
      initialStore: { Activity: [activeActivity('a_active')] },
      callFunction
    });
    const out = await handleRefreshRank({ cloud, event: {} });
    expect(out.personal_count).toBe(0);
    expect(out.dept_count).toBe(0);
    expect(out.updated_at).toBe(null);
  });
});
