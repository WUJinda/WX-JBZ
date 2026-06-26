const {
  resolveIdentity,
  buildNewUser,
  projectLoginState,
  login
} = require('../../cloudfunctions/auth/authLogin');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('auth.login 纯函数', () => {
  describe('resolveIdentity（身份解析）', () => {
    it('从 mock wxContext 正确取 OPENID', () => {
      const getWXContext = () => ({ OPENID: 'oABC123', UNIONID: 'uid-1' });
      const r = resolveIdentity(getWXContext);
      expect(r.openid).toBe('oABC123');
      expect(r.unionid).toBe('uid-1');
    });

    it('OPENID 缺失抛 AUTH_NO_OPENID', () => {
      try {
        resolveIdentity(() => ({}));
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.code).toBe(CODE.AUTH_NO_OPENID);
      }
    });

    it('OPENID 为空字符串抛 AUTH_NO_OPENID', () => {
      expect(() => resolveIdentity(() => ({ OPENID: '' }))).toThrow();
    });

    it('getWXContext 非函数抛 AUTH_NO_OPENID', () => {
      try {
        resolveIdentity(null);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.code).toBe(CODE.AUTH_NO_OPENID);
      }
    });

    it('身份仅含 openid/unionid，绝不涉及 token', () => {
      const r = resolveIdentity(() => ({ OPENID: 'oX', token: 'fake' }));
      expect(r).not.toHaveProperty('token');
    });
  });

  describe('buildNewUser', () => {
    it('构造首次登录 User 文档（含 openid / 无 phone / join_status=pending）', () => {
      const now = () => '2026-06-26T10:00:00Z';
      const doc = buildNewUser({ openid: 'oABC' }, { nickname: '张明', avatar: 'a.jpg' }, now);
      expect(doc._openid).toBe('oABC');
      expect(doc.nickname).toBe('张明');
      expect(doc.avatar).toBe('a.jpg');
      expect(doc.phone).toBe('');
      expect(doc.phone_masked).toBe('');
      expect(doc.join_status).toBe('pending');
      expect(doc.is_admin).toBe(false);
      expect(doc.created_at).toBe('2026-06-26T10:00:00Z');
      expect(doc).not.toHaveProperty('unionid');
    });

    it('含 unionid 时写入', () => {
      const doc = buildNewUser({ openid: 'oABC', unionid: 'u1' });
      expect(doc.unionid).toBe('u1');
    });

    it('profile 缺省时 nickname/avatar 为空串', () => {
      const doc = buildNewUser({ openid: 'oABC' });
      expect(doc.nickname).toBe('');
      expect(doc.avatar).toBe('');
    });
  });

  describe('projectLoginState（登录态投影）', () => {
    it('不下发原始 phone / openid / unionid', () => {
      const user = {
        _openid: 'oSECRET',
        unionid: 'uSECRET',
        phone: '13812341234',
        phone_masked: '138****1234',
        nickname: '张明',
        join_status: 'joined',
        is_admin: false,
        dept_id: 'd_01'
      };
      const out = projectLoginState(user);
      expect(out).not.toHaveProperty('phone');
      expect(out).not.toHaveProperty('openid');
      expect(out).not.toHaveProperty('unionid');
      expect(out.phone_masked).toBe('138****1234');
    });

    it('user 为 null 返回未注册态', () => {
      const out = projectLoginState(null);
      expect(out.registered).toBe(false);
      expect(out.join_status).toBe('pending');
    });

    it('registered 表示已完成手机号验证（phone 非空）', () => {
      // 仅建号、未验证手机号 → registered=false
      expect(projectLoginState({ _openid: 'oX', phone: '', phone_masked: '' }).registered).toBe(false);
      // 已验证手机号 → registered=true
      expect(
        projectLoginState({ _openid: 'oX', phone: '13812341234', phone_masked: '138****1234' }).registered
      ).toBe(true);
    });
  });

  describe('login 主逻辑（upsert 去重）', () => {
    it('首次登录建号，返回 registered=false', async () => {
      const { db, store } = createMockDb({});
      const out = await login({
        getWXContext: () => ({ OPENID: 'oNEW' }),
        db,
        profile: { nickname: '新人' }
      });
      expect(out.registered).toBe(false);
      expect(store.User.length).toBe(1);
      expect(store.User[0]._openid).toBe('oNEW');
    });

    it('同一 openid 不建重复账号（再次登录不新增）', async () => {
      const existing = {
        _id: 'u_001',
        _openid: 'oDUP',
        nickname: '老用户',
        phone: '13812341234',
        phone_masked: '138****1234',
        join_status: 'joined',
        is_admin: true,
        dept_id: 'd_01'
      };
      const { db, store } = createMockDb({ User: [existing] });
      const out = await login({ getWXContext: () => ({ OPENID: 'oDUP' }), db });
      expect(out.registered).toBe(true);
      expect(out.join_status).toBe('joined');
      expect(out.is_admin).toBe(true);
      // 关键：不重复建号
      expect(store.User.length).toBe(1);
      expect(store.User[0]._id).toBe('u_001');
    });

    it('不同 openid 各自建号，互不干扰', async () => {
      const { db, store } = createMockDb({ User: [] });
      await login({ getWXContext: () => ({ OPENID: 'oA' }), db });
      await login({ getWXContext: () => ({ OPENID: 'oB' }), db });
      await login({ getWXContext: () => ({ OPENID: 'oA' }), db });
      expect(store.User.length).toBe(2);
    });

    it('db 缺失抛 SYS_DB_ERROR', async () => {
      await expect(login({ getWXContext: () => ({ OPENID: 'oX' }) })).rejects.toMatchObject({
        code: CODE.SYS_DB_ERROR
      });
    });
  });
});
