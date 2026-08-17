/**
 * tasks.settleActivityPoints 业务纯函数（个人积分规则结算部分）。
 *
 * 职责：活动结束后，按【最终累计榜单】一次性结算积分（2026-08-17 规则调整，对标 F1 名次分制）：
 *   - 个人榜前 10 名（PERSONAL_AWARDS 平缓曲线）分别 +12/+10/+8/+7/+6/+5/+4/+3/+2/+1；
 *   - 0 步门槛（F1「完赛才计分」）：total_steps<=0 的名次跳过且【不递补】——
 *     有效步数人数不足 10 时宁缺毋滥，防 0 步/未同步用户滑进前十得分；
 *   - 部门榜第 1 名（非小样本部门），该部门所有参赛人员（join_status==='joined'）每人 +2；
 *   - 个人奖与部门奖叠加（同人既是个人前 10 又在部门第1名部门 → 两笔相加）。
 *   - 部门奖排除 small_sample 部门：若所有部门均为小样本则跳过部门奖（防 1~2 人部门凭极值获奖）。
 *   - 生成结算公告摘要 settlement（活动页「比赛结束」弹窗用）：部门冠军 + 前十名得分名单。
 *
 * 结算数据来源：读 store.RankCache（已被 tasks.rankAggregate 聚合的最终榜），不重算。
 *   end_time 后 steps.sync 被拒（STEP_ACTIVITY_CLOSED），步数固化，RankCache 即最终值；
 *   stepsSync.isValidStepRecord 不依赖 locked，故无需等次日 dailyLock。
 *
 * 幂等：activity.points_settled===true → 跳过（返回 alreadySettled）。
 *   handler 层另用 CAS where(points_settled:false).update(true) 做 DB 级并发兜底（见 tasks/index.js）。
 *
 * 口径说明：
 *   - 部门奖排除 small_sample 部门（取第一个非小样本部门作为冠军；全小样本则跳过）。
 *   - 部门第1名「参赛人员」= join_status==='joined' 全口径（含 0 步成员），
 *     与部门榜 member_count 只算 >0 步成员不同——有意为之（全员奖励），注释固化防误改。
 *   - RankCache personal rows 的 user_id 存的是 openid，匹配 User 用 _openid；
 *     发奖写回用 User._id（纯函数 award.userId 存 _id，见下）。
 *
 * 红线：纯函数，不 require wx-server-sdk / 不调云 API。store 注入式，可单测。
 */

const { CODE, BizError } = require('../common/errors');
const { deriveStatus } = require('../activity/activityStatus');

// 个人榜名次 → 积分（前 10 名平缓曲线：rank 1~10 → 12/10/8/7/6/5/4/3/2/1）。
// 2026-08-17 调整：Top3 [5,3,1] → Top10 平缓版——扩大得分面 + 头部差距平缓防碾压（对标 F1 名次分，曲线取平缓变体）。
const PERSONAL_AWARDS = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1];
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
 *   awards?: [{ userId, openid, delta, reason }],  // reason: 'personal-rank-N'(N=1~10) | 'dept-winner-member'
 *   settlement?: {                  // 结算公告摘要（活动页弹窗），就地写 activity.settlement 随 handler CAS 落库
 *     settled_at: string(ISO),
 *     dept_champion: { dept_id, dept_name } | null,  // null=全小样本等无部门冠军
 *     top: [{ rank, nickname, delta }]               // 实际获得名次分者（0 步跳过的不在列，rank 为榜单真实名次）
 *   },
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

  // 读最终榜单：personal 取前 PERSONAL_AWARDS.length 名，dept 取第 1 名。
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

  // 结算公告摘要：前十名得分名单（实际发名次分者，0 步跳过的不在列）。
  const settlementTop = [];

  // 个人奖：前 PERSONAL_AWARDS.length 名（rows 已按 rank 升序）。
  // 0 步门槛（2026-08-17 决策，对标 F1「完赛才计分」）：total_steps<=0 跳过且不递补——
  //   参与且产生步数的人数不足 10 时，靠后的名次分作废，防 0 步/未同步用户滑进前十得分。
  const topRankers = personalRows.slice(0, PERSONAL_AWARDS.length);
  topRankers.forEach((row, i) => {
    const openid = row && row.user_id;
    const delta = PERSONAL_AWARDS[i];
    if (!openid || !delta) return;
    if (!(Number(row.total_steps) > 0)) return; // 0 步门槛：跳过且不递补
    const user = userByOpenid.get(openid);
    if (!user) return; // 榜单中的 openid 在 User 表找不到 → 跳过（理论上不会）
    user.points = (Number(user.points) || 0) + delta;
    awards.push({ userId: user._id, openid, delta, reason: 'personal-rank-' + (i + 1) });
    // rank 用榜单真实名次（0 步跳过时名次不连续，如实展示）；缺失时回退序号。
    const rowRank = Number(row.rank);
    settlementTop.push({
      rank: Number.isFinite(rowRank) && rowRank > 0 ? rowRank : i + 1,
      nickname: row.nickname || '',
      delta
    });
  });

  // 部门奖：第 1 名（非小样本）部门的所有参赛人员（joined 全口径，含 0 步成员）。
  // 排除 small_sample 部门（§657）：小样本部门不进入人均主排名，自然也不应获得部门奖。
  //   deptRows 排序时小样本排后 → find 跳过小样本取第一个主榜部门；全是小样本 → undefined → 跳过部门奖。
  const deptWinner = deptRows.find((r) => r && !r.small_sample);
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

  // 结算公告摘要（活动页「比赛结束」弹窗数据）：部门冠军（无则 null）+ 前十名得分名单。
  const settlement = {
    settled_at: settledAt,
    dept_champion: deptId
      ? { dept_id: deptId, dept_name: (deptWinner && deptWinner.dept_name) || '' }
      : null,
    top: settlementTop
  };

  // 标记已结算（就地改 activity，handler 据此 CAS 写回库；settlement 摘要随同一次 update 落库）。
  if (activity && typeof activity === 'object') {
    activity.points_settled = true;
    activity.points_settled_at = settledAt;
    activity.settlement = settlement;
  }

  return { activityId, settled: true, awards, settlement, settledAt };
}

module.exports = {
  settleActivityPoints,
  PERSONAL_AWARDS,
  DEPT_WINNER_MEMBER_AWARD
};
