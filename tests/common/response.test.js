const { ok, fail, failFromError } = require('../../cloudfunctions/common/response');
const { CODE, BizError } = require('../../cloudfunctions/common/errors');

describe('response 出参封装', () => {
  it('ok 默认 message=ok 且 data=null', () => {
    expect(ok()).toEqual({ code: 0, message: 'ok', data: null });
  });

  it('ok 携带 data', () => {
    expect(ok({ a: 1 })).toEqual({ code: 0, message: 'ok', data: { a: 1 } });
  });

  it('ok 自定义 message', () => {
    expect(ok(1, 'done')).toEqual({ code: 0, message: 'done', data: 1 });
  });

  it('fail code 非 0', () => {
    const r = fail(CODE.AUTH_NOT_ADMIN, 'forbidden');
    expect(r.code).toBe(CODE.AUTH_NOT_ADMIN);
    expect(r.message).toBe('forbidden');
    expect(r.data).toBeNull();
  });

  it('fail data 可选', () => {
    const r = fail(CODE.BIZ_DEPT_NOT_FOUND, 'no dept', { id: 'x' });
    expect(r.data).toEqual({ id: 'x' });
  });

  it('fail 非 number code 兜底为系统错误', () => {
    const r = fail(undefined, 'oops');
    expect(r.code).toBe(CODE.SYS_DB_ERROR);
  });

  it('failFromError 从 BizError 还原出参', () => {
    const err = BizError(CODE.AUTH_USER_NOT_FOUND, 'no user');
    const r = failFromError(err);
    expect(r).toEqual({ code: CODE.AUTH_USER_NOT_FOUND, message: 'no user', data: null });
  });

  it('failFromError 对普通 Error 兜底为系统错误', () => {
    const r = failFromError(new Error('boom'));
    expect(r.code).toBe(CODE.SYS_DB_ERROR);
    expect(r.message).toBe('boom');
  });
});
