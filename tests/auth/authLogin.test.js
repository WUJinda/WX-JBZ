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

  describe('buildNewUser（构造 User 文档工具，现由 auth.register 复用后覆盖 invite_code）', () => {
    it('构造 User 文档（含 openid / 占位空 invite_code / join_status=pending）', () => {
      const now = () => '2026-06-26T10:00:00Z';
      const doc = buildNewUser({ openid: 'oABC' }, { nickname: '张明', avatar: 'a.jpg' }, now);
      expect(doc._openid).toBe('oABC');
      expect(doc.nickname).toBe('张明');
      expect(doc.avatar).toBe('a.jpg');
      expect(doc.invite_code).toBe(''); // 占位空串；register 消费邀请码后覆盖
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
    it('不下发原始 openid / unionid', () => {
      const user = {
        _openid: 'oSECRET',
        unionid: 'uSECRET',
        invite_code: 'ABC123',
        nickname: '张明',
        join_status: 'joined',
        is_admin: false,
        dept_id: 'd_01'
      };
      const out = projectLoginState(user);
      expect(out).not.toHaveProperty('openid');
      expect(out).not.toHaveProperty('unionid');
      expect(out.registered).toBe(true);
    });

    it('user 为 null 返回未注册态（is_new:true）', () => {
      const out = projectLoginState(null);
      expect(out.registered).toBe(false);
      expect(out.join_status).toBe('pending');
      expect(out.is_new).toBe(true);
    });

    it('registered = User 文档存在（去手机号后口径，老用户天然兼容）', () => {
      expect(projectLoginState(null).registered).toBe(false);
      expect(projectLoginState({ _openid: 'oX', invite_code: 'ABC123' }).registered).toBe(true);
      // 即便历史占位用户（无 invite_code）也视为已注册：User 存在即已准入
      expect(projectLoginState({ _openid: 'oX' }).registered).toBe(true);
    });

    it('is_new：user 为 null → true；存在 → false', () => {
      expect(projectLoginState(null).is_new).toBe(true);
      expect(projectLoginState({ _openid: 'oX' }).is_new).toBe(false);
    });
  });

  describe('login 主逻辑（只查不建）', () => {
    it('首次 login（User 不存在）：不建号，返回 is_new:true + 未注册态', async () => {
      const { db, store } = createMockDb({});
      const out = await login({ getWXContext: () => ({ OPENID: 'oNEW' }), db });
      expect(out.is_new).toBe(true);
      expect(out.registered).toBe(false);
      expect(out.join_status).toBe('pending');
      // 关键：login 不再 add User（建号移至 register，消费邀请码后建号）
      expect(store.User.length).toBe(0);
    });

    it('老用户 login：返回登录态，is_new:false，不新增记录', async () => {
      const existing = {
        _id: 'u_001',
        _openid: 'oDUP',
        nickname: '老用户',
        invite_code: 'OLD123',
        join_status: 'joined',
        is_admin: true,
        dept_id: 'd_01'
      };
      const { db, store } = createMockDb({ User: [existing] });
      const out = await login({ getWXContext: () => ({ OPENID: 'oDUP' }), db });
      expect(out.is_new).toBe(false);
      expect(out.registered).toBe(true);
      expect(out.join_status).toBe('joined');
      expect(out.is_admin).toBe(true);
      expect(store.User.length).toBe(1); // 不新增
    });

    it('不同 openid 多次 login 都不建号（建号由 register 负责）', async () => {
      const { db, store } = createMockDb({ User: [] });
      await login({ getWXContext: () => ({ OPENID: 'oA' }), db });
      await login({ getWXContext: () => ({ OPENID: 'oB' }), db });
      await login({ getWXContext: () => ({ OPENID: 'oA' }), db });
      expect(store.User.length).toBe(0);
    });

    it('db 缺失抛 SYS_DB_ERROR', async () => {
      await expect(login({ getWXContext: () => ({ OPENID: 'oX' }) })).rejects.toMatchObject({
        code: CODE.SYS_DB_ERROR
      });
    });
  });
});
