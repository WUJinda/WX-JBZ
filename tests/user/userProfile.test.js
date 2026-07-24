const { projectProfile, projectSteps, getProfile } = require('../../cloudfunctions/user/userProfile');
const { buildStats } = require('../../cloudfunctions/user/userStats');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('user.profile 纯函数', () => {
  describe('projectSteps（累计步数占位）', () => {
    it('数字原样返回（向下取整）', () => {
      expect(projectSteps(12500)).toBe(12500);
      expect(projectSteps(12500.9)).toBe(12500);
    });
    it('数字字符串转数字', () => {
      expect(projectSteps('8000')).toBe(8000);
    });
    it('null/undefined/负数/NaN 兜底为 0', () => {
      expect(projectSteps(null)).toBe(0);
      expect(projectSteps(undefined)).toBe(0);
      expect(projectSteps(-1)).toBe(0);
      expect(projectSteps('abc')).toBe(0);
    });
  });

  describe('projectProfile（脱敏下发）', () => {
    it('不下发原始 openid / unionid', () => {
      const user = {
        _openid: 'oSECRET',
        unionid: 'uSECRET',
        invite_code: 'ABC123',
        nickname: '张明',
        avatar: 'a.jpg',
        dept_id: 'd_01',
        join_status: 'joined',
        total_steps: 12500
      };
      const out = projectProfile(user);
      expect(out).not.toHaveProperty('openid');
      expect(out).not.toHaveProperty('unionid');
      expect(out.invite_code).toBe('ABC123');
      expect(out.nickname).toBe('张明');
      expect(out.dept_id).toBe('d_01');
      expect(out.join_status).toBe('joined');
      expect(out.total_steps).toBe(12500);
      // is_admin 缺失兜底 false（该 user 未置管理员）
      expect(out.is_admin).toBe(false);
    });

    it('invite_code 缺失时为空串', () => {
      const out = projectProfile({});
      expect(out.invite_code).toBe('');
    });

    it('total_steps 缺失兜底为 0', () => {
      const out = projectProfile({});
      expect(out.total_steps).toBe(0);
    });

    it('join_status 缺失兜底为 pending', () => {
      const out = projectProfile({});
      expect(out.join_status).toBe('pending');
    });

    it('is_admin===true 下发为 true（前端 admin 入口门禁依赖此字段）', () => {
      expect(projectProfile({ is_admin: true }).is_admin).toBe(true);
    });

    it('is_admin 缺失/非布尔 true 兜底为 false（严格防误授权）', () => {
      expect(projectProfile({}).is_admin).toBe(false);
      expect(projectProfile({ is_admin: false }).is_admin).toBe(false);
      expect(projectProfile({ is_admin: 'true' }).is_admin).toBe(false); // 字符串 'true' 不认
      expect(projectProfile({ is_admin: 1 }).is_admin).toBe(false); // 数字 1 不认
    });
  });

  describe('getProfile 主逻辑', () => {
    it('按 openid 查到用户并下发 invite_code（不下发 _openid）', async () => {
      const { db } = createMockDb({
        User: [
          {
            _id: 'u_1',
            _openid: 'oU',
            nickname: '张明',
            avatar: 'a.jpg',
            invite_code: 'ABC123',
            dept_id: 'd_01',
            join_status: 'joined'
          }
        ]
      });
      const out = await getProfile({ openid: 'oU', db });
      expect(out.invite_code).toBe('ABC123');
      expect(out.dept_id).toBe('d_01');
      expect(out).not.toHaveProperty('_openid');
    });

    it('dept_id 有值时关联 Department 补 dept_name（修复前端部门显示「未加入」）', async () => {
      const { db } = createMockDb({
        User: [
          {
            _id: 'u_1',
            _openid: 'oU',
            nickname: '张明',
            dept_id: 'd_01',
            join_status: 'joined'
          }
        ],
        Department: [{ _id: 'd_1', dept_id: 'd_01', name: '研发部' }]
      });
      const out = await getProfile({ openid: 'oU', db });
      expect(out.dept_id).toBe('d_01');
      expect(out.dept_name).toBe('研发部');
    });

    it('dept_id 缺省（未报名）或 Department 无匹配 → dept_name 兜底空串', async () => {
      // 未报名：dept_id 缺省
      const { db: db1 } = createMockDb({
        User: [{ _id: 'u_2', _openid: 'oP', join_status: 'pending' }]
      });
      const out1 = await getProfile({ openid: 'oP', db: db1 });
      expect(out1.dept_name).toBe('');
      expect(out1.dept_id).toBe(null);

      // 已报名但 Department 无匹配（脏数据 / 部门被管理员删除）
      const { db: db2 } = createMockDb({
        User: [{ _id: 'u_3', _openid: 'oX', dept_id: 'd_ghost', join_status: 'joined' }],
        Department: []
      });
      const out2 = await getProfile({ openid: 'oX', db: db2 });
      expect(out2.dept_name).toBe('');
      expect(out2.dept_id).toBe('d_ghost'); // dept_id 照常下发，仅 name 兜底
    });

    it('User 不存在抛 AUTH_USER_NOT_FOUND', async () => {
      const { db } = createMockDb({ User: [] });
      await expect(getProfile({ openid: 'oNONE', db })).rejects.toMatchObject({
        code: CODE.AUTH_USER_NOT_FOUND
      });
    });

    it('openid 缺失抛 AUTH_NO_OPENID', async () => {
      const { db } = createMockDb({});
      await expect(getProfile({ db })).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('db 缺失抛 SYS_DB_ERROR', async () => {
      await expect(getProfile({ openid: 'oU' })).rejects.toMatchObject({
        code: CODE.SYS_DB_ERROR
      });
    });

    // 累计步数口径:handler 用 buildStats 实时聚合注入,不再读 User.total_steps 幽灵字段。
    it('totalSteps 形参覆盖 User.total_steps(handler 注入 buildStats 聚合值)', async () => {
      const { db } = createMockDb({
        User: [{ _id: 'u_1', _openid: 'oU', nickname: '张明', total_steps: 12500 }]
      });
      const out = await getProfile({ openid: 'oU', db, totalSteps: 24000 });
      // 形参胜出,忽略 User.total_steps(生产中该字段从不被写、恒 undefined→0)
      expect(out.total_steps).toBe(24000);
    });

    it('不传 totalSteps → 退回读 user.total_steps(向后兼容旧调用)', async () => {
      const { db } = createMockDb({
        User: [{ _id: 'u_1', _openid: 'oU', total_steps: 12500 }]
      });
      const out = await getProfile({ openid: 'oU', db });
      expect(out.total_steps).toBe(12500);
    });

    it('累计步数与 user.stats / home 同源:同 records 喂 buildStats,getProfile 透传其 total_steps', async () => {
      // 模拟 home/user.stats 的聚合输入(活动期内两条有效记录)
      const records = [
        { user_id: 'oU', activity_id: 'a1', date: '2026-07-01', steps: 8000, locked: true, synced_at: '2026-07-01T10:00:00Z' },
        { user_id: 'oU', activity_id: 'a1', date: '2026-07-02', steps: 9000, locked: false, synced_at: '2026-07-02T10:00:00Z' }
      ];
      const activity = {
        activity_id: 'a1',
        start_time: '2026-07-01T00:00:00+08:00',
        end_time: '2026-07-21T23:59:59+08:00'
      };
      const now = new Date('2026-07-02T04:00:00Z'); // 北京 07-02 12:00
      const statsTotal = buildStats({ records, activity, now }).total_steps;
      expect(statsTotal).toBe(8000 + 9000);

      const { db } = createMockDb({
        User: [{ _id: 'u_1', _openid: 'oU', total_steps: 99999 }] // 幽灵字段须被忽略
      });
      // handler 等价路径:buildStats 算 total → 注入 getProfile →「我的」页显示值
      const out = await getProfile({ openid: 'oU', db, totalSteps: statsTotal });
      expect(out.total_steps).toBe(statsTotal); // 与首页 / user.stats 完全一致
    });
  });
});
