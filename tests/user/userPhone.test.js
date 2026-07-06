const {
  setPhone,
  normalizePhoneInput,
  isValidPhone,
  PHONE_MANUAL_FALLBACK_ENABLED
} = require('../../cloudfunctions/user/userPhone');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('user.setPhone 手动填写保底纯函数', () => {
  describe('normalizePhoneInput / isValidPhone（与 authPhone 同源）', () => {
    it('去 +86 国家码（紧跟 11 位，与 authPhone 同口径）', () => {
      expect(normalizePhoneInput('+8613812341234')).toBe('13812341234');
    });
    it('去空格 / 横线分隔（纯号）', () => {
      expect(normalizePhoneInput('138-1234-1234')).toBe('13812341234');
      expect(normalizePhoneInput('138 1234 1234')).toBe('13812341234');
    });
    it('去 86 前缀（紧接 11 位国内号）', () => {
      expect(normalizePhoneInput('8613812341234')).toBe('13812341234');
    });
    it('null/undefined → 空串', () => {
      expect(normalizePhoneInput(null)).toBe('');
      expect(normalizePhoneInput(undefined)).toBe('');
    });
    it('isValidPhone：11 位数字合法', () => {
      expect(isValidPhone('13812341234')).toBe(true);
    });
    it('isValidPhone：非 11 位 / 含非数字 非法', () => {
      expect(isValidPhone('1381234123')).toBe(false);
      expect(isValidPhone('138123412345')).toBe(false);
      expect(isValidPhone('1381234123a')).toBe(false);
      expect(isValidPhone('')).toBe(false);
    });
  });

  describe('降级开关', () => {
    it('默认开启（保底生效，开发/未开通微信组件阶段）', () => {
      expect(PHONE_MANUAL_FALLBACK_ENABLED).toBe(true);
    });
    it('allowFallback=false：抛 SYS_NOT_IMPLEMENTED（强制走 auth.phone）', async () => {
      const { db } = createMockDb({ User: [{ _openid: 'oU' }] });
      await expect(
        setPhone({ openid: 'oU', db, phone: '13812341234', allowFallback: false })
      ).rejects.toMatchObject({ code: CODE.SYS_NOT_IMPLEMENTED });
    });
  });

  describe('setPhone 主逻辑', () => {
    it('合法手机号：写入归一化 phone + 脱敏，返回 phone_masked', async () => {
      const { db, store } = createMockDb({
        User: [{ _id: 'u_1', _openid: 'oU', phone: '' }]
      });
      const out = await setPhone({ openid: 'oU', db, phone: '13812341234' });
      expect(out.phone_masked).toBe('138****1234');
      const me = store.User.find((u) => u._openid === 'oU');
      expect(me.phone).toBe('13812341234');
      expect(me.phone_masked).toBe('138****1234');
      expect(me.updated_at).toBeTruthy();
    });

    it('归一化：带 +86 前缀的号正常写入（库内统一纯 11 位）', async () => {
      const { db, store } = createMockDb({ User: [{ _openid: 'oU', phone: '' }] });
      await setPhone({ openid: 'oU', db, phone: '+8613812341234' });
      expect(store.User.find((u) => u._openid === 'oU').phone).toBe('13812341234');
    });

    it('换号：旧 phone 被覆盖（与 verifyPhone 同为按 openid 覆盖写）', async () => {
      const { db, store } = createMockDb({
        User: [{ _openid: 'oU', phone: '13900001111', phone_masked: '139****1111' }]
      });
      await setPhone({ openid: 'oU', db, phone: '13812341234' });
      const me = store.User.find((u) => u._openid === 'oU');
      expect(me.phone).toBe('13812341234');
      expect(me.phone_masked).toBe('138****1234');
    });

    it('格式非法（短号/含字母/空/纯空白）：抛 BIZ_PARAM_MISSING，不查重不写入', async () => {
      const { db, store } = createMockDb({ User: [{ _openid: 'oU', phone: '' }] });
      for (const bad of ['12345', '1381234123a', '', '   ']) {
        await expect(setPhone({ openid: 'oU', db, phone: bad })).rejects.toMatchObject({
          code: CODE.BIZ_PARAM_MISSING
        });
      }
      expect(store.User.find((u) => u._openid === 'oU').phone).toBe('');
    });

    it('撞他人号：抛 BIZ_PHONE_TAKEN，本人 phone 不变', async () => {
      const { db, store } = createMockDb({
        User: [
          { _openid: 'oU', phone: '' },
          { _openid: 'oOTHER', phone: '13812341234', phone_masked: '138****1234' }
        ]
      });
      await expect(setPhone({ openid: 'oU', db, phone: '13812341234' })).rejects.toMatchObject({
        code: CODE.BIZ_PHONE_TAKEN
      });
      expect(store.User.find((u) => u._openid === 'oU').phone).toBe('');
    });

    it('自身同号（幂等）：phone 已是本人号 → 成功不抛错', async () => {
      const { db } = createMockDb({
        User: [{ _openid: 'oU', phone: '13812341234', phone_masked: '138****1234' }]
      });
      const out = await setPhone({ openid: 'oU', db, phone: '13812341234' });
      expect(out.phone_masked).toBe('138****1234');
    });

    it('User 不存在（update 0 条）：抛 AUTH_USER_NOT_FOUND', async () => {
      const { db } = createMockDb({ User: [{ _openid: 'oOTHER' }] });
      await expect(
        setPhone({ openid: 'oMISSING', db, phone: '13812341234' })
      ).rejects.toMatchObject({ code: CODE.AUTH_USER_NOT_FOUND });
    });

    it('openid 缺失：抛 AUTH_NO_OPENID', async () => {
      const { db } = createMockDb({ User: [{ _openid: 'oU' }] });
      await expect(setPhone({ db, phone: '13812341234' })).rejects.toMatchObject({
        code: CODE.AUTH_NO_OPENID
      });
    });

    it('db 缺失：抛 SYS_DB_ERROR', async () => {
      await expect(setPhone({ openid: 'oU', phone: '13812341234' })).rejects.toMatchObject({
        code: CODE.SYS_DB_ERROR
      });
    });

    it('不下发明文 phone（返回仅 phone_masked）', async () => {
      const { db } = createMockDb({ User: [{ _openid: 'oU' }] });
      const out = await setPhone({ openid: 'oU', db, phone: '13812341234' });
      expect(Object.keys(out).sort()).toEqual(['phone_masked']);
      expect(out).not.toHaveProperty('phone');
    });

    it('安全：不授予 is_admin（手动填写路径不读 superAdminPhone，避免明文伪造超管号提权）', async () => {
      const { db, store } = createMockDb({ User: [{ _openid: 'oU', is_admin: false }] });
      await setPhone({ openid: 'oU', db, phone: '13800000000' });
      const me = store.User.find((u) => u._openid === 'oU');
      expect(me.is_admin).toBe(false);
    });
  });
});
