const {
  isValidPhone,
  isInWhitelist,
  normalizePhone,
  verifyPhone,
  PHONE_WHITELIST_REQUIRED
} = require('../../cloudfunctions/auth/authPhone');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('auth.phone 纯函数', () => {
  describe('isValidPhone', () => {
    it('11 位数字合法', () => {
      expect(isValidPhone('13812341234')).toBe(true);
    });
    it('非 11 位不合法', () => {
      expect(isValidPhone('123')).toBe(false);
      expect(isValidPhone('123456789012')).toBe(false);
    });
    it('含非数字不合法', () => {
      expect(isValidPhone('138-1234-1234')).toBe(false);
    });
    it('空串不合法', () => {
      expect(isValidPhone('')).toBe(false);
    });
    it('非字符串不合法', () => {
      expect(isValidPhone(null)).toBe(false);
      expect(isValidPhone(13812341234)).toBe(false);
    });
  });

  describe('isInWhitelist（白名单校验）', () => {
    const wl = [{ phone: '13812341234' }, { phone: '15900001111' }];

    it('白名单内手机号命中', () => {
      expect(isInWhitelist('13812341234', wl)).toBe(true);
      expect(isInWhitelist('15900001111', wl)).toBe(true);
    });

    it('白名单外手机号不命中', () => {
      expect(isInWhitelist('13700000000', wl)).toBe(false);
    });

    it('非合法手机号一律不命中', () => {
      expect(isInWhitelist('123', wl)).toBe(false);
    });

    it('whitelist 非数组不命中', () => {
      expect(isInWhitelist('13812341234', null)).toBe(false);
      expect(isInWhitelist('13812341234', undefined)).toBe(false);
    });
  });

  describe('normalizePhone（脱敏）', () => {
    it('合法手机号返回完整号 + 脱敏号', () => {
      const r = normalizePhone('13812341234');
      expect(r.phone).toBe('13812341234');
      expect(r.phone_masked).toBe('138****1234');
    });

    it('非合法手机号抛 SYS_EXTERNAL_ERROR', () => {
      try {
        normalizePhone('123');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.code).toBe(CODE.SYS_EXTERNAL_ERROR);
      }
    });
  });

  describe('verifyPhone 主逻辑（强制白名单分支 requireWhitelist:true）', () => {
    it('白名单内手机号：校验通过，更新 User，仅下发脱敏号', async () => {
      const { db, store } = createMockDb({
        Whitelist: [{ phone: '13812341234' }],
        User: [{ _id: 'u_1', _openid: 'oU', phone: '', phone_masked: '' }]
      });
      const out = await verifyPhone({
        openid: 'oU',
        phone: '13812341234',
        db,
        requireWhitelist: true
      });
      expect(out.verified).toBe(true);
      expect(out.phone_masked).toBe('138****1234');
      // 完整号写入 User，不下发出参
      expect(out).not.toHaveProperty('phone');
      expect(store.User[0].phone).toBe('13812341234');
      expect(store.User[0].phone_masked).toBe('138****1234');
    });

    it('白名单外手机号：抛 BIZ_NOT_IN_WHITELIST', async () => {
      const { db } = createMockDb({
        Whitelist: [{ phone: '13812341234' }],
        User: [{ _id: 'u_1', _openid: 'oU' }]
      });
      await expect(
        verifyPhone({ openid: 'oU', phone: '13700000000', db, requireWhitelist: true })
      ).rejects.toMatchObject({ code: CODE.BIZ_NOT_IN_WHITELIST });
    });

    it('User 不存在：抛 AUTH_USER_NOT_FOUND', async () => {
      const { db } = createMockDb({
        Whitelist: [{ phone: '13812341234' }],
        User: []
      });
      await expect(
        verifyPhone({ openid: 'oMISSING', phone: '13812341234', db, requireWhitelist: true })
      ).rejects.toMatchObject({ code: CODE.AUTH_USER_NOT_FOUND });
    });

    it('openid 缺失：抛 AUTH_NO_OPENID', async () => {
      const { db } = createMockDb({});
      await expect(
        verifyPhone({ phone: '13812341234', db, requireWhitelist: true })
      ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('db 缺失：抛 SYS_DB_ERROR', async () => {
      await expect(
        verifyPhone({ openid: 'oU', phone: '13812341234', requireWhitelist: true })
      ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
    });
  });

  describe('白名单开关（PHONE_WHITELIST_REQUIRED）', () => {
    it('当前生产配置：PHONE_WHITELIST_REQUIRED === false（放开注册，任意手机号可注册）', () => {
      // 文档化当前生产配置；切回 true 需改源码并同步本断言。
      expect(PHONE_WHITELIST_REQUIRED).toBe(false);
    });

    it('requireWhitelist:false 时白名单外手机号也可通过（任意手机号注册）', async () => {
      const { db, store } = createMockDb({
        Whitelist: [], // 白名单为空
        User: [{ _id: 'u_1', _openid: 'oU', phone: '', phone_masked: '' }]
      });
      const out = await verifyPhone({
        openid: 'oU',
        phone: '13700000000', // 不在任何白名单
        db,
        requireWhitelist: false
      });
      expect(out.verified).toBe(true);
      expect(out.phone_masked).toBe('137****0000');
      expect(store.User[0].phone).toBe('13700000000');
    });

    it('不传 requireWhitelist 时跟随模块常量（当前 false → 放开）', async () => {
      const { db } = createMockDb({
        Whitelist: [],
        User: [{ _id: 'u_1', _openid: 'oU', phone: '', phone_masked: '' }]
      });
      // 不传 requireWhitelist：行为由 PHONE_WHITELIST_REQUIRED 决定（= false → 通过）
      const out = await verifyPhone({ openid: 'oU', phone: '13812341234', db });
      expect(out.verified).toBe(true);
    });
  });
});
