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
 * @returns {Promise<object|null>} tasks.rankAggregate 的 data（{personal, dept, updatedAt}）；
 *   永不 reject（内部 catch，失败返回 null 仅 warn）。供 sync handler 取本人 my_rank。
 */
async function triggerRankAggregate(cloudSdk, activityId) {
  try {
    const res = await cloudSdk.callFunction({
      name: 'tasks',
      data: { action: 'rankAggregate', activity_id: activityId }
    });
    // tasks.main 返回 ok(data) → callFunction 结果 { result: { code, message, data } }。
    // 返回 data（含 personal/dept）供 sync handler 直接取 my_rank，免前端二次查 RankCache（写后读旧快照）。
    return (res && res.result && res.result.data) || null;
  } catch (e) {
    // 聚合失败不阻断 sync：StepRecord 已落库，定时任务（每 10 分钟）幂等覆盖兜底。
    console.warn('[sync] 触发 rankAggregate 失败，榜单将由定时任务兜底', (e && e.message) || e);
    return null;
  }
}

/**
 * 从 rankAggregate 结果里取本人排名行（供 sync 返回 my_rank，免前端二次查 RankCache 写后读旧快照）。
 * @param {object|null} rankRes triggerRankAggregate 返回的 {personal, dept, updatedAt}
 * @param {string} openid 本人 openid（= StepRecord.user_id = personal row.user_id）
 * @returns {{rank:number, total_steps:number}|null} 未进榜/未聚合/失败 → null
 */
function extractMyRank(rankRes, openid) {
  if (!rankRes || !Array.isArray(rankRes.personal) || !openid) return null;
  const row = rankRes.personal.find((r) => r && r.user_id === openid);
  if (!row) return null;
  return { rank: row.rank, total_steps: row.total_steps };
}

module.exports = { triggerRankAggregate, extractMyRank };
