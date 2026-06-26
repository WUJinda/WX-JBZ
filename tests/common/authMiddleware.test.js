const { getOpenid, authMiddleware } = require('../../cloudfunctions/common/authMiddleware');
const { CODE, BizError } = require('../../cloudfunctions/common/errors');

describe('authMiddleware 鉴权骨架', () => {
  describe('getOpenid', () => {
    it('能从注入的 getWXContext 取到 OPENID', () => {
      const getWXContext = () => ({ OPENID: 'oABC123', UNIONID: 'uid-1' });
      const r = getOpenid(getWXContext);
      expect(r.openid).toBe('oABC123');
      expect(r.unionid).toBe('uid-1');
    });

    it('OPENID 缺失时抛鉴权错误', () => {
      const getWXContext = () => ({});
      try {
        getOpenid(getWXContext);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe(CODE.AUTH_NO_OPENID);
      }
    });

    it('OPENID 为空字符串时抛鉴权错误', () => {
      const getWXContext = () => ({ OPENID: '' });
      expect(() => getOpenid(getWXContext)).toThrow();
    });

    it('getWXContext 非函数时抛鉴权错误', () => {
      try {
        getOpenid(null);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.code).toBe(CODE.AUTH_NO_OPENID);
      }
    });
  });

  describe('authMiddleware', () => {
    it('默认不强制 User 存在，返回 openid 上下文', () => {
      const getWXContext = () => ({ OPENID: 'oXYZ' });
      const ctx = authMiddleware({ getWXContext });
      expect(ctx.openid).toBe('oXYZ');
    });

    it('requireUser 当前为骨架占位，不抛错（DB 逻辑留给后续轮次）', () => {
      const getWXContext = () => ({ OPENID: 'oXYZ' });
      // 本轮不实现 DB 查询，仅保证不报错地拿到 openid
      const ctx = authMiddleware({ getWXContext, requireUser: true });
      expect(ctx.openid).toBe('oXYZ');
    });

    it('身份仅来自 OPENID，绝不涉及 token 字段', () => {
      const getWXContext = () => ({ OPENID: 'oTOKEN_FREE', token: 'fake' });
      const ctx = authMiddleware({ getWXContext });
      // 鉴权上下文只含 openid，不应包含任何 token 字段
      expect(ctx).not.toHaveProperty('token');
      expect(ctx.openid).toBe('oTOKEN_FREE');
    });
  });
});
