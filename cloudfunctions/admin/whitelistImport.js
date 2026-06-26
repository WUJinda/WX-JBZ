/**
 * admin.applyWhitelistImport 纯函数（对齐技术架构 §122，PRD F8 R8.2 白名单导入覆盖）。
 *
 * 职责：将解析出的手机号 upsert 到 store.Whitelist。
 *   - phone 唯一；已存在则覆盖 imported_at=now（R8.2 重复导入覆盖）。
 *   - 返回 { imported, updated }。
 *   - 幂等：同输入二次调用 imported=0、updated=N。
 *
 * 本地轨：store 注入式，纯函数可单测；不调真实云 API。
 * 解耦：本模块不 require wx-server-sdk。
 */

/**
 * 应用白名单导入（就地修改 store.Whitelist）。
 * @param {object} store mock db（{ Whitelist: object[] }）
 * @param {object} params
 * @param {string[]} params.phones 已去重的手机号列表
 * @param {string} params.now 当前时间 ISO
 * @returns {{imported: number, updated: number}}
 */
function applyWhitelistImport(store, params) {
  const p = params || {};
  const phones = Array.isArray(p.phones) ? p.phones : [];
  const now = p.now;

  if (!store || !Array.isArray(store.Whitelist)) {
    throw new Error('applyWhitelistImport: store.Whitelist is required');
  }

  let imported = 0;
  let updated = 0;

  for (const phone of phones) {
    if (!phone) continue;
    const existing = store.Whitelist.find((w) => w && w.phone === phone);
    if (existing) {
      existing.imported_at = now;
      updated += 1;
    } else {
      store.Whitelist.push({ phone, imported_at: now });
      imported += 1;
    }
  }

  return { imported, updated };
}

module.exports = { applyWhitelistImport };
