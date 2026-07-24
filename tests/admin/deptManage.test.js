/**
 * admin 部门管理单测（H1）：createDept / updateDept / deleteDept + 名称唯一。
 */
const { createDept, updateDept, deleteDept } = require('../../cloudfunctions/admin/deptManage');
const { CODE } = require('../../cloudfunctions/common/errors');

const ACT = 'a1';

function makeStore() {
  return {
    Department: [
      { dept_id: 'd_01', name: '一部', activity_id: ACT, member_count: 0, size: 0, created_at: 'old' },
      { dept_id: 'd_02', name: '二部', activity_id: ACT, member_count: 0, size: 0, created_at: 'old' }
    ]
  };
}

describe('createDept（创建部门）', () => {
  it('正常创建：生成 dept_id（d_ 前缀），写入 Department（size 缺省 0）', () => {
    const store = makeStore();
    const r = createDept(store, { activityId: ACT, name: '三部', now: 'NEW' });
    expect(r.name).toBe('三部');
    expect(r.deptId).toMatch(/^d_/);
    expect(r.size).toBe(0);
    expect(store.Department).toHaveLength(3);
    const created = store.Department.find((d) => d.dept_id === r.deptId);
    expect(created.activity_id).toBe(ACT);
    expect(created.created_at).toBe('NEW');
    expect(created.member_count).toBe(0);
    expect(created.size).toBe(0);
  });

  it('创建时带 size：规整为整数≥0 写入', () => {
    const store = makeStore();
    const r = createDept(store, { activityId: ACT, name: '四部', size: 9, now: 'NEW' });
    expect(r.size).toBe(9);
    const created = store.Department.find((d) => d.dept_id === r.deptId);
    expect(created.size).toBe(9);
  });

  it('创建时 size 非法（负数/非数字）→ 兜底 0', () => {
    const store = makeStore();
    const r1 = createDept(store, { activityId: ACT, name: '五部', size: -3, now: 'NEW' });
    expect(r1.size).toBe(0);
    const r2 = createDept(store, { activityId: ACT, name: '六部', size: 'abc', now: 'NEW' });
    expect(r2.size).toBe(0);
  });

  it('名称唯一：同 activity 下重名抛 SYS_DB_ERROR', () => {
    const store = makeStore();
    let err;
    try {
      createDept(store, { activityId: ACT, name: '一部', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('不同 activity 下同名允许（idx_dept_activity_name 按 activity+name 组合唯一）', () => {
    const store = makeStore();
    const r = createDept(store, { activityId: 'a2', name: '一部', now: 'NEW' });
    expect(r.deptId).toMatch(/^d_/);
  });

  it('name 缺失抛 SYS_DB_ERROR', () => {
    const store = makeStore();
    let err;
    try {
      createDept(store, { activityId: ACT, name: '', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });
});

describe('updateDept（更新部门名）', () => {
  it('正常更新（不传 size → 返回规整 size）', () => {
    const store = makeStore();
    const r = updateDept(store, { deptId: 'd_01', name: '新一部', now: 'NEW' });
    expect(r).toEqual({ deptId: 'd_01', name: '新一部', size: 0, updatedAt: 'NEW' });
    expect(store.Department[0].name).toBe('新一部');
  });

  it('更新 size：提供时写入并返回', () => {
    const store = makeStore();
    const r = updateDept(store, { deptId: 'd_01', name: '一部', size: 9, now: 'NEW' });
    expect(r.size).toBe(9);
    expect(store.Department[0].size).toBe(9);
  });

  it('更新时不传 size → 保留原值', () => {
    const store = makeStore();
    store.Department[0].size = 7;
    const r = updateDept(store, { deptId: 'd_01', name: '一部', now: 'NEW' });
    expect(r.size).toBe(7);
    expect(store.Department[0].size).toBe(7);
  });

  it('更新 size 非法 → 兜底 0', () => {
    const store = makeStore();
    const r = updateDept(store, { deptId: 'd_01', name: '一部', size: -5, now: 'NEW' });
    expect(r.size).toBe(0);
    expect(store.Department[0].size).toBe(0);
  });

  it('deptId 不存在抛 BIZ_DEPT_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      updateDept(store, { deptId: 'd_xxx', name: 'x', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
  });

  it('名称唯一（排除自身）：改为他部门名抛 SYS_DB_ERROR', () => {
    const store = makeStore();
    let err;
    try {
      updateDept(store, { deptId: 'd_01', name: '二部', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('改为自身同名允许（幂等）', () => {
    const store = makeStore();
    const r = updateDept(store, { deptId: 'd_01', name: '一部', now: 'NEW' });
    expect(r.name).toBe('一部');
  });
});

describe('deleteDept（删除部门）', () => {
  it('正常删除', () => {
    const store = makeStore();
    const r = deleteDept(store, { deptId: 'd_01' });
    expect(r).toEqual({ deptId: 'd_01', deleted: true });
    expect(store.Department).toHaveLength(1);
    expect(store.Department.find((d) => d.dept_id === 'd_01')).toBeUndefined();
  });

  it('deptId 不存在抛 BIZ_DEPT_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      deleteDept(store, { deptId: 'd_xxx' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
  });

  it('部门下仍有成员 → 拒绝删除抛 SYS_DB_ERROR（孤儿数据防护）', () => {
    const store = makeStore();
    store.User = [
      { _openid: 'oA', dept_id: 'd_01', join_status: 'joined' },
      { _openid: 'oB', dept_id: 'd_01', join_status: 'pending' }
    ];
    let err;
    try {
      deleteDept(store, { deptId: 'd_01' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
    // 部门未被删除（成员未转移前不可删）
    expect(store.Department.find((d) => d.dept_id === 'd_01')).toBeTruthy();
  });
});
