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

const { triggerRankAggregate } = require('../../cloudfunctions/steps/stepsTriggerRank');

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
    // 不应抛错（内部 catch）；返回的 promise 应 resolve 为 undefined。
    await expect(triggerRankAggregate(cloud, 'a_demo_001')).resolves.toBeUndefined();
    expect(cloud.callFunction).toHaveBeenCalledTimes(1);
  });
});
