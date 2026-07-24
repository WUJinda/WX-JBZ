/**
 * admin.queryPoints 单测（积分台账列表查询）：
 *   - 返回 list + totalCount，每项含 points/dept_name/total_steps；
 *   - deptId 等值过滤 / keyword 模糊匹配 / 分页切片；
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
