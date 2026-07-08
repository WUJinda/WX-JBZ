/**
 * auth.register 云轨建号链路单测（胶水层回归锚点）。
 *
 * 测 register handler（handleRegister）的 db 注入与出入参组装：
 *   1. cloud.database() 取 db + context.openid + event.{nickname,avatar,phone} 一次性进 registerUser；
 *   2. 错误透传不吞（手机号被占 / 格式非法 / openid 缺失）。
 *
 * ⚠️ 回归锚点：纯函数单测（authRegister.test）直接注入 db，绕过 handleRegister，故「漏传 db」抓不到。
 *    历史上 register handler 漏传 db（体验版报 'db with collection() is required' SYS_DB_ERROR），
 *    本文件「正常建号」用例即锚定之——漏传 db 会让此用例抛 SYS_DB_ERROR 而非建号成功。
 *
 * 通过 require auth/index.js 取 handleRegister，注入 mock cloud（database 用 createMockDb）。
 */

const { handleRegister } = require('../../cloudfunctions/auth/index');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

/**
 * 构造 mock cloud：database() 返回 createMockDb 产的 db。
 */
function createMockCloud(initialStore) {
  const { db, store } = createMockDb(initialStore || {});
  const cloud = { database: () => db };
  return { cloud, db, store };
}

describe('auth.register 云轨建号链路（handleRegister）', () => {
  it('正常建号：db 注入成功，registerUser 落库并返回态（回归锚点：漏传 db 会抛 SYS_DB_ERROR）', async () => {
    const { cloud, store } = createMockCloud({ User: [] });
    const out = await handleRegister({
      cloud,
      event: { action: 'register', nickname: '张三', avatar: 'cloud://a.jpg', phone: '13812341234' },
      context: { openid: 'oNEW' }
    });
    expect(out.registered).toBe(true);
    expect(out.is_new).toBe(true);
    expect(out.phone_masked).toBe('138****1234');
    expect(out.join_status).toBe('pending');
    // 落库校验：phone 非空、is_admin=false（不授超管）、join_status=pending
    expect(store.User.length).toBe(1);
    expect(store.User[0]._openid).toBe('oNEW');
    expect(store.User[0].phone).toBe('13812341234');
    expect(store.User[0].is_admin).toBe(false);
    expect(store.User[0].join_status).toBe('pending');
  });

  it('手机号被别的 openid 占用 → 透传 BIZ_PHONE_TAKEN（不吞错）', async () => {
    const { cloud, store } = createMockCloud({
      User: [{ _id: 'u1', _openid: 'oOTHER', phone: '13812341234', phone_masked: '138****1234' }]
    });
    await expect(
      handleRegister({
        cloud,
        event: { action: 'register', nickname: '新人', phone: '13812341234' },
        context: { openid: 'oNEW' }
      })
    ).rejects.toMatchObject({ code: CODE.BIZ_PHONE_TAKEN });
    expect(store.User.length).toBe(1); // 未新增
  });

  it('手机号格式非法 → 透传 BIZ_PARAM_MISSING', async () => {
    const { cloud } = createMockCloud({ User: [] });
    await expect(
      handleRegister({
        cloud,
        event: { action: 'register', nickname: '张三', phone: '123' },
        context: { openid: 'oNEW' }
      })
    ).rejects.toMatchObject({ code: CODE.BIZ_PARAM_MISSING });
  });

  it('openid 缺失（context 无 openid）→ 透传 AUTH_NO_OPENID', async () => {
    const { cloud } = createMockCloud({ User: [] });
    await expect(
      handleRegister({
        cloud,
        event: { action: 'register', nickname: '张三', phone: '13812341234' },
        context: {}
      })
    ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
  });
});
