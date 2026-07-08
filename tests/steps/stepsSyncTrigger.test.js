/**
 * stepsTriggerRank 单测：steps.sync 成功后触发 tasks.rankAggregate 的行为。
 *
 * 测 triggerRankAggregate（独立模块，不 require wx-server-sdk，注入 mock cloud）：
 *   1. 正常触发：callFunction 被调一次，入参 {name:'tasks', data:{action:'rankAggregate', activity_id}}
 *   2. 空 activityId 透传：不私自吞空值（交给 tasks handler getActiveActivityId 兜底）
 *   3. 失败容错：callFunction reject 时不 rethrow（返回的 promise resolves，sync 主路径不阻断）
 *
 * mock cloud 只需 callFunction（triggerRankAggregate 仅用此），无需 mockDb。
 * vitest globals:true —— describe/it/expect/vi 全局可用，无需 import（与现有测试同风格）。
 */

const { triggerRankAggregate, extractMyRank } = require('../../cloudfunctions/steps/stepsTriggerRank');

/**
 * 构造 mock cloud：仅含 callFunction。
 * @param {object} [opts]
 * @param {Function} [opts.callFunction] 自定义 callFunction mock（默认 resolve {result:{code:0}}）
 */
function mockCloud(opts) {
  opts = opts || {};
  return {
    callFunction:
      (opts && opts.callFunction) || vi.fn().mockResolvedValue({ result: { code: 0 } })
  };
}

describe('stepsTriggerRank: 同步后触发榜单聚合', () => {
  it('正常触发：callFunction 入参为 tasks.rankAggregate + 透传 activity_id', async () => {
    const cloud = mockCloud();
    await triggerRankAggregate(cloud, 'a_demo_001');
    expect(cloud.callFunction).toHaveBeenCalledTimes(1);
    expect(cloud.callFunction).toHaveBeenCalledWith({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: 'a_demo_001' }
    });
  });

  it('正常返回 tasks 结果 data（含 personal/dept），供 sync handler 取 my_rank', async () => {
    const rankData = {
      personal: [{ rank: 1, user_id: 'u1', total_steps: 1000 }],
      dept: [],
      updatedAt: '2026-07-03T04:00:00.000Z'
    };
    const cloud = mockCloud({
      callFunction: vi.fn().mockResolvedValue({ result: { code: 0, data: rankData } })
    });
    const out = await triggerRankAggregate(cloud, 'a_demo_001');
    expect(out).toEqual(rankData);
  });

  it('空 activityId 透传：不私自吞空值（交给 tasks 兜底）', async () => {
    const cloud = mockCloud();
    await triggerRankAggregate(cloud, '');
    expect(cloud.callFunction).toHaveBeenCalledTimes(1);
    expect(cloud.callFunction).toHaveBeenCalledWith({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: '' }
    });
  });

  it('失败容错：callFunction reject 时不 rethrow，sync 主路径不阻断', async () => {
    const cloud = mockCloud({
      callFunction: vi.fn().mockRejectedValue(new Error('tasks 未部署或超时'))
    });
    // 不应抛错（内部 catch）；失败返回 null（聚合结果缺，sync handler 据此 my_rank=null）。
    await expect(triggerRankAggregate(cloud, 'a_demo_001')).resolves.toBe(null);
    expect(cloud.callFunction).toHaveBeenCalledTimes(1);
  });
});

describe('extractMyRank: 从聚合结果取本人排名（sync 返回 my_rank 用）', () => {
  it('命中：返回本人 {rank, total_steps}', () => {
    const rankRes = {
      personal: [
        { rank: 1, user_id: 'u_other', total_steps: 9000 },
        { rank: 2, user_id: 'u_me', total_steps: 5000 }
      ],
      dept: [],
      updatedAt: 't'
    };
    expect(extractMyRank(rankRes, 'u_me')).toEqual({ rank: 2, total_steps: 5000 });
  });

  it('未进榜（聚合结果无本人）→ null', () => {
    const rankRes = { personal: [{ rank: 1, user_id: 'u_other', total_steps: 9000 }] };
    expect(extractMyRank(rankRes, 'u_me')).toBeNull();
  });

  it('rankRes 为 null（聚合失败/未聚合）→ null', () => {
    expect(extractMyRank(null, 'u_me')).toBeNull();
    expect(extractMyRank(undefined, 'u_me')).toBeNull();
  });

  it('openid 为空 → null（防御）', () => {
    const rankRes = { personal: [{ rank: 1, user_id: 'u_me', total_steps: 100 }] };
    expect(extractMyRank(rankRes, '')).toBeNull();
  });
});
