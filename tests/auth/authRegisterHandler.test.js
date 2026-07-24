/**
 * auth.register 云轨建号链路单测（胶水层回归锚点）。
 *
 * 测 register handler（handleRegister）的 db 注入与出入参组装：
 *   1. cloud.database() 取 db + context.openid + event.{nickname,avatar,invite_code} 一次性进 registerUser；
 *   2. 错误透传不吞（邀请码已用 / 格式非法 / openid 缺失）。
 *
 * ⚠️ 回归锚点：纯函数单测（authRegister.test）直接注入 db，绕过 handleRegister，故「漏传 db」抓不到。
 *    历史上 register handler 漏传 db（体验版报 'db with collection() is required' SYS_DB_ERROR），
 *    本文件「正常建号」用例即锚定之——漏传 db 会让此用例抛 SYS_DB_ERROR 而非建号成功。
 */

const { handleRegister } = require('../../cloudfunctions/auth/index');
const { createMockDb } = require('../helpers/mockDb');
const { CODE } = require('../../cloudfunctions/common/errors');

function createMockCloud(initialStore) {
  const { db, store } = createMockDb(initialStore || {});
  const cloud = { database: () => db };
  return { cloud, db, store };
}

function unusedCode(c) {
  return { code: c, status: 'unused', batch_id: 'b1', created_by: 'admin', created_at: new Date('2026-07-01'), note: '' };
}

describe('auth.register 云轨建号链路（handleRegister）', () => {
  it('正常建号：db 注入成功，消费邀请码 + registerUser 落库（回归锚点：漏传 db 抛 SYS_DB_ERROR）', async () => {
    const { cloud, store } = createMockCloud({ User: [], InviteCode: [unusedCode('ABC123')] });
    const out = await handleRegister({
      cloud,
      event: { action: 'register', nickname: '张三', avatar: 'cloud://a.jpg', invite_code: 'ABC123' },
      context: { openid: 'oNEW' }
    });
    expect(out.registered).toBe(true);
    expect(out.is_new).toBe(true);
    expect(out.invite_code).toBe('ABC123');
    expect(out.join_status).toBe('pending');
    expect(store.User.length).toBe(1);
    expect(store.User[0]._openid).toBe('oNEW');
    expect(store.User[0].invite_code).toBe('ABC123');
    expect(store.User[0].is_admin).toBe(false);
    expect(store.User[0].join_status).toBe('pending');
    // 邀请码被消费
    expect(store.InviteCode[0].status).toBe('used');
  });

  it('邀请码已被使用 → 透传 BIZ_INVITE_CODE_USED（不吞错）', async () => {
    const { cloud, store } = createMockCloud({
      User: [],
      InviteCode: [Object.assign(unusedCode('ABC123'), { status: 'used', used_by: 'oOTHER' })]
    });
    await expect(
      handleRegister({
        cloud,
        event: { action: 'register', nickname: '新人', invite_code: 'ABC123' },
        context: { openid: 'oNEW' }
      })
    ).rejects.toMatchObject({ code: CODE.BIZ_INVITE_CODE_USED });
    expect(store.User.length).toBe(0); // 未建号
  });

  it('邀请码格式非法 → 透传 BIZ_INVITE_CODE_INVALID', async () => {
    const { cloud } = createMockCloud({ User: [], InviteCode: [] });
    await expect(
      handleRegister({
        cloud,
        event: { action: 'register', nickname: '张三', invite_code: 'ZZZZZZZZ' },
        context: { openid: 'oNEW' }
      })
    ).rejects.toMatchObject({ code: CODE.BIZ_INVITE_CODE_INVALID });
  });

  it('openid 缺失（context 无 openid）→ 透传 AUTH_NO_OPENID', async () => {
    const { cloud } = createMockCloud({ User: [], InviteCode: [unusedCode('ABC123')] });
    await expect(
      handleRegister({
        cloud,
        event: { action: 'register', nickname: '张三', invite_code: 'ABC123' },
        context: {}
      })
    ).rejects.toMatchObject({ code: CODE.AUTH_NO_OPENID });
  });
});
