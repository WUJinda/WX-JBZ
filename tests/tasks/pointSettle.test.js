/**
 * tasks.settleActivityPoints 单测（积分结算，2026-08-17 规则调整后）：
 *   - 个人榜前 10 名平缓曲线 +12/+10/+8/+7/+6/+5/+4/+3/+2/+1；
 *   - 0 步门槛：total_steps<=0 的名次跳过且不递补（宁缺毋滥）；
 *   - 第 11 名起不得分；
 *   - 部门榜第1名部门参赛人员（joined 含0步）每人 +2；
 *   - 个人+部门叠加（12+2=14）；
 *   - settlement 结算公告摘要（部门冠军 + 前十名单）；
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
  it('PERSONAL_AWARDS = 前10名平缓曲线，部门冠军成员每人 +2', () => {
    expect(PERSONAL_AWARDS).toEqual([12, 10, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(DEPT_WINNER_MEMBER_AWARD).toBe(2);
  });
});

describe('settleActivityPoints 个人榜前 10 名（平缓曲线）', () => {
  it('前10名分别 +12/+10/+8/+7/+6/+5/+4/+3/+2/+1，第11名起不得分', async () => {
    // 15 人榜单：前 10 得分，后 5 人 0 分。
    const users = [];
    const rows = [];
    for (let i = 1; i <= 15; i++) {
      users.push(user('u' + i, 'op' + i, 'd1'));
      rows.push({ rank: i, user_id: 'op' + i, total_steps: 1000 - i * 10, nickname: '昵称' + i });
    }
    const store = { User: users, RankCache: [personalDoc(rows), deptDoc([])] };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    for (let i = 0; i < 10; i++) {
      expect(store.User[i].points).toBe(PERSONAL_AWARDS[i]);
    }
    expect(store.User[10].points).toBe(0); // 第 11 名
    expect(store.User[14].points).toBe(0); // 第 15 名（榜尾）
    expect(r.awards).toHaveLength(10);
  });

  it('不足 10 人：只奖励存在的名次', async () => {
    const store = {
      User: [user('u1', 'op1', 'd1')],
      RankCache: [personalDoc([{ rank: 1, user_id: 'op1', total_steps: 100 }]), deptDoc([])]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(12); // 仅第1名
  });

  it('0 步门槛：前 10 名中的 0 步用户跳过且不递补（名次分作废）', async () => {
    // 第 1 名正常；第 2、3 名 0 步（滑进前十的未同步用户）→ 跳过不递补：
    //   第 2/3 名的分作废，第 4 名仍拿 PERSONAL_AWARDS[3]=7（不因前移拿 10）。
    const rows = [
      { rank: 1, user_id: 'op1', total_steps: 500, nickname: '一' },
      { rank: 2, user_id: 'op2', total_steps: 0, nickname: '零二' },
      { rank: 3, user_id: 'op3', total_steps: 0, nickname: '零三' },
      { rank: 4, user_id: 'op4', total_steps: 300, nickname: '四' }
    ];
    const store = {
      User: [
        user('u1', 'op1', 'd1'), user('u2', 'op2', 'd1'),
        user('u3', 'op3', 'd1'), user('u4', 'op4', 'd1')
      ],
      RankCache: [personalDoc(rows), deptDoc([])]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(12); // 第 1 名
    expect(store.User[1].points).toBe(0); // 第 2 名 0 步 → 不发
    expect(store.User[2].points).toBe(0); // 第 3 名 0 步 → 不发
    expect(store.User[3].points).toBe(7); // 第 4 名拿第 4 名分（不递补第 2 名的 10 分）
    expect(r.awards).toHaveLength(2); // 仅 rank1 + rank4
    // settlement.top 只含实际得分者，rank 用榜单真实名次（2/3 名次缺失如实展示）。
    expect(r.settlement.top).toEqual([
      { rank: 1, nickname: '一', delta: 12 },
      { rank: 4, nickname: '四', delta: 7 }
    ]);
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
  it('个人第1名且在部门冠军（非小样本）部门 → +12+2=14', async () => {
    const store = {
      User: [user('u1', 'op1', 'd_win')],
      RankCache: [
        personalDoc([{ rank: 1, user_id: 'op1', total_steps: 500 }]),
        deptDoc([{ rank: 1, dept_id: 'd_win', small_sample: false }])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(true);
    expect(store.User[0].points).toBe(14);
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

  it('活动文档缺 points_settled 字段（旧数据/未初始化）→ 不误判已结算，正常发奖并就地置位', async () => {
    // 回归：新建活动不落库该字段（schema default 仅是文档规范），CAS where(false) 不匹配缺失文档，
    //   曾致 handler 永远返回 alreadySettled 但从未发奖（台账全 0）。纯函数层必须把缺失视为未结算。
    const store = {
      User: [user('u1', 'op1', 'd1', 'joined', 0)],
      RankCache: [personalDoc([{ rank: 1, user_id: 'op1', total_steps: 100 }]), deptDoc([])]
    };
    const act = activity(); // 不带 points_settled 字段
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: act, now: NOW });
    expect(r.settled).toBe(true);
    expect(r.alreadySettled).toBeUndefined();
    expect(store.User[0].points).toBe(12); // 个人榜第 1 名
    expect(act.points_settled).toBe(true); // 就地标记（handler 据此 CAS 落库）
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
    expect(store.User[0].points).toBe(12);
  });

  it('RankCache 缺失（无 personal/dept 文档）→ skipped:no-rankcache', async () => {
    const store = { User: [user('u1', 'op1', 'd1')], RankCache: [] };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settled).toBe(false);
    expect(r.skipped).toBe('no-rankcache');
  });
});

describe('settleActivityPoints 就地标记 activity + 返回结构', () => {
  it('结算后 activity.points_settled=true 并返回 awards/settlement/settledAt', async () => {
    const act = activity();
    const store = {
      User: [user('u1', 'op1', 'd1')],
      RankCache: [personalDoc([{ rank: 1, user_id: 'op1', total_steps: 100, nickname: '冠军哥' }]), deptDoc([])]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: act, now: NOW });
    expect(act.points_settled).toBe(true);
    expect(act.points_settled_at).toBe(NOW.toISOString());
    expect(act.settlement).toBe(r.settlement); // 摘要就地写入 activity（handler 随 CAS 落库）
    expect(r.settledAt).toBe(NOW.toISOString());
    expect(r.awards[0]).toMatchObject({ userId: 'u1', openid: 'op1', delta: 12, reason: 'personal-rank-1' });
    expect(r.settlement).toEqual({
      settled_at: NOW.toISOString(),
      dept_champion: null, // 无部门榜数据 → 无部门冠军
      top: [{ rank: 1, nickname: '冠军哥', delta: 12 }]
    });
  });
});

describe('settleActivityPoints settlement 结算公告摘要（活动页弹窗）', () => {
  it('部门冠军（非小样本）→ dept_champion 含 dept_id/dept_name', async () => {
    const act = activity();
    const store = {
      User: [user('u1', 'op1', 'd_win')],
      RankCache: [
        personalDoc([{ rank: 1, user_id: 'op1', total_steps: 500, nickname: '甲' }]),
        deptDoc([{ rank: 1, dept_id: 'd_win', dept_name: '综合部', total_steps: 999, member_count: 5, small_sample: false }])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: act, now: NOW });
    expect(r.settlement.dept_champion).toEqual({ dept_id: 'd_win', dept_name: '综合部' });
  });

  it('全小样本部门 → 无部门奖，dept_champion=null（弹窗隐藏部门冠军块）', async () => {
    const store = {
      User: [user('u1', 'op1', 'd_small1', 'joined')],
      RankCache: [
        personalDoc([{ rank: 1, user_id: 'op1', total_steps: 300, nickname: '乙' }]),
        deptDoc([{ rank: 1, dept_id: 'd_small1', dept_name: '二人组', member_count: 1, small_sample: true }])
      ]
    };
    const r = await settleActivityPoints({ store, activityId: ACTIVITY_ID, activity: activity(), now: NOW });
    expect(r.settlement.dept_champion).toBeNull();
    expect(r.settlement.top).toEqual([{ rank: 1, nickname: '乙', delta: 12 }]);
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
