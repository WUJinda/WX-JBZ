const {
  registerUser,
  validateNickname,
  NICKNAME_MAX_LEN
} = require('../../cloudfunctions/auth/authRegister');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

describe('auth.register 纯函数', () => {
  describe('validateNickname（与 userAccount/editCalc 同口径）', () => {
    it('trim 后 1..NICKNAME_MAX_LEN 码点合法', () => {
      expect(validateNickname('张明')).toBe(true);
      expect(validateNickname('  张明  ')).toBe(true); // 内部 trim
      expect(validateNickname('a')).toBe(true);
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN))).toBe(true);
    });

    it('空串 / 纯空格 / 非字符串 不合法', () => {
      expect(validateNickname('')).toBe(false);
      expect(validateNickname('   ')).toBe(false);
      expect(validateNickname(null)).toBe(false);
      expect(validateNickname(123)).toBe(false);
    });

    it('超过 NICKNAME_MAX_LEN 码点不合法', () => {
      expect(validateNickname('a'.repeat(NICKNAME_MAX_LEN + 1))).toBe(false);
    });
  });

  describe('registerUser 主逻辑（一次性建号 upsert）', () => {
    it('全新用户：add 建号，phone 非空，join_status=pending，is_admin=false（不授超管）', async () => {
      const { db, store } = createMockDb({ User: [] });
      const out = await registerUser({
        openid: 'oNEW',
        nickname: '新人',
        avatar: 'cloud://a.jpg',
        phone: '13812341234',
        db,
        now: new Date('2026-07-08T10:00:00Z')
      });
      expect(out.registered).toBe(true);
      expect(out.is_new).toBe(true);
      expect(out.phone_masked).toBe('138****1234');
      expect(out.join_status).toBe('pending');
      expect(store.User.length).toBe(1);
      expect(store.User[0]._openid).toBe('oNEW');
      expect(store.User[0].phone).toBe('13812341234');
      expect(store.User[0].phone_masked).toBe('138****1234');
      expect(store.User[0].join_status).toBe('pending');
      expect(store.User[0].is_admin).toBe(false); // 手动填写路径不授超管
      expect(store.User[0].nickname).toBe('新人');
    });

    it('手机号归一化：+86 前缀（紧跟11位）/ 横线分隔 → 11 位纯数字', async () => {
      // normalizePhoneInput 的 +86 去前缀要求紧跟 11 位连续数字（与 authPhone 同源）
      const { db, store } = createMockDb({ User: [] });
      await registerUser({ openid: 'oX', nickname: '张三', phone: '+8613812341234', db });
      expect(store.User[0].phone).toBe('13812341234');
      expect(store.User[0].phone_masked).toBe('138****1234');
      // 横线分隔（无国家码）也能归一化
      const { db: db2, store: store2 } = createMockDb({ User: [] });
      await registerUser({ openid: 'oY', nickname: '李四', phone: '138-1234-1234', db: db2 });
      expect(store2.User[0].phone).toBe('13812341234');
    });

    it('phone 被别的 openid 占用 → BIZ_PHONE_TAKEN，不新增', async () => {
      const { db, store } = createMockDb({
        User: [{ _id: 'u1', _openid: 'oOTHER', phone: '13812341234', phone_masked: '138****1234' }]
      });
      await expect(
        registerUser({ openid: 'oNEW', nickname: '新人', phone: '13812341234', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_PHONE_TAKEN });
      expect(store.User.length).toBe(1); // 未新增
    });

    it('本人同 openid 已存在（历史 phone="" 占位）→ update 补 phone（upsert，is_new:false）', async () => {
      const { db, store } = createMockDb({
        User: [
          {
            _id: 'u1',
            _openid: 'oME',
            nickname: '',
            phone: '',
            phone_masked: '',
            join_status: 'pending'
          }
        ]
      });
      const out = await registerUser({
        openid: 'oME',
        nickname: '我',
        avatar: 'cloud://b.jpg',
        phone: '13812341234',
        db
      });
      expect(out.registered).toBe(true);
      expect(out.is_new).toBe(false);
      expect(store.User.length).toBe(1); // update 不新增
      expect(store.User[0].phone).toBe('13812341234');
      expect(store.User[0].nickname).toBe('我');
    });

    it('昵称格式非法 → BIZ_PARAM_MISSING', async () => {
      const { db } = createMockDb({ User: [] });
      await expect(
        registerUser({ openid: 'oX', nickname: '', phone: '13812341234', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
    });

    it('手机号非法（非 11 位）→ BIZ_PARAM_MISSING', async () => {
      const { db } = createMockDb({ User: [] });
      await expect(
        registerUser({ openid: 'oX', nickname: '张三', phone: '123', db })
      ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
    });

    it('avatar 可选：空串允许建号（后续 profile.edit 补）', async () => {
      const { db, store } = createMockDb({ User: [] });
      await registerUser({ openid: 'oX', nickname: '张三', avatar: '', phone: '13812341234', db });
      expect(store.User[0].avatar).toBe('');
    });

    it('openid 缺失 → AUTH_NO_OPENID', async () => {
      const { db } = createMockDb({ User: [] });
      await expect(
        registerUser({ nickname: '张三', phone: '13812341234', db })
      ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
    });

    it('db 缺失 → SYS_DB_ERROR', async () => {
      await expect(
        registerUser({ openid: 'oX', nickname: '张三', phone: '13812341234' })
      ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
    });

    it('update 命中 0 行（并发注销等）→ 抛 SYS_DB_ERROR，不静默假成功（P1-3）', async () => {
      // 自定义 mock：openid 查到存在，但 update 返回 0 行（模拟 where 后被并发删除）
      const customDb = {
        collection: () => ({
          where: (cond) => ({
            get: () =>
              Promise.resolve({
                data:
                  '_openid' in cond
                    ? [{ _id: 'u1', _openid: 'oME', phone: '', join_status: 'pending' }]
                    : []
              }),
            update: () => Promise.resolve({ stats: { updated: 0 } })
          })
        })
      };
      await expect(
        registerUser({ openid: 'oME', nickname: '我', phone: '13812341234', db: customDb })
      ).rejects.toMatchObject({ code: CODE.SYS_DB_ERROR });
    });

    it('add 撞 idx_user_phone 唯一索引（并发同号）→ 转 BIZ_PHONE_TAKEN', async () => {
      // 自定义 mock：phone 未占、openid 不存在，但 add 抛 idx_user_phone 撞键
      const customDb = {
        collection: () => ({
          where: () => ({
            get: () => Promise.resolve({ data: [] })
          }),
          add: () =>
            Promise.reject({
              errMsg:
                'collection.add:fail -502001 duplicate key error index: idx_user_phone dup key'
            })
        })
      };
      await expect(
        registerUser({ openid: 'oNEW', nickname: '新人', phone: '13812341234', db: customDb })
      ).rejects.toMatchObject({ code: CODE.BIZ_PHONE_TAKEN });
    });
  });

  it('NICKNAME_MAX_LEN === 20（与 userAccount/editCalc 同口径）', () => {
    expect(NICKNAME_MAX_LEN).toBe(20);
  });
});
