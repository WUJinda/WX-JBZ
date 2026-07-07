/**
 * 触发榜单聚合（steps.sync 成功后即时刷新 RankCache）。
 *
 * 背景：RankCache 中间表由 tasks.rankAggregate 聚合生成，原本仅靠定时触发器（每 10 分钟）
 *   或手动触发。用户同步步数后想立刻看到排名，故 steps.sync 写完 StepRecord 后主动触发一次
 *   聚合——await 等其完成，前端随即 loadStats 即可拿到新名次。
 *
 * 容错：失败仅 warn，不阻断 sync 主返回（StepRecord 已落库，定时任务兜底覆盖）。
 *
 * 独立成文件（不 require wx-server-sdk）便于本地单测注入 mock cloud——steps/index.js 顶部
 *   模块级 require wx-server-sdk + cloud.init，本地无该 sdk 时整个 index.js 无法在测试环境
 *   require；本模块把「触发」动作抽成可注入 cloudSdk 的纯包装，符合双轨架构可测约定。
 *
 * 解耦：本模块不 require wx-server-sdk，cloudSdk 由调用方（steps/index.js）注入。
 */

/**
 * 触发 tasks.rankAggregate 聚合一次（覆盖写 RankCache，幂等）。
 *
 * @param {object} cloudSdk 注入的 cloud 实例（steps/index.js 的模块级 cloud）
 * @param {string} activityId 活动 id（可能为空串：前端 getActivityId() 冷启动可能返回空；
 *   tasks handler 会 getActiveActivityId 兜底，故原样透传，不私自吞空值）
 * @returns {Promise<void>} 永不 reject（内部 catch，失败仅 warn）
 */
async function triggerRankAggregate(cloudSdk, activityId) {
  try {
    await cloudSdk.callFunction({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: activityId }
    });
  } catch (e) {
    // 聚合失败不阻断 sync：StepRecord 已落库，定时任务（每 10 分钟）幂等覆盖兜底。
    console.warn('[sync] 触发 rankAggregate 失败，榜单将由定时任务兜底', (e && e.message) || e);
  }
}

module.exports = { triggerRankAggregate };
