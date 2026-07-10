/**
 * admin.changeUserDept 单测（H1 R8.3）：
 *   - 校验 userId 存在 / deptId 存在；
 *   - 更新 dept_id + updated_at；
 *   - 幂等（已是该部门不改 updated_at）。
 */
const { changeUserDept } = require('../../cloudfunctions/admin/changeDept');
const { CODE } = require('../../cloudfunctions/common/errors');

function makeStore() {
  return {
    User: [
      { _id: 'u1', _openid: 'op1', dept_id: 'd_01', updated_at: 'old' },
      { _id: 'u2', _openid: 'op2', dept_id: 'd_02', updated_at: 'old' }
    ],
    Department: [
      { dept_id: 'd_01', name: '一部', activity_id: 'a1' },
      { dept_id: 'd_02', name: '二部', activity_id: 'a1' }
    ]
  };
}

describe('changeUserDept（修改用户部门）', () => {
  it('正常修改：更新 dept_id + updated_at', () => {
    const store = makeStore();
    const r = changeUserDept(store, { userId: 'u1', deptId: 'd_02', now: 'NEW' });
    expect(r).toEqual({ userId: 'u1', deptId: 'd_02', updatedAt: 'NEW' });
    expect(store.User[0].dept_id).toBe('d_02');
    expect(store.User[0].updated_at).toBe('NEW');
  });

  it('userId 不存在抛 AUTH_USER_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      changeUserDept(store, { userId: 'nope', deptId: 'd_02', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });

  it('deptId 不存在抛 BIZ_DEPT_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      changeUserDept(store, { userId: 'u1', deptId: 'd_xxx', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
  });

  it('userId 缺失抛 AUTH_USER_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      changeUserDept(store, { userId: '', deptId: 'd_02', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });

  it('deptId 缺失抛 BIZ_DEPT_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      changeUserDept(store, { userId: 'u1', deptId: '', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
  });

  it('幂等：已是该部门不改 updated_at，视为成功', () => {
    const store = makeStore();
    // u1 当前 d_01，updated_at='old'
    const r = changeUserDept(store, { userId: 'u1', deptId: 'd_01', now: 'NEW' });
    expect(r.deptId).toBe('d_01');
    expect(r.updatedAt).toBe('old'); // 未改
    expect(store.User[0].updated_at).toBe('old');
  });

  // 同活动校验（防多活动数据并存时跨活动串部门）
  it('目标部门属当前活动 → 通过', () => {
    const store = makeStore(); // d_01/d_02 均 activity_id='a1'
    const r = changeUserDept(store, { userId: 'u1', deptId: 'd_02', now: 'NEW', activityId: 'a1' });
    expect(r.deptId).toBe('d_02');
    expect(store.User[0].dept_id).toBe('d_02');
  });

  it('目标部门属另一活动 → 抛 BIZ_DEPT_NOT_FOUND（防跨活动串部门）', () => {
    const store = {
      User: [{ _id: 'u1', _openid: 'op1', dept_id: 'd_01', updated_at: 'old' }],
      Department: [{ dept_id: 'd_other', name: '他部', activity_id: 'a2' }] // 属活动 a2
    };
    let err;
    try {
      changeUserDept(store, { userId: 'u1', deptId: 'd_other', now: 'NEW', activityId: 'a1' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
    expect(String(err.message)).toMatch(/不属于当前活动/);
  });

  it('dept.activity_id 缺失 + 传 activityId → 跳过校验通过（兼容历史数据）', () => {
    const store = {
      User: [{ _id: 'u1', _openid: 'op1', dept_id: '', updated_at: 'old' }],
      Department: [{ dept_id: 'd_legacy', name: '老部门' }] // 无 activity_id（历史数据）
    };
    const r = changeUserDept(store, { userId: 'u1', deptId: 'd_legacy', now: 'NEW', activityId: 'a1' });
    expect(r.deptId).toBe('d_legacy');
  });

  it('不传 activityId → 跳过同活动校验（向后兼容）', () => {
    const store = {
      User: [{ _id: 'u1', _openid: 'op1', dept_id: '', updated_at: 'old' }],
      Department: [{ dept_id: 'd_other', name: '他部', activity_id: 'a2' }]
    };
    // 不传 activityId：即使 dept 属 a2 也不校验（兼容旧调用/单测）。
    const r = changeUserDept(store, { userId: 'u1', deptId: 'd_other', now: 'NEW' });
    expect(r.deptId).toBe('d_other');
  });
});
