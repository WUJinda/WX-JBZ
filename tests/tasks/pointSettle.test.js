/**
 * tasks.settleActivityPoints 单测（积分结算）：
 *   - 个人榜 Top3 +5/+3/+1；
 *   - 部门榜第1名部门参赛人员（joined 含0步）每人 +2；
 *   - 个人+部门叠加（5+2=7）；
 *   - 幂等（已结算跳过）/ 未结束跳过 / terminated 视为 ended / RankCache 缺失跳过；
 *   - 就地标记 activity + 返回结构；
 *   - 缺参/store 校验。
 */
const {
  settleActivityPoints,
  PERSONAL_AWARDS,
  DEPT_WINNER_MEMBER_AWARD
} = require('../../cloudfunctions/tasks/pointSettle');
const { CODE } = require('../../cloudfunctions/common/errors');

const ACTIVITY_ID = 'a_demo_001';
const NOW = new Date('2026-07-25T04:00:00Z'); // 活动已结束（end_time 07-21）

function activity(extra) {
  return Object.assign(
    {
      activity_id: ACTIVITY_ID,
      name: '健步走',
      start_time: '2026-07-01T00:00:00+08:00',
      end_time: '2026-07-21T23:59:59+08:00'
    },
    extra || {}
  );
}

function user(_id, openid, deptId, joinStatus, points) {
  return {
    _id,
    _openid: openid,
    nickname: 'n' + _id,
    dept_id: deptId || '',
    join_status: joinStatus || 'joined',
    points: points || 0
  };
}

function personalDoc(rows) {
  return { type: 'personal', activity_id: ACTIVITY_ID, rows, updated_at: 't' };
}
function deptDoc(rows) {
  return { type: 'dept', activity_id: ACTIVITY_ID, rows, updated_at: 't' };
}

describe('积分规则常量', () => {
  it('PERSONAL_AWARDS = [5,3,1]，部门冠军成员每人 +2', () => {
    expect(PERSONAL_AWARDS).toEqual([5, 3, 1]);
    expect(DEPT_WINNER_MEMBER_AWARD).toBe(2);
  });
});

describe('settleActivityPoints 个人榜 Top3 (+5/+3/+1)', () => {
  it('前3名分别 +5/+3/+1', async () => {
    const store = {
      User: [user('u1', 'op1', 'd1'), user('u2', 'op2', 'd1'), user('u3', 'op3', 'd1')],
      RankCache: [
        personalDoc([
          { rank: 1, user_id: 'op1', total_steps: 300 },
          { rank: 2, user_id: 'op2', total_steps: 200 },
          { rank: 3, user_id: 'op3', total_steps: 100 }
        ]),
        deptDoc([])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(5);
    expect(store.User[1].points).toBe(3);
    expect(store.User[2].points).toBe(1);
  });

  it('不足3人：只奖励存在的名次', async () => {
    const store = {
      User: [user('u1', 'op1', 'd1')],
      RankCache: [personalDoc([{ rank: 1, user_id: 'op1', total_steps: 100 }]), deptDoc([])]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(5); // 仅第1名
  });
});

describe('settleActivityPoints 部门榜第1名部门成员 +2', () => {
  it('部门第1名（非小样本）所有参赛人员（joined 含0步）每人 +2', async () => {
    const store = {
      User: [
        user('u1', 'op1', 'd_win', 'joined'),
        user('u2', 'op2', 'd_win', 'joined', 0), // 0 步也参赛 → +2
        user('u3', 'op3', 'd_lose', 'joined') // 非冠军部门 → 不加
      ],
      RankCache: [
        personalDoc([]),
        deptDoc([{ rank: 1, dept_id: 'd_win', total_steps: 999, member_count: 2, small_sample: false }])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(2);
    expect(store.User[1].points).toBe(2); // 0 步成员也 +2
    expect(store.User[2].points).toBe(0); // 非冠军部门
  });

  it('小样本部门排第1时不获得部门奖（跳过小样本取第一个主榜部门）', async () => {
    const store = {
      User: [
        user('u1', 'op1', 'd_small', 'joined'),
        user('u2', 'op2', 'd_main', 'joined')
      ],
      RankCache: [
        personalDoc([]),
        deptDoc([
          { rank: 1, dept_id: 'd_small', total_steps: 500, member_count: 1, avg_steps: 500, small_sample: true },
          { rank: 2, dept_id: 'd_main', total_steps: 900, member_count: 3, avg_steps: 300, small_sample: false }
        ])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(0); // 小样本部门成员不获奖
    expect(store.User[1].points).toBe(2); // 第一个非小样本部门获奖
  });

  it('所有部门均为小样本 → 跳过部门奖', async () => {
    const store = {
      User: [user('u1', 'op1', 'd_small1', 'joined')],
      RankCache: [
        personalDoc([]),
        deptDoc([{ rank: 1, dept_id: 'd_small1', total_steps: 500, member_count: 1, avg_steps: 500, small_sample: true }])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(0); // 全小样本 → 无部门奖
    expect(r.awards).toHaveLength(0); // 无任何发奖
  });

  it('未报名（pending）成员不发部门奖', async () => {
    const store = {
      User: [user('u1', 'op1', 'd_win', 'pending')],
      RankCache: [personalDoc([]), deptDoc([{ rank: 1, dept_id: 'd_win', small_sample: false }])]
    };
    await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(store.User[0].points).toBe(0);
  });
});

describe('settleActivityPoints 个人+部门叠加', () => {
  it('个人第1名且在部门冠军（非小样本）部门 → +5+2=7', async () => {
    const store = {
      User: [user('u1', 'op1', 'd_win')],
      RankCache: [
        personalDoc([{ rank: 1, user_id: 'op1', total_steps: 500 }]),
        deptDoc([{ rank: 1, dept_id: 'd_win', small_sample: false }])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(7);
    expect(r.awards).toHaveLength(2); // personal-rank-1 + dept-winner-member
  });
});

describe('settleActivityPoints 幂等与跳过', () => {
  it('已结算（points_settled=true）→ 跳过不改积分', async () => {
    const store = {
      User: [user('u1', 'op1', 'd1', 'joined', 0)],
      RankCache: [personalDoc([{ rank: 1, user_id: 'op1', total_steps: 100 }]), deptDoc([])]
    };
    const r = await settleActivityPoints({
      store, activityId: ACTIVITY_ID, activity: activity({ points_settled: true }), now: NOW
    });
    expect(r.settled).toBe(false);
    expect(r.alreadySettled).toBe(true);
    expect(store.User[0].points).toBe(0); // 未加
  });

  it('活动未结束（active）→ skipped:not-ended', async () => {
    const store = { User: [user('u1', 'op1', 'd1')], RankCache: [personalDoc([]), deptDoc([])] };
    const NOW_ACTIVE = new Date('2026-07-10T04:00:00Z');
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW_ACTIVE });
    expect(r.settled).toBe(false);
    expect(r.skipped).toBe('not-ended');
  });

  it('terminated 活动视为 ended → 可结算', async () => {
    const store = {
      User: [user('u1', 'op1', 'd1')],
      RankCache: [personalDoc([{ rank: 1, user_id: 'op1', total_steps: 100 }]), deptDoc([])]
    };
    const r = await settleActivityPoints({
      store, activityId: ACTIVITY_ID,
      activity: activity({ terminated: true, end_time: '2026-08-01T00:00:00+08:00' }), // end 在未来但 terminated
      now: NOW
    });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(5);
  });

  it('RankCache 缺失（无 personal/dept 文档）→ skipped:no-rankcache', async () => {
    const store = { User: [user('u1', 'op1', 'd1')], RankCache: [] };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(false);
    expect(r.skipped).toBe('no-rankcache');
  });
});

describe('settleActivityPoints 就地标记 activity + 返回结构', () => {
  it('结算后 activity.points_settled=true 并返回 awards/settledAt', async () => {
    const act = activity();
    const store = {
      User: [user('u1', 'op1', 'd1')],
      RankCache: [personalDoc([{ rank: 1, user_id: 'op1', total_steps: 100 }]), deptDoc([])]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: act, now: NOW });
    expect(act.points_settled).toBe(true);
    expect(act.points_settled_at).toBe(NOW.toISOString());
    expect(r.settledAt).toBe(NOW.toISOString());
    expect(r.awards[0]).toMatchObject({ userId: 'u1', openid: 'op1', delta: 5, reason: 'personal-rank-1' });
  });
});

describe('settleActivityPoints 缺参/store 校验', () => {
  it('缺 activityId → BIZ_PARAM_MISSING', async () => {
    await expect(settleActivityPoints({ store: { User: [], RankCache: [] } })).rejects.toMatchObject({
      code: CODE.BIZ_PARAM_MISSING
    });
  });
  it('缺 store.User → SYS_DB_ERROR', async () => {
    await expect(
      settleActivityPoints({ activityId: ACTIVITY_ID, store: { RankCache: [] } })
    ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
  });
  it('缺 store.RankCache → SYS_DB_ERROR', async () => {
    await expect(
      settleActivityPoints({ activityId: ACTIVITY_ID, store: { User: [] } })
    ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
  });
});
