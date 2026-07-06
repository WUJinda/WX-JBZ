/**
 * auth.phone 云轨解密链路单测（A4 红线强制项）。
 *
 * 测 phone handler（handlePhone）的解密链路：
 *   1. 调 cloud.openapi.phonenumber.getPhoneNumber({code}) 解密取真实手机号；
 *   2. 真实手机号进入 verifyPhone 纯函数做归一化+脱敏+更新（白名单受 PHONE_WHITELIST_REQUIRED
 *      开关控制，当前 false=放开注册；切回 true 时白名单校验同步生效）；
 *   3. 能力缺失（openapi 缺失/非函数）→ SYS_EXTERNAL_ERROR(5002)；
 *   4. code 缺失 → SYS_EXTERNAL_ERROR(5002)；
 *   5. 红线：即使 event.phone 传了明文，也被忽略——进入业务的是解密号而非明文。
 *
 * 通过 require auth/index.js 取 handlePhone，注入 mock cloud（openapi + database）。
 * mock db 复用 helpers/mockDb 的 createMockDb，database() 返回它即可。
 */

const { handlePhone } = require('../../cloudfunctions/auth/index');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

/**
 * 构造 mock cloud：含 openapi.phonenumber.getPhoneNumber + database()。
 * @param {object} opts
 * @param {Function} [opts.getPhoneNumber] mock 的 getPhoneNumber 实现
 * @param {object} [opts.phonenumberMissing] openapi.phonenumber 缺失
 * @param {object} [opts.store] createMockDb 产出的初始数据
 */
function createMockCloud(opts) {
  opts = opts || {};
  const { db } = createMockDb(opts.store || {});
  const cloud = { database: () => db };
  if (!opts.phonenumberMissing) {
    const openapi = {};
    openapi.phonenumber = {
      getPhoneNumber: opts.getPhoneNumber || (async () => {
        throw new Error('getPhoneNumber not stubbed');
      })
    };
    cloud.openapi = openapi;
  }
  return { cloud, db };
}

describe('auth.phone 云轨解密链路（handlePhone）', () => {
  const context = { openid: 'oUSER1' };

  it('解密成功：真实手机号进入 verifyPhone，校验通过且仅下发脱敏号', async () => {
    const { cloud, db } = createMockCloud({
      store: {
        Whitelist: [{ phone: '13800138000' }],
        User: [{ _id: 'u_1', _openid: 'oUSER1', phone: '', phone_masked: '' }]
      },
      getPhoneNumber: async () => ({
        phoneInfo: { phoneNumber: '13800138000' }
      })
    });
    const out = await handlePhone({
      cloud,
      event: { action: 'phone', code: 'real-code-from-wx' },
      context
    });
    expect(out.verified).toBe(true);
    expect(out.phone_masked).toBe('138****8000');
    // 真实号写入 User
    expect(db.collection('User')._store[0].phone).toBe('13800138000');
  });

  it('红线：event.phone 明文被忽略，进入业务的是解密号而非明文', async () => {
    // 白名单只有解密号 13800138000；若 handler 误用明文 99999999999，会抛 BIZ_NOT_IN_WHITELIST。
    // 解密号在白名单 → 通过；断言通过即证明用的是解密号。
    const { cloud } = createMockCloud({
      store: {
        Whitelist: [{ phone: '13800138000' }],
        User: [{ _id: 'u_1', _openid: 'oUSER1', phone: '', phone_masked: '' }]
      },
      getPhoneNumber: async () => ({
        phoneInfo: { phoneNumber: '13800138000' }
      })
    });
    const out = await handlePhone({
      cloud,
      // 故意传一个伪造的明文 phone（白名单里没有它），验证它被忽略。
      event: { action: 'phone', code: 'real-code', phone: '99999999999' },
      context
    });
    expect(out.verified).toBe(true);
    expect(out.phone_masked).toBe('138****8000');
  });

  it('红线反证：明文 phone 被忽略，落库的是解密号（而非明文）', async () => {
    // 放开白名单（PHONE_WHITELIST_REQUIRED=false）后，红线聚焦「明文不可信」：
    // 解密号 13800138000 与明文 13900139000 是不同的合法号，断言落库的是解密号
    // → 证明 handler 用的是解密号、明文被彻底忽略（不可伪造）。
    const { cloud, db } = createMockCloud({
      store: {
        User: [{ _id: 'u_1', _openid: 'oUSER1', phone: '', phone_masked: '' }]
      },
      getPhoneNumber: async () => ({
        phoneInfo: { phoneNumber: '13800138000' }
      })
    });
    const out = await handlePhone({
      cloud,
      // 故意传一个与解密号不同的合法明文 phone，验证它被忽略。
      event: { action: 'phone', code: 'real-code', phone: '13900139000' },
      context
    });
    expect(out.verified).toBe(true);
    expect(out.phone_masked).toBe('138****8000');
    // 落库的是解密号 13800138000，不是明文 13900139000
    expect(db.collection('User')._store[0].phone).toBe('13800138000');
  });

  it('能力缺失：cloud.openapi.phonenumber 缺失 → 抛 SYS_EXTERNAL_ERROR(5002)', async () => {
    const { cloud } = createMockCloud({
      store: { User: [{ _id: 'u_1', _openid: 'oUSER1' }] },
      phonenumberMissing: true
    });
    await expect(
      handlePhone({
        cloud,
        event: { action: 'phone', code: 'real-code' },
        context
      })
    ).rejects.toMatchObject({ code: CODE.SYS_EXTERNAL_ERROR });
  });

  it('能力缺失：getPhoneNumber 非函数 → 抛 SYS_EXTERNAL_ERROR(5002)', async () => {
    const { cloud, db } = createMockCloud({
      store: { User: [{ _id: 'u_1', _openid: 'oUSER1' }] }
    });
    // 覆盖为非函数
    cloud.openapi.phonenumber.getPhoneNumber = 'not-a-function';
    await expect(
      handlePhone({
        cloud,
        event: { action: 'phone', code: 'real-code' },
        context
      })
    ).rejects.toMatchObject({ code: CODE.SYS_EXTERNAL_ERROR });
  });

  it('code 缺失：event.code 缺失 → 抛 SYS_EXTERNAL_ERROR(5002)', async () => {
    const { cloud } = createMockCloud({
      store: { User: [{ _id: 'u_1', _openid: 'oUSER1' }] },
      getPhoneNumber: async () => ({ phoneInfo: { phoneNumber: '13800138000' } })
    });
    await expect(
      handlePhone({
        cloud,
        event: { action: 'phone' }, // 无 code
        context
      })
    ).rejects.toMatchObject({ code: CODE.SYS_EXTERNAL_ERROR });
  });

  it('code 为空字符串 → 抛 SYS_EXTERNAL_ERROR(5002)', async () => {
    const { cloud } = createMockCloud({
      store: { User: [{ _id: 'u_1', _openid: 'oUSER1' }] },
      getPhoneNumber: async () => ({ phoneInfo: { phoneNumber: '13800138000' } })
    });
    await expect(
      handlePhone({
        cloud,
        event: { action: 'phone', code: '' },
        context
      })
    ).rejects.toMatchObject({ code: CODE.SYS_EXTERNAL_ERROR });
  });

  it('openapi 调用抛错 → 统一 SYS_EXTERNAL_ERROR(5002)', async () => {
    const { cloud } = createMockCloud({
      store: { User: [{ _id: 'u_1', _openid: 'oUSER1' }] },
      getPhoneNumber: async () => {
        throw new Error('wechat api error: invalid code');
      }
    });
    await expect(
      handlePhone({
        cloud,
        event: { action: 'phone', code: 'expired-code' },
        context
      })
    ).rejects.toMatchObject({ code: CODE.SYS_EXTERNAL_ERROR });
  });

  it('解密结果无 phoneNumber → 抛 SYS_EXTERNAL_ERROR(5002)', async () => {
    const { cloud } = createMockCloud({
      store: { User: [{ _id: 'u_1', _openid: 'oUSER1' }] },
      getPhoneNumber: async () => ({ phoneInfo: {} })
    });
    await expect(
      handlePhone({
        cloud,
        event: { action: 'phone', code: 'real-code' },
        context
      })
    ).rejects.toMatchObject({ code: CODE.SYS_EXTERNAL_ERROR });
  });
});
