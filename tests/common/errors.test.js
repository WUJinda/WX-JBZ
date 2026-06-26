const { CODE, BizError, notImplemented } = require('../../cloudfunctions/common/errors');

describe('errors 模块', () => {
  it('CODE 成功码为 0', () => {
    expect(CODE.OK).toBe(0);
  });

  it('错误码分段符合架构 §12', () => {
    // 1xxx 鉴权
    expect(String(CODE.AUTH_NO_OPENID)).toMatch(/^1\d{3}$/);
    expect(String(CODE.AUTH_NOT_ADMIN)).toMatch(/^1\d{3}$/);
    // 2xxx 业务
    expect(String(CODE.BIZ_NOT_IN_WHITELIST)).toMatch(/^2\d{3}$/);
    // 3xxx 步数
    expect(String(CODE.STEP_DECRYPT_FAILED)).toMatch(/^3\d{3}$/);
    // 5xxx 系统
    expect(String(CODE.SYS_DB_ERROR)).toMatch(/^5\d{3}$/);
    expect(String(CODE.SYS_NOT_IMPLEMENTED)).toMatch(/^5\d{3}$/);
  });

  it('BizError 构造出带 code 的 Error', () => {
    const err = BizError(CODE.AUTH_NO_OPENID, 'openid missing');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BizError');
    expect(err.code).toBe(CODE.AUTH_NO_OPENID);
    expect(err.message).toBe('openid missing');
  });

  it('BizError 默认 message', () => {
    const err = BizError(CODE.SYS_DB_ERROR);
    expect(err.message).toBe('biz error');
  });

  it('BizError 携带可选 data', () => {
    const err = BizError(CODE.BIZ_NOT_IN_WHITELIST, '不在白名单', { phone: 'x' });
    expect(err.data).toEqual({ phone: 'x' });
  });

  it('notImplemented 返回 5xxx 系统码且 message 含 not implemented', () => {
    const err = notImplemented('auth.login');
    expect(err.code).toBe(CODE.SYS_NOT_IMPLEMENTED);
    expect(err.message).toContain('not implemented');
    expect(err.message).toContain('auth.login');
  });
});
