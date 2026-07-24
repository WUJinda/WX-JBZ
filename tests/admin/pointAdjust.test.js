/**
 * admin.adjustPoints 单测（管理员手动调整积分，对齐 changeDept.test.js 范式）：
 *   - 加分 / 扣分（负 delta）/ delta=0 幂等；
 *   - delta 字符串数字归一 / 旧用户无 points 兜底；
 *   - 校验：userId 缺失/不存在抛 AUTH_USER_NOT_FOUND；delta 缺失/非整数抛 BIZ_PARAM_MISSING；
 *     缺 store.User 抛 SYS_DB_ERROR。
 *   - 就地改 store（无 _dirty，直接验 store.User[0].points）。
 */
const { adjustPoints } = require('../../cloudfunctions/admin/pointAdjust');
const { CODE } = require('../../cloudfunctions/common/errors');

function makeStore() {
  return {
    User: [
      { _id: 'u1', _openid: 'op1', dept_id: 'd_01', points: 5, updated_at: 'old' },
      { _id: 'u2', _openid: 'op2', dept_id: 'd_02', points: 0, updated_at: 'old' }
    ]
  };
}

describe('adjustPoints（管理员手动调整积分）', () => {
  it('正常加分：points += delta + updated_at', () => {
    const store = makeStore();
    const r = adjustPoints(store, { userId: 'u1', delta: 3, now: 'NEW' });
    expect(r).toEqual({ userId: 'u1', points: 8, delta: 3, updatedAt: 'NEW' });
    expect(store.User[0].points).toBe(8);
    expect(store.User[0].updated_at).toBe('NEW');
  });

  it('正常扣分（负 delta）', () => {
    const store = makeStore();
    const r = adjustPoints(store, { userId: 'u1', delta: -5, now: 'NEW' });
    expect(r.points).toBe(0);
    expect(store.User[0].points).toBe(0);
  });

  it('delta=0 幂等成功（points 不变，updated_at 刷新）', () => {
    const store = makeStore();
    const r = adjustPoints(store, { userId: 'u1', delta: 0, now: 'NEW' });
    expect(r.points).toBe(5);
    expect(store.User[0].updated_at).toBe('NEW');
  });

  it('delta 字符串数字（JSON 传输）→ Number() 归一', () => {
    const store = makeStore();
    const r = adjustPoints(store, { userId: 'u1', delta: '3', now: 'NEW' });
    expect(r.points).toBe(8);
    expect(r.delta).toBe(3);
  });

  it('旧用户无 points（undefined）→ 兜底 0 后 +=', () => {
    const store = { User: [{ _id: 'u1', _openid: 'op1', dept_id: 'd_01', updated_at: 'old' }] };
    const r = adjustPoints(store, { userId: 'u1', delta: 5, now: 'NEW' });
    expect(r.points).toBe(5);
    expect(store.User[0].points).toBe(5);
  });
});

describe('adjustPoints 校验', () => {
  it('userId 缺失 → AUTH_USER_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      adjustPoints(store, { userId: '', delta: 3, now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });

  it('userId 不存在 → AUTH_USER_NOT_FOUND', () => {
    const store = makeStore();
    let err;
    try {
      adjustPoints(store, { userId: 'nope', delta: 3, now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.AUTH_USER_NOT_FOUND);
  });

  it('delta 缺失 → BIZ_PARAM_MISSING', () => {
    const store = makeStore();
    let err;
    try {
      adjustPoints(store, { userId: 'u1', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('delta 非整数（1.5）→ BIZ_PARAM_MISSING', () => {
    const store = makeStore();
    let err;
    try {
      adjustPoints(store, { userId: 'u1', delta: 1.5, now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('delta 非数字字符串（abc）→ BIZ_PARAM_MISSING', () => {
    const store = makeStore();
    let err;
    try {
      adjustPoints(store, { userId: 'u1', delta: 'abc', now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.BIZ_PARAM_MISSING);
  });

  it('缺 store.User → SYS_DB_ERROR', () => {
    let err;
    try {
      adjustPoints({}, { userId: 'u1', delta: 3, now: 'NEW' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe(CODE.SYS_DB_ERROR);
  });
});
