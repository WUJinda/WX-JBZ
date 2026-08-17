/**
 * admin.queryPoints 单测（积分台账列表查询）：
 *   - 返回 list + totalCount，每项含 points/dept_name/total_steps；
 *   - deptId 等值过滤 / keyword 模糊匹配 / 分页切片；
 *   - 排序（2026-08-17）：积分降序第一优先级，同分按步数降序、_id 升序稳定兜底；
 *   - RankCache 缺失 total_steps 兜底 0 / 旧用户无 points 兜底 0；
 *   - 投影红线：绝不下发 _openid / phone / sync_count。
 */
const {
  queryPoints,
  projectPointUser,
  POINT_USER_FIELDS,
  DEFAULT_PAGE_SIZE
} = require('../../cloudfunctions/admin/pointList');

function user(_id, extra) {
  return Object.assign(
    {
      _id,
      _openid: 'op_' + _id,
      nickname: '用户' + _id,
      dept_id: 'd_01',
      join_status: 'joined',
      points: 0
    },
    extra || {}
  );
}

describe('queryPoints 查询/筛选/分页', () => {
  it('返回 list + totalCount，每项含 points/dept_name/total_steps', () => {
    const store = {
      User: [user('u1', { points: 7 }), user('u2', { points: 3, dept_id: 'd_02' })],
      Department: [{ dept_id: 'd_01', name: '一部' }, { dept_id: 'd_02', name: '二部' }],
      RankCache: [
        {
          type: 'personal',
          activity_id: 'a1',
          rows: [{ user_id: 'op_u1', total_steps: 500 }, { user_id: 'op_u2', total_steps: 300 }]
        }
      ]
    };
    const r = queryPoints(store, { activityId: 'a1' });
    expect(r.totalCount).toBe(2);
    expect(r.list[0]).toMatchObject({ _id: 'u1', points: 7, dept_name: '一部', total_steps: 500 });
    expect(r.list[1]).toMatchObject({ _id: 'u2', points: 3, dept_name: '二部', total_steps: 300 });
  });

  it('deptId 等值过滤', () => {
    const store = {
      User: [
        user('u1', { dept_id: 'd_01' }),
        user('u2', { dept_id: 'd_02' }),
        user('u3', { dept_id: 'd_01' })
      ],
      Department: []
    };
    const r = queryPoints(store, { deptId: 'd_01' });
    expect(r.totalCount).toBe(2);
    expect(r.list.map((u) => u._id)).toEqual(['u1', 'u3']);
  });

  it('keyword 模糊匹配 nickname（大小写不敏感）', () => {
    const store = {
      User: [user('u1', { nickname: 'Alice' }), user('u2', { nickname: 'Bob' })],
      Department: []
    };
    const r = queryPoints(store, { keyword: 'ali' });
    expect(r.totalCount).toBe(1);
    expect(r.list[0]._id).toBe('u1');
  });

  it('分页：pageSize 切片，末页剩 1 条', () => {
    const users = [];
    for (let i = 0; i < 7; i++) users.push(user('u' + i));
    const store = { User: users, Department: [] };
    const r1 = queryPoints(store, { page: 1, pageSize: 3 });
    expect(r1.totalCount).toBe(7);
    expect(r1.list).toHaveLength(3);
    const r3 = queryPoints(store, { page: 3, pageSize: 3 });
    expect(r3.list).toHaveLength(1); // 末页剩 1 条
  });

  it('RankCache 缺失时 total_steps 兜底 0', () => {
    const store = { User: [user('u1', { points: 5 })], Department: [] };
    const r = queryPoints(store, {});
    expect(r.list[0].total_steps).toBe(0);
  });

  it('旧用户无 points 字段 → 兜底 0', () => {
    const store = {
      User: [{ _id: 'u1', _openid: 'op_u1', nickname: '甲', dept_id: 'd_01', join_status: 'joined' }],
      Department: []
    };
    const r = queryPoints(store, {});
    expect(r.list[0].points).toBe(0);
  });
});

describe('queryPoints 排序（积分降序第一优先级，2026-08-17 需求）', () => {
  const rankCache = (stepsByOpenid) => ({
    type: 'personal',
    activity_id: 'a1',
    rows: Object.keys(stepsByOpenid).map((k) => ({ user_id: k, total_steps: stepsByOpenid[k] }))
  });

  it('乱序插入 → 按积分降序返回（替代插入序）', () => {
    const store = {
      User: [user('u1', { points: 3 }), user('u2', { points: 12 }), user('u3', { points: 7 })],
      Department: []
    };
    const r = queryPoints(store, {});
    expect(r.list.map((u) => u._id)).toEqual(['u2', 'u3', 'u1']);
    expect(r.list.map((u) => u.points)).toEqual([12, 7, 3]);
  });

  it('同分 → total_steps 降序（步数多者靠前）', () => {
    const store = {
      User: [user('u1', { points: 5 }), user('u2', { points: 5 }), user('u3', { points: 5 })],
      Department: [],
      RankCache: [rankCache({ op_u1: 300, op_u2: 900, op_u3: 100 })]
    };
    const r = queryPoints(store, { activityId: 'a1' });
    expect(r.list.map((u) => u._id)).toEqual(['u2', 'u1', 'u3']);
  });

  it('同分同步数 → _id 升序稳定兜底；旧用户无 points 兑底 0 与 0 分并列', () => {
    const noPoints = { _id: 'u0', _openid: 'op_u0', nickname: '旧用户', dept_id: 'd_01', join_status: 'joined' };
    const store = {
      User: [user('u2', { points: 0 }), noPoints, user('u1', { points: 0 })],
      Department: []
    };
    const r = queryPoints(store, {});
    expect(r.list.map((u) => u._id)).toEqual(['u0', 'u1', 'u2']);
  });

  it('负分排在末尾（正分 > 0 分 > 负分）', () => {
    const store = {
      User: [user('u1', { points: -5 }), user('u2', { points: 0 }), user('u3', { points: 2 })],
      Department: []
    };
    const r = queryPoints(store, {});
    expect(r.list.map((u) => u._id)).toEqual(['u3', 'u2', 'u1']);
  });

  it('分页在排序后切片：高积分在前几页', () => {
    const users = [];
    for (let i = 0; i < 6; i++) users.push(user('u' + i, { points: i })); // 积分 0..5，插入序为升序
    const store = { User: users, Department: [] };
    const r1 = queryPoints(store, { page: 1, pageSize: 3 });
    expect(r1.list.map((u) => u.points)).toEqual([5, 4, 3]);
    const r2 = queryPoints(store, { page: 2, pageSize: 3 });
    expect(r2.list.map((u) => u.points)).toEqual([2, 1, 0]);
  });

  it('排序不改变 store.User 原始数组顺序（纯函数无副作用）', () => {
    const store = {
      User: [user('u1', { points: 1 }), user('u2', { points: 9 })],
      Department: []
    };
    queryPoints(store, {});
    expect(store.User.map((u) => u._id)).toEqual(['u1', 'u2']);
  });
});

describe('queryPoints 投影红线（绝不下发 _openid / phone / sync_count）', () => {
  it('POINT_USER_FIELDS 不含 _openid / phone / sync_count', () => {
    expect(POINT_USER_FIELDS).not.toContain('_openid');
    expect(POINT_USER_FIELDS).not.toContain('phone');
    expect(POINT_USER_FIELDS).not.toContain('sync_count');
  });

  it('projectPointUser 输出不含敏感字段', () => {
    const u = {
      _id: 'u1',
      _openid: 'op_u1',
      nickname: '甲',
      dept_id: 'd_01',
      join_status: 'joined',
      points: 5,
      phone: '13800001111',
      sync_count: 3
    };
    const out = projectPointUser(u, '一部', 100);
    expect(out._openid).toBeUndefined();
    expect(out.phone).toBeUndefined();
    expect(out.sync_count).toBeUndefined();
    expect(out.join_status).toBeUndefined(); // 白名单也不含 join_status
    expect(out).toMatchObject({ _id: 'u1', nickname: '甲', dept_id: 'd_01', points: 5, dept_name: '一部', total_steps: 100 });
  });

  it('DEFAULT_PAGE_SIZE = 50', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });
});
