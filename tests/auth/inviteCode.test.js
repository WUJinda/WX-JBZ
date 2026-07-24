const {
  normalizeInviteCode,
  validateInviteCode,
  consumeCode,
  CROCKFORD_ALPHABET,
  CODE_LENGTH
} = require('../../cloudfunctions/auth/inviteCode');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

function codeDoc(code, status, extra) {
  return Object.assign(
    { code, status, batch_id: 'b1', created_by: 'admin', created_at: new Date('2026-07-01'), note: '' },
    extra || {}
  );
}

describe('auth/inviteCode 工具与消费纯函数', () => {
  describe('normalizeInviteCode', () => {
    it('转大写 + 去空格/横线', () => {
      expect(normalizeInviteCode('abc-123')).toBe('ABC123');
      expect(normalizeInviteCode(' a b c 1 2 3 ')).toBe('ABC123');
    });

    it('宽容解码误读字符 O→0 / I或L→1 / U→V', () => {
      // O→0, I→1, L→1, U→V
      expect(normalizeInviteCode('OILU')).toBe('011V');
    });

    it('null/空 → 空串', () => {
      expect(normalizeInviteCode(null)).toBe('');
      expect(normalizeInviteCode('')).toBe('');
    });
  });

  describe('validateInviteCode', () => {
    it('6 位 Crockford 字符合法', () => {
      expect(validateInviteCode('ABC123')).toBe(true);
      expect(validateInviteCode('07KM9P')).toBe(true);
    });

    it('长度非 6 → false', () => {
      expect(validateInviteCode('ABC12')).toBe(false);
      expect(validateInviteCode('ABC1234')).toBe(false);
    });

    it('含非 Crockford 字符（I/L/O/U）→ false', () => {
      expect(validateInviteCode('ABC12I')).toBe(false);
      expect(validateInviteCode('ABC12L')).toBe(false);
      expect(validateInviteCode('ABC12O')).toBe(false);
      expect(validateInviteCode('ABC12U')).toBe(false);
    });

    it('非字符串 → false', () => {
      expect(validateInviteCode(null)).toBe(false);
      expect(validateInviteCode(123456)).toBe(false);
    });
  });

  describe('consumeCode（原子消费 unused→used）', () => {
    it('unused 码 → 消费成功，写 status=used + used_by + used_at', async () => {
      const { db, store } = createMockDb({ InviteCode: [codeDoc('ABC123', 'unused')] });
      const now = new Date('2026-07-08');
      const out = await consumeCode({ db, code: 'ABC123', openid: 'oNEW', now });
      expect(out.code).toBe('ABC123');
      expect(out.used_at).toBe(now);
      expect(store.InviteCode[0].status).toBe('used');
      expect(store.InviteCode[0].used_by).toBe('oNEW');
      expect(store.InviteCode[0].used_at).toBe(now);
    });

    it('used 码 → BIZ_INVITE_CODE_USED', async () => {
      const { db } = createMockDb({ InviteCode: [codeDoc('ABC123', 'used', { used_by: 'oOTHER' })] });
      await expect(consumeCode({ db, code: 'ABC123', openid: 'oNEW' })).rejects.toMatchObject({
        code: CODE.BIZ_INVITE_CODE_USED
      });
    });

    it('disabled 码 → BIZ_INVITE_CODE_DISABLED', async () => {
      const { db } = createMockDb({ InviteCode: [codeDoc('ABC123', 'disabled')] });
      await expect(consumeCode({ db, code: 'ABC123', openid: 'oNEW' })).rejects.toMatchObject({
        code: CODE.BIZ_INVITE_CODE_DISABLED
      });
    });

    it('码不存在 → BIZ_INVITE_CODE_INVALID', async () => {
      const { db } = createMockDb({ InviteCode: [] });
      await expect(consumeCode({ db, code: 'ABC123', openid: 'oNEW' })).rejects.toMatchObject({
        code: CODE.BIZ_INVITE_CODE_INVALID
      });
    });

    it('格式非法 → BIZ_INVITE_CODE_INVALID（不查库）', async () => {
      const { db } = createMockDb({ InviteCode: [] });
      await expect(consumeCode({ db, code: 'ZZ', openid: 'oNEW' })).rejects.toMatchObject({
        code: CODE.BIZ_INVITE_CODE_INVALID
      });
    });

    it('缺 db → SYS_DB_ERROR；缺 openid → AUTH_NO_OPENID', async () => {
      await expect(consumeCode({ code: 'ABC123', openid: 'oNEW' })).rejects.toMatchObject({
        code: CODE.SYS_DB_ERROR
      });
      const { db } = createMockDb({ InviteCode: [codeDoc('ABC123', 'unused')] });
      await expect(consumeCode({ db, code: 'ABC123', openid: '' })).rejects.toMatchObject({
        code: CODE.AUTH_NO_OPENID
      });
    });
  });

  it('常量：CODE_LENGTH=6；Crockford 字母表 32 字符且排除 I/L/O/U', () => {
    expect(CODE_LENGTH).toBe(6);
    expect(CROCKFORD_ALPHABET.length).toBe(32);
    ['I', 'L', 'O', 'U'].forEach((ch) => {
      expect(CROCKFORD_ALPHABET.indexOf(ch), `字母表不应含 ${ch}`).toBe(-1);
    });
  });
});
