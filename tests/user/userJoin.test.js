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
      // 已选部门（由 user.chooseDept 设）；join 为纯报名，不应改动它。
      dept_id: 'd_01',
      join_status: 'pending',
      updated_at: '2026-06-01T00:00:00Z'
    },
    userOverrides || {}
  );
  return { store: { User: [user] }, user };
}

describe('user.join 纯函数（纯报名，与选部门解耦）', () => {
  const NOW = new Date('2026-06-26T10:00:00Z');

  describe('findDept（供 chooseDept 复用）', () => {
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
        { join_status: 'joined', dept_id: 'd_01', dept_name: '研发部', joined_at: '2026-06-26T10:00:00.000Z', phone: '13812341234', _openid: 'oU' }
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

    it('user 无 dept_name → dept_name 空串（join 不补部门名，部门名由 chooseDept/profile 提供）', () => {
      const out = projectJoinResult({ join_status: 'joined', dept_id: 'd_01' });
      expect(out.dept_name).toBe('');
    });
  });

  describe('joinDepartment 正常报名（pending → joined，纯报名不动部门）', () => {
    it('设 join_status=joined / joined_at，不动 dept_id', async () => {
      const { store, user } = makeStore({ join_status: 'pending', dept_id: 'd_01' });
      const out = await joinDepartment({ store, openid: 'oU', now: NOW });
      expect(out.join_status).toBe('joined');
      expect(out.dept_id).toBe('d_01'); // 透传已有 dept_id（join 不碰部门）
      expect(out.joined_at).toBe('2026-06-26T10:00:00.000Z');
      // store 中 User 已落库
      expect(user.join_status).toBe('joined');
      expect(user.dept_id).toBe('d_01'); // 部门不变
      expect(user.joined_at).toBe('2026-06-26T10:00:00.000Z');
    });

    it('无部门用户也能报名（dept_id=null 不影响 join）', async () => {
      const { store, user } = makeStore({ join_status: 'pending', dept_id: null });
      const out = await joinDepartment({ store, openid: 'oU', now: NOW });
      expect(out.join_status).toBe('joined');
      expect(user.join_status).toBe('joined');
      expect(user.dept_id).toBeNull(); // join 不设部门
    });
  });

  describe('R1.4 已报名拒绝（防重复报名）', () => {
    it('已 joined 用户再次 join → 拒绝', async () => {
      const { store, user } = makeStore({ join_status: 'joined', dept_id: 'd_01' });
      await expect(
        joinDepartment({ store, openid: 'oU', now: NOW })
      ).rejects.toMatchObject({ code: CODE.AUTH_JOIN_STATUS_DENIED });
      // 未落库（仍 joined，joined_at 不变）
      expect(user.joined_at).toBeUndefined();
    });
  });

  describe('参数校验', () => {
    it('缺 openid → 拒绝 AUTH_NO_OPENID', async () => {
      const { store } = makeStore();
      await expect(
        joinDepartment({ store, openid: '', now: NOW })
      ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('用户不存在 → 拒绝 AUTH_USER_NOT_FOUND', async () => {
      const store = { User: [] };
      await expect(
        joinDepartment({ store, openid: 'oGHOST', now: NOW })
      ).rejects.toMatchObject({ code: CODE.AUTH_USER_NOT_FOUND });
    });

    it('store 缺失 → 拒绝 SYS_DB_ERROR', async () => {
      await expect(
        joinDepartment({ store: null, openid: 'oU' })
      ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
    });
  });

  describe('报名截止 signupDeadline', () => {
    it('未传 signupDeadline → 不校验（不限，兼容活动缺失）', async () => {
      const { store } = makeStore({ join_status: 'pending' });
      const out = await joinDepartment({ store, openid: 'oU', now: NOW });
      expect(out.join_status).toBe('joined');
    });

    it('now < signupDeadline → 正常报名', async () => {
      const { store } = makeStore({ join_status: 'pending' });
      const out = await joinDepartment({
        store, openid: 'oU', now: NOW,
        signupDeadline: '2026-07-31T23:59:59+08:00' // 晚于 NOW(2026-06-26)
      });
      expect(out.join_status).toBe('joined');
    });

    it('now > signupDeadline → 拒绝 BIZ_SIGNUP_ENDED，不落库', async () => {
      const { store, user } = makeStore({ join_status: 'pending' });
      await expect(
        joinDepartment({
          store, openid: 'oU', now: NOW,
          signupDeadline: '2026-06-01T00:00:00Z' // 早于 NOW(2026-06-26)
        })
      ).rejects.toMatchObject({ code: CODE.BIZ_SIGNUP_ENDED });
      // 未落库（仍 pending）
      expect(store.User[0].join_status).toBe('pending');
    });

    it('已报名用户不受截止影响（已报名检查优先于截止）', async () => {
      const { store } = makeStore({ join_status: 'joined', dept_id: 'd_01' });
      // 已 joined + 截止已过 → 仍走 AUTH_JOIN_STATUS_DENIED（非 BIZ_SIGNUP_ENDED）
      await expect(
        joinDepartment({
          store, openid: 'oU', now: NOW,
          signupDeadline: '2026-06-01T00:00:00Z'
        })
      ).rejects.toMatchObject({ code: CODE.AUTH_JOIN_STATUS_DENIED });
    });
  });

  describe('活动终止 activityTerminated', () => {
    it('activityTerminated=true → 拒绝 STEP_ACTIVITY_CLOSED，不落库', async () => {
      const { store } = makeStore({ join_status: 'pending' });
      await expect(
        joinDepartment({ store, openid: 'oU', now: NOW, activityTerminated: true })
      ).rejects.toMatchObject({ code: CODE.STEP_ACTIVITY_CLOSED });
      expect(store.User[0].join_status).toBe('pending');
    });

    it('activityTerminated=false → 正常报名', async () => {
      const { store } = makeStore({ join_status: 'pending' });
      const out = await joinDepartment({ store, openid: 'oU', now: NOW, activityTerminated: false });
      expect(out.join_status).toBe('joined');
    });

    it('未传 activityTerminated → 不校验（兼容活动缺失/旧数据无 terminated 字段）', async () => {
      const { store } = makeStore({ join_status: 'pending' });
      const out = await joinDepartment({ store, openid: 'oU', now: NOW });
      expect(out.join_status).toBe('joined');
    });

    it('terminated 优先于报名截止（活动终止时即使截止未到也拒）', async () => {
      const { store } = makeStore({ join_status: 'pending' });
      await expect(
        joinDepartment({
          store, openid: 'oU', now: NOW,
          activityTerminated: true,
          signupDeadline: '2026-12-31T00:00:00Z' // 截止未到，但活动已终止
        })
      ).rejects.toMatchObject({ code: CODE.STEP_ACTIVITY_CLOSED });
    });

    it('已报名用户优先报 AUTH_JOIN_STATUS_DENIED（即便活动已终止）', async () => {
      const { store } = makeStore({ join_status: 'joined', dept_id: 'd_01' });
      await expect(
        joinDepartment({ store, openid: 'oU', now: NOW, activityTerminated: true })
      ).rejects.toMatchObject({ code: CODE.AUTH_JOIN_STATUS_DENIED });
    });
  });
});
