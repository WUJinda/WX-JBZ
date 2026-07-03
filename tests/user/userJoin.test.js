const {
  joinDepartment,
  findDept,
  projectJoinResult
} = require('../../cloudfunctions/user/userJoin');
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

describe('user.join 纯函数（D1）', () => {
  const NOW = new Date('2026-06-26T10:00:00Z');

  describe('findDept', () => {
    it('按 dept_id 命中', () => {
      expect(findDept('d_01', MOCK_DEPARTMENTS).name).toBe('研发部');
    });
    it('不存在返回 null', () => {
      expect(findDept('d_xx', MOCK_DEPARTMENTS)).toBeNull();
    });
    it('缺参返回 null', () => {
      expect(findDept('', MOCK_DEPARTMENTS)).toBeNull();
      expect(findDept('d_01', null)).toBeNull();
    });
  });

  describe('projectJoinResult 脱敏下发', () => {
    it('输出 join_status/dept_id/dept_name/joined_at，不下发 phone/openid', () => {
      const out = projectJoinResult(
        { join_status: 'joined', dept_id: 'd_01', joined_at: '2026-06-26T10:00:00.000Z', phone: '13812341234', _openid: 'oU' },
        { name: '研发部' }
      );
      expect(out).toEqual({
        join_status: 'joined',
        dept_id: 'd_01',
        dept_name: '研发部',
        joined_at: '2026-06-26T10:00:00.000Z'
      });
      expect(out).not.toHaveProperty('phone');
      expect(out).not.toHaveProperty('openid');
    });
  });

  describe('joinDepartment 正常报名（pending → joined）', () => {
    it('设 dept_id / join_status=joined / joined_at', async () => {
      const { store, user } = makeStore({ join_status: 'pending' });
      const out = await joinDepartment({ store, openid: 'oU', deptId: 'd_01', now: NOW });
      expect(out.join_status).toBe('joined');
      expect(out.dept_id).toBe('d_01');
      expect(out.dept_name).toBe('研发部');
      expect(out.joined_at).toBe('2026-06-26T10:00:00.000Z');
      // store 中 User 已落库
      expect(user.dept_id).toBe('d_01');
      expect(user.join_status).toBe('joined');
      expect(user.joined_at).toBe('2026-06-26T10:00:00.000Z');
    });

    it('F5：Department 注入源缺失时抛错（不再回退 mock，避免 join 到假部门）', async () => {
      const store = { User: [{ _openid: 'oU', join_status: 'pending' }] };
      await expect(
        joinDepartment({ store, openid: 'oU', deptId: 'd_02', now: NOW })
      ).rejects.toMatchObject({ code: CODE.BIZ_DEPT_NOT_FOUND });
    });
  });

  describe('R1.4 / R2.2 已报名拒绝（防重复 + 不可自改）', () => {
    it('已 joined 用户再次 join 同部门 → 拒绝', async () => {
      const { store } = makeStore({ join_status: 'joined', dept_id: 'd_01' });
      await expect(
        joinDepartment({ store, openid: 'oU', deptId: 'd_01', now: NOW })
      ).rejects.toMatchObject({ code: CODE.AUTH_JOIN_STATUS_DENIED });
    });

    it('已 joined 用户改 join 不同部门 → 仍拒绝（不可自改）', async () => {
      const { store } = makeStore({ join_status: 'joined', dept_id: 'd_01' });
      await expect(
        joinDepartment({ store, openid: 'oU', deptId: 'd_02', now: NOW })
      ).rejects.toMatchObject({ code: CODE.AUTH_JOIN_STATUS_DENIED });
    });
  });

  describe('参数校验', () => {
    it('缺 dept_id → 拒绝 BIZ_DEPT_NOT_FOUND', async () => {
      const { store } = makeStore();
      await expect(
        joinDepartment({ store, openid: 'oU', deptId: '', now: NOW })
      ).rejects.toMatchObject({ code: CODE.BIZ_DEPT_NOT_FOUND });
    });

    it('部门不存在 → 拒绝 BIZ_DEPT_NOT_FOUND', async () => {
      const { store } = makeStore();
      await expect(
        joinDepartment({ store, openid: 'oU', deptId: 'd_nope', now: NOW })
      ).rejects.toMatchObject({ code: CODE.BIZ_DEPT_NOT_FOUND });
    });

    it('缺 openid → 拒绝 AUTH_NO_OPENID', async () => {
      const { store } = makeStore();
      await expect(
        joinDepartment({ store, openid: '', deptId: 'd_01', now: NOW })
      ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('用户不存在 → 拒绝 AUTH_USER_NOT_FOUND', async () => {
      const store = { User: [], Department: MOCK_DEPARTMENTS };
      await expect(
        joinDepartment({ store, openid: 'oGHOST', deptId: 'd_01', now: NOW })
      ).rejects.toMatchObject({ code: CODE.AUTH_USER_NOT_FOUND });
    });

    it('store 缺失 → 拒绝 SYS_DB_ERROR', async () => {
      await expect(
        joinDepartment({ store: null, openid: 'oU', deptId: 'd_01' })
      ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
    });
  });
});
