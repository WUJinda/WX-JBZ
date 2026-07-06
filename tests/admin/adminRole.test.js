/**
 * admin.setAdminRole 单测（管理员任命/撤销）：
 *   - 正常任命（false→true）/ 撤销他人（true→false）；
 *   - userId 不存在 / 缺失 → AUTH_USER_NOT_FOUND；
 *   - isAdmin 非布尔 → BIZ_PARAM_MISSING；
 *   - 自我降级（取消自己的管理员）→ BIZ_SELF_DEMOTE_FORBIDDEN；
 *   - 幂等（已是目标状态不改 updated_at）。
 */
const { setAdminRole } = require('../../cloudfunctions/admin/adminRole');
const { CODE } = require('../../cloudfunctions/common/errors');

function makeStore() {
  return {
    User: [
      { _id: 'u1', _openid: 'op_admin', is_admin: true, updated_at: 'old' },
      { _id: 'u2', _openid: 'op_user', is_admin: false, updated_at: 'old' }
    ]
  };
}

describe('setAdminRole（任命/撤销管理员）', () => {
  it('任命普通用户为管理员：is_admin→true + updated_at', () => {
    const store = makeStore();
    const r = setAdminRole(store, { userId: 'u2', isAdmin: true, callerOpenid: 'op_admin', now: 'NEW' });
    expect(r).toEqual({ userId: 'u2', isAdmin: true, updatedAt: 'NEW' });
    expect(store.User[1].is_admin).toBe(true);
    expect(store.User[1].updated_at).toBe('NEW');
  });

  it('撤销他人管理员：is_admin→false + updated_at', () => {
    const store = makeStore();
    // caller 是另一个管理员（op_other），目标 u1（op_admin）不是 caller 自己 → 允许撤销。
    const r = setAdminRole(store, { userId: 'u1', isAdmin: false, callerOpenid: 'op_other', now: 'NEW' });
    expect(r).toEqual({ userId: 'u1', isAdmin: false, updatedAt: 'NEW' });
    expect(store.User[0].is_admin).toBe(false);
  });

  it('自我降级（取消自己的管理员）抛 BIZ_SELF_DEMOTE_FORBIDDEN 且不改库', () => {
    const store = makeStore();
    let err;
    try {
      setAdminRole(store, { userId: 'u1', isAdmin: false, callerOpenid: 'op_admin', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_SELF_DEMOTE_FORBIDDEN);
    expect(store.User[0].is_admin).toBe(true);
  });

  it('任命自己（isAdmin=true）不触发自我降级拦截，幂等成功', () => {
    // isAdmin=true 时即便目标是 caller 自己也不算「降级」，放行；且已是 true → 幂等。
    const store = makeStore();
    const r = setAdminRole(store, { userId: 'u1', isAdmin: true, callerOpenid: 'op_admin', now: 'NEW' });
    expect(r.isAdmin).toBe(true);
    expect(r.updatedAt).toBe('old'); // 幂等未改
  });

  it('userId 不存在抛 AUTH_USER_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      setAdminRole(store, { userId: 'nope', isAdmin: true, callerOpenid: 'op_admin', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });

  it('userId 缺失抛 AUTH_USER_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      setAdminRole(store, { userId: '', isAdmin: true, callerOpenid: 'op_admin', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });

  it('isAdmin 非布尔抛 BIZ_PARAM_MISSING', () => {
    const store = makeStore();
    let err;
    try {
      setAdminRole(store, { userId: 'u2', isAdmin: 'true', callerOpenid: 'op_admin', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('幂等：已是目标状态不改 updated_at，视为成功', () => {
    const store = makeStore();
    // u2 当前 is_admin=false，再设 false → 不改 updated_at。
    const r = setAdminRole(store, { userId: 'u2', isAdmin: false, callerOpenid: 'op_admin', now: 'NEW' });
    expect(r.isAdmin).toBe(false);
    expect(r.updatedAt).toBe('old');
    expect(store.User[1].updated_at).toBe('old');
  });
});
