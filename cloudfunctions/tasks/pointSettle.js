/**
 * tasks.settleActivityPoints 业务纯函数（个人积分规则结算部分）。
 *
 * 职责：活动结束后，按【最终累计榜单】一次性结算积分：
 *   - 个人榜第 1/2/3 名分别 +5/+3/+1；
 *   - 部门榜第 1 名，该部门所有参赛人员（join_status==='joined'）每人 +2；
 *   - 个人奖与部门奖叠加（同人既是个人 Top3 又在部门第1名部门 → 两笔相加）。
 *
 * 结算数据来源：读 store.RankCache（已被 tasks.rankAggregate 聚合的最终榜），不重算。
 *   end_time 后 steps.sync 被拒（STEP_ACTIVITY_CLOSED），步数固化，RankCache 即最终值；
 *   stepsSync.isValidStepRecord 不依赖 locked，故无需等次日 dailyLock。
 *
 * 幂等：activity.points_settled===true → 跳过（返回 alreadySettled）。
 *   handler 层另用 CAS where(points_settled:false).update(true) 做 DB 级并发兜底（见 tasks/index.js）。
 *
 * 口径说明：
 *   - 部门第1名「参赛人员」= join_status==='joined' 全口径（含 0 步成员），
 *     与部门榜 member_count 只算 >0 步成员不同——有意为之（全员奖励），注释固化防误改。
 *   - RankCache personal rows 的 user_id 存的是 openid，匹配 User 用 _openid；
 *     发奖写回用 User._id（纯函数 award.userId 存 _id，见下）。
 *
 * 红线：纯函数，不 require wx-server-sdk / 不调云 API。store 注入式，可单测。
 */

const { CODE, BizError } = require('../common/errors');
const { deriveStatus } = require('../activity/activityStatus');

// 个人榜名次 → 积分（rank 1/2/3 → 5/3/1）。
const PERSONAL_AWARDS = [5, 3, 1];
// 部门榜第 1 名部门参赛人员每人积分。
const DEPT_WINNER_MEMBER_AWARD = 2;

/**
 * 活动结束积分结算（纯函数 + 注入式 store/now）。
 *
 * 就地副作用：改 store.User[i].points、改 params.activity.points_settled/points_settled_at
 *   （handler 据此 CAS 写回库；单测可直接断言）。
 *
 * @param {object} params
 * @param {object} params.store mock db（{ User: object[], RankCache: object[] }）
 *   User 需含 _openid/dept_id/join_status/points；RankCache 需含 personal/dept 两文档（rankAggregate 产出）。
 * @param {string} params.activityId 活动 id
 * @param {object} [params.activity] 活动文档（含 end_time/terminated/points_settled）
 * @param {Date} [params.now=new Date()] 注入时间（便于单测）
 * @returns {Promise<object>} {
 *   activityId, settled: boolean,
 *   alreadySettled?: boolean,        // activity.points_settled===true → 跳过
 *   skipped?: 'not-ended'|'no-rankcache',
 *   awards?: [{ userId, openid, delta, reason }],  // reason: 'personal-rank-1/2/3' | 'dept-winner-member'
 *   settledAt?: string(ISO)
 * }
 */
async function settleActivityPoints(params) {
  const p = params || {};
  const { store, activityId, activity } = p;
  if (!activityId) {
    throw BizError(CODE.BIZ_PARAM_MISSING, 'settleActivityPoints: activityId required');
  }
  if (!store || !Array.isArray(store.User)) {
    throw BizError(CODE.SYS_DB_ERROR, 'settleActivityPoints: store.User is required');
  }
  if (!Array.isArray(store.RankCache)) {
    throw BizError(CODE.SYS_DB_ERROR, 'settleActivityPoints: store.RankCache is required');
  }

  const nowDate = p.now instanceof Date ? p.now : new Date();
  const settledAt = nowDate.toISOString();

  // 幂等：已结算 → 跳过（不抛错，定时任务友好）。
  if (activity && activity.points_settled === true) {
    return { activityId, settled: false, alreadySettled: true, settledAt };
  }

  // 仅活动结束后结算（terminated 也归 ended）。
  const status = deriveStatus(activity || {}, nowDate);
  if (status !== 'ended') {
    return { activityId, settled: false, skipped: 'not-ended', settledAt };
  }

  // 读最终榜单：personal 取 Top3，dept 取第 1 名。
  const personalDoc = store.RankCache.find(
    (d) => d && d.type === 'personal' && d.activity_id === activityId
  );
  const deptDoc = store.RankCache.find(
    (d) => d && d.type === 'dept' && d.activity_id === activityId
  );
  const personalRows = (personalDoc && Array.isArray(personalDoc.rows)) ? personalDoc.rows : [];
  const deptRows = (deptDoc && Array.isArray(deptDoc.rows)) ? deptDoc.rows : [];
  if (!personalRows.length && !deptRows.length) {
    return { activityId, settled: false, skipped: 'no-rankcache', settledAt };
  }

  const awards = [];
  const userByOpenid = new Map();
  store.User.forEach((u) => {
    if (u && u._openid) userByOpenid.set(u._openid, u);
  });

  // 个人奖：Top3（rows 已按 rank 升序）。
  const top3 = personalRows.slice(0, 3);
  top3.forEach((row, i) => {
    const openid = row && row.user_id;
    const delta = PERSONAL_AWARDS[i];
    if (!openid || !delta) return;
    const user = userByOpenid.get(openid);
    if (!user) return; // 榜单中的 openid 在 User 表找不到 → 跳过（理论上不会）
    user.points = (Number(user.points) || 0) + delta;
    awards.push({ userId: user._id, openid, delta, reason: 'personal-rank-' + (i + 1) });
  });

  // 部门奖：第 1 名部门的所有参赛人员（joined 全口径，含 0 步成员）。
  const deptWinner = deptRows[0];
  const deptId = deptWinner && deptWinner.dept_id;
  if (deptId) {
    store.User.forEach((u) => {
      if (u && u.dept_id === deptId && u.join_status === 'joined') {
        u.points = (Number(u.points) || 0) + DEPT_WINNER_MEMBER_AWARD;
        awards.push({
          userId: u._id,
          openid: u._openid,
          delta: DEPT_WINNER_MEMBER_AWARD,
          reason: 'dept-winner-member'
        });
      }
    });
  }

  // 标记已结算（就地改 activity，handler 据此 CAS 写回库）。
  if (activity && typeof activity === 'object') {
    activity.points_settled = true;
    activity.points_settled_at = settledAt;
  }

  return { activityId, settled: true, awards, settledAt };
}

module.exports = {
  settleActivityPoints,
  PERSONAL_AWARDS,
  DEPT_WINNER_MEMBER_AWARD
};
