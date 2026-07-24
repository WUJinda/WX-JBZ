/**
 * rank.personal / rank.dept / rank.deptMembers 业务纯函数单测（G1）：
 * personal 分页+我的排名定位+总人数+updated_at；
 * dept metric avg/total 切换+我的部门排名；
 * deptMembers 按 dept_id 过滤+本人标记。
 *
 * P0-3：RankCache 单文档形态——每 (type,activity_id) 一个文档 {type,activity_id,rows:[...],updated_at}。
 *       getCacheRows 从单文档读 rows，readPersonal/readDept/readDeptMembers 断言不变。
 */
const {
  readPersonal,
  readDept,
  readDeptMembers,
  projectPersonal,
  projectDept,
  DEFAULT_PAGE_SIZE
} = require('../../cloudfunctions/rank/rankQuery');

const ACTIVITY_ID = 'a_demo_001';
const UPDATED_AT = '2026-07-03T04:00:00.000Z';

// P0-3 单文档 helper：把行数组包成一个 RankCache 文档。
function pCache(rows) {
  return [{ type: 'personal', activity_id: ACTIVITY_ID, rows, updated_at: UPDATED_AT }];
}
function dCache(rows) {
  return [{ type: 'dept', activity_id: ACTIVITY_ID, rows, updated_at: UPDATED_AT }];
}

function pRow(rank, userId, total, firstReachAt, deptId, nickname) {
  return {
    rank,
    user_id: userId,
    ref_id: userId,
    total_steps: total,
    first_reach_at: firstReachAt,
    nickname: nickname || ('n_' + userId),
    dept_id: deptId || '',
    dept_name: deptId || '',
    updated_at: UPDATED_AT
  };
}

function dRow(rank, deptId, total, memberCount, avg, small, deptName) {
  return {
    rank,
    dept_id: deptId,
    ref_id: deptId,
    total_steps: total,
    member_count: memberCount,
    avg_steps: avg,
    small_sample: !!small,
    dept_name: deptName || deptId,
    updated_at: UPDATED_AT
  };
}

describe('projectPersonal / projectDept 投影脱敏', () => {
  it('projectPersonal 不下发 _openid/phone/sync_count', () => {
    const out = projectPersonal({
      rank: 1, user_id: 'u1', total_steps: 100, first_reach_at: 't',
      nickname: '张*明', dept_id: 'd1', dept_name: '一组',
      _openid: 'op', phone: '138', sync_count: 3
    });
    expect(out._openid).toBeUndefined();
    expect(out.phone).toBeUndefined();
    expect(out.sync_count).toBeUndefined();
    expect(out.ref_id).toBe('u1');
    expect(out.nickname).toBe('张*明');
  });

  it('projectDept 不下发敏感字段，含 small_sample', () => {
    const out = projectDept({
      rank: 1, dept_id: 'd1', total_steps: 1000, member_count: 3,
      avg_steps: 333, small_sample: false, dept_name: '一组'
    });
    expect(out._openid).toBeUndefined();
    expect(out.small_sample).toBe(false);
    expect(out.avg_steps).toBe(333);
    expect(out.ref_id).toBe('d1');
  });
});

describe('readPersonal 个人榜分页 + 我的排名', () => {
  it('默认分页大小 50', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it('按 rank 升序返回，附 totalCount + updatedAt', async () => {
    const store = { RankCache: pCache([
      pRow(2, 'u2', 200, 't2', 'd1'),
      pRow(1, 'u1', 300, 't1', 'd1'),
      pRow(3, 'u3', 100, 't3', 'd1')
    ]) };
    const result = await readPersonal({ store, activityId: ACTIVITY_ID, userId: 'u1' });
    expect(result.list.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(result.totalCount).toBe(3);
    expect(result.updatedAt).toBe(UPDATED_AT);
  });

  it('分页：page=1,pageSize=2 取前两条', async () => {
    const store = { RankCache: pCache([
      pRow(1, 'u1', 300, 't1', 'd1'),
      pRow(2, 'u2', 200, 't2', 'd1'),
      pRow(3, 'u3', 100, 't3', 'd1')
    ]) };
    const result = await readPersonal({
      store, activityId: ACTIVITY_ID, page: 1, pageSize: 2
    });
    expect(result.list).toHaveLength(2);
    expect(result.list[0].user_id).toBe('u1');
    expect(result.list[1].user_id).toBe('u2');
    expect(result.totalCount).toBe(3); // totalCount 是总数，不是当页数
  });

  it('分页：page=2,pageSize=2 取第三条', async () => {
    const store = { RankCache: pCache([
      pRow(1, 'u1', 300, 't1', 'd1'),
      pRow(2, 'u2', 200, 't2', 'd1'),
      pRow(3, 'u3', 100, 't3', 'd1')
    ]) };
    const result = await readPersonal({
      store, activityId: ACTIVITY_ID, page: 2, pageSize: 2
    });
    expect(result.list).toHaveLength(1);
    expect(result.list[0].user_id).toBe('u3');
  });

  it('myRank：按 user_id 定位我的排名（含 rank/total_steps）', async () => {
    const store = { RankCache: pCache([
      pRow(1, 'u1', 300, 't1', 'd1'),
      pRow(2, 'u2', 200, 't2', 'd1')
    ]) };
    const result = await readPersonal({ store, activityId: ACTIVITY_ID, userId: 'u2' });
    expect(result.myRank).not.toBeNull();
    expect(result.myRank.rank).toBe(2);
    expect(result.myRank.user_id).toBe('u2');
    expect(result.myRank.total_steps).toBe(200);
  });

  it('myRank：未进榜（无该用户）→ null', async () => {
    const store = { RankCache: pCache([pRow(1, 'u1', 300, 't1', 'd1')]) };
    const result = await readPersonal({ store, activityId: ACTIVITY_ID, userId: 'uX' });
    expect(result.myRank).toBeNull();
  });

  it('无数据返回空列表 + totalCount=0 + updatedAt=null', async () => {
    const store = { RankCache: [] };
    const result = await readPersonal({ store, activityId: ACTIVITY_ID, userId: 'u1' });
    expect(result.list).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.myRank).toBeNull();
    expect(result.updatedAt).toBeNull();
  });
});

describe('getCacheRows 多文档兜底（取 updated_at 最新）', () => {
  it('同 (type,activity_id) 多份文档 → 取 updated_at 最新的那份 rows', async () => {
    // 旧文档只含 u_old；新文档只含 u_new。应选中最新文档（u_new 在榜、u_old 不在）。
    const store = { RankCache: [
      { type: 'personal', activity_id: ACTIVITY_ID, updated_at: '2026-07-01T00:00:00.000Z',
        rows: [pRow(1, 'u_old', 100, 't', 'd1')] },
      { type: 'personal', activity_id: ACTIVITY_ID, updated_at: '2026-07-09T00:00:00.000Z',
        rows: [pRow(1, 'u_new', 999, 't', 'd1')] }
    ] };
    const result = await readPersonal({ store, activityId: ACTIVITY_ID, userId: 'u_new' });
    expect(result.list.map((r) => r.user_id)).toEqual(['u_new']);
    expect(result.myRank && result.myRank.user_id).toBe('u_new');
    expect(result.totalCount).toBe(1);
  });

  it('文档顺序无关：最新文档排在数组首位也正确选中', async () => {
    const store = { RankCache: [
      { type: 'personal', activity_id: ACTIVITY_ID, updated_at: '2026-07-09T00:00:00.000Z',
        rows: [pRow(1, 'u_new', 999, 't', 'd1')] },
      { type: 'personal', activity_id: ACTIVITY_ID, updated_at: '2026-07-01T00:00:00.000Z',
        rows: [pRow(1, 'u_old', 100, 't', 'd1')] }
    ] };
    const result = await readPersonal({ store, activityId: ACTIVITY_ID });
    expect(result.list.map((r) => r.user_id)).toEqual(['u_new']);
  });

  it('不同 type 不串档：personal 读取忽略 updated_at 更新的 dept 文档', async () => {
    const store = { RankCache: [
      { type: 'personal', activity_id: ACTIVITY_ID, updated_at: '2026-07-01T00:00:00.000Z',
        rows: [pRow(1, 'u_old', 100, 't', 'd1')] },
      { type: 'dept', activity_id: ACTIVITY_ID, updated_at: '2026-07-09T00:00:00.000Z',
        rows: [dRow(1, 'd1', 1000, 2, 500, false, '一组')] }
    ] };
    // 读 personal：dept 文档 updated_at 更新但 type 不同，不被选中 → 仍取 personal 的 u_old。
    const result = await readPersonal({ store, activityId: ACTIVITY_ID });
    expect(result.list.map((r) => r.user_id)).toEqual(['u_old']);
  });
});

describe('readDept 部门榜（按人均步数排名 + 我的部门排名）', () => {
  // 构造：d1 avg=300 total=900(3人)，d2 avg=200 total=1000(5人)，d3(小部门) avg=500 total=500(1人)
  const store = { RankCache: dCache([
    dRow(1, 'd1', 900, 3, 300, false, '一组'),
    dRow(2, 'd2', 1000, 5, 200, false, '二组'),
    dRow(3, 'd3', 500, 1, 500, true, '三组') // 小部门
  ]) };

  it('按 avg desc 排序，小部门排后', async () => {
    const result = await readDept({ store, activityId: ACTIVITY_ID });
    // 主榜：d1(avg300) > d2(avg200)；小部门 d3 排后
    expect(result.list.map((r) => r.dept_id)).toEqual(['d1', 'd2', 'd3']);
    expect(result.list.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(result.list[2].small_sample).toBe(true);
  });

  it('myDeptRank：按 deptIdOfUser 定位', async () => {
    const result = await readDept({
      store, activityId: ACTIVITY_ID, deptIdOfUser: 'd1'
    });
    expect(result.myDeptRank).not.toBeNull();
    expect(result.myDeptRank.dept_id).toBe('d1');
    expect(result.myDeptRank.avg_steps).toBe(300);
  });

  it('重排不破坏小部门排后规则（§657）', async () => {
    const result = await readDept({ store, activityId: ACTIVITY_ID });
    const smallIdx = result.list.findIndex((r) => r.small_sample);
    const mainIdx = result.list.findIndex((r) => !r.small_sample);
    expect(smallIdx).toBeGreaterThan(mainIdx); // 小部门在主榜之后
  });

  it('重排不污染源 RankCache 文档的 rows（P1-8 深拷贝）', async () => {
    // 同一 store 连续用两次读：源文档 rows 的 rank 不应被重排污染。
    await readDept({ store, activityId: ACTIVITY_ID }); // 会重排赋 rank
    const doc = store.RankCache[0];
    // 源 rows 仍按原始 rank（d1=1,d2=2,d3=3），未被重排改写。
    expect(doc.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('无数据返回空 + myDeptRank=null', async () => {
    const result = await readDept({ store: { RankCache: [] }, activityId: ACTIVITY_ID, deptIdOfUser: 'd1' });
    expect(result.list).toEqual([]);
    expect(result.myDeptRank).toBeNull();
  });
});

describe('readDeptMembers 部门内成员排名（按 dept_id 过滤 + is_me）', () => {
  const store = { RankCache: pCache([
    pRow(1, 'u1', 300, 't1', 'd1', '甲'),
    pRow(2, 'u2', 200, 't2', 'd1', '乙'),
    pRow(3, 'u3', 100, 't3', 'd1', '丙'),
    pRow(1, 'u4', 500, 't4', 'd2', '丁') // 其他部门
  ]) };

  it('按 dept_id 过滤，重排部门内 rank（从 1 起）', async () => {
    const result = await readDeptMembers({
      store, activityId: ACTIVITY_ID, deptId: 'd1', currentUserId: 'u2'
    });
    expect(result.totalCount).toBe(3);
    // 部门内重排：u1(300) rank1, u2(200) rank2, u3(100) rank3
    expect(result.list.map((r) => ({ u: r.user_id, rk: r.rank }))).toEqual([
      { u: 'u1', rk: 1 },
      { u: 'u2', rk: 2 },
      { u: 'u3', rk: 3 }
    ]);
  });

  it('本人标记 is_me=true，其他人 false', async () => {
    const result = await readDeptMembers({
      store, activityId: ACTIVITY_ID, deptId: 'd1', currentUserId: 'u2'
    });
    const me = result.list.find((r) => r.user_id === 'u2');
    const other = result.list.find((r) => r.user_id === 'u1');
    expect(me.is_me).toBe(true);
    expect(other.is_me).toBe(false);
  });

  it('不含其他部门成员', async () => {
    const result = await readDeptMembers({
      store, activityId: ACTIVITY_ID, deptId: 'd1', currentUserId: 'u1'
    });
    expect(result.list.find((r) => r.user_id === 'u4')).toBeUndefined();
  });

  it('分页：pageSize=2 取前两条', async () => {
    const result = await readDeptMembers({
      store, activityId: ACTIVITY_ID, deptId: 'd1', currentUserId: 'u1',
      page: 1, pageSize: 2
    });
    expect(result.list).toHaveLength(2);
    expect(result.totalCount).toBe(3);
  });

  it('无数据（部门无成员）返回空', async () => {
    const result = await readDeptMembers({
      store, activityId: ACTIVITY_ID, deptId: 'dX', currentUserId: 'u1'
    });
    expect(result.list).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('不下发 _openid/phone/sync_count', async () => {
    const result = await readDeptMembers({
      store, activityId: ACTIVITY_ID, deptId: 'd1', currentUserId: 'u1'
    });
    result.list.forEach((r) => {
      expect(r._openid).toBeUndefined();
      expect(r.phone).toBeUndefined();
      expect(r.sync_count).toBeUndefined();
    });
  });

  it('deptMembers 重排不污染源 RankCache 文档的 rows（P1-8 深拷贝）', async () => {
    await readDeptMembers({ store, activityId: ACTIVITY_ID, deptId: 'd1', currentUserId: 'u1' });
    const doc = store.RankCache[0];
    // 源 rows 不应被加上 dept_rank 字段（深拷贝隔离）。
    expect(doc.rows.every((r) => r.dept_rank === undefined)).toBe(true);
  });
});
