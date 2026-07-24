const {
  registerUser,
  validateNickname,
  NICKNAME_MAX_LEN
} = require('../../cloudfunctions/auth/authRegister');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

function unusedCode(code) {
  return {
    code,
    status: 'unused',
    batch_id: 'b1',
    created_by: 'admin',
    created_at: new Date('2026-07-01'),
    note: ''
  };
}

describe('auth.register 纯函数', () => {
  describe('validateNickname（与 userAccount/editCalc 同口径）', () => {
    it('trim 后 1..NICKNAME_MAX_LEN 码点合法', () => {
      expect(validateNickname('张明')).toBe(true);
      expect(validateNickname('  张明  ')).toBe(true);
      expect(validateNickname('a')).toBe(true);
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN))).toBe(true);
    });

    it('空串 / 纯空格 / 非字符串 不合法', () => {
      expect(validateNickname('')).toBe(false);
      expect(validateNickname('   ')).toBe(false);
      expect(validateNickname(null)).toBe(false);
      expect(validateNickname(123)).toBe(false);
    });

    it('超过 NICKNAME_MAX_LEN 码点不合法', () => {
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN + 1))).toBe(false);
    });
  });

  describe('registerUser 主逻辑（消费邀请码 + 一次性建号）', () => {
    it('全新用户：消费邀请码 + add 建号，invite_code 写入，join_status=pending，is_admin=false（不授超管）', async () => {
      const { db, store } = createMockDb({
        User: [],
        InviteCode: [unusedCode('ABCDEF')]
      });
      const out = await registerUser({
        openid: 'oNEW',
        nickname: '新人',
        avatar: 'cloud://a.jpg',
        inviteCode: 'ABCDEF',
        db,
        now: new Date('2026-07-08T10:00:00Z')
      });
      expect(out.registered).toBe(true);
      expect(out.is_new).toBe(true);
      expect(out.invite_code).toBe('ABCDEF');
      expect(out.join_status).toBe('pending');
      expect(store.User.length).toBe(1);
      expect(store.User[0]._openid).toBe('oNEW');
      expect(store.User[0].invite_code).toBe('ABCDEF');
      expect(store.User[0].join_status).toBe('pending');
      expect(store.User[0].is_admin).toBe(false); // 邀请码注册不授超管
      expect(store.User[0].nickname).toBe('新人');
      // 邀请码被消费：status=used + used_by
      expect(store.InviteCode[0].status).toBe('used');
      expect(store.InviteCode[0].used_by).toBe('oNEW');
    });

    it('邀请码归一化：小写/带横线/误读字符（I→1）→ 归一化后消费', async () => {
      const { db, store } = createMockDb({
        User: [],
        InviteCode: [unusedCode('ABC123')]
      });
      // 'abc-i23' → 大写 ABC-I23 → 去横线 ABCI23 → I→1 → ABC123
      const out = await registerUser({ openid: 'oX', nickname: '张三', inviteCode: 'abc-i23', db });
      expect(out.invite_code).toBe('ABC123');
      expect(store.InviteCode[0].status).toBe('used');
    });

    it('已存在用户（重复提交/竞态）→ 幂等返回 is_new:false，不重复消费邀请码', async () => {
      const { db, store } = createMockDb({
        User: [{ _id: 'u1', _openid: 'oME', nickname: '我', invite_code: 'OLD123', join_status: 'pending' }],
        InviteCode: [unusedCode('NEW123')]
      });
      const out = await registerUser({ openid: 'oME', nickname: '我', inviteCode: 'NEW123', db });
      expect(out.registered).toBe(true);
      expect(out.is_new).toBe(false);
      expect(out.invite_code).toBe('OLD123'); // 沿用已建号时的码
      expect(store.User.length).toBe(1); // 不新增
      expect(store.InviteCode[0].status).toBe('unused'); // 未消费新码
    });

    it('昵称格式非法 → BIZ_PARAM_MISSING（不消费码）', async () => {
      const { db, store } = createMockDb({ User: [], InviteCode: [unusedCode('ABC123')] });
      await expect(
        registerUser({ openid: 'oX', nickname: '', inviteCode: 'ABC123', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
      expect(store.InviteCode[0].status).toBe('unused'); // 未消费
    });

    it('缺邀请码 → BIZ_PARAM_MISSING', async () => {
      const { db } = createMockDb({ User: [] });
      await expect(
        registerUser({ openid: 'oX', nickname: '张三', inviteCode: '', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
    });

    it('邀请码格式非法（非 6 位 Crockford）→ BIZ_INVITE_CODE_INVALID', async () => {
      const { db } = createMockDb({ User: [] });
      await expect(
        registerUser({ openid: 'oX', nickname: '张三', inviteCode: 'ZZZZZZZZ', db }) // 8 位
      ).rejects.toMatchObject({ code: CODE.BIZ_INVITE_CODE_INVALID });
    });

    it('邀请码已被使用 → BIZ_INVITE_CODE_USED', async () => {
      const { db } = createMockDb({
        User: [],
        InviteCode: [{ code: 'ABC123', status: 'used', used_by: 'oOTHER', batch_id: 'b1', created_by: 'admin', created_at: new Date('2026-07-01'), note: '' }]
      });
      await expect(
        registerUser({ openid: 'oNEW', nickname: '新人', inviteCode: 'ABC123', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_INVITE_CODE_USED });
    });

    it('邀请码已被禁用 → BIZ_INVITE_CODE_DISABLED', async () => {
      const { db } = createMockDb({
        User: [],
        InviteCode: [{ code: 'ABC123', status: 'disabled', batch_id: 'b1', created_by: 'admin', created_at: new Date('2026-07-01'), note: '' }]
      });
      await expect(
        registerUser({ openid: 'oNEW', nickname: '新人', inviteCode: 'ABC123', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_INVITE_CODE_DISABLED });
    });

    it('邀请码不存在 → BIZ_INVITE_CODE_INVALID', async () => {
      const { db } = createMockDb({ User: [], InviteCode: [] });
      await expect(
        registerUser({ openid: 'oNEW', nickname: '新人', inviteCode: 'ABC123', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_INVITE_CODE_INVALID });
    });

    it('avatar 可选：空串允许建号（后续 profile.edit 补）', async () => {
      const { db, store } = createMockDb({ User: [], InviteCode: [unusedCode('ABC123')] });
      await registerUser({ openid: 'oX', nickname: '张三', avatar: '', inviteCode: 'ABC123', db });
      expect(store.User[0].avatar).toBe('');
    });

    it('openid 缺失 → AUTH_NO_OPENID', async () => {
      const { db } = createMockDb({ User: [], InviteCode: [unusedCode('ABC123')] });
      await expect(
        registerUser({ nickname: '张三', inviteCode: 'ABC123', db })
      ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('db 缺失 → SYS_DB_ERROR', async () => {
      await expect(
        registerUser({ openid: 'oX', nickname: '张三', inviteCode: 'ABC123' })
      ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
    });
  });

  it('NICKNAME_MAX_LEN === 20（与 userAccount/editCalc 同口径）', () => {
    expect(NICKNAME_MAX_LEN).toBe(20);
  });
});
