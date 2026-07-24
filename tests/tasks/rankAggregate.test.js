/**
 * tasks.rankAggregate 业务纯函数单测（G1）：
 * first_reach_at 同分早达成排前 / 单条达成 / 0步不进榜；
 * 有效步数口径（活动期内已同步即有效，不依赖 locked）；个人榜排序；部门榜 total/avg/member_count；
 * 小部门处理（可配阈值）；幂等覆盖写。
 */
const {
  aggregateRanking,
  buildPersonalRanking,
  buildDeptRanking,
  computeFirstReachAt,
  overwriteRankCache
} = require('../../cloudfunctions/tasks/rankAggregate');
const { maskNickname } = require('../../cloudfunctions/common/mask');
const { CODE } = require('../../cloudfunctions/common/errors');

const ACTIVITY_ID = 'a_demo_001';
// 北京时间 07-03 12:00 = UTC 07-03 04:00
const NOW = new Date('2026-07-03T04:00:00Z'); // today = 2026-07-03

// 注意：真实链路里 User._id（云库自动主键）与 _openid 不同，且 StepRecord.user_id 存的是 openid。
// 这里令 _id 带 'rec_' 前缀、_openid = 入参，刻意让 _id ≠ _openid，
// 以验证 rankAggregate 是「以 _openid 关联」（正确）而非「以 _id 关联」（会导致 nickname/dept 全空）。
function user(openid, nickname, deptId, joinStatus) {
  return {
    _id: 'rec_' + openid,
    _openid: openid,
    nickname,
    dept_id: deptId || '',
    join_status: joinStatus || 'joined'
  };
}

function dept(deptId, name, memberCount, size) {
  return {
    dept_id: deptId,
    name: name || deptId,
    activity_id: ACTIVITY_ID,
    member_count: memberCount || 0,
    size: size || 0
  };
}

// user_id 存 openid（与 User._openid 对齐），模拟真实 steps handler 行为。
function rec(openid, date, steps, opts) {
  const o = opts || {};
  return {
    user_id: openid,
    _openid: openid,
    activity_id: ACTIVITY_ID,
    date,
    steps,
    locked: !!o.locked,
    abnormal: !!o.abnormal,
    synced_at: o.synced_at || (date + 'T04:00:00.000Z')
  };
}

function makeStore(parts) {
  return Object.assign({ StepRecord: [], User: [], Department: [], RankCache: [] }, parts || {});
}

describe('computeFirstReachAt（R5.1 同分排序核心）', () => {
  it('按 synced_at 升序累加，首次 ≥ total_steps 的 synced_at（非最后一条）', () => {
    // total = 100+200+300 = 600
    // 累加：100(<600) → 300(<600) → 600(>=600) → 取第三条 synced_at
    const recs = [
      rec('u', '2026-07-01', 100, { synced_at: '2026-07-01T01:00:00.000Z' }),
      rec('u', '2026-07-02', 200, { synced_at: '2026-07-02T01:00:00.000Z' }),
      rec('u', '2026-07-03', 300, { synced_at: '2026-07-03T01:00:00.000Z' })
    ];
    const total = 600;
    expect(computeFirstReachAt(recs, total)).toBe('2026-07-03T01:00:00.000Z');
  });

  it('单条即达成：取该条 synced_at', () => {
    const recs = [rec('u', '2026-07-01', 1000, { synced_at: '2026-07-01T05:00:00.000Z' })];
    expect(computeFirstReachAt(recs, 1000)).toBe('2026-07-01T05:00:00.000Z');
  });

  it('total_steps=0 → null（0步不进榜）', () => {
    const recs = [rec('u', '2026-07-01', 0)];
    expect(computeFirstReachAt(recs, 0)).toBeNull();
  });

  it('同步顺序乱序时仍按 synced_at 升序累加（不是录入顺序）', () => {
    // 录入顺序乱，但 synced_at 升序应为 07-01 < 07-02
    const recs = [
      rec('u', '2026-07-02', 800, { synced_at: '2026-07-02T01:00:00.000Z' }),
      rec('u', '2026-07-01', 300, { synced_at: '2026-07-01T01:00:00.000Z' })
    ];
    // total = 1100；累加 07-01:300(<1100) → 07-02:1100(>=1100) → 取 07-02
    expect(computeFirstReachAt(recs, 1100)).toBe('2026-07-02T01:00:00.000Z');
  });

  it('累计首次「达到或超过」（=也触发，非严格大于）', () => {
    // total = 500；累加 300(<500) → 500(>=500，=触发) → 取第二条
    const recs = [
      rec('u', '2026-07-01', 300, { synced_at: '2026-07-01T01:00:00.000Z' }),
      rec('u', '2026-07-02', 200, { synced_at: '2026-07-02T01:00:00.000Z' })
    ];
    expect(computeFirstReachAt(recs, 500)).toBe('2026-07-02T01:00:00.000Z');
  });
});

describe('aggregateRanking 个人榜（有效步数口径 + 排序 + 脱敏）', () => {
  it('有效步数口径 = 活动期内已同步即有效（不依赖 locked）', async () => {
    // u1: 07-01 locked=100 + 07-02 未锁=200（新口径有效）+ 07-03 today=50
    // 有效 = 100 + 200 + 50 = 350
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u1', '2026-07-02', 200, { locked: false }), // 新口径：活动期内已同步 → 有效
        rec('u1', '2026-07-03', 50, { locked: false }) // 今日
      ],
      User: [user('u1', '甲', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal).toHaveLength(1);
    expect(result.personal[0].total_steps).toBe(350);
  });

  it('total_steps=0 也进榜（2026-07-09 修改：0 步用户排在榜末）', async () => {
    // u2: 07-02 steps=0 → 有效口径通过但 total=0 → 也进榜，排在最后
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-02', 0, { locked: false }) // 0 步 → 也进榜，但排在最后
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal).toHaveLength(2); // u1 和 u2 都进榜
    expect(result.personal[0].user_id).toBe('u1'); // u1 排第一（100 步）
    expect(result.personal[1].user_id).toBe('u2'); // u2 排第二（0 步）
    expect(result.personal[1].total_steps).toBe(0);
    expect(result.personal[1].first_reach_at).toBeNull(); // 0 步无 first_reach_at
  });

  it('已报名但无任何 StepRecord 的用户也进榜（决策2：0 步排在榜末）', async () => {
    // u1 有记录（100 步）；u2 已报名但从未同步（无任何 StepRecord）→ 也应进榜，total=0 排末尾
    const store = makeStore({
      StepRecord: [rec('u1', '2026-07-01', 100, { locked: true })],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal).toHaveLength(2);
    expect(result.personal[0].user_id).toBe('u1');
    expect(result.personal[0].total_steps).toBe(100);
    expect(result.personal[1].user_id).toBe('u2'); // 无记录用户排末尾
    expect(result.personal[1].total_steps).toBe(0);
    expect(result.personal[1].first_reach_at).toBeNull();
  });

  it('同一 (user,date) 重复 StepRecord 文档只计一次（B1：无索引聚合侧去重兜底）', async () => {
    // u1 同一天 07-01 有两条记录（模拟写侧并发重复）：100 + 150。
    // 去重取 steps 最大者（150），total 应为 150 而非 250（否则排名翻倍）。
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true, synced_at: '2026-07-01T01:00:00.000Z' }),
        rec('u1', '2026-07-01', 150, { locked: true, synced_at: '2026-07-01T02:00:00.000Z' }) // 重复文档
      ],
      User: [user('u1', '甲', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal).toHaveLength(1);
    expect(result.personal[0].total_steps).toBe(150); // 去重后取最大，非 250
  });

  it('按 total_steps desc 排序，赋 rank 从 1 起', async () => {
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-01', 300, { locked: true }),
        rec('u3', '2026-07-01', 200, { locked: true })
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1'), user('u3', '丙', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal.map((r) => ({ u: r.user_id, s: r.total_steps, rk: r.rank }))).toEqual([
      { u: 'u2', s: 300, rk: 1 },
      { u: 'u3', s: 200, rk: 2 },
      { u: 'u1', s: 100, rk: 3 }
    ]);
  });

  it('同分按 first_reach_at 升序（更早达成排前，R5.1）', async () => {
    // u1/u2 同分 1000，u1 早达成（synced_at 更早）→ 排前
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 1000, { locked: true, synced_at: '2026-07-01T01:00:00.000Z' }),
        rec('u2', '2026-07-01', 1000, { locked: true, synced_at: '2026-07-02T01:00:00.000Z' })
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal[0].user_id).toBe('u1'); // 早达成排前
    expect(result.personal[0].rank).toBe(1);
    expect(result.personal[1].user_id).toBe('u2');
    expect(result.personal[1].rank).toBe(2);
    expect(result.personal[0].first_reach_at).toBe('2026-07-01T01:00:00.000Z');
    expect(result.personal[1].first_reach_at).toBe('2026-07-02T01:00:00.000Z');
  });

  it('同分同 first_reach_at 时顺序稳定（不抛错）', async () => {
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 500, { locked: true, synced_at: '2026-07-01T01:00:00.000Z' }),
        rec('u2', '2026-07-01', 500, { locked: true, synced_at: '2026-07-01T01:00:00.000Z' })
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal).toHaveLength(2);
    expect(result.personal[0].total_steps).toBe(500);
  });

  it('nickname 脱敏 + 附 dept_name/dept_id（R5.3）', async () => {
    const store = makeStore({
      StepRecord: [rec('u1', '2026-07-01', 100, { locked: true })],
      User: [user('u1', '张小明', 'd_01')],
      Department: [dept('d_01', '研发部')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal[0].nickname).toBe(maskNickname('张小明')); // 张*明
    expect(result.personal[0].dept_id).toBe('d_01');
    expect(result.personal[0].dept_name).toBe('研发部');
  });

  it('未报名用户（join_status!=joined）不进榜', async () => {
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-01', 200, { locked: true })
      ],
      User: [user('u1', '甲', 'd1', 'joined'), user('u2', '乙', 'd1', 'pending')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal).toHaveLength(1);
    expect(result.personal[0].user_id).toBe('u1');
  });

  it('first_reach_at 累加跨多条记录取首次达成点（核心边界）', async () => {
    // u1: 07-01=300, 07-02=300, 07-03=400 → total=1000
    // 累加 300(<1000) → 600(<1000) → 1000(>=1000) → 取 07-03 synced_at
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 300, { locked: true, synced_at: '2026-07-01T01:00:00.000Z' }),
        rec('u1', '2026-07-02', 300, { locked: true, synced_at: '2026-07-02T01:00:00.000Z' }),
        rec('u1', '2026-07-03', 400, { locked: true, synced_at: '2026-07-03T01:00:00.000Z' })
      ],
      User: [user('u1', '甲', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.personal[0].first_reach_at).toBe('2026-07-03T01:00:00.000Z');
    expect(result.personal[0].total_steps).toBe(1000);
  });
});

describe('aggregateRanking 部门榜（total/avg/member_count + 小部门）', () => {
  it('按 dept 聚合 total/member_count/avg（R6.2 有效成员数）', async () => {
    // d1: u1=100 + u2=300 = 400，有效成员 2 → avg=200
    // d2: u3=500，有效成员 1 → avg=500（但小部门）
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-01', 300, { locked: true }),
        rec('u3', '2026-07-01', 500, { locked: true })
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1'), user('u3', '丙', 'd2')],
      Department: [dept('d1', '一组'), dept('d2', '二组')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    const d1 = result.dept.find((r) => r.dept_id === 'd1');
    const d2 = result.dept.find((r) => r.dept_id === 'd2');
    expect(d1.total_steps).toBe(400);
    expect(d1.member_count).toBe(2);
    expect(d1.avg_steps).toBe(200);
    expect(d2.total_steps).toBe(500);
    expect(d2.member_count).toBe(1);
    expect(d2.avg_steps).toBe(500);
  });

  it('默认按 avg 排序（主榜）', async () => {
    // 三个大部门（>=3 成员），avg 各异
    const users = [];
    const recs = [];
    const depts = [];
    let uid = 0;
    // d1: 3 人各 100 → avg 100
    for (let i = 0; i < 3; i++) { uid++; users.push(user('u' + uid, 'n' + uid, 'd1')); recs.push(rec('u' + uid, '2026-07-01', 100, { locked: true })); }
    // d2: 3 人各 300 → avg 300
    for (let i = 0; i < 3; i++) { uid++; users.push(user('u' + uid, 'n' + uid, 'd2')); recs.push(rec('u' + uid, '2026-07-01', 300, { locked: true })); }
    // d3: 3 人各 200 → avg 200
    for (let i = 0; i < 3; i++) { uid++; users.push(user('u' + uid, 'n' + uid, 'd3')); recs.push(rec('u' + uid, '2026-07-01', 200, { locked: true })); }
    depts.push(dept('d1', '一组'), dept('d2', '二组'), dept('d3', '三组'));
    const store = makeStore({ StepRecord: recs, User: users, Department: depts });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.dept.map((r) => r.dept_id)).toEqual(['d2', 'd3', 'd1']);
    expect(result.dept[0].rank).toBe(1);
  });

  it('小部门（未配置size→退化为绝对下限activeCount<3）不进人均主排名、排后、标small_sample，但仍展示（§657）', async () => {
    // d1: 1 人（小部门）avg=500；d2: 3 人 avg=100。两部门均未配置 size→size=0
    //   → 仅绝对下限 activeCount<minMembers(3)：d1(1<3)=small，d2(3<3)=正常
    // 小部门应排在 d2 之后
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 500, { locked: true }),
        rec('u2', '2026-07-01', 100, { locked: true }),
        rec('u3', '2026-07-01', 100, { locked: true }),
        rec('u4', '2026-07-01', 100, { locked: true })
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd2'), user('u3', '丙', 'd2'), user('u4', '丁', 'd2')],
      Department: [dept('d1', '一组'), dept('d2', '二组')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    const d1 = result.dept.find((r) => r.dept_id === 'd1');
    const d2 = result.dept.find((r) => r.dept_id === 'd2');
    expect(d1.small_sample).toBe(true); // member_count=1 < 3
    expect(d2.small_sample).toBe(false);
    // 排序：d2（主榜）在前，d1（小部门）排后
    expect(d2.rank).toBeLessThan(d1.rank);
    expect(result.dept).toHaveLength(2); // 仍展示
  });

  it('minMembers 可配（阈值=2 时，2 人部门不标 small_sample）', async () => {
    // d1: 2 人；阈值=2 → member_count(2) < 2 为 false → 不标小部门
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-01', 200, { locked: true })
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1')],
      Department: [dept('d1', '一组')]
    });
    const result = await aggregateRanking({
      store, activityId: ACTIVITY_ID, now: NOW, config: { minMembers: 2 }
    });
    expect(result.dept[0].small_sample).toBe(false);
    expect(result.dept[0].member_count).toBe(2);
  });

  it('配置 size 后按 2/3 比例判样本量小（size=9：参与<6→small，≥6→正常）', async () => {
    // d1: size=9，5 人同步 → ceil(9*2/3)=6，5<6 → smallByRatio 触发
    // d2: size=9，6 人同步 → 6<6=false → 不 small
    const users = [];
    const recs = [];
    const depts = [dept('d1', '一组', 0, 9), dept('d2', '二组', 0, 9)];
    let uid = 0;
    for (let i = 0; i < 5; i++) { uid++; users.push(user('u' + uid, 'n' + uid, 'd1')); recs.push(rec('u' + uid, '2026-07-01', 100, { locked: true })); }
    for (let i = 0; i < 6; i++) { uid++; users.push(user('u' + uid, 'n' + uid, 'd2')); recs.push(rec('u' + uid, '2026-07-01', 100, { locked: true })); }
    const store = makeStore({ StepRecord: recs, User: users, Department: depts });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    const d1 = result.dept.find((r) => r.dept_id === 'd1');
    const d2 = result.dept.find((r) => r.dept_id === 'd2');
    expect(d1.small_sample).toBe(true);  // 5<6 比例触发
    expect(d2.small_sample).toBe(false); // 6 达标
  });

  it('size=0 未配置 → 仅绝对下限（向后兼容旧 <3 规则）', async () => {
    // d1: 2 人（size 未配置）→ ratio 不触发，但 2<3 绝对下限 → small
    // d2: 3 人（size 未配置）→ 3<3=false → 不 small
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-01', 100, { locked: true }),
        rec('u3', '2026-07-01', 100, { locked: true }),
        rec('u4', '2026-07-01', 100, { locked: true }),
        rec('u5', '2026-07-01', 100, { locked: true })
      ],
      User: [user('u1', 'a', 'd1'), user('u2', 'b', 'd1'), user('u3', 'c', 'd2'), user('u4', 'd', 'd2'), user('u5', 'e', 'd2')],
      Department: [dept('d1', '一组'), dept('d2', '二组')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    const d1 = result.dept.find((r) => r.dept_id === 'd1');
    const d2 = result.dept.find((r) => r.dept_id === 'd2');
    expect(d1.small_sample).toBe(true);  // 2<3
    expect(d2.small_sample).toBe(false); // 3 达标
  });

  it('比例与绝对下限取严（size=2 全员同步：ratio 不触发但 abs<3 → 仍 small）', async () => {
    // d1: size=2，2 人同步 → ceil(2*2/3)=2，2<2=false（ratio 不触发）；但 2<3 绝对下限 → small
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-01', 100, { locked: true })
      ],
      User: [user('u1', 'a', 'd1'), user('u2', 'b', 'd1')],
      Department: [dept('d1', '一组', 0, 2)]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.dept[0].small_sample).toBe(true);
  });

  it('未同步的部门成员不计入 member_count 分母（R6.2）', async () => {
    // d1: u1 同步 100（有效）+ u2 未同步（无 StepRecord）→ member_count=1
    const store = makeStore({
      StepRecord: [rec('u1', '2026-07-01', 100, { locked: true })],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1')],
      Department: [dept('d1', '一组')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    expect(result.dept[0].member_count).toBe(1);
    expect(result.dept[0].avg_steps).toBe(100);
  });
});

describe('aggregateRanking 幂等（覆盖写 RankCache 单文档，P0-3）', () => {
  it('同输入跑两次 RankCache 结果一致（单文档覆盖写，无残留/无翻倍）', async () => {
    const baseStore = () => makeStore({
      StepRecord: [
        rec('u1', '2026-07-01', 100, { locked: true }),
        rec('u2', '2026-07-01', 200, { locked: true })
      ],
      User: [user('u1', '甲', 'd1'), user('u2', '乙', 'd1')],
      Department: [dept('d1', '一组')]
    });

    const store1 = baseStore();
    const r1 = await aggregateRanking({ store: store1, activityId: ACTIVITY_ID, now: NOW });
    const cacheAfter1 = JSON.parse(JSON.stringify(store1.RankCache));

    // 第二次跑（store 已有第一次的缓存文档，应覆盖写 rows，结果一致、文档数不翻倍）。
    const r2 = await aggregateRanking({ store: store1, activityId: ACTIVITY_ID, now: NOW });
    const cacheAfter2 = JSON.parse(JSON.stringify(store1.RankCache));

    expect(cacheAfter1).toEqual(cacheAfter2);
    expect(r1.personal).toEqual(r2.personal);
    expect(r1.dept).toEqual(r2.dept);
    // 单文档：personal 1 个文档（rows 含 2 行），dept 1 个文档（rows 含 1 行），总 2 个文档不翻倍。
    const personalDoc = store1.RankCache.find((d) => d.type === 'personal');
    const deptDoc = store1.RankCache.find((d) => d.type === 'dept');
    expect(personalDoc.rows).toHaveLength(2);
    expect(deptDoc.rows).toHaveLength(1);
    expect(store1.RankCache).toHaveLength(2);
  });

  it('RankCache 单文档含正确的 type/activity_id/rows/updated_at', async () => {
    const store = makeStore({
      StepRecord: [rec('u1', '2026-07-01', 100, { locked: true })],
      User: [user('u1', '甲', 'd1')],
      Department: [dept('d1', '一组')]
    });
    await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW });
    const p = store.RankCache.find((d) => d.type === 'personal');
    expect(p.activity_id).toBe(ACTIVITY_ID);
    expect(p.updated_at).toBe(NOW.toISOString());
    expect(Array.isArray(p.rows)).toBe(true);
    expect(p.rows[0].rank).toBe(1);
    expect(p.rows[0].user_id).toBe('u1');
  });

  it('overwriteRankCache 单文档覆盖写：同 (type,activity_id) 替换 rows、不同 activity 各自独立', () => {
    // 预置一个 'old' activity 的 personal 文档（模拟其他活动）。
    const store = { RankCache: [
      { type: 'personal', activity_id: 'old', rows: [{ rank: 1, user_id: 'x' }], updated_at: 't0' }
    ] };
    overwriteRankCache(store, 'personal', ACTIVITY_ID, [
      { rank: 1, user_id: 'u1', total_steps: 100 }
    ], '2026-07-03T04:00:00.000Z');
    // 'old' activity 文档保留，ACTIVITY_ID 新增一个文档。
    expect(store.RankCache).toHaveLength(2);
    const newDoc = store.RankCache.find((d) => d.activity_id === ACTIVITY_ID && d.type === 'personal');
    expect(newDoc.rows[0].user_id).toBe('u1');
    // 再次覆盖写同 (type,activity_id)：替换 rows，文档数不增加。
    overwriteRankCache(store, 'personal', ACTIVITY_ID, [
      { rank: 1, user_id: 'u2', total_steps: 200 }
    ], '2026-07-03T05:00:00.000Z');
    expect(store.RankCache).toHaveLength(2);
    const replaced = store.RankCache.find((d) => d.activity_id === ACTIVITY_ID && d.type === 'personal');
    expect(replaced.rows).toHaveLength(1);
    expect(replaced.rows[0].user_id).toBe('u2');
    expect(replaced.updated_at).toBe('2026-07-03T05:00:00.000Z');
  });
});

describe('aggregateRanking 缺参校验', () => {
  it('缺 activityId → BIZ_PARAM_MISSING（参数缺失，非 STEP_ACTIVITY_CLOSED）', async () => {
    await expect(aggregateRanking({ store: { StepRecord: [] } })).rejects.toMatchObject({
      code: CODE.BIZ_PARAM_MISSING
    });
  });
  it('缺 store.StepRecord 抛错', async () => {
    await expect(aggregateRanking({ activityId: ACTIVITY_ID, store: {} })).rejects.toThrow();
  });
});

describe('aggregateRanking 活动期过滤（date<start_date 的脏记录不计入排名）', () => {
  const ACTIVITY = {
    activity_id: ACTIVITY_ID,
    start_time: '2026-07-01T00:00:00+08:00',
    end_time: '2026-07-21T23:59:59+08:00'
  };

  it('脏 locked 记录（活动期外）不计入 total_steps', async () => {
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-06-29', 99999, { locked: true }), // 脏（活动期外）
        rec('u1', '2026-07-01', 100, { locked: true }),  // 活动期内
        rec('u1', '2026-07-03', 50, { locked: false })   // 今日
      ],
      User: [user('u1', '甲', 'd1')]
    });
    const result = await aggregateRanking({
      store, activityId: ACTIVITY_ID, activity: ACTIVITY, now: NOW
    });
    expect(result.personal).toHaveLength(1);
    expect(result.personal[0].total_steps).toBe(150); // 脏 99999 被过滤，仅 100+50
  });

  it('不传 activity（兜底）→ 脏记录照常计入排名', async () => {
    const store = makeStore({
      StepRecord: [
        rec('u1', '2026-06-29', 99999, { locked: true }),
        rec('u1', '2026-07-01', 100, { locked: true })
      ],
      User: [user('u1', '甲', 'd1')]
    });
    const result = await aggregateRanking({ store, activityId: ACTIVITY_ID, now: NOW }); // 无 activity
    expect(result.personal[0].total_steps).toBe(99999 + 100);
  });
});
