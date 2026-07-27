const {
  validateNickname,
  validateAvatar,
  projectUpdateResult,
  updateProfile,
  cancelAccount,
  NICKNAME_MAX_LEN
} = require('../../cloudfunctions/user/userAccount');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('user.update / user.cancel 纯函数', () => {
  describe('validateNickname', () => {
    it('正常昵称合法', () => {
      expect(validateNickname('张明')).toBe(true);
    });
    it('前后空白被 trim', () => {
      expect(validateNickname('  张明  ')).toBe(true);
    });
    it('空串 / 纯空白非法', () => {
      expect(validateNickname('')).toBe(false);
      expect(validateNickname('   ')).toBe(false);
    });
    it('达到上限长度合法（按码点计）', () => {
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN))).toBe(true);
    });
    it('超过上限非法', () => {
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN + 1))).toBe(false);
    });
    it('emoji 按码点计数（非 UTF-16 码元）', () => {
      // 2 个 emoji = 2 码点 → 合法
      expect(validateNickname('😀😄')).toBe(true);
    });
    it('非字符串非法', () => {
      expect(validateNickname(null)).toBe(false);
      expect(validateNickname(undefined)).toBe(false);
      expect(validateNickname(123)).toBe(false);
    });
  });

  describe('validateAvatar', () => {
    it('非空字符串合法（fileID / URL 均可）', () => {
      expect(validateAvatar('cloud://env.abc/avatar.jpg')).toBe(true);
      expect(validateAvatar('https://x.com/a.png')).toBe(true);
    });
    it('空串 / 非字符串非法', () => {
      expect(validateAvatar('')).toBe(false);
      expect(validateAvatar(null)).toBe(false);
      expect(validateAvatar(undefined)).toBe(false);
    });
    it('超长非法', () => {
      expect(validateAvatar('a'.repeat(1025))).toBe(false);
    });
  });

  describe('projectUpdateResult', () => {
    it('摘出 nickname/avatar/updated_at，不下发敏感字段', () => {
      const out = projectUpdateResult({
        nickname: '张明',
        avatar: 'a.jpg',
        updated_at: '2026-07-06T00:00:00Z',
        _openid: 'oSECRET',
        phone: '13812341234'
      });
      expect(out.nickname).toBe('张明');
      expect(out.avatar).toBe('a.jpg');
      expect(out.updated_at).toBe('2026-07-06T00:00:00Z');
      expect(out).not.toHaveProperty('_openid');
      expect(out).not.toHaveProperty('phone');
    });
    it('字段缺失兜底', () => {
      const out = projectUpdateResult({});
      expect(out.nickname).toBe('');
      expect(out.avatar).toBe('');
      expect(out.updated_at).toBe(null);
    });
  });

  describe('updateProfile 主逻辑', () => {
    it('合法昵称头像：更新 User 并下发结果', async () => {
      const { db } = createMockDb({
        User: [{ _id: 'u_1', _openid: 'oU', nickname: '', avatar: '' }]
      });
      const out = await updateProfile({
        openid: 'oU',
        db,
        nickname: '张明',
        avatar: 'cloud://env.abc/a.jpg'
      });
      expect(out.nickname).toBe('张明');
      expect(out.avatar).toBe('cloud://env.abc/a.jpg');
      expect(out.updated_at).toBeTruthy();
    });

    it('昵称非法：抛 BIZ_PARAM_MISSING', async () => {
      const { db } = createMockDb({ User: [{ _openid: 'oU' }] });
      await expect(
        updateProfile({ openid: 'oU', db, nickname: '', avatar: 'a.jpg' })
      ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
    });

    it('头像非法：抛 BIZ_PARAM_MISSING', async () => {
      const { db } = createMockDb({ User: [{ _openid: 'oU' }] });
      await expect(
        updateProfile({ openid: 'oU', db, nickname: '张明', avatar: '' })
      ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
    });

    it('User 不存在：抛 AUTH_USER_NOT_FOUND', async () => {
      const { db } = createMockDb({ User: [] });
      await expect(
        updateProfile({ openid: 'oMISSING', db, nickname: '张明', avatar: 'a.jpg' })
      ).rejects.toMatchObject({ code: CODE.AUTH_USER_NOT_FOUND });
    });

    it('openid 缺失：抛 AUTH_NO_OPENID', async () => {
      const { db } = createMockDb({ User: [{ _openid: 'oU' }] });
      await expect(
        updateProfile({ db, nickname: '张明', avatar: 'a.jpg' })
      ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('db 缺失：抛 SYS_DB_ERROR', async () => {
      await expect(
        updateProfile({ openid: 'oU', nickname: '张明', avatar: 'a.jpg' })
      ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
    });

    it('仅更新本人（不波及其他 User）', async () => {
      const { db, store } = createMockDb({
        User: [
          { _id: 'u_1', _openid: 'oU', nickname: 'old', avatar: 'old.jpg' },
          { _id: 'u_2', _openid: 'oOTHER', nickname: 'keep', avatar: 'keep.jpg' }
        ]
      });
      await updateProfile({ openid: 'oU', db, nickname: 'new', avatar: 'new.jpg' });
      const me = store.User.find((u) => u._openid === 'oU');
      const other = store.User.find((u) => u._openid === 'oOTHER');
      expect(me.nickname).toBe('new');
      expect(me.avatar).toBe('new.jpg');
      expect(other.nickname).toBe('keep');
      expect(other.avatar).toBe('keep.jpg');
    });
  });

  describe('cancelAccount 主逻辑', () => {
    it('删除本人 StepRecord + User，返回计数', async () => {
      const { db, store } = createMockDb({
        StepRecord: [
          { _id: 's_1', user_id: 'oU', date: '2026-07-03', steps: 8000 },
          { _id: 's_2', user_id: 'oU', date: '2026-07-04', steps: 9000 },
          { _id: 's_3', user_id: 'oOTHER', date: '2026-07-03', steps: 5000 }
        ],
        User: [
          { _id: 'u_1', _openid: 'oU', nickname: '张明' },
          { _id: 'u_2', _openid: 'oOTHER', nickname: '李四' }
        ]
      });
      const out = await cancelAccount({ openid: 'oU', db });
      expect(out.deleted_steps).toBe(2);
      expect(out.deleted_user).toBe(1);
      // 仅删本人，他人数据保留
      expect(store.StepRecord.filter((s) => s.user_id === 'oU')).toHaveLength(0);
      expect(store.StepRecord.filter((s) => s.user_id === 'oOTHER')).toHaveLength(1);
      expect(store.User.find((u) => u._openid === 'oU')).toBeUndefined();
      expect(store.User.find((u) => u._openid === 'oOTHER')).toBeTruthy();
    });

    it('注销时释放邀请码：used → unused，清 used_by / used_at', async () => {
      const { db, store } = createMockDb({
        StepRecord: [],
        User: [
          { _id: 'u_1', _openid: 'oU', invite_code: 'ABC123' }
        ],
        InviteCode: [
          { code: 'ABC123', status: 'used', used_by: 'oU', used_at: new Date('2026-07-20'), batch_id: 'b1', created_at: new Date('2026-07-01'), note: '张明 / 软件开发中心' }
        ]
      });
      const out = await cancelAccount({ openid: 'oU', db, inviteCode: 'ABC123' });
      expect(out.released_code).toBe(true);
      expect(out.deleted_user).toBe(1);
      // 邀请码已复位
      const code = store.InviteCode.find((c) => c.code === 'ABC123');
      expect(code.status).toBe('unused');
      expect(code.used_by).toBe('');
      expect(code.used_at).toBeNull();
    });

    it('注销时邀请码已被管理员处理（不存在/已删）：released_code=false，不阻断注销', async () => {
      const { db } = createMockDb({
        StepRecord: [],
        User: [{ _openid: 'oU', invite_code: 'GONE' }],
        InviteCode: []
      });
      const out = await cancelAccount({ openid: 'oU', db, inviteCode: 'GONE' });
      expect(out.released_code).toBe(false);
      expect(out.deleted_user).toBe(1);
    });

    it('不传 inviteCode 时跳过释放（released_code=false）', async () => {
      const { db, store } = createMockDb({
        StepRecord: [],
        User: [{ _openid: 'oU' }],
        InviteCode: [
          { code: 'ABC123', status: 'used', used_by: 'oU' }
        ]
      });
      const out = await cancelAccount({ openid: 'oU', db });
      expect(out.released_code).toBe(false);
      // 码仍保持 used（未被触碰）
      expect(store.InviteCode[0].status).toBe('used');
    });

    it('仅释放本人码：他人使用的同码不受影响', async () => {
      const { db, store } = createMockDb({
        StepRecord: [],
        User: [{ _openid: 'oU', invite_code: 'ABC123' }],
        InviteCode: [
          { code: 'ABC123', status: 'used', used_by: 'oOTHER', used_at: new Date('2026-07-19') }
        ]
      });
      const out = await cancelAccount({ openid: 'oU', db, inviteCode: 'ABC123' });
      expect(out.released_code).toBe(false);
      // used_by 不是 oU，码未被复位
      expect(store.InviteCode[0].status).toBe('used');
      expect(store.InviteCode[0].used_by).toBe('oOTHER');
    });

    it('幂等：无数据时删 0 条不抛错', async () => {
      const { db } = createMockDb({ StepRecord: [], User: [] });
      const out = await cancelAccount({ openid: 'oNONE', db });
      expect(out.deleted_steps).toBe(0);
      expect(out.deleted_user).toBe(0);
    });

    it('不下发敏感字段（仅返回计数与释放标志）', async () => {
      const { db } = createMockDb({
        StepRecord: [{ user_id: 'oU' }],
        User: [{ _openid: 'oU', phone: '13812341234' }]
      });
      const out = await cancelAccount({ openid: 'oU', db });
      expect(Object.keys(out).sort()).toEqual(['deleted_steps', 'deleted_user', 'released_code']);
    });

    it('openid 缺失：抛 AUTH_NO_OPENID', async () => {
      const { db } = createMockDb({});
      await expect(cancelAccount({ db })).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('db 缺失：抛 SYS_DB_ERROR', async () => {
      await expect(cancelAccount({ openid: 'oU' })).rejects.toMatchObject({
        code: CODE.SYS_DB_ERROR
      });
    });
  });
});
