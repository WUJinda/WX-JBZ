const {
  getOpenid,
  authMiddleware,
  assertUserExists,
  assertJoined,
  assertJoinedFresh
} = require('../../cloudfunctions/common/authMiddleware');
const { CODE, BizError } = require('../../cloudfunctions/common/errors');
const { createMockDb } = require('../helpers/mockDb');

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

describe('assertUserExists', () => {
  it('openid 对应 User 存在时返回该 user', async () => {
    const { db } = createMockDb({ User: [{ _openid: 'oABC', join_status: 'joined' }] });
    const user = await assertUserExists(db, 'oABC');
    expect(user._openid).toBe('oABC');
  });

  it('openid 缺失时抛 AUTH_NO_OPENID', async () => {
    const { db } = createMockDb({});
    await expect(assertUserExists(db, '')).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
  });

  it('无对应用户时抛 AUTH_USER_NOT_FOUND', async () => {
    const { db } = createMockDb({ User: [{ _openid: 'other' }] });
    await expect(assertUserExists(db, 'oABC')).rejects.toMatchObject({
      code: CODE.AUTH_USER_NOT_FOUND
    });
  });
});

describe('assertJoined', () => {
  it('join_status=joined 时通过', () => {
    expect(() => assertJoined({ join_status: 'joined' })).not.toThrow();
  });

  it('join_status 非 joined 时抛 AUTH_JOIN_STATUS_DENIED', () => {
    expect(() => assertJoined({ join_status: 'pending' })).toThrow();
  });

  it('user 为空时抛 AUTH_JOIN_STATUS_DENIED', () => {
    expect(() => assertJoined(null)).toThrow();
  });
});

describe('assertJoinedFresh', () => {
  // sleepFn stub：即时 resolve 并计数，避免依赖真实 setTimeout；retries/delayMs 语义即可覆盖。
  const noSleep = () => Promise.resolve();

  it('firstUser 已 joined → 零读零 sleep 直接返回', async () => {
    const collection = vi.fn(); // 若被调用即失败信号
    const db = { collection };
    const sleeps = [];
    const user = await assertJoinedFresh(db, 'oX', {
      firstUser: { _openid: 'oX', join_status: 'joined' },
      sleepFn: () => { sleeps.push(1); return Promise.resolve(); }
    });
    expect(user.join_status).toBe('joined');
    expect(collection).not.toHaveBeenCalled();
    expect(sleeps.length).toBe(0);
  });

  it('首次读即 joined → 不 sleep', async () => {
    const { db } = createMockDb({ User: [{ _openid: 'oX', join_status: 'joined' }] });
    const sleeps = [];
    const user = await assertJoinedFresh(db, 'oX', {
      sleepFn: () => { sleeps.push(1); return Promise.resolve(); }
    });
    expect(user.join_status).toBe('joined');
    expect(sleeps.length).toBe(0);
  });

  it('首次 pending → 退避重读后 joined（模拟副本同步追上）', async () => {
    const { db, store } = createMockDb({ User: [{ _openid: 'oX', join_status: 'pending' }] });
    let calls = 0;
    const sleepFn = () => {
      calls += 1;
      // 第一次退避后副本追上：原地改 store.User，下次 get() 读到 joined。
      if (calls === 1) store.User[0].join_status = 'joined';
      return Promise.resolve();
    };
    const user = await assertJoinedFresh(db, 'oX', { sleepFn });
    expect(user.join_status).toBe('joined');
    expect(calls).toBe(1); // 退避一次即自愈
  });

  it('重试用尽仍 pending → 抛 AUTH_JOIN_STATUS_DENIED(1004)', async () => {
    const { db } = createMockDb({ User: [{ _openid: 'oX', join_status: 'pending' }] });
    let calls = 0;
    await expect(
      assertJoinedFresh(db, 'oX', {
        retries: 2,
        sleepFn: () => { calls += 1; return Promise.resolve(); }
      })
    ).rejects.toMatchObject({ code: CODE.AUTH_JOIN_STATUS_DENIED });
    expect(calls).toBe(2); // 重试了 2 次才放弃
  });

  it('User 不存在 → 抛 AUTH_USER_NOT_FOUND(1002，非 1004)', async () => {
    const { db } = createMockDb({ User: [] });
    await expect(
      assertJoinedFresh(db, 'oX', { sleepFn: noSleep })
    ).rejects.toMatchObject({ code: CODE.AUTH_USER_NOT_FOUND });
  });

  it('firstUser 为旧快照 pending → 不盲信，读最新库发现 joined', async () => {
    // 写后读场景核心：context.user(firstUser) 可能是旧 pending，但主节点已 joined → 必须读最新库。
    const { db } = createMockDb({ User: [{ _openid: 'oX', join_status: 'joined' }] });
    const user = await assertJoinedFresh(db, 'oX', {
      firstUser: { _openid: 'oX', join_status: 'pending' },
      sleepFn: noSleep
    });
    expect(user.join_status).toBe('joined');
  });
});
