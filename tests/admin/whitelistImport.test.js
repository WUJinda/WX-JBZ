/**
 * admin.applyWhitelistImport 单测（H1 R8.2）：
 *   - 首次导入 imported=N；
 *   - 重复导入覆盖 imported_at（updated=N，imported=0）；
 *   - 幂等：同输入二次调用 imported=0、updated=N。
 */
const { applyWhitelistImport } = require('../../cloudfunctions/admin/whitelistImport');

function makeStore() {
  return { Whitelist: [] };
}

describe('applyWhitelistImport（白名单导入覆盖）', () => {
  it('首次导入：全部新增，imported=N，updated=0', () => {
    const store = makeStore();
    const r = applyWhitelistImport(store, {
      phones: ['13800001111', '13900002222'],
      now: '2026-06-26T00:00:00.000Z'
    });
    expect(r).toEqual({ imported: 2, updated: 0 });
    expect(store.Whitelist).toHaveLength(2);
    expect(store.Whitelist[0]).toEqual({ phone: '13800001111', imported_at: '2026-06-26T00:00:00.000Z' });
  });

  it('重复导入：已存在的覆盖 imported_at，imported=0 updated=N', () => {
    const store = makeStore();
    const now1 = '2026-06-26T00:00:00.000Z';
    const now2 = '2026-06-27T00:00:00.000Z';
    applyWhitelistImport(store, { phones: ['13800001111', '13900002222'], now: now1 });

    const r = applyWhitelistImport(store, { phones: ['13800001111', '13900002222'], now: now2 });
    expect(r).toEqual({ imported: 0, updated: 2 });
    expect(store.Whitelist).toHaveLength(2);
    // imported_at 被覆盖为新时间。
    expect(store.Whitelist[0].imported_at).toBe(now2);
  });

  it('幂等：同输入同 now 二次调用 imported=0 updated=N', () => {
    const store = makeStore();
    const now = '2026-06-26T00:00:00.000Z';
    applyWhitelistImport(store, { phones: ['13800001111', '13900002222', '13700003333'], now });

    const r2 = applyWhitelistImport(store, { phones: ['13800001111', '13900002222', '13700003333'], now });
    expect(r2).toEqual({ imported: 0, updated: 3 });
    expect(store.Whitelist).toHaveLength(3);
  });

  it('混合新增+更新', () => {
    const store = makeStore();
    const now1 = '2026-06-26T00:00:00.000Z';
    applyWhitelistImport(store, { phones: ['13800001111'], now: now1 });

    const r = applyWhitelistImport(store, {
      phones: ['13800001111', '13900002222'],
      now: '2026-06-27T00:00:00.000Z'
    });
    expect(r).toEqual({ imported: 1, updated: 1 });
    expect(store.Whitelist).toHaveLength(2);
  });

  it('空 phones：no-op', () => {
    const store = makeStore();
    const r = applyWhitelistImport(store, { phones: [], now: 'now' });
    expect(r).toEqual({ imported: 0, updated: 0 });
    expect(store.Whitelist).toHaveLength(0);
  });

  it('store.Whitelist 缺失抛错', () => {
    let err;
    try {
      applyWhitelistImport({}, { phones: ['13800001111'], now: 'now' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
  });
});
