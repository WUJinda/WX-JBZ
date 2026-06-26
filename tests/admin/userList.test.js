/**
 * admin.queryUsers 单测（H1）：
 *   - 筛选（deptId / keyword 大小写不敏感）+ 本地分页 + 投影白名单。
 *   - 红线：projectUser 绝不下发 _openid / phone。
 */
const { queryUsers, projectUser, DEFAULT_PAGE_SIZE } = require('../../cloudfunctions/admin/userList');

function user(_id, extra) {
  return Object.assign(
    {
      _id,
      _openid: 'op_' + _id,
      phone: '1380000' + _id,
      nickname: '用户' + _id,
      avatar: 'http://x/' + _id,
      phone_masked: '138****' + _id,
      dept_id: 'd_01',
      join_status: 'joined',
      joined_at: '2026-06-01',
      created_at: '2026-06-01'
    },
    extra || {}
  );
}

describe('queryUsers（用户列表筛选+分页+投影）', () => {
  it('默认返回全部（分页 50）', () => {
    const store = { User: [user('1'), user('2')] };
    const r = queryUsers(store, {});
    expect(r.totalCount).toBe(2);
    expect(r.list).toHaveLength(2);
  });

  it('deptId 等值过滤', () => {
    const store = { User: [user('1', { dept_id: 'd_01' }), user('2', { dept_id: 'd_02' })] };
    const r = queryUsers(store, { deptId: 'd_02' });
    expect(r.totalCount).toBe(1);
    expect(r.list[0]._id).toBe('2');
  });

  it('keyword 模糊匹配 nickname（大小写不敏感）', () => {
    const store = {
      User: [user('1', { nickname: 'Alice' }), user('2', { nickname: 'Bob' }), user('3', { nickname: 'alice2' })]
    };
    const r = queryUsers(store, { keyword: 'ALI' });
    expect(r.totalCount).toBe(2); // Alice + alice2
  });

  it('keyword 模糊匹配 phone_masked', () => {
    const store = { User: [user('1', { phone_masked: '138****1111' }), user('2', { phone_masked: '139****2222' })] };
    const r = queryUsers(store, { keyword: '1111' });
    expect(r.totalCount).toBe(1);
    expect(r.list[0]._id).toBe('1');
  });

  it('本地分页：page + pageSize', () => {
    const users = [];
    for (let i = 0; i < 7; i++) users.push(user('u' + i));
    const store = { User: users };
    const r1 = queryUsers(store, { page: 1, pageSize: 3 });
    expect(r1.totalCount).toBe(7);
    expect(r1.list).toHaveLength(3);
    expect(r1.list[0]._id).toBe('u0');
    const r2 = queryUsers(store, { page: 3, pageSize: 3 });
    expect(r2.list).toHaveLength(1); // 7 - 6 = 1
    expect(r2.list[0]._id).toBe('u6');
  });

  it('DEFAULT_PAGE_SIZE=50', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });
});

describe('projectUser 投影红线（绝不下发 _openid / phone）', () => {
  it('projectUser 输出对象不含 _openid / phone', () => {
    const u = user('x', { _openid: 'secret_openid', phone: '13800000000' });
    const out = projectUser(u);
    expect(out._openid).toBeUndefined();
    expect(out.phone).toBeUndefined();
    // 白名单字段在
    expect(out.nickname).toBe('用户x');
    expect(out.phone_masked).toBe('138****x');
    expect(out.dept_id).toBe('d_01');
    expect(out.join_status).toBe('joined');
  });

  it('queryUsers 返回列表中每一项都不含 _openid / phone', () => {
    const store = { User: [user('1'), user('2')] };
    const r = queryUsers(store, {});
    for (const item of r.list) {
      expect(item._openid).toBeUndefined();
      expect(item.phone).toBeUndefined();
    }
  });

  it('projectUser 仅含白名单字段（逐字段白名单）', () => {
    const u = user('1', { sync_count: 99, unionid: 'secret_unionid', foo: 'bar' });
    const out = projectUser(u);
    expect(out.sync_count).toBeUndefined();
    expect(out.unionid).toBeUndefined();
    expect(out.foo).toBeUndefined();
  });
});
