/**
 * user.chooseDept 单测（选部门，与报名解耦）：
 *   - 写 dept_id + updated_at，不动 join_status；
 *   - 部门已选定不可换（已选不同部门 → BIZ_DEPT_LOCKED）；
 *   - 同部门幂等（不改 updated_at）；
 *   - 部门不存在 / 用户不存在 / 缺参 → 对应错误码。
 */
const { chooseDepartment, projectChooseDeptResult } = require('../../cloudfunctions/user/userChooseDept');
const { CODE } = require('../../cloudfunctions/common/errors');
const { MOCK_DEPARTMENTS } = require('../../cloudfunctions/dept/deptList');

function makeStore(userOverrides) {
  const user = Object.assign(
    {
      _id: 'u_1',
      _openid: 'oU',
      nickname: '张明',
      phone: '13812341234',
      phone_masked: '138****1234',
      dept_id: null,
      join_status: 'pending',
      updated_at: '2026-06-01T00:00:00Z'
    },
    userOverrides || {}
  );
  return { store: { User: [user], Department: MOCK_DEPARTMENTS }, user };
}

// 同步抛错捕获（与 admin/changeDept.test.js 同范式）。
function catchCode(fn) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  return err;
}

describe('user.chooseDept 纯函数（选部门，与报名解耦）', () => {
  const NOW = new Date('2026-06-26T10:00:00Z');

  describe('projectChooseDeptResult 脱敏下发', () => {
    it('输出 dept_id/dept_name/join_status/updated_at，不下发 phone/openid', () => {
      const out = projectChooseDeptResult(
        { dept_id: 'd_01', join_status: 'pending', updated_at: '2026-06-26T10:00:00.000Z', phone: '13812341234', _openid: 'oU' },
        { name: '研发部' }
      );
      expect(out).toEqual({
        dept_id: 'd_01',
        dept_name: '研发部',
        join_status: 'pending',
        updated_at: '2026-06-26T10:00:00.000Z'
      });
      expect(out).not.toHaveProperty('phone');
      expect(out).not.toHaveProperty('openid');
    });
  });

  describe('chooseDepartment 正常选部门（写 dept_id，不碰 join_status）', () => {
    it('首次选部门：设 dept_id / updated_at，join_status 保持 pending', () => {
      const { store, user } = makeStore({ dept_id: null, join_status: 'pending' });
      const out = chooseDepartment({ store, openid: 'oU', deptId: 'd_01', now: NOW });
      expect(out.dept_id).toBe('d_01');
      expect(out.dept_name).toBe('研发部');
      expect(out.join_status).toBe('pending'); // 不碰 join_status
      expect(user.dept_id).toBe('d_01');
      expect(user.join_status).toBe('pending'); // 仍是 pending（报名由 join 单独触发）
      expect(user.updated_at).toBe('2026-06-26T10:00:00.000Z');
    });

    it('同部门重复选择 → 幂等成功，不改 updated_at', () => {
      const { store, user } = makeStore({ dept_id: 'd_01', updated_at: '2026-06-01T00:00:00Z' });
      const out = chooseDepartment({ store, openid: 'oU', deptId: 'd_01', now: NOW });
      expect(out.dept_id).toBe('d_01');
      expect(user.updated_at).toBe('2026-06-01T00:00:00Z'); // 幂等不改
    });
  });

  describe('部门已选定不可换', () => {
    it('已选 d_01 再选 d_02 → 拒绝 BIZ_DEPT_LOCKED（决策3 专用码）', () => {
      const { store, user } = makeStore({ dept_id: 'd_01' });
      const err = catchCode(() =>
        chooseDepartment({ store, openid: 'oU', deptId: 'd_02', now: NOW })
      );
      expect(err.code).toBe(CODE.BIZ_DEPT_LOCKED);
      expect(user.dept_id).toBe('d_01'); // 未被改
    });
  });

  describe('参数校验', () => {
    it('缺 dept_id → 拒绝 BIZ_DEPT_NOT_FOUND', () => {
      const { store } = makeStore();
      const err = catchCode(() =>
        chooseDepartment({ store, openid: 'oU', deptId: '', now: NOW })
      );
      expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
    });

    it('部门不存在 → 拒绝 BIZ_DEPT_NOT_FOUND', () => {
      const { store } = makeStore();
      const err = catchCode(() =>
        chooseDepartment({ store, openid: 'oU', deptId: 'd_nope', now: NOW })
      );
      expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
    });

    it('Department 源缺失 → 拒绝 BIZ_DEPT_NOT_FOUND（不回退 mock）', () => {
      const store = { User: [{ _openid: 'oU', dept_id: null }] };
      const err = catchCode(() =>
        chooseDepartment({ store, openid: 'oU', deptId: 'd_01', now: NOW })
      );
      expect(err.code).toBe(CODE.BIZ_DEPT_NOT_FOUND);
    });

    it('缺 openid → 拒绝 AUTH_NO_OPENID', () => {
      const { store } = makeStore();
      const err = catchCode(() =>
        chooseDepartment({ store, openid: '', deptId: 'd_01', now: NOW })
      );
      expect(err.code).toBe(CODE.AUTH_NO_OPENID);
    });

    it('用户不存在 → 拒绝 AUTH_USER_NOT_FOUND', () => {
      const store = { User: [], Department: MOCK_DEPARTMENTS };
      const err = catchCode(() =>
        chooseDepartment({ store, openid: 'oGHOST', deptId: 'd_01', now: NOW })
      );
      expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
    });

    it('store 缺失 → 拒绝 SYS_DB_ERROR', () => {
      const err = catchCode(() =>
        chooseDepartment({ store: null, openid: 'oU', deptId: 'd_01' })
      );
      expect(err.code).toBe(CODE.SYS_DB_ERROR);
    });
  });
});
