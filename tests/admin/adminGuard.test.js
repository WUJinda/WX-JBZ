/**
 * admin.assertAdmin 三态单测（H1）：
 *   - admin 通过返回 user；
 *   - 非 admin 抛 AUTH_NOT_ADMIN；
 *   - openid 缺失 / 用户不存在抛对应错。
 */
const { assertAdmin } = require('../../cloudfunctions/admin/adminGuard');
const { CODE } = require('../../cloudfunctions/common/errors');

function makeStore(users) {
  return { User: users || [] };
}

describe('assertAdmin（管理员守卫三态）', () => {
  it('admin 通过：返回该 user 对象', () => {
    const u = { _id: 'u1', _openid: 'op_admin', nickname: '管理员', is_admin: true };
    const store = makeStore([u, { _id: 'u2', _openid: 'op_x', is_admin: false }]);
    const got = assertAdmin(store, 'op_admin');
    expect(got).toBe(u);
  });

  it('非 admin（is_admin!==true）抛 AUTH_NOT_ADMIN', () => {
    const store = makeStore([{ _id: 'u2', _openid: 'op_normal', is_admin: false }]);
    let err;
    try {
      assertAdmin(store, 'op_normal');
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe(CODE.AUTH_NOT_ADMIN);
  });

  it('is_admin 缺省（!==true）抛 AUTH_NOT_ADMIN', () => {
    const store = makeStore([{ _id: 'u3', _openid: 'op_noadmin' }]);
    let err;
    try {
      assertAdmin(store, 'op_noadmin');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_NOT_ADMIN);
  });

  it('用户不存在（openid 无对应）抛 AUTH_USER_NOT_FOUND', () => {
    const store = makeStore([{ _id: 'u1', _openid: 'op_a', is_admin: true }]);
    let err;
    try {
      assertAdmin(store, 'op_not_exist');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });

  it('openid 缺失抛 AUTH_NO_OPENID', () => {
    const store = makeStore([]);
    let err;
    try {
      assertAdmin(store, '');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_NO_OPENID);
  });

  it('store.User 缺失（空数组兜底）→ 用户不存在抛 AUTH_USER_NOT_FOUND', () => {
    let err;
    try {
      assertAdmin({ User: [] }, 'op_any');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });
});
