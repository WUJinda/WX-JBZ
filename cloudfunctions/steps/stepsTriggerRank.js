/**
 * 触发榜单聚合（steps.sync 成功后即时刷新 RankCache）。
 *
 * 背景：RankCache 中间表由 tasks.rankAggregate 聚合生成，原本仅靠定时触发器（每 10 分钟）
 *   或手动触发。用户同步步数后想立刻看到排名，故 steps.sync 写完 StepRecord 后主动触发一次
 *   聚合——await 等其完成，前端随即 loadStats 即可拿到新名次。
 *
 * 写后读（triggerRankAggregateFresh）：steps 写 StepRecord（主节点）→ 跨函数 callFunction tasks
 *   → tasks 读 StepRecord（副本），副本同步延迟窗口内 tasks 可能读不到当前用户刚写的记录 →
 *   聚合缺本人 → RankCache 缺本人（表现：第一个同步者在榜、第二个同步者不在榜）。故 sync 改调
 *   triggerRankAggregateFresh：首次聚合拿不到本人 my_rank 且本人确有步数时退避重试聚合，
 *   吸收写后读窗口（与 common/authMiddleware.assertJoinedFresh 同模式）。
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

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 触发榜单聚合并取本人排名（含跨函数「写后读」退避重试）。
 *
 * 背景（2026-07-08 实测）：steps.sync 写 StepRecord（主节点）→ callFunction tasks →
 *   tasks loadByWhere 读 StepRecord（副本）。跨函数副本同步延迟窗口内，tasks 可能读不到
 *   当前用户刚写的记录 → 聚合结果缺当前用户 → 覆盖写 RankCache 缺当前用户 → 前端看不到该用户排名。
 *   现象：第一个同步者（记录早已同步）在榜，第二个同步者（刚写、副本未同步）不在榜。
 *   与 common/authMiddleware.assertJoinedFresh（user.join 写 User → steps 读 User 跨函数写后读）
 *   同类、同环境、已证真实存在。
 *
 * 解法：第一次聚合后取本人 my_rank，若为 null → 延迟重试聚合（参考 assertJoinedFresh 退避）。
 *   重试时副本已同步，tasks 能读到当前用户 → 覆盖写 RankCache → 当前用户进榜 + sync 返回准确 my_rank。
 *   **2026-07-09 修改：0 步用户也进榜（只是排在最后），不再区分 hasSteps**。
 *
 * 容错：聚合失败（triggerRankAggregate 内部 catch 返回 null）→ my_rank=null，不阻断 sync 主返回
 *   （StepRecord 已落库，定时任务兜底覆盖）。
 *
 * 重试开销：每次重试 = 一次完整 callFunction(tasks)（聚合 + 覆盖写 RankCache）。仅在写后读窗口内
 *   触发（罕见），且 sync 频控（每人每日 ≤6 次），可接受。最坏 retries×delayMs（默认 2×500=1s）
 *   延长 sync 响应，换来当前用户即时进榜 + 准确 my_rank。
 *
 * @param {object} cloudSdk 注入的 cloud 实例（steps/index.js 的模块级 cloud）
 * @param {string} activityId 活动 id（透传给 tasks，空串由 tasks getActiveActivityId 兜底）
 * @param {string} openid 本人 openid（= StepRecord.user_id，用于定位 my_rank）
 * @param {object} [options]
 * @param {number} [options.retries=2] 退避重试次数（每次先 sleep delayMs 再聚合）
 * @param {number} [options.delayMs=500] 退避间隔（ms）
 * @param {(ms:number)=>Promise} [options.sleepFn] 注入 sleep（便于单测；默认 Promise+setTimeout）
 * @returns {Promise<{rankRes:object|null, myRank:{rank,total_steps}|null}>}
 *   rankRes 最后一次聚合结果；myRank 本人排名或 null（未进榜/聚合失败）。
 */
async function triggerRankAggregateFresh(cloudSdk, activityId, openid, options) {
  const opts = options || {};
  const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 500;
  const sleep = typeof opts.sleepFn === 'function' ? opts.sleepFn : defaultSleep;

  // 第一次聚合（快路径）：副本已同步时直接拿到 my_rank，零 sleep、零重试。
  let rankRes = await triggerRankAggregate(cloudSdk, activityId);
  let myRank = openid ? extractMyRank(rankRes, openid) : null;
  if (myRank) return { rankRes, myRank };

  // openid 缺失 → 无定位键，重试无意义（不应发生，sync 已校验 openid）。
  if (!openid) return { rankRes, myRank };

  // 写后读退避：没读到本人 → 副本延迟窗口，延迟重试聚合（覆盖写 RankCache 含本人）。
  // **2026-07-09：0 步用户也重试，确保所有已报名用户都进榜**。
  for (let i = 0; i < retries; i++) {
    await sleep(delayMs);
    rankRes = await triggerRankAggregate(cloudSdk, activityId);
    myRank = extractMyRank(rankRes, openid);
    if (myRank) return { rankRes, myRank };
  }
  // 重试用尽仍 null：副本延迟超窗口（罕见）或真未进榜。StepRecord 已落库，定时任务兜底覆盖。
  return { rankRes, myRank };
}

module.exports = { triggerRankAggregate, triggerRankAggregateFresh, extractMyRank };
